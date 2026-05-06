/**
 * GEO-292: Stage reporting command — sends pipeline stage to Bridge via HTTP.
 * Fail-open: HTTP errors produce stderr warning but exit 0.
 *
 * FLY-60 W2 (a): when stage=completed, also attach a `landing_status`
 * object parsed from `${FLYWHEEL_LAND_STATUS_PATH}` (preferred) or
 * `${cwd}/.flywheel/runs/${FLYWHEEL_EXEC_ID}/land-status.json` (fallback)
 * to the event payload. Bridge's event-route reads this to decide
 * whether to fire `runPostShipFinalization` on the post-merge
 * re-finalize path. If the file doesn't exist or stage≠completed, no
 * payload addition (back-compat).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

interface LandingStatus {
	status?: string;
	prNumber?: number;
	mergeCommitSha?: string;
}

/**
 * Resolve the land-status.json path: env var first, cwd-derived fallback.
 * Returns null if neither resolves to an existing file.
 */
function resolveLandStatusPath(execId: string): string | null {
	const envPath = process.env.FLYWHEEL_LAND_STATUS_PATH;
	if (envPath && existsSync(envPath)) {
		return envPath;
	}
	const cwdDerived = resolvePath(
		process.cwd(),
		".flywheel",
		"runs",
		execId,
		"land-status.json",
	);
	if (existsSync(cwdDerived)) {
		return cwdDerived;
	}
	return null;
}

/**
 * Parse landing-status.json. Returns the parsed object or null if the file
 * doesn't exist / can't be read / is malformed (fail-open — stage event still
 * sends, just without `landing_status` in the payload).
 */
function readLandingStatus(execId: string): LandingStatus | null {
	try {
		const path = resolveLandStatusPath(execId);
		if (!path) return null;
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as LandingStatus;
		// Pick only the fields we need; ignore extras like mergedAt for
		// payload size + back-compat. Bridge predicate only checks `status`.
		return {
			status: parsed.status,
			prNumber: parsed.prNumber,
			mergeCommitSha: parsed.mergeCommitSha,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[stage] failed to parse land-status.json: ${msg}`);
		return null;
	}
}

const VALID_STAGES = new Set([
	"started",
	"brainstorm",
	"research",
	"plan",
	"design_review",
	"implement",
	"test",
	"code_review",
	"pr_created",
	"approve",
	"ship",
	"completed",
]);

const TIMEOUT_MS = 2000;

export async function stage(opts: {
	subcommand: string;
	stageName: string;
}): Promise<void> {
	if (opts.subcommand !== "set") {
		console.error(`Unknown stage subcommand: ${opts.subcommand}`);
		console.error("Usage: flywheel-comm stage set <stage>");
		process.exit(1);
	}

	if (!opts.stageName) {
		console.error("Stage name is required");
		console.error(`Valid stages: ${[...VALID_STAGES].join(", ")}`);
		process.exit(1);
	}

	if (!VALID_STAGES.has(opts.stageName)) {
		console.error(
			`Invalid stage: ${opts.stageName}. Valid stages: ${[...VALID_STAGES].join(", ")}`,
		);
		process.exit(1);
	}

	const execId = process.env.FLYWHEEL_EXEC_ID;
	const issueId = process.env.FLYWHEEL_ISSUE_ID;
	const projectName = process.env.FLYWHEEL_PROJECT_NAME;
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	if (!execId) {
		console.error("FLYWHEEL_EXEC_ID environment variable is required");
		process.exit(1);
	}
	if (!issueId) {
		console.error("FLYWHEEL_ISSUE_ID environment variable is required");
		process.exit(1);
	}
	if (!projectName) {
		console.error("FLYWHEEL_PROJECT_NAME environment variable is required");
		process.exit(1);
	}
	if (!bridgeUrl) {
		console.error("FLYWHEEL_BRIDGE_URL environment variable is required");
		process.exit(1);
	}

	// FLY-60 W2 (a): attach landing_status when stage=completed so Bridge
	// can fire post-ship finalization on the merge-proven event.
	const payload: { stage: string; landing_status?: LandingStatus } = {
		stage: opts.stageName,
	};
	if (opts.stageName === "completed") {
		const landingStatus = readLandingStatus(execId);
		if (landingStatus) {
			payload.landing_status = landingStatus;
		}
	}

	const body = {
		event_id: randomUUID(),
		execution_id: execId,
		issue_id: issueId,
		project_name: projectName,
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload,
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ingestToken) {
		headers.Authorization = `Bearer ${ingestToken}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${bridgeUrl}/events`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!response.ok) {
			console.error(
				`[flywheel-comm stage] Warning: Bridge returned ${response.status} — stage not recorded`,
			);
			return; // fail-open: exit 0
		}

		console.log(`Stage: ${opts.stageName}`);
	} catch (err) {
		clearTimeout(timeout);
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`[flywheel-comm stage] Warning: ${message} — stage not recorded`,
		);
		// fail-open: exit 0
	}
}
