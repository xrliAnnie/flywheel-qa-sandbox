import { compileLeadIdentityRows } from "./lead-identity.js";
import {
	compileSummaryAssignmentRows,
	type SummaryAssignmentProjection,
} from "./summary-assignment-core.js";
import type { SummaryGranularitySelection } from "./summary-config.js";

export * from "./summary-assignment-core.js";

export function compileSummaryAssignments(
	raw: unknown,
	selection: SummaryGranularitySelection,
): SummaryAssignmentProjection {
	const compiled = compileLeadIdentityRows(raw);
	return compileSummaryAssignmentRows(
		compiled.map(({ project, identity }) => ({
			projectName: identity.projectName,
			leadId: identity.leadId,
			summaryRole: identity.summaryRole,
			summaryAggregatorLeadId: project.summaryAggregatorLeadId,
		})),
		selection,
	);
}
