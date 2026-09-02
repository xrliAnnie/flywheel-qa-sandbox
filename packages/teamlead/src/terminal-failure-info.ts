import type { TerminalFailureInfo } from "flywheel-core";

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
		(failureKind !== "goal_blocked" &&
			failureKind !== "worktree_takeover_failed" &&
			failureKind !== "reown_exhausted") ||
		!failureReason
	) {
		return undefined;
	}
	const classification = normalizeTerminalFailureClassification(failure);
	return {
		failureKind,
		failureReason,
		...(classification ?? {}),
	};
}
