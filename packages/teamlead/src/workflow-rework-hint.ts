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

interface WorkflowReworkTopology {
	manifest: {
		edges: readonly { from: string; to: string }[];
		loops: readonly { from: string; to: string }[];
	};
	resolved: {
		nodes: readonly {
			id: string;
			type: string;
			dispatch?: unknown;
		}[];
	};
}

export interface ResolvedFounderReworkRoute {
	semanticTarget: FounderReworkTarget;
	targetNodeId: string;
	invalidationScope: string[];
	verificationPolicy: FounderReworkVerificationStep[];
}

function semanticReworkTarget(value: string): FounderReworkTarget | undefined {
	return PREFIX_TARGETS[value.normalize("NFKC").trim().toLowerCase()];
}

/**
 * Interpret design/implement/qa (and their Chinese tokens) as semantic node
 * types inside the pinned snapshot. Other values remain exact custom node ids.
 */
export function resolveWorkflowReworkTarget(
	topology: WorkflowReworkTopology,
	requestedTarget: string,
): WorkflowReworkTopology["resolved"]["nodes"][number] {
	const normalized = requestedTarget.normalize("NFKC").trim();
	const semantic = semanticReworkTarget(normalized);
	const exact = topology.resolved.nodes.find(
		(node) => node.id === normalized && node.dispatch !== undefined,
	);
	if (!semantic) {
		if (!exact)
			throw new Error(`unknown workflow rework target: ${normalized}`);
		return exact;
	}
	const candidates = topology.resolved.nodes.filter(
		(node) => node.type === semantic && node.dispatch !== undefined,
	);
	// A historical custom graph can use a reserved word as an exact generic id.
	// Preserve that pin only when the semantic type is absent from the snapshot.
	if (candidates.length === 0 && exact) return exact;
	if (candidates.length === 0) {
		throw new Error(`missing semantic workflow rework target: ${semantic}`);
	}
	if (candidates.length !== 1) {
		throw new Error(`ambiguous semantic workflow rework target: ${semantic}`);
	}
	return candidates[0]!;
}

/** Resolve the physical target and downstream invalidation path from one pin. */
export function resolveFounderReworkRoute(
	topology: WorkflowReworkTopology,
	requestedTarget: string,
): ResolvedFounderReworkRoute {
	const semanticTarget = semanticReworkTarget(requestedTarget);
	if (!semanticTarget) {
		throw new Error(`unknown founder rework target: ${requestedTarget}`);
	}
	const target = resolveWorkflowReworkTarget(topology, semanticTarget);
	const reachable = new Set<string>();
	const pending = [target.id];
	while (pending.length > 0) {
		const current = pending.shift()!;
		if (reachable.has(current)) continue;
		const node = topology.resolved.nodes.find(
			(candidate) => candidate.id === current,
		);
		if (!node || node.dispatch === undefined) continue;
		reachable.add(current);
		for (const edge of topology.manifest.edges) {
			if (edge.from === current) pending.push(edge.to);
		}
	}
	const routeNodes = topology.resolved.nodes.filter((node) =>
		reachable.has(node.id),
	);
	const verificationPolicy: FounderReworkVerificationStep[] = [
		...(routeNodes.some((node) => node.type === "design")
			? (["design_review"] as const)
			: []),
		...(routeNodes.some(
			(node) => node.type === "implement" || node.type === "review",
		)
			? (["code_review"] as const)
			: []),
		...(routeNodes.some((node) => node.type === "qa")
			? (["qa_retest"] as const)
			: []),
		"founder_gate",
	];
	return {
		semanticTarget,
		targetNodeId: target.id,
		invalidationScope: routeNodes.map((node) => node.id),
		verificationPolicy,
	};
}

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
