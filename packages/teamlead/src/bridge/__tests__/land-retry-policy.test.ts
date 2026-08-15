import { describe, expect, it } from "vitest";
import {
	classifyLandRetryReason,
	nextLandRetry,
	normalizeLandLinearDoneReason,
} from "../land-retry-policy.js";

describe("land retry policy", () => {
	it.each([
		[undefined, "unknown"],
		[null, "unknown"],
		[42, "unknown"],
		[{}, "unknown"],
		["", "unknown"],
		["   \t\n", "unknown"],
	])("normalizes non-reasons (%j) to unknown", (reason, expected) => {
		expect(normalizeLandLinearDoneReason(reason)).toBe(expected);
	});

	it("bounds durable Linear Done reasons at 200 characters deterministically", () => {
		const prefix = "arbitration_failed:";
		const reason199 = `${prefix}${"x".repeat(199 - prefix.length)}`;
		const reason200 = `${prefix}${"x".repeat(200 - prefix.length)}`;
		const reason201 = `${prefix}${"x".repeat(201 - prefix.length)}`;

		expect(normalizeLandLinearDoneReason(reason199)).toBe(reason199);
		expect(normalizeLandLinearDoneReason(reason200)).toBe(reason200);
		const normalized = normalizeLandLinearDoneReason(reason201);
		expect(normalized).toHaveLength(200);
		expect(normalized.startsWith(prefix)).toBe(true);
		expect(normalizeLandLinearDoneReason(reason201)).toBe(normalized);
	});

	it.each([
		"ship_workflow_pending",
		"workflow_pr_manifest_partial:1; partial delivery must stay flag-off until all declared PRs merge",
		"founder_projection_pending",
		"founder_review_missing",
		"founder_review_not_passed",
		"founder_review_stale_artifact",
		"issue_closeout_incomplete",
		"founder_review_producer_ambiguous",
		"founder_review_artifact_binding_missing",
		"founder_review_authority_unavailable",
	])("classifies %s as waiting without spending retry budget", (reason) => {
		expect(classifyLandRetryReason(reason)).toBe("waiting");
	});

	it.each([
		"linear_lookup_failed_retryable",
		"arbitration_failed:linear timeout",
		"land_execution_error:github temporarily unavailable",
		"land_postconditions_incomplete:thread_archive",
		"workflow_pr_manifest_manifest_unavailable",
		"land_source_session_unavailable",
		"future_reason_not_yet_known",
	])("classifies %s as retryable", (reason) => {
		expect(classifyLandRetryReason(reason)).toBe("retryable");
	});

	it.each([
		"pr_head_mismatch",
		"pr_closed_unmerged",
		"ship_workflow_failed:tests failed",
		"cool_trigger_receipt_corrupt",
		"land_step_receipt_conflict",
		"land_execution_error:land_step_receipt_conflict",
	])("classifies %s as terminal", (reason) => {
		expect(classifyLandRetryReason(reason)).toBe("terminal");
	});

	it("backs retryable failures off through a bounded four-hour recovery window", () => {
		const epochKey = "3:cleanup_requested";
		const start = Date.parse("2026-08-14T20:00:00.000Z");
		let retryCount = 0;
		let retryEpochKey: string | null = null;
		const expectedDelays = [
			60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000, 3_600_000,
			7_200_000,
		];

		for (const delay of expectedDelays) {
			const now = new Date(start + retryCount * 1_000).toISOString();
			const result = nextLandRetry({
				classification: "retryable",
				reason: "linear_lookup_failed_retryable",
				now,
				epochKey,
				priorRetryCount: retryCount,
				priorRetryEpochKey: retryEpochKey,
			});
			expect(result).toMatchObject({
				state: "partial",
				retryCount: retryCount + 1,
				retryEpochKey: epochKey,
				lastError: "linear_lookup_failed_retryable",
			});
			expect(Date.parse(result.nextAttemptAt!)).toBe(Date.parse(now) + delay);
			retryCount = result.retryCount;
			retryEpochKey = result.retryEpochKey;
		}

		const exhausted = nextLandRetry({
			classification: "retryable",
			reason: "linear_lookup_failed_retryable",
			now: "2026-08-14T20:05:00.000Z",
			epochKey,
			priorRetryCount: retryCount,
			priorRetryEpochKey: retryEpochKey,
		});
		expect(exhausted).toMatchObject({
			state: "held",
			retryCount: 9,
			retryEpochKey: epochKey,
			nextAttemptAt: null,
		});
		expect(exhausted.lastError).toBe(
			"retry_exhausted:linear_lookup_failed_retryable",
		);
	});

	it("does not reset the budget when retryable reasons oscillate without durable progress", () => {
		const reasons = [
			"arbitration_failed:linear timeout",
			"land_execution_error:discord unavailable",
			"arbitration_failed:linear timeout",
			"land_execution_error:discord unavailable",
			"arbitration_failed:linear timeout",
			"land_execution_error:discord unavailable",
			"arbitration_failed:linear timeout",
			"land_execution_error:discord unavailable",
			"arbitration_failed:linear timeout",
		];
		let priorRetryCount = 0;
		let priorRetryEpochKey: string | null = null;

		const results = reasons.map((reason, index) => {
			const result = nextLandRetry({
				classification: classifyLandRetryReason(reason),
				reason,
				now: new Date(
					Date.parse("2026-08-14T21:00:00.000Z") + index,
				).toISOString(),
				epochKey: "4:cleanup_requested",
				priorRetryCount,
				priorRetryEpochKey,
			});
			priorRetryCount = result.retryCount;
			priorRetryEpochKey = result.retryEpochKey;
			return result;
		});

		expect(results.map((result) => result.retryCount)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9,
		]);
		expect(results.at(-1)?.state).toBe("held");
	});

	it("resets the budget only when the durable step epoch advances", () => {
		const result = nextLandRetry({
			classification: "retryable",
			reason: "issue_closeout_incomplete",
			now: "2026-08-14T22:00:00.000Z",
			epochKey: "5:finalization_partial",
			priorRetryCount: 4,
			priorRetryEpochKey: "4:cleanup_requested",
		});

		expect(result).toMatchObject({
			state: "partial",
			retryCount: 1,
			retryEpochKey: "5:finalization_partial",
			nextAttemptAt: "2026-08-14T22:01:00.000Z",
		});
	});

	it("keeps waiting and terminal dispositions out of retry accounting", () => {
		const waiting = nextLandRetry({
			classification: "waiting",
			reason: "ship_workflow_pending",
			now: "2026-08-14T23:00:00.000Z",
			epochKey: "2:cool_triggered",
			priorRetryCount: 2,
			priorRetryEpochKey: "1:authority_verified",
		});
		expect(waiting).toEqual({
			state: "partial",
			retryCount: 2,
			retryEpochKey: "1:authority_verified",
			nextAttemptAt: null,
			lastError: "ship_workflow_pending",
		});

		const terminal = nextLandRetry({
			classification: "terminal",
			reason: "pr_head_mismatch",
			now: "2026-08-14T23:00:00.000Z",
			epochKey: "2:cool_triggered",
			priorRetryCount: 2,
			priorRetryEpochKey: "1:authority_verified",
		});
		expect(terminal).toEqual({
			state: "held",
			retryCount: 2,
			retryEpochKey: "1:authority_verified",
			nextAttemptAt: null,
			lastError: "pr_head_mismatch",
		});
	});
});
