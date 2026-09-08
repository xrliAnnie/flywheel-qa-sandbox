// FLY-2383: the run manifest, and the rule that a run can only lose its VALID.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIN_MAIN_RUN_DURATION_MS } from "./constants.mjs";

// Single definition, shared with the report so the two cannot drift apart.
export { MIN_MAIN_RUN_DURATION_MS } from "./constants.mjs";

/**
 * Verdict resolution. Anything that went wrong — a guard, a premature exit, a
 * stalled downlink, a cleanup that would not converge, a run that did not reach
 * half an hour on the monotonic clock — downgrades the run. Nothing upgrades it.
 *
 * This is why the final manifest is written after the post-cleanup census: a
 * cleanup failure discovered late must still be able to overwrite an earlier
 * VALID.
 */
export function resolveVerdict(input) {
	const reasons = [];
	if (input.guardViolation) {
		reasons.push(`guard:${input.guardViolation.reason}`);
	}
	if (input.childExitedEarly) reasons.push("child_exited_early");
	if (input.downlinkStalled) reasons.push("downlink_stalled");
	if (input.clockAnomaly) reasons.push("clock_anomaly");
	if (input.excessiveHoles) {
		reasons.push(`excessive_holes:${input.excessiveHoles.holes}`);
	}
	if (input.instrumentFail) reasons.push("instrument_fail");
	for (const error of input.cleanupErrors ?? []) {
		reasons.push(`cleanup:${error}`);
	}
	if (
		input.requireMinDuration &&
		!(input.monotonicDurationMs >= MIN_MAIN_RUN_DURATION_MS)
	) {
		reasons.push("below_min_duration");
	}
	return {
		verdict: reasons.length === 0 ? "VALID" : "INVALID",
		reasons,
	};
}

/**
 * A run can satisfy the three PRD conditions only when all three hold at once.
 * Missing the orchestration overlap does not void the observation — it just
 * means the third condition is still open and must not be reported as closed.
 */
export function resolveThreeConditions(input) {
	const conditions = {
		realAgentTurnDuringVoice: input.completedTurns > 0,
		halfHourScale: input.monotonicDurationMs >= MIN_MAIN_RUN_DURATION_MS,
		realOrchestrationInFlight: input.qualifyingOverlap === true,
	};
	const missing = Object.entries(conditions)
		.filter(([, satisfied]) => !satisfied)
		.map(([name]) => name);
	return { conditions, allSatisfied: missing.length === 0, missing };
}

export function sha256File(readFileSync, path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function atomicWriteJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(
		dirname(path),
		`.${process.pid}.${Date.now()}.manifest.tmp`,
	);
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	renameSync(temporary, path);
	return path;
}
