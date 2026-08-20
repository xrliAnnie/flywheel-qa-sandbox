export type FounderReworkTarget = "design" | "implement" | "qa";

export type FounderReworkVerificationStep =
	| "design_review"
	| "code_review"
	| "qa_retest"
	| "founder_gate";

/**
 * Advisory server interpretation of immutable founder feedback. The feedback
 * text remains the authority; this value only selects the rework route.
 */
export interface FounderReworkHint {
	readonly target: FounderReworkTarget;
	readonly invalidationScope: FounderReworkTarget[];
	readonly verificationPolicy: FounderReworkVerificationStep[];
	readonly interpretedBy: string;
	readonly interpretationReason: string;
}

const ROUTES: Record<
	FounderReworkTarget,
	Pick<FounderReworkHint, "invalidationScope" | "verificationPolicy">
> = {
	design: {
		invalidationScope: ["design", "implement", "qa"],
		verificationPolicy: [
			"design_review",
			"code_review",
			"qa_retest",
			"founder_gate",
		],
	},
	implement: {
		invalidationScope: ["implement", "qa"],
		verificationPolicy: ["code_review", "qa_retest", "founder_gate"],
	},
	qa: {
		invalidationScope: ["qa"],
		verificationPolicy: ["qa_retest", "founder_gate"],
	},
};

export function makeFounderReworkHint(
	target: FounderReworkTarget,
	interpretedBy: string,
	interpretationReason: string,
): FounderReworkHint {
	const route = ROUTES[target];
	return {
		target,
		invalidationScope: [...route.invalidationScope],
		verificationPolicy: [...route.verificationPolicy],
		interpretedBy,
		interpretationReason,
	};
}

const PREFIX_TARGETS: Record<string, FounderReworkTarget> = {
	design: "design",
	implement: "implement",
	qa: "qa",
	设计: "design",
	实现: "implement",
	测试: "qa",
};

export function parseFounderReworkPrefix(
	content: string,
): { target: FounderReworkTarget; prefix: string } | undefined {
	const match = content.match(
		/^\s*(design|implement|qa|设计|实现|测试)\s*[:：]/i,
	);
	if (!match?.[1]) return undefined;
	const prefix = match[1];
	const target = PREFIX_TARGETS[prefix.toLowerCase()];
	return target ? { target, prefix } : undefined;
}

/**
 * Fixed founder card protocol. Free thread speech never calls these helpers;
 * they are only for a Discord action already anchored to the current card.
 */
export function normalizeFounderCardProtocolText(content: string): string {
	return (
		content
			.normalize("NFKC")
			.trim()
			.toLowerCase()
			// A question mark preserves the message as a question, never a verdict.
			.replace(/[。.!！]+$/u, "")
			.trim()
	);
}

export function isFixedFounderCardApproval(content: string): boolean {
	return new Set(["approve", "look good to me"]).has(
		normalizeFounderCardProtocolText(content),
	);
}

export function isExplicitFounderKickback(content: string): boolean {
	return (
		normalizeFounderCardProtocolText(content) === "打回" ||
		parseFounderReworkPrefix(content) !== undefined
	);
}

export function isFounderReworkTarget(
	value: unknown,
): value is FounderReworkTarget {
	return value === "design" || value === "implement" || value === "qa";
}

const sameSequence = (left: unknown, right: readonly string[]): boolean =>
	Array.isArray(left) &&
	left.length === right.length &&
	left.every((value, index) => value === right[index]);

export function parseFounderReworkHint(
	value: unknown,
): FounderReworkHint | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (!isFounderReworkTarget(candidate.target)) return undefined;
	const expected = ROUTES[candidate.target];
	if (
		!sameSequence(candidate.invalidationScope, expected.invalidationScope) ||
		!sameSequence(candidate.verificationPolicy, expected.verificationPolicy) ||
		typeof candidate.interpretedBy !== "string" ||
		!candidate.interpretedBy.trim() ||
		typeof candidate.interpretationReason !== "string" ||
		!candidate.interpretationReason.trim()
	) {
		return undefined;
	}
	return {
		target: candidate.target,
		invalidationScope: [...expected.invalidationScope],
		verificationPolicy: [...expected.verificationPolicy],
		interpretedBy: candidate.interpretedBy,
		interpretationReason: candidate.interpretationReason,
	};
}
