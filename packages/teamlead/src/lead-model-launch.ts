import {
	getModelConfigSnapshot,
	type LeadLaunchSelection,
	type ModelConfigSnapshot,
	resolveAllowedEffort,
	resolveLeadLaunchSelection,
} from "flywheel-config";
import { type LeadAutoCompactBaseline, loadProjects } from "./ProjectConfig.js";

/**
 * FLY-583's companion-role fallback effort. The launcher applies it when
 * projects.json carries no effort override for a companion Lead.
 */
const COMPANION_FALLBACK_EFFORT = "xhigh";

export interface LeadModelLaunchDecision extends LeadLaunchSelection {
	autoCompactWindowTokens?: number;
	autoCompactBaseline?: LeadAutoCompactBaseline;
	rawModel: string | null;
	rawEffort: string | null;
	configRevision: string;
	/** Registry/API-backed window for this exact canonical id; null is unknown. */
	contextWindowTokens: number | null;
	/**
	 * FLY-1650: the FLY-583 companion fallback, narrowed to what the RESOLVED
	 * model actually accepts on the lead surface — `null` when it accepts none.
	 *
	 * The launcher used to hardcode `xhigh` here, which meant the shell could
	 * re-add the exact effort this resolver had just rejected. It cannot
	 * validate the pair itself (it has no registry), so the resolver reports
	 * the answer and the shell keeps only the policy decision of *when* to
	 * apply a fallback.
	 *
	 * Narrowing only: for every model that accepts `xhigh` this is the string
	 * `"xhigh"`, byte-identical to the previous hardcoded value.
	 */
	companionDefaultEffort: string | null;
}

export class LeadModelSourceError extends Error {
	readonly code = "MODEL_SOURCE_FAILURE";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LeadModelSourceError";
	}
}

/**
 * Resolve one physical Lead launch directly from the authoritative projects
 * source. The launcher calls this for every crash-loop iteration; manifests
 * are output evidence only and environment carriers have no model authority.
 */
export function resolveLeadModelLaunch(
	projectName: string,
	leadId: string,
	snapshot: ModelConfigSnapshot = getModelConfigSnapshot(),
): LeadModelLaunchDecision {
	let projects: ReturnType<typeof loadProjects>;
	try {
		projects = loadProjects();
	} catch (error) {
		throw new LeadModelSourceError(
			`model_config source failure: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	const project = projects.find(
		(candidate) => candidate.projectName === projectName,
	);
	if (!project) {
		throw new LeadModelSourceError(
			`model_config identity failure: project not found: ${projectName}`,
		);
	}
	const lead = project.leads.find((candidate) => candidate.agentId === leadId);
	if (!lead) {
		throw new LeadModelSourceError(
			`model_config identity failure: lead not found: ${projectName}/${leadId}`,
		);
	}
	const rawModel = lead.model?.trim() || null;
	const rawEffort = lead.effort?.trim() || null;
	const selection = resolveLeadLaunchSelection(
		rawModel ?? undefined,
		rawEffort ?? undefined,
		snapshot,
	);
	return {
		...selection,
		...(lead.autoCompactWindowTokens === undefined
			? {}
			: { autoCompactWindowTokens: lead.autoCompactWindowTokens }),
		...(lead.autoCompactBaseline === undefined
			? {}
			: { autoCompactBaseline: { ...lead.autoCompactBaseline } }),
		rawModel,
		rawEffort,
		configRevision: snapshot.revision,
		contextWindowTokens:
			snapshot.getModelRegistryEntry(selection.model)?.contextWindowTokens ??
			null,
		companionDefaultEffort: resolveAllowedEffort(
			selection.model,
			COMPANION_FALLBACK_EFFORT,
			{ surface: "lead", snapshot },
		),
	};
}

/** Missing or stale optimization evidence must never prevent a Lead launch. */
export function resolveLeadAutoCompactWindow(
	decision: LeadModelLaunchDecision,
	actual: Omit<
		LeadAutoCompactBaseline,
		"inputFloorTokens" | "inputFloorOffTokens"
	>,
): { windowTokens: number | null; reason: string } {
	const window = decision.autoCompactWindowTokens;
	const baseline = decision.autoCompactBaseline;
	if (window === undefined)
		return { windowTokens: null, reason: "not_configured" };
	if (!baseline) return { windowTokens: null, reason: "baseline_missing" };
	const floor = Math.max(
		baseline.inputFloorTokens,
		baseline.inputFloorOffTokens ?? NaN,
	);
	if (
		!Number.isSafeInteger(window) ||
		window < 400000 ||
		window > 1000000 ||
		!Number.isSafeInteger(baseline.inputFloorTokens) ||
		baseline.inputFloorTokens < 1 ||
		!Number.isSafeInteger(baseline.inputFloorOffTokens) ||
		(baseline.inputFloorOffTokens ?? 0) < 1 ||
		window < Math.max(2 * floor, floor + 200000)
	) {
		return { windowTokens: null, reason: "insufficient_working_room" };
	}
	if (
		decision.model !== actual.model ||
		(
			[
				"claudeVersion",
				"model",
				"rulesBodySha",
				"toolsConfigSha",
				"bootstrapPolicyVersion",
			] as const
		).some((key) => baseline[key] !== actual[key])
	) {
		return { windowTokens: null, reason: "baseline_mismatch" };
	}
	return { windowTokens: window, reason: "eligible" };
}
