/**
 * FLY-222: routing-tuple validation for a scheduled-learning collection
 * (plan §Phase 2 / Codex R2 #6).
 *
 * The scheduler must NOT spawn a learning Runner — nor create its trigger issue
 * — unless the collection's `(lead_id, department_label, target_linear_project)`
 * tuple is coherent against the live project roster. This validates the parts
 * resolvable WITHOUT a network call:
 *   1. the project entry exists,
 *   2. `lead_id` names a Lead in that project that CAN spawn Runners,
 *   3. `department_label` routes UNIQUELY to that same `lead_id`.
 *
 * The Linear-side resolution (team key + `target_linear_project` name +
 * `department_label` → labelId) is a network concern left to the create-issue
 * call, which already errors loudly on an unknown team/project/label. On a
 * failure here the scheduler skips THIS collection with a bounded alert — it is
 * not a process-fatal throw (one misconfigured collection must not wedge the
 * others).
 */

import type { LeadConfig, ProjectEntry } from "./ProjectConfig.js";

export type RoutingTupleReason =
	| "project_not_found"
	| "lead_not_found"
	| "lead_cannot_spawn"
	| "label_routes_to_no_lead"
	| "label_routes_to_other_lead"
	| "label_ambiguous";

export type RoutingTupleResult =
	| { valid: true }
	| { valid: false; reason: RoutingTupleReason; detail: string };

export interface LearningRoutingTuple {
	leadId: string;
	departmentLabel: string;
}

/** Leads whose `match.labels` include `label` (case-insensitive). */
function leadsMatchingLabel(leads: LeadConfig[], label: string): LeadConfig[] {
	const want = label.trim().toLowerCase();
	return leads.filter((l) =>
		(l.match?.labels ?? []).some((x) => x.trim().toLowerCase() === want),
	);
}

/**
 * Validate the static (non-network) part of a learning collection's routing
 * tuple. Pure.
 */
export function validateLearningRoutingTuple(
	projects: ProjectEntry[],
	projectName: string,
	tuple: LearningRoutingTuple,
): RoutingTupleResult {
	const project = projects.find((p) => p.projectName === projectName);
	if (!project) {
		return {
			valid: false,
			reason: "project_not_found",
			detail: `project "${projectName}" is not in the roster`,
		};
	}

	const leads = project.leads ?? [];
	const lead = leads.find((l) => l.agentId === tuple.leadId);
	if (!lead) {
		return {
			valid: false,
			reason: "lead_not_found",
			detail: `lead_id "${tuple.leadId}" is not a Lead of "${projectName}"`,
		};
	}
	// canSpawnRunners defaults to true; only an explicit `false` blocks spawning.
	if (lead.canSpawnRunners === false) {
		return {
			valid: false,
			reason: "lead_cannot_spawn",
			detail: `lead "${tuple.leadId}" has canSpawnRunners: false`,
		};
	}

	const matching = leadsMatchingLabel(leads, tuple.departmentLabel);
	if (matching.length > 1) {
		return {
			valid: false,
			reason: "label_ambiguous",
			detail: `department_label "${tuple.departmentLabel}" routes to multiple Leads (${matching
				.map((l) => l.agentId)
				.join(", ")}) — trigger-issue routing would be ambiguous`,
		};
	}
	const [only] = matching;
	if (!only) {
		return {
			valid: false,
			reason: "label_routes_to_no_lead",
			detail: `department_label "${tuple.departmentLabel}" matches no Lead's match.labels in "${projectName}"`,
		};
	}
	if (only.agentId !== tuple.leadId) {
		return {
			valid: false,
			reason: "label_routes_to_other_lead",
			detail: `department_label "${tuple.departmentLabel}" routes to "${only.agentId}", not the configured lead_id "${tuple.leadId}"`,
		};
	}

	return { valid: true };
}
