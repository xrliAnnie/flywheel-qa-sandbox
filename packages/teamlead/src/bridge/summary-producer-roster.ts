import {
	compileSummaryAssignmentRows,
	type SummaryAssignmentSourceRow,
} from "flywheel-comm/summary-assignment";
import type { SummaryGranularitySelection } from "flywheel-comm/summary-config";
import type { ProjectEntry } from "../ProjectConfig.js";

export interface SummaryProducer {
	projectName: string;
	leadId: string;
}

/** Resolve the exact configured duty roster for one call-time granularity. */
export function resolveSummaryProducers(
	projects: readonly ProjectEntry[],
	selection: SummaryGranularitySelection,
): SummaryProducer[] {
	const sourceRows: SummaryAssignmentSourceRow[] = projects.flatMap((project) =>
		project.leads.map((lead) => ({
			projectName: project.projectName,
			leadId: lead.agentId,
			summaryRole: lead.summaryRole,
			summaryAggregatorLeadId: project.summaryAggregatorLeadId,
		})),
	);
	return compileSummaryAssignmentRows(sourceRows, selection)
		.leads.filter((lead) => lead.hasSummaryDuty)
		.map(({ projectName, leadId }) => ({ projectName, leadId }));
}
