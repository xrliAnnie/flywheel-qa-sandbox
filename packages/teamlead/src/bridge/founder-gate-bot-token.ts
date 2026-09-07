import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore, WorkflowGateHolderRow } from "../StateStore.js";

export function resolveFounderGateBotToken(input: {
	store: StateStore;
	projects: ProjectEntry[];
	holder: WorkflowGateHolderRow;
	fallbackToken?: string;
}): string | undefined {
	const run = input.store.getWorkflowRun(input.holder.run_id);
	const source = input.store.getSession(input.holder.source_execution_id);
	if (!run || !source) return undefined;
	try {
		const labels = input.store.getSessionLabels(
			input.holder.source_execution_id,
		);
		const { lead } = resolveLeadForIssue(
			input.projects,
			run.project_name,
			labels,
		);
		return (lead.botToken ?? input.fallbackToken)?.trim() || undefined;
	} catch {
		return undefined;
	}
}
