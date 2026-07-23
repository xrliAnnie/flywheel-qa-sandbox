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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "../db.js";
import {
	type DesignHtmlEvidence,
	findDesignHtmlPaths,
} from "../design-html-evidence.js";
import { currentWorkflowActivationFromEnv } from "./workflow-activation.js";

// FLY-222 #1: `no_code` is the terminal route for a runner-driven no-code /
// no-merge clean success (e.g. the scheduled learning Runner — reads, analyzes,
// creates issue drafts + memory, never writes code or merges). The Bridge maps
// it to terminal `completed` (NOT awaiting_review), so the runner doesn't get
// stuck and a fixed reusable trigger issue isn't 409-blocked next cadence.
// FLY-493: `pr_handoff` is the terminal route for a no-transport (antigravity)
// Runner that builds + opens a PR but cannot be woken to drive the founder-gated
// ship. The Bridge maps it to terminal `completed` (NOT awaiting_review, so no
// wake-dependent approve loop) while recording PR + `ready_to_merge` evidence;
// the founder ships the PR by hand. REQUIRES --pr, REJECTS --merged.
const VALID_ROUTES = new Set([
	"auto_approve",
	"needs_review",
	"blocked",
	"no_code",
	"pr_handoff",
	// FLY-793: three-stage Design phase completion (docs committed, no PR/merge).
	"phase_design_complete",
]);

const ATTEMPT_COUNT = 4;
const ATTEMPT_TIMEOUT_MS = 5000;
const BACKOFF_MS = [1000, 2000, 4000] as const;

type Evidence = {
	// FLY-493: `ready_to_merge` (pr_handoff) joins `merged` — a no-transport
	// Runner records PR evidence without a merge.
	landingStatus?: { status: "merged" | "ready_to_merge"; prNumber: number };
	commitCount: number;
	filesChangedCount: number;
	linesAdded: number;
	linesRemoved: number;
	diffSummary: string;
	changedFilePaths: string[];
	commitMessages: string[];
	/**
	 * FLY-191 Phase 2 (§5.5.2): the worktree HEAD at completion time. For
	 * route=needs_review this is the PR head the review request is bound to;
	 * the Bridge persists it as `sessions.pr_head_sha`, and `verify-approval`
	 * fail-closes unless the approval matches the runner's CURRENT head.
	 * Omitted (NOT defaulted) when git is unavailable — verify-approval treats
	 * a missing persisted sha as not-approved. Field name matches
	 * ExecutionEvidence.headSha (the in-process emitter path) so both /events
	 * producers stay field-aligned.
	 */
	headSha?: string;
};

type Payload = {
	decision: { route: string };
	evidence: Evidence;
	sessionRole: string;
	summary?: string;
	exitReason: string;
	issueIdentifier?: string;
	/**
	 * FLY-191 Phase 2 (Codex PR R1 CRITICAL): the CommDB question id from
	 * `gate approve_to_ship --no-block` — binds this review request to ONE
	 * exact question. The Bridge persists it as the session's
	 * review_question_id; verify-approval honors a response ONLY on it.
	 */
	reviewQuestionId?: string;
	/** FLY-1404: minted only after the CLI proves committed issue-scoped HTML. */
	designHtmlEvidence?: DesignHtmlEvidence;
	workflowActivation?: {
		activationId: string;
		runId: string;
		nodeId: string;
		attempt: number;
		turnEpoch: number;
	};
};

export interface CompleteOpts {
	route: string;
	pr?: number;
	merged: boolean;
	sessionRole?: string;
	summary?: string;
	exitReason?: string;
	baseRef?: string;
	/** FLY-191 Phase 2: questionId from `gate --no-block` (route=needs_review). */
	questionId?: string;
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
	// FLY-222 #1: no_code is a no-merge completion — reject contradictory flags
	// so a misuse can't silently look like a merged completion.
	// FLY-793: phase_design_complete is likewise a no-code/no-merge phase handoff.
	if (
		(opts.route === "no_code" || opts.route === "phase_design_complete") &&
		(opts.merged || opts.pr !== undefined)
	) {
		console.error(
			`--route ${opts.route} is for no-code/no-merge completions; do not pass --merged or --pr`,
		);
		process.exit(1);
	}
	// FLY-493: pr_handoff records an OPEN PR (no merge). PR evidence is mandatory
	// (the handoff is ambiguous without it); --merged is contradictory.
	if (opts.route === "pr_handoff") {
		// Codex code review R1: the CLI parses --pr via parseInt, so a missing
		// value or `--pr abc` yields NaN. NaN serializes to JSON `null`, which the
		// event sinks would still terminalize — reject any non-positive-integer PR
		// up front so a malformed handoff can never emit null PR evidence.
		if (
			opts.pr === undefined ||
			opts.pr === null ||
			!Number.isInteger(opts.pr) ||
			opts.pr <= 0
		) {
			console.error("--route pr_handoff requires --pr <positive integer>");
			process.exit(1);
		}
		if (opts.merged) {
			console.error(
				"--route pr_handoff is for an OPEN PR handed to the founder; do not pass --merged",
			);
			process.exit(1);
		}
	}

	const execId = requireEnv("FLYWHEEL_EXEC_ID");
	const issueId = requireEnv("FLYWHEEL_ISSUE_ID");
	const projectName = requireEnv("FLYWHEEL_PROJECT_NAME");
	const bridgeUrl = requireEnv("FLYWHEEL_BRIDGE_URL");
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	// FLY-1257 M1-c: marker presence is an explicit Codex capability signal.
	// Claude runners do not receive this env var and retain their prior behavior.
	// Marker files are runner-writable wake mirrors, not lifecycle authority:
	// query CommDB so deleting a marker cannot hide an unanswered gate.
	const gateMarkerDir = process.env.FLYWHEEL_GATE_MARKER_DIR?.trim();
	if (opts.route === "blocked" && gateMarkerDir) {
		const commDbPath = process.env.FLYWHEEL_COMM_DB?.trim();
		if (!commDbPath) {
			console.error(
				"[complete] FLYWHEEL_COMM_DB is required to prove Codex gate state; refusing route=blocked.",
			);
			process.exit(1);
		}
		let pendingGates: ReturnType<CommDB["getPendingGatesByRunner"]>;
		let db: CommDB | undefined;
		try {
			db = new CommDB(commDbPath, false);
			pendingGates = db.getPendingGatesByRunner(execId);
		} catch (error) {
			console.error(
				`[complete] cannot prove gate state from CommDB ${commDbPath}; refusing route=blocked. ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		} finally {
			db?.close();
		}
		const pending = pendingGates[0];
		if (pending) {
			console.error(
				`[complete] gate/review pending is not blocked; refusing route=blocked while ${pending.checkpoint} gate ${pending.id} is unanswered. Continue polling with flywheel-comm check ${pending.id}.`,
			);
			process.exit(1);
		}
	}

	const sessionRole = opts.sessionRole ?? "main";
	const exitReason = opts.exitReason ?? "completed";
	const baseRef = opts.baseRef ?? deriveBaseRef();
	const issueIdentifier = deriveIssueIdentifier();
	const evidence = collectEvidence({
		baseRef,
		merged: opts.merged,
		pr: opts.pr,
	});
	const designHtmlEvidence =
		opts.route === "phase_design_complete"
			? collectDesignHtmlEvidence({ baseRef, issueIdentifier, evidence })
			: undefined;
	// FLY-493: pr_handoff carries `ready_to_merge` landing evidence (the OPEN PR
	// the founder will ship). Fail-closed: if a land-status file is present
	// (FLYWHEEL_LAND_STATUS_PATH), its prNumber MUST match --pr — a mismatch is a
	// wiring bug, fail loud rather than completing with ambiguous evidence.
	if (opts.route === "pr_handoff" && opts.pr !== undefined) {
		validateLandStatusPr(opts.pr);
		evidence.landingStatus = { status: "ready_to_merge", prNumber: opts.pr };
	}
	const summary = opts.summary ?? evidence.commitMessages[0];
	const workflowActivation = currentWorkflowActivationFromEnv(execId);

	const payload: Payload = {
		decision: { route: opts.route },
		evidence,
		sessionRole,
		exitReason,
	};
	if (summary) payload.summary = summary;
	if (issueIdentifier) payload.issueIdentifier = issueIdentifier;
	if (designHtmlEvidence) payload.designHtmlEvidence = designHtmlEvidence;
	if (workflowActivation) {
		payload.workflowActivation = {
			activationId: workflowActivation.activation_id,
			runId: workflowActivation.run_id,
			nodeId: workflowActivation.node_id,
			attempt: workflowActivation.attempt,
			turnEpoch: workflowActivation.epoch,
		};
	}
	// FLY-191 Phase 2: only meaningful for review requests; pass through as-is
	// (Bridge validates + fail-closes on absence for needs_review).
	if (opts.questionId?.trim())
		payload.reviewQuestionId = opts.questionId.trim();
	// FLY-945 Fix C: re-opening review FROM approved_to_ship (an approval
	// expired because the head moved — verify-approval pr_head_sha mismatch)
	// REQUIRES a NEW --question-id (a fresh `gate approve_to_ship --no-block`).
	// Without one the Bridge treats this completion as the FLY-208 5a
	// evidence-gap terminal instead of a fresh review window. Warn loudly —
	// the CLI cannot see the session status, so this is advisory, not a guard.
	if (opts.route === "needs_review" && !opts.questionId?.trim()) {
		console.warn(
			"[complete] needs_review WITHOUT --question-id: if this session was " +
				"already approved_to_ship (re-review after a head move), the Bridge " +
				"will NOT re-open the review window — open a NEW " +
				"`gate approve_to_ship --no-block` and pass its questionId via " +
				"--question-id.",
		);
	}

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
	let attemptsMade = 0;
	for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
		attemptsMade = attempt;
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
			let response: Response;
			try {
				response = await fetch(`${bridgeUrl}/events`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timer);
			}
			if (response.ok) {
				console.log(
					`[complete] session_completed delivered (attempt ${attempt}/${ATTEMPT_COUNT})`,
				);
				return;
			}
			let responseText = "";
			let responseJson: Record<string, unknown> | undefined;
			try {
				responseText = (await response.text()).slice(0, 1000);
				const parsed = responseText ? JSON.parse(responseText) : undefined;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					responseJson = parsed as Record<string, unknown>;
				}
			} catch {
				// The status remains authoritative when the response is not JSON.
			}
			const detail =
				typeof responseJson?.reason === "string"
					? responseJson.reason
					: typeof responseJson?.error === "string"
						? responseJson.error
						: responseText.trim();
			lastError = `Bridge returned ${response.status}${detail ? `: ${detail}` : ""}`;
			console.error(
				`[complete] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
			if (
				response.status >= 400 &&
				response.status < 500 &&
				response.status !== 429 &&
				responseJson?.retryable !== true
			) {
				break;
			}
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
		attempts: attemptsMade,
		lastError,
	});
	const markerStatus = markerWritten
		? "Marker written."
		: "Marker NOT written (see above).";
	console.error(
		`[complete] FAIL-CLOSE: ${attemptsMade} attempts failed. ${markerStatus} Last error: ${lastError}`,
	);
	process.exit(1);
}

function collectDesignHtmlEvidence(args: {
	baseRef: string;
	issueIdentifier: string | undefined;
	evidence: Evidence;
}): DesignHtmlEvidence | undefined {
	if (process.env.FLYWHEEL_DESIGN_HTML_GATE === "0") {
		console.error(
			"[complete] design-HTML gate DISABLED via FLYWHEEL_DESIGN_HTML_GATE=0 — skipping founder design HTML validation; the Bridge process must also have FLYWHEEL_DESIGN_HTML_GATE=0 or it will reject this attestation-less completion",
		);
		return undefined;
	}
	const issueIdentifier = args.issueIdentifier;
	if (!issueIdentifier) {
		failDesignHtmlCompletion(
			"the current branch name does not contain a canonical issue token (for example feat-FLY-123)",
			undefined,
		);
	}
	const headSha = args.evidence.headSha;
	if (!headSha) {
		failDesignHtmlCompletion(
			"the committed HEAD SHA could not be proven",
			issueIdentifier,
		);
	}
	const range = `${args.baseRef}..${headSha}`;
	const changed = git([
		"diff",
		"--name-only",
		"--diff-filter=ACMR",
		range,
	]).trim();
	const candidates = findDesignHtmlPaths(
		changed ? changed.split("\n") : [],
		issueIdentifier,
	).filter((path) => gitObjectExists(headSha, path));
	if (candidates.length === 0) {
		failDesignHtmlCompletion(
			`no committed .html exists under doc/${issueIdentifier}-<slug>/ in ${range}`,
			issueIdentifier,
		);
	}
	return {
		version: 1,
		issueIdentifier,
		paths: candidates,
		headSha,
	};
}

function failDesignHtmlCompletion(
	reason: string,
	issueIdentifier: string | undefined,
): never {
	const issue = issueIdentifier ?? "<ISSUE-ID>";
	const project = process.env.FLYWHEEL_PROJECT_NAME ?? "<project>";
	const execId = process.env.FLYWHEEL_EXEC_ID ?? "<exec-id>";
	const lead = process.env.FLYWHEEL_LEAD_ID ?? "<lead-id>";
	console.error(
		`[complete] FLY-1404 founder design HTML is required before phase_design_complete: ${reason}.\n` +
			`Remediation: create doc/${issue}-<slug>/design.html with all five sections: ` +
			"① one-sentence summary ② core flow diagram/before-after ③ data and structure ④ key tradeoffs and rejected alternatives ⑤ honest boundaries (done/not done). " +
			"Commit and push the HTML, then publish without Discord delivery:\n" +
			`  node "$FLYWHEEL_COMM_CLI" publish-report --html <absolute-html-path> --project ${project} --publish-only\n` +
			"Report the hosted URL to the Lead (or publish-failed plus repo path):\n" +
			`  node "$FLYWHEEL_COMM_CLI" ask --lead ${lead} --exec-id ${execId} --report \"DESIGN-HTML ready: <hosted-url> | repo: <repo-path> | issue: ${issue}\"\n` +
			'Then re-run `node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete`. Emergency operator escape only: FLYWHEEL_DESIGN_HTML_GATE=0.',
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
	// Capture HEAD exactly once, before any diff/object reads. Every evidence
	// query below and the FLY-1404 HTML attestation use this immutable object id,
	// so a concurrent branch update cannot mix content from one commit with the
	// headSha of another.
	const parsedHeadSha = git(["rev-parse", "HEAD"]).trim().toLowerCase();
	const headSha = /^[0-9a-f]{40}$/.test(parsedHeadSha)
		? parsedHeadSha
		: undefined;
	const range = `${baseRef}..${headSha ?? "HEAD"}`;

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
	// FLY-191 Phase 2: bind this completion to the exact head being submitted
	// for review. Full sha only; on git failure leave the field absent
	// (verify-approval fail-closes on a missing persisted sha — never guess).
	if (headSha) {
		evidence.headSha = headSha;
	}
	if (merged && pr !== undefined) {
		evidence.landingStatus = { status: "merged", prNumber: pr };
	}
	return evidence;
}

/**
 * FLY-493: fail-closed validation that a present land-status file agrees with
 * the --pr passed to `complete --route pr_handoff`. If `FLYWHEEL_LAND_STATUS_PATH`
 * is unset or the file is absent, the --pr is the sole authority (no-op). If the
 * file is present and its `prNumber` disagrees with --pr, exit 1 (loud) rather
 * than emit ambiguous handoff evidence.
 */
function validateLandStatusPr(pr: number): void {
	const path = process.env.FLYWHEEL_LAND_STATUS_PATH?.trim();
	if (!path || !existsSync(path)) return;
	let filePr: unknown;
	try {
		filePr = JSON.parse(readFileSync(path, "utf8"))?.prNumber;
	} catch (err) {
		console.error(
			`[complete] pr_handoff: land-status file ${path} is unreadable/invalid JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		process.exit(1);
	}
	if (filePr !== pr) {
		console.error(
			`[complete] pr_handoff: land-status prNumber (${String(filePr)}) does not match --pr (${pr}). Refusing to emit ambiguous handoff evidence.`,
		);
		process.exit(1);
	}
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

/** True only when git proves that ref:path exists. Empty stdout is success. */
export function gitObjectExists(ref: string, path: string): boolean {
	try {
		execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
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
