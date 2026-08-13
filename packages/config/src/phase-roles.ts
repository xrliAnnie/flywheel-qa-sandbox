import type { ModelRuntimeVendor } from "./model-builtins.js";
import { type ModelTier, modelDisplayName } from "./model-tiers.js";
import {
	NODE_TYPE_REGISTRY,
	type WorkflowNodeTypeId,
} from "./node-type-registry.js";

export type WorkflowPhaseRole = "design" | "implement" | "qa";

/** Ordered shared-branch workflow roles. */
export const PHASE_ROLE_SEQUENCE: readonly WorkflowPhaseRole[] = [
	...Object.values(NODE_TYPE_REGISTRY)
		.filter((entry) => entry.isPhaseRole)
		.map((entry) => entry.id as WorkflowPhaseRole),
];

export function isWorkflowPhaseRole(
	role: string | null | undefined,
): role is WorkflowPhaseRole {
	return (
		role != null &&
		NODE_TYPE_REGISTRY[role as WorkflowNodeTypeId]?.isPhaseRole === true
	);
}

/** Preserve the immutable dispatch role when a completion payload says main. */
export function resolveCompletionSessionRole(
	existingRole: string | null | undefined,
	incomingRole: string | null | undefined,
): string {
	if (
		existingRole != null &&
		NODE_TYPE_REGISTRY[existingRole as WorkflowNodeTypeId]
			?.preserveCompletionRole === true
	) {
		return existingRole;
	}
	return incomingRole ?? "main";
}

/** Display-only fallback tiers retained for historical rows with unknown ids. */
export const DEFAULT_PHASE_TIER: Readonly<
	Record<WorkflowPhaseRole, ModelTier>
> = {
	design: "heavy",
	implement: "heavy",
	qa: "medium",
};

export type WorkflowDispatchVendor = ModelRuntimeVendor;
export type DesignBackend = WorkflowDispatchVendor;

export const DESIGN_BACKENDS = [
	"codex",
	"claude",
] as const satisfies readonly DesignBackend[];

export function isDesignBackend(value: unknown): value is DesignBackend {
	return DESIGN_BACKENDS.includes(value as DesignBackend);
}

export const PHASE_THREAD_BADGE_PARTS: Readonly<
	Record<WorkflowPhaseRole, { emoji: string; word: string }>
> = Object.fromEntries(
	PHASE_ROLE_SEQUENCE.map((role) => {
		const [emoji, ...word] = Array.from(NODE_TYPE_REGISTRY[role].badge);
		return [role, { emoji: emoji ?? "", word: word.join("") }];
	}),
) as Record<WorkflowPhaseRole, { emoji: string; word: string }>;

export const PHASE_THREAD_BADGE: Readonly<Record<WorkflowPhaseRole, string>> =
	Object.fromEntries(
		PHASE_ROLE_SEQUENCE.map((role) => [role, NODE_TYPE_REGISTRY[role].badge]),
	) as Record<WorkflowPhaseRole, string>;

export function phaseThreadBadge(role: string | null | undefined): string {
	return isWorkflowPhaseRole(role) ? NODE_TYPE_REGISTRY[role].badge : "";
}

const PHASE_MESSAGE_NAME: Readonly<Record<WorkflowPhaseRole, string>> = {
	design: "设计",
	implement: "实现",
	qa: "QA",
};

/**
 * Founder-facing role tag. Pending rows deliberately omit a model name rather
 * than reading a live global fallback that may differ from the run snapshot.
 */
export function phaseMessageTag(
	role: string | null | undefined,
	runnerModel: string | null | undefined,
	_designBackend?: DesignBackend | null,
): string {
	if (!isWorkflowPhaseRole(role)) return "";
	const name = PHASE_MESSAGE_NAME[role];
	const model = modelDisplayName(runnerModel);
	return model ? `[${name}·${model}] ` : `[${name}] `;
}
