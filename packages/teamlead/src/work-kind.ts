import { workflowRegistryShapes } from "flywheel-config";

/** FLY-1436: dispatch validation aliases the menu binding SSOT. */
export const WORK_KIND_CATEGORIES = workflowRegistryShapes();
export type WorkKindCategory = string;

/**
 * Read-only decoder vocabulary for snapshots sealed before the FLY-2121
 * category cutover. Keep this separate from WORK_KIND_CATEGORIES so retired
 * names can be read but can never admit or route new work.
 */
export const WORKFLOW_SNAPSHOT_TASK_CATEGORIES = [
	...WORK_KIND_CATEGORIES,
	"design",
] as const;
export type WorkflowMenuShapeId = string;

export const ENG_TIERS = ["trivial", "light", "heavy"] as const;
export type EngTier = (typeof ENG_TIERS)[number];
export const DEFAULT_ENG_TIER: EngTier = "heavy";

/** Historical label retained as the explicit single-session routing override. */
export const LEGACY_ROUTING_OVERRIDE_LABEL = "no-three-stage";
export const ROUTING_OVERRIDES_ALLOWLIST = [
	LEGACY_ROUTING_OVERRIDE_LABEL,
] as const;
export type RoutingOverride = (typeof ROUTING_OVERRIDES_ALLOWLIST)[number];

export type CanonicalRoutingOverrides =
	| { status: "valid"; overrides: RoutingOverride[] }
	| { status: "invalid"; reason: "not_array" | "unknown_override" };

export function canonicalizeRoutingOverrides(
	raw: unknown,
): CanonicalRoutingOverrides {
	if (raw == null) return { status: "valid", overrides: [] };
	if (!Array.isArray(raw)) {
		return { status: "invalid", reason: "not_array" };
	}
	if (
		raw.some(
			(value) =>
				typeof value !== "string" ||
				!ROUTING_OVERRIDES_ALLOWLIST.includes(value as RoutingOverride),
		)
	) {
		return { status: "invalid", reason: "unknown_override" };
	}
	return {
		status: "valid",
		overrides: [...new Set(raw as RoutingOverride[])],
	};
}

export const CATEGORY_SOURCES = [
	"task_category",
	"template_override",
	"default_fallback",
] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

export type WorkflowRouteVisibility =
	| {
			route: "workflow_v2" | "pipeline_dag_v1";
			category: string | null;
			source: CategorySource;
			tier?: EngTier;
	  }
	| {
			route: "bypass_override" | "generic_fallback";
			override?: RoutingOverride;
			source?: "default_fallback";
	  };

/** Founder-facing route line shared by thread root, channel broadcast, and pin. */
export function formatWorkflowRouteVisibility(
	input: WorkflowRouteVisibility,
): string {
	if (input.route === "generic_fallback") {
		return "🧭 **Route**: `generic` · source `default_fallback`";
	}
	if (input.route === "bypass_override") {
		return "🧭 **Route**: `generic` · override `no-three-stage`";
	}
	if ("category" in input) {
		const category = input.category ?? "template";
		return [
			`🧭 **Route**: \`${category}\` → \`${input.route}\``,
			...(input.tier ? [`tier \`${input.tier}\``] : []),
			`source \`${input.source}\``,
		].join(" · ");
	}
	throw new Error("unknown workflow route visibility");
}

/** Audit-only suggestions. These values never participate in selection. */
export const DEPT_SUGGESTED_CATEGORY: Readonly<
	Record<string, WorkKindCategory>
> = Object.freeze({
	product: "prd",
	engineering: "code",
});

export type CanonicalWorkKind =
	| { status: "absent" }
	| { status: "valid"; category: WorkKindCategory }
	| {
			status: "invalid";
			reason: "not_string" | "unknown_category";
	  };

export function canonicalizeWorkKind(raw: unknown): CanonicalWorkKind {
	if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
		return { status: "absent" };
	}
	if (typeof raw !== "string") {
		return { status: "invalid", reason: "not_string" };
	}
	const category = raw.trim().toLowerCase();
	return WORK_KIND_CATEGORIES.includes(category as WorkKindCategory)
		? { status: "valid", category: category as WorkKindCategory }
		: { status: "invalid", reason: "unknown_category" };
}

export type CanonicalEngTier =
	| { status: "absent" }
	| { status: "valid"; tier: EngTier }
	| { status: "invalid"; reason: "not_string" | "unknown_tier" };

export function canonicalizeEngTier(raw: unknown): CanonicalEngTier {
	if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
		return { status: "absent" };
	}
	if (typeof raw !== "string") {
		return { status: "invalid", reason: "not_string" };
	}
	const tier = raw.trim().toLowerCase();
	return ENG_TIERS.includes(tier as EngTier)
		? { status: "valid", tier: tier as EngTier }
		: { status: "invalid", reason: "unknown_tier" };
}

export interface WorkflowSelectionDigestBase {
	project: string;
	issueId: string;
	category: string;
	templateId: string;
	revision: number;
	selectionSource: "lead" | "binding" | "default";
	selectedBy: string;
	reason: string;
}

/**
 * Shared by initial selection, shadow re-read, and materialization TOCTOU
 * verification. Omitting workKind preserves the pre-FLY-1407 body exactly.
 */
export function buildWorkflowSelectionDigestBody(
	base: WorkflowSelectionDigestBase,
	workKind?: { categorySource: CategorySource; tier?: EngTier },
): WorkflowSelectionDigestBase & {
	categorySource?: CategorySource;
	tier?: EngTier;
} {
	return workKind
		? {
				...base,
				categorySource: workKind.categorySource,
				...(workKind.tier ? { tier: workKind.tier } : {}),
			}
		: base;
}
