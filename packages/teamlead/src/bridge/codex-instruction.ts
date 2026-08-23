/**
 * FLY-137 + FLY-827: shared Codex-review Runner-instruction builders + the
 * code-review inbox writer. Extracted from event-route so the SAME instruction
 * text + write path is reused by:
 *   - event-route `handleCodexAutoTrigger` (pr_created / design_review trigger)
 *   - neutral Codex review-hold re-queue (FLY-827: a runner that never ran /
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
	designBinding?: {
		requestId: string;
		reviewedPlanBlobSha: string;
	},
): string {
	if (reviewType === "design") {
		if (!planPath) {
			throw new Error(
				"design review instruction requires a concrete plan path",
			);
		}
		const target = planPath;
		const schemaTail = designBinding
			? [
					`codexThreadId:<string>, requestId:"${designBinding.requestId}",`,
					`reviewedPlanBlobSha:"${designBinding.reviewedPlanBlobSha}"}.`,
				]
			: [`codexThreadId:<string>}.`];
		const gateTail = designBinding
			? [
					`fail-closed and asks Bridge to verify the request id, path, committed`,
					`plan blob, session worktree, and clean Git state before it passes.`,
				]
			: [
					`fail-closed; it will block until the result file or a skip marker`,
					`appears.`,
				];
		return [
			`[FLY-137] Codex design review required for exec=${executionId}.`,
			`Run: /codex-design-review ${target}`,
			`Iterate on findings until Codex returns APPROVED. Write the approved`,
			`result to .flywheel/runs/${executionId}/codex/design-review.json with`,
			`schema {executionId, reviewType:"design", status:"APPROVED",`,
			`reviewedTarget:"${target}", timestamp:<ISO-8601>, rounds:<int>,`,
			...schemaTail,
			`Then call \`flywheel-comm await-codex-gate design --exec-id ${executionId}\``,
			`before \`flywheel-comm stage set implement\`. The gate command is`,
			...gateTail,
		].join(" ");
	}
	return [
		`[FLY-827] Codex code review is a HARD GATE for exec=${executionId} —`,
		`founder review and merge will be BLOCKED until it passes for the`,
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
 * FLY-1718 P3: one shared fail-closed response for absent, dirty, or otherwise
 * unbindable design plans. A placeholder path is never review authority.
 */
export function buildMissingDesignPlanInstruction(
	executionId: string,
	detail?: string,
): string {
	return [
		`[FLY-137] ERROR: design review plan could not be bound for exec=${executionId}.`,
		detail ? `Reason: ${detail}.` : "",
		`Re-run: \`flywheel-comm stage set design_review --plan <relative-path>\`.`,
		`The plan must exist at that path, be committed on the runner branch, and`,
		`have no staged, unstaged, or untracked changes. Commit plan current contents`,
		`and re-run review. Codex design review was NOT triggered; do not proceed`,
		`to implement.`,
	]
		.filter(Boolean)
		.join(" ");
}

/** FLY-1099 §3.3: result of a code-review instruction queue attempt. */
export interface QueueCodexInstructionResult {
	queued: boolean;
	/** true when a stable-id redelivery hit the sink dedup (already queued). */
	deduped?: boolean;
	error?: string;
}

/**
 * FLY-1099 §3.3 (Codex R1 #4/#7 + R3 #3): result-bearing code-review
 * instruction queue. DB errors are surfaced to the caller (the ledger drain
 * retries bounded), never swallowed. `instructionId` (when set, e.g. the
 * ledger's action_key) makes redelivery idempotent at the sink — a crash
 * between the CommDB write and the ledger's `delivered` mark cannot double-
 * queue /codex-code-review.
 */
export function queueCodexCodeReviewInstructionResult(
	projectName: string,
	executionId: string,
	opts: {
		instructionId?: string;
		logger?: { warn(m: string): void; log(m: string): void };
	} = {},
): QueueCodexInstructionResult {
	const logger = opts.logger ?? console;
	try {
		const dbPath = commDbPathForProject(projectName);
		mkdirSync(dirname(dbPath), { recursive: true });
		const commDb = new CommDB(dbPath);
		try {
			const content = buildCodexInstruction("code", undefined, executionId);
			if (opts.instructionId) {
				const inserted = commDb.insertInstructionWithId(
					opts.instructionId,
					"bridge",
					executionId,
					content,
				);
				logger.log(
					`[codex-gate] ${inserted ? "queued" : "dedup no-op for"} code review instruction ${opts.instructionId} → ${executionId}`,
				);
				return { queued: true, deduped: !inserted };
			}
			commDb.insertInstruction("bridge", executionId, content);
			logger.log(
				`[codex-gate] re-queued code review instruction for ${executionId}`,
			);
			return { queued: true };
		} finally {
			commDb.close();
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(
			`[codex-gate] failed to queue code review instruction for ${executionId}: ${message}`,
		);
		return { queued: false, error: message };
	}
}

/**
 * FLY-827: write the code-review instruction to a runner's CommDB inbox. Used by
 * the codex-hold re-queue (and mirrors event-route's happy-path write). Best-effort:
 * logs + swallows failures (never throws into the gate lifecycle). Legacy void
 * face — delegates to the result-bearing implementation above (FLY-1099 §3.3).
 */
export function queueCodexCodeReviewInstruction(
	projectName: string,
	executionId: string,
	logger: { warn(m: string): void; log(m: string): void } = console,
): void {
	queueCodexCodeReviewInstructionResult(projectName, executionId, { logger });
}
