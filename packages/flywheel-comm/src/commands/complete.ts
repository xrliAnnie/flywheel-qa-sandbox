/**
 * FLY-108: Runner-driven `session_completed` emitter.
 *
 * Terminal event that drives WorkflowFSM to a terminal state + (when merged)
 * triggers `runPostShipFinalization` on Bridge. Must be reliable (retry with
 * exponential backoff, fail-close + marker file on all failure) because a
 * lost event means the bug this command is meant to fix reproduces verbatim.
 *
 * Payload shape is aligned field-by-field with `TeamLeadClient.emitCompleted()`
 * (`packages/edge-worker/src/ExecutionEventEmitter.ts:61-85`) and the Bridge
 * consumers in `packages/teamlead/src/bridge/event-route.ts:313-553`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VALID_ROUTES = new Set(["auto_approve", "needs_review", "blocked"]);

const ATTEMPT_COUNT = 4;
const ATTEMPT_TIMEOUT_MS = 5000;
const BACKOFF_MS = [1000, 2000, 4000] as const;

type Evidence = {
	landingStatus?: { status: "merged"; prNumber: number };
	commitCount: number;
	filesChangedCount: number;
	linesAdded: number;
	linesRemoved: number;
	diffSummary: string;
	changedFilePaths: string[];
	commitMessages: string[];
};

type Payload = {
	decision: { route: string };
	evidence: Evidence;
	sessionRole: string;
	summary?: string;
	exitReason: string;
	issueIdentifier?: string;
};

export interface CompleteOpts {
	route: string;
	pr?: number;
	merged: boolean;
	sessionRole?: string;
	summary?: string;
	exitReason?: string;
	baseRef?: string;
}

export async function complete(opts: CompleteOpts): Promise<void> {
	if (!opts.route) {
		console.error("--route is required");
		process.exit(1);
	}
	if (!VALID_ROUTES.has(opts.route)) {
		console.error(
			`Invalid --route: ${opts.route}. Must be one of: ${[...VALID_ROUTES].join(", ")}`,
		);
		process.exit(1);
	}
	if (opts.merged && (opts.pr === undefined || opts.pr === null)) {
		console.error("--merged requires --pr <number>");
		process.exit(1);
	}

	const execId = requireEnv("FLYWHEEL_EXEC_ID");
	const issueId = requireEnv("FLYWHEEL_ISSUE_ID");
	const projectName = requireEnv("FLYWHEEL_PROJECT_NAME");
	const bridgeUrl = requireEnv("FLYWHEEL_BRIDGE_URL");
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	const sessionRole = opts.sessionRole ?? "main";
	const exitReason = opts.exitReason ?? "completed";
	const baseRef = opts.baseRef ?? deriveBaseRef();
	const issueIdentifier = deriveIssueIdentifier();
	const evidence = collectEvidence({
		baseRef,
		merged: opts.merged,
		pr: opts.pr,
	});
	const summary = opts.summary ?? evidence.commitMessages[0];

	const payload: Payload = {
		decision: { route: opts.route },
		evidence,
		sessionRole,
		exitReason,
	};
	if (summary) payload.summary = summary;
	if (issueIdentifier) payload.issueIdentifier = issueIdentifier;

	const body = {
		event_id: randomUUID(),
		execution_id: execId,
		issue_id: issueId,
		project_name: projectName,
		event_type: "session_completed",
		source: "flywheel-comm",
		payload,
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;

	let lastError: string | undefined;
	for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
			const response = await fetch(`${bridgeUrl}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timer);
			if (response.ok) {
				console.log(
					`[complete] session_completed delivered (attempt ${attempt}/${ATTEMPT_COUNT})`,
				);
				return;
			}
			lastError = `Bridge returned ${response.status}`;
			console.error(
				`[complete] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			console.error(
				`[complete] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
		}
		if (attempt < ATTEMPT_COUNT) {
			const delay = BACKOFF_MS[attempt - 1] ?? 0;
			await sleep(delay);
		}
	}

	// All retries exhausted — fail-close + marker file.
	const markerWritten = writeMarker({
		execId,
		body,
		attempts: ATTEMPT_COUNT,
		lastError,
	});
	const markerStatus = markerWritten
		? "Marker written."
		: "Marker NOT written (see above).";
	console.error(
		`[complete] FAIL-CLOSE: ${ATTEMPT_COUNT} attempts failed. ${markerStatus} Last error: ${lastError}`,
	);
	process.exit(1);
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`${name} environment variable is required`);
		process.exit(1);
	}
	return v;
}

function deriveIssueIdentifier(): string | undefined {
	try {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		const match = branch.match(/[A-Z]+-\d+/);
		return match ? match[0] : undefined;
	} catch {
		return undefined;
	}
}

function deriveBaseRef(): string {
	try {
		const base = git(["merge-base", "HEAD", "origin/main"]).trim();
		return base || "origin/main";
	} catch {
		return "origin/main";
	}
}

function collectEvidence(args: {
	baseRef: string;
	merged: boolean;
	pr?: number;
}): Evidence {
	const { baseRef, merged, pr } = args;
	const range = `${baseRef}..HEAD`;

	const commitCount = parseInt(
		git(["rev-list", "--count", range]).trim() || "0",
		10,
	);

	const numstat = git(["diff", "--numstat", range]).trim();
	const numstatLines = numstat ? numstat.split("\n") : [];
	let linesAdded = 0;
	let linesRemoved = 0;
	for (const line of numstatLines) {
		const [addedStr, removedStr] = line.split("\t");
		const added = parseInt(addedStr ?? "0", 10);
		const removed = parseInt(removedStr ?? "0", 10);
		if (!Number.isNaN(added)) linesAdded += added;
		if (!Number.isNaN(removed)) linesRemoved += removed;
	}

	const nameOnly = git(["diff", "--name-only", range]).trim();
	const changedFilePaths = nameOnly ? nameOnly.split("\n") : [];

	const diffSummary =
		git(["diff", "--stat", range]).trim().split("\n").pop()?.trim() ?? "";

	const logOut = git(["log", "--format=%s", range]).trim();
	const commitMessages = logOut ? logOut.split("\n") : [];

	const evidence: Evidence = {
		commitCount,
		filesChangedCount: changedFilePaths.length,
		linesAdded,
		linesRemoved,
		diffSummary,
		changedFilePaths,
		commitMessages,
	};
	if (merged && pr !== undefined) {
		evidence.landingStatus = { status: "merged", prNumber: pr };
	}
	return evidence;
}

function git(args: string[]): string {
	try {
		return execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function writeMarker(args: {
	execId: string;
	body: unknown;
	attempts: number;
	lastError: string | undefined;
}): boolean {
	const home = process.env.HOME ?? homedir();
	const dir = join(home, ".flywheel", "state", "complete-failed");
	const markerPath = join(dir, `${args.execId}.json`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify(
				{
					execution_id: args.execId,
					attempts: args.attempts,
					error: args.lastError,
					timestamp: new Date().toISOString(),
					...(typeof args.body === "object" ? args.body : {}),
				},
				null,
				2,
			),
			"utf8",
		);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(
			`[complete] CRITICAL: marker write failed at ${markerPath}: ${msg}`,
		);
		console.error(
			`[complete] session_completed emit failed AND marker could not be persisted — stale patrol has no record of this failure. Check disk/permissions at ${dir}.`,
		);
		return false;
	}
}
