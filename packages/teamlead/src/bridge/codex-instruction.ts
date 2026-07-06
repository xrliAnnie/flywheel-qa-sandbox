/**
 * FLY-137 + FLY-827: shared Codex-review Runner-instruction builders + the
 * code-review inbox writer. Extracted from event-route so the SAME instruction
 * text + write path is reused by:
 *   - event-route `handleCodexAutoTrigger` (pr_created / design_review trigger)
 *   - AutoQaCoordinator codex-hold re-queue (FLY-827: a runner that never ran /
 *     never reported Codex gets the instruction re-sent — D3 loop closure).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { commDbPathForProject } from "./commdb-path.js";

/**
 * Resolve the review type from a stage transition target.
 * - `design_review` → "design"
 * - `pr_created`    → "code"
 * - anything else   → null (no auto-trigger)
 */
export function codexReviewTypeFor(stage: string): "design" | "code" | null {
	if (stage === "design_review") return "design";
	if (stage === "pr_created") return "code";
	return null;
}

/**
 * Build the Runner-targeted instruction text for design/code review.
 *
 * FLY-827: the CODE-review schema now requires `reviewedHeadSha` (the commit
 * Codex actually reviewed). `await-codex-gate code` verifies it equals the local
 * `git rev-parse HEAD` (fail-closed on mismatch) — so a stale review file can't
 * approve a new head — and reports the verdict to the Bridge automatically (no
 * extra runner command needed).
 */
export function buildCodexInstruction(
	reviewType: "design" | "code",
	planPath: string | undefined,
	executionId: string,
): string {
	if (reviewType === "design") {
		const target =
			planPath ?? "<MISSING — re-run stage set design_review --plan <path>>";
		return [
			`[FLY-137] Codex design review required for exec=${executionId}.`,
			`Run: /codex-design-review ${target}`,
			`Iterate on findings until Codex returns APPROVED. Write the approved`,
			`result to .flywheel/runs/${executionId}/codex/design-review.json with`,
			`schema {executionId, reviewType:"design", status:"APPROVED",`,
			`reviewedTarget:"${target}", timestamp:<ISO-8601>, rounds:<int>,`,
			`codexThreadId:<string>}.`,
			`Then call \`flywheel-comm await-codex-gate design --exec-id ${executionId}\``,
			`before \`flywheel-comm stage set implement\`. The gate command is`,
			`fail-closed; it will block until the result file or a skip marker`,
			`appears.`,
		].join(" ");
	}
	return [
		`[FLY-827] Codex code review is a HARD GATE for exec=${executionId} —`,
		`auto-QA will NOT start and merge will be BLOCKED until it passes for the`,
		`current PR head. Run: /codex-code-review`,
		`Iterate on findings until Codex returns APPROVED. Write the approved`,
		`result to .flywheel/runs/${executionId}/codex/code-review.json with`,
		`schema {executionId, reviewType:"code", status:"APPROVED",`,
		`reviewedTarget:"<pr-url>", reviewedHeadSha:"<git rev-parse HEAD at review`,
		`time, 40-hex>", timestamp:<ISO-8601>, rounds:<int>, codexThreadId:<string>}.`,
		`Then call \`flywheel-comm await-codex-gate code --exec-id ${executionId}\``,
		`before \`flywheel-comm stage set approve\`. The gate verifies reviewedHeadSha`,
		`=== current HEAD (fail-closed) and reports the APPROVED verdict to the`,
		`Bridge for you — you do NOT need a separate command. If you added commits`,
		`after the review, re-run /codex-code-review for the new head.`,
	].join(" ");
}

/**
 * FLY-827: write the code-review instruction to a runner's CommDB inbox. Used by
 * the codex-hold re-queue (and mirrors event-route's happy-path write). Best-effort:
 * logs + swallows failures (never throws into the gate lifecycle).
 */
export function queueCodexCodeReviewInstruction(
	projectName: string,
	executionId: string,
	logger: { warn(m: string): void; log(m: string): void } = console,
): void {
	try {
		const dbPath = commDbPathForProject(projectName);
		mkdirSync(dirname(dbPath), { recursive: true });
		const commDb = new CommDB(dbPath);
		try {
			commDb.insertInstruction(
				"bridge",
				executionId,
				buildCodexInstruction("code", undefined, executionId),
			);
			logger.log(
				`[codex-gate] re-queued code review instruction for ${executionId}`,
			);
		} finally {
			commDb.close();
		}
	} catch (err) {
		logger.warn(
			`[codex-gate] failed to queue code review instruction for ${executionId}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}
