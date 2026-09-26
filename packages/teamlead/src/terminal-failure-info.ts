import {
	CODEX_QUOTA_FAILURE_REASON,
	parseCodexQuotaSignalV1,
	type TerminalFailureInfo,
} from "flywheel-core";

export interface TerminalFailureClassification {
	failureClass: "environment";
	failureCode: "codex:unauthorized";
}

export function normalizeTerminalFailureClassification(input: {
	failureClass?: unknown;
	failureCode?: unknown;
}): TerminalFailureClassification | undefined {
	if (
		input.failureClass !== "environment" ||
		input.failureCode !== "codex:unauthorized"
	) {
		return undefined;
	}
	return {
		failureClass: "environment",
		failureCode: "codex:unauthorized",
	};
}

export function normalizeTerminalFailureInfo(
	value: unknown,
): TerminalFailureInfo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const failure = value as Record<string, unknown>;
	const failureKind =
		typeof failure.failureKind === "string" ? failure.failureKind : undefined;
	const failureReason =
		typeof failure.failureReason === "string"
			? failure.failureReason
			: undefined;
	if (
		(failureKind !== "goal_usage_limited" &&
			failureKind !== "goal_blocked" &&
			failureKind !== "codex_auth_pre_spawn_failed" &&
			failureKind !== "worktree_takeover_failed" &&
			failureKind !== "reown_exhausted") ||
		!failureReason
	) {
		return undefined;
	}
	if (failureKind === "codex_auth_pre_spawn_failed") {
		if (
			failure.failureCode !== "auth_preflight_failed" ||
			failure.failureClass !== undefined ||
			failure.quotaSignal !== undefined
		) {
			return undefined;
		}
		return {
			failureKind,
			failureCode: "auth_preflight_failed",
			failureReason,
		};
	}
	const quotaSignal = parseCodexQuotaSignalV1(failure.quotaSignal);
	if (
		failure.quotaSignal !== undefined &&
		(!quotaSignal || failureKind !== "goal_usage_limited")
	)
		return undefined;
	if (failureKind === "goal_usage_limited") {
		if (
			failureReason !== CODEX_QUOTA_FAILURE_REASON ||
			failure.failureClass !== undefined ||
			failure.failureCode !== undefined
		)
			return undefined;
		return {
			failureKind,
			failureReason,
			...(quotaSignal ? { quotaSignal } : {}),
		};
	}
	const classification = normalizeTerminalFailureClassification(failure);
	return {
		failureKind,
		failureReason,
		...(classification ?? {}),
	};
}
