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
import { isAbsolute, resolve as resolvePath } from "node:path";
import { normalizeOptionalBearer } from "flywheel-config";

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

// FLY-137 v1.27.2: must stay in sync with packages/teamlead/src/bridge/stage-utils.ts
// (Bridge-side VALID_STAGES). `onboard` inserted between `started` and `brainstorm`.
const VALID_STAGES = new Set([
	"started",
	"onboard",
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

/**
 * FLY-137 Phase 5: validate `--plan <relative-path>` against worktree.
 * Must be a relative path with no `..` traversal that resolves inside the
 * worktree. Returns the validated relative path on success, or exits 1
 * with diagnostic on failure (fail-closed — bad plan_path is a Runner
 * protocol violation, not a soft warning).
 */
function validatePlanPath(planPath: string, worktreeRoot: string): string {
	if (isAbsolute(planPath)) {
		console.error(`--plan must be a relative path (got absolute: ${planPath})`);
		process.exit(1);
	}
	if (planPath.split("/").some((seg) => seg === "..")) {
		console.error(`--plan must not contain '..' segments (got: ${planPath})`);
		process.exit(1);
	}
	const resolved = resolvePath(worktreeRoot, planPath);
	if (!resolved.startsWith(`${worktreeRoot}/`) && resolved !== worktreeRoot) {
		console.error(
			`--plan resolved path escapes worktree: ${resolved} (worktree=${worktreeRoot})`,
		);
		process.exit(1);
	}
	return planPath;
}

export async function stage(opts: {
	subcommand: string;
	stageName: string;
	planPath?: string;
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

	// FLY-137 Phase 5: `--plan` is only meaningful for design_review.
	// Reject quietly elsewhere to surface Runner mistakes.
	if (opts.planPath !== undefined && opts.stageName !== "design_review") {
		console.error(
			`--plan flag is only valid for stage=design_review (got stage=${opts.stageName})`,
		);
		process.exit(1);
	}

	const execId = process.env.FLYWHEEL_EXEC_ID;
	const issueId = process.env.FLYWHEEL_ISSUE_ID;
	const projectName = process.env.FLYWHEEL_PROJECT_NAME;
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
	const ingestToken = normalizeOptionalBearer(
		process.env.FLYWHEEL_INGEST_TOKEN,
	);

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
	// FLY-137 Phase 5: attach plan_path when stage=design_review so Bridge
	// can persist it on the session row and reference it in the Codex
	// auto-trigger instruction.
	const payload: {
		stage: string;
		landing_status?: LandingStatus;
		plan_path?: string;
	} = {
		stage: opts.stageName,
	};
	if (opts.stageName === "completed") {
		const landingStatus = readLandingStatus(execId);
		if (landingStatus) {
			payload.landing_status = landingStatus;
		}
	}
	if (opts.stageName === "design_review" && opts.planPath !== undefined) {
		payload.plan_path = validatePlanPath(opts.planPath, process.cwd());
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
		} else {
			console.log(`Stage: ${opts.stageName}`);
		}
	} catch (err) {
		clearTimeout(timeout);
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`[flywheel-comm stage] Warning: ${message} — stage not recorded`,
		);
	}
}
