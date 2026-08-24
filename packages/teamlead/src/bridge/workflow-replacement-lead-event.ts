import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type {
	StateStore,
	WorkflowReplacementLeadIntent,
	WorkflowRunRow,
} from "../StateStore.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
import type {
	DurableQueueReceipt,
	RuntimeRegistry,
} from "./runtime-registry.js";

export function resolveWorkflowReplacementLeadIntent(input: {
	projects: ProjectEntry[];
	run: WorkflowRunRow;
	labels: string[];
}): WorkflowReplacementLeadIntent | undefined {
	const project = input.projects.find(
		(candidate) => candidate.projectName === input.run.project_name,
	);
	if (!project || project.leads.length === 0) return undefined;
	const selected = input.run.selected_by
		? project.leads.find((lead) => lead.agentId === input.run.selected_by)
		: undefined;
	if (selected) {
		return {
			leadId: selected.agentId,
			projectName: project.projectName,
			leadResolution: "resolved",
		};
	}
	const { lead } = resolveLeadForIssue(
		input.projects,
		input.run.project_name,
		input.labels,
	);
	return {
		leadId: lead.agentId,
		projectName: project.projectName,
		leadResolution: "fallback",
	};
}

export function enqueueWorkflowReplacementLeadEvent(input: {
	store: StateStore;
	registry: RuntimeRegistry;
	seq: number;
}): DurableQueueReceipt | undefined {
	const row = input.store.getLeadEventBySeq(input.seq);
	if (!row || row.event_type !== "workflow_replacement_eligibility") {
		return undefined;
	}
	return input.registry.enqueueLeadEvent(
		leadEventEnvelopeFromJournalRow(row, 2),
	);
}
