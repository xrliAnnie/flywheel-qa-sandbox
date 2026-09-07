import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { resolveSummaryProducers } from "../summary-producer-roster.js";

const selected = (granularity: "per-lead" | "per-project") => ({
	state: "selected" as const,
	granularity,
	setBy: "founder",
	setAt: "2026-09-07T00:00:00.000Z",
});

function project(
	projectName: string,
	leads: Array<{
		agentId: string;
		summaryRole: "producer" | "aggregator" | "recipient" | "exempt";
	}>,
	summaryAggregatorLeadId?: string,
): ProjectEntry {
	return {
		projectName,
		projectRoot: `/tmp/${projectName}`,
		leads,
		summaryAggregatorLeadId,
	} as ProjectEntry;
}

describe("FLY-2382 summary producer roster", () => {
	it("returns the eleven configured producer duties and excludes every other role", () => {
		const producerIds = Array.from(
			{ length: 11 },
			(_, index) => `producer-${index + 1}`,
		);
		const projects = [
			project("flywheel", [
				...producerIds.slice(0, 6).map((agentId) => ({
					agentId,
					summaryRole: "producer" as const,
				})),
				{ agentId: "flywheel-aggregator", summaryRole: "aggregator" },
				{ agentId: "raya", summaryRole: "recipient" },
				{ agentId: "infra-exempt", summaryRole: "exempt" },
			]),
			project(
				"growth",
				producerIds.slice(6).map((agentId) => ({
					agentId,
					summaryRole: "producer" as const,
				})),
			),
		];

		const expected = producerIds
			.map((leadId, index) => ({
				projectName: index < 6 ? "flywheel" : "growth",
				leadId,
			}))
			.sort((a, b) =>
				`${a.projectName}/${a.leadId}`.localeCompare(
					`${b.projectName}/${b.leadId}`,
				),
			);
		expect(resolveSummaryProducers(projects, selected("per-lead"))).toEqual(
			expected,
		);
	});

	it("uses each project's configured aggregator in per-project mode", () => {
		const projects = [
			project(
				"flywheel",
				[
					{ agentId: "eng-lead", summaryRole: "producer" },
					{ agentId: "cos-lead", summaryRole: "aggregator" },
				],
				"cos-lead",
			),
			project(
				"growth",
				[
					{ agentId: "rafiki-lead", summaryRole: "producer" },
					{ agentId: "reflection-lead", summaryRole: "exempt" },
				],
				"rafiki-lead",
			),
		];

		expect(resolveSummaryProducers(projects, selected("per-project"))).toEqual([
			{ projectName: "flywheel", leadId: "cos-lead" },
			{ projectName: "growth", leadId: "rafiki-lead" },
		]);
	});

	it("fails closed when granularity is unselected or an aggregator is invalid", () => {
		const projects = [
			project(
				"flywheel",
				[{ agentId: "eng-lead", summaryRole: "producer" }],
				"missing-lead",
			),
		];

		expect(() =>
			resolveSummaryProducers(projects, { state: "unselected" }),
		).toThrow(/summary_granularity_unselected/);
		expect(() =>
			resolveSummaryProducers(projects, selected("per-project")),
		).toThrow(/summary_aggregator_invalid/);
	});
});
