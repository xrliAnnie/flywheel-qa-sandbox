export type LandRetryClassification = "waiting" | "retryable" | "terminal";

export interface LandRetryInput {
	classification: LandRetryClassification;
	reason: string;
	now: string;
	epochKey: string;
	priorRetryCount: number;
	priorRetryEpochKey: string | null;
}

export interface LandRetryDecision {
	state: "partial" | "held";
	retryCount: number;
	retryEpochKey: string | null;
	nextAttemptAt: string | null;
	lastError: string;
}

const WAITING_REASONS = new Set([
	"ship_workflow_pending",
	"founder_projection_pending",
	"founder_review_missing",
	"founder_review_not_passed",
	"founder_review_stale_artifact",
]);

const TERMINAL_REASONS = new Set([
	"pr_head_mismatch",
	"pr_closed_unmerged",
	"cool_trigger_receipt_corrupt",
	"land_step_receipt_conflict",
]);

export const SHIP_WORKFLOW_RETRYABLE_FAILURES = new Set([
	"await_ci_timeout",
	"merge_405_required_check",
	"run_cancelled",
	"run_timed_out",
]);

const RETRY_DELAYS_MS = [
	60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
] as const;
const RETRY_EXHAUSTED_PREFIX = "retry_exhausted:";
const MAX_LAND_ERROR_LENGTH = 500;
const MAX_LINEAR_DONE_REASON_LENGTH = 200;

export function normalizeLandLinearDoneReason(reason: unknown): string {
	if (typeof reason !== "string" || reason.trim().length === 0) {
		return "unknown";
	}
	return reason.slice(0, MAX_LINEAR_DONE_REASON_LENGTH);
}

export function classifyLandRetryReason(
	reason: string,
): LandRetryClassification {
	const unwrapped = reason.startsWith("land_execution_error:")
		? reason.slice("land_execution_error:".length)
		: reason;
	if (
		WAITING_REASONS.has(reason) ||
		reason.startsWith("workflow_pr_manifest_partial:")
	) {
		return "waiting";
	}
	if (unwrapped.startsWith("ship_workflow_failed:")) {
		const failure = unwrapped.slice("ship_workflow_failed:".length);
		return SHIP_WORKFLOW_RETRYABLE_FAILURES.has(failure)
			? "retryable"
			: "terminal";
	}
	if (TERMINAL_REASONS.has(unwrapped)) {
		return "terminal";
	}
	return "retryable";
}

function exhaustedReason(reason: string): string {
	return `${RETRY_EXHAUSTED_PREFIX}${reason.slice(
		0,
		MAX_LAND_ERROR_LENGTH - RETRY_EXHAUSTED_PREFIX.length,
	)}`;
}

export function nextLandRetry(input: LandRetryInput): LandRetryDecision {
	if (input.classification !== "retryable") {
		return {
			state: input.classification === "terminal" ? "held" : "partial",
			retryCount: input.priorRetryCount,
			retryEpochKey: input.priorRetryEpochKey,
			nextAttemptAt: null,
			lastError: input.reason,
		};
	}

	const sameEpoch = input.priorRetryEpochKey === input.epochKey;
	const retryCount = (sameEpoch ? input.priorRetryCount : 0) + 1;
	if (retryCount > RETRY_DELAYS_MS.length) {
		return {
			state: "held",
			retryCount,
			retryEpochKey: input.epochKey,
			nextAttemptAt: null,
			lastError: exhaustedReason(input.reason),
		};
	}
	const delayMs = RETRY_DELAYS_MS[retryCount - 1];
	if (delayMs === undefined) {
		throw new Error("land_retry_delay_missing");
	}

	return {
		state: "partial",
		retryCount,
		retryEpochKey: input.epochKey,
		nextAttemptAt: new Date(Date.parse(input.now) + delayMs).toISOString(),
		lastError: input.reason,
	};
}
