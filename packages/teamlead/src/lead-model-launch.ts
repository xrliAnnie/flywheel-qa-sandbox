import {
	getModelConfigSnapshot,
	type LeadLaunchSelection,
	type ModelConfigSnapshot,
	resolveLeadLaunchSelection,
} from "flywheel-config";
import { loadProjects } from "./ProjectConfig.js";

export interface LeadModelLaunchDecision extends LeadLaunchSelection {
	rawModel: string | null;
	rawEffort: string | null;
	configRevision: string;
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
	return {
		...resolveLeadLaunchSelection(
			rawModel ?? undefined,
			rawEffort ?? undefined,
			snapshot,
		),
		rawModel,
		rawEffort,
		configRevision: snapshot.revision,
	};
}
