import { createHash } from "node:crypto";
import type { SummaryRole } from "./lead-identity.js";
import type {
	SummaryGranularity,
	SummaryGranularitySelection,
} from "./summary-config.js";

export type SummaryAssignmentErrorCode =
	| "summary_granularity_unselected"
	| "summary_aggregator_invalid";

export class SummaryAssignmentError extends Error {
	constructor(
		readonly code: SummaryAssignmentErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "SummaryAssignmentError";
	}
}

export interface SummaryAssignmentSourceRow {
	projectName: string;
	leadId: string;
	summaryRole: SummaryRole;
	summaryAggregatorLeadId?: unknown;
}

export interface SummaryAssignmentRow {
	projectName: string;
	leadId: string;
	summaryRole: SummaryRole;
	hasSummaryDuty: boolean;
}

export interface SummaryAssignmentProjection {
	schemaVersion: 1;
	granularity: SummaryGranularity;
	projectAggregators: Array<{ projectName: string; leadId: string }>;
	leads: SummaryAssignmentRow[];
	digest: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function compileSummaryAssignmentRows(
	sourceRows: SummaryAssignmentSourceRow[],
	selection: SummaryGranularitySelection,
): SummaryAssignmentProjection {
	if (selection.state === "unselected") {
		throw new SummaryAssignmentError(
			"summary_granularity_unselected",
			"summary granularity is unselected",
		);
	}
	const aggregators = new Map<string, string>();
	const rowsByProject = new Map<string, SummaryAssignmentSourceRow[]>();
	for (const row of sourceRows) {
		const projectRows = rowsByProject.get(row.projectName) ?? [];
		projectRows.push(row);
		rowsByProject.set(row.projectName, projectRows);
	}
	for (const [projectName, projectRows] of rowsByProject) {
		const aggregator = projectRows[0]?.summaryAggregatorLeadId;
		if (aggregator === undefined && selection.granularity === "per-lead") {
			continue;
		}
		if (typeof aggregator !== "string" || aggregator.length === 0) {
			throw new SummaryAssignmentError(
				"summary_aggregator_invalid",
				`project ${projectName} requires a non-empty summaryAggregatorLeadId`,
			);
		}
		const selected = projectRows.find((row) => row.leadId === aggregator);
		if (!selected) {
			throw new SummaryAssignmentError(
				"summary_aggregator_invalid",
				`project ${projectName} summaryAggregatorLeadId ${aggregator} is not a project Lead`,
			);
		}
		if (
			selected.summaryRole !== "producer" &&
			selected.summaryRole !== "aggregator"
		) {
			throw new SummaryAssignmentError(
				"summary_aggregator_invalid",
				`project ${projectName} summaryAggregatorLeadId ${aggregator} has ineligible role ${selected.summaryRole}`,
			);
		}
		aggregators.set(projectName, aggregator);
	}
	const leads = sourceRows
		.map((row) => ({
			projectName: row.projectName,
			leadId: row.leadId,
			summaryRole: row.summaryRole,
			hasSummaryDuty:
				selection.granularity === "per-lead"
					? row.summaryRole === "producer"
					: aggregators.get(row.projectName) === row.leadId,
		}))
		.sort((a, b) =>
			`${a.projectName}/${a.leadId}`.localeCompare(
				`${b.projectName}/${b.leadId}`,
			),
		);
	const projectAggregators = [...aggregators]
		.map(([projectName, leadId]) => ({ projectName, leadId }))
		.sort((a, b) => a.projectName.localeCompare(b.projectName));
	const canonical = {
		schemaVersion: 1 as const,
		granularity: selection.granularity,
		projectAggregators,
		leads,
	};
	return { ...canonical, digest: sha256(JSON.stringify(canonical)) };
}
