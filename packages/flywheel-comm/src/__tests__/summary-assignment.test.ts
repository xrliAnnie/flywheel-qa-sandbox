import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	compileSummaryAssignments,
	type SummaryAssignmentError,
} from "../summary-assignment.js";

function lead(agentId: string, summaryRole: string) {
	return { agentId, summaryRole };
}

describe("FLY-2030 canonical summary assignments", () => {
	it("keeps the production assignment manifest ready for both founder-owned modes", () => {
		const manifestPath = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../engineering/doc/FLY-2030-raya-brain-inquiry/summary-role-assignments.json",
		);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			assignments: Array<{
				projectName: string;
				leadId: string;
				summaryRole: string;
			}>;
			projectAggregators: Array<{ projectName: string; leadId: string }>;
		};
		const aggregatorByProject = new Map(
			manifest.projectAggregators.map((row) => [row.projectName, row.leadId]),
		);
		const projectMap = new Map<
			string,
			{
				projectName: string;
				summaryAggregatorLeadId: string | undefined;
				leads: ReturnType<typeof lead>[];
			}
		>();
		for (const assignment of manifest.assignments) {
			const project = projectMap.get(assignment.projectName) ?? {
				projectName: assignment.projectName,
				summaryAggregatorLeadId: aggregatorByProject.get(
					assignment.projectName,
				),
				leads: [],
			};
			project.leads.push(lead(assignment.leadId, assignment.summaryRole));
			projectMap.set(assignment.projectName, project);
		}
		const registry = [...projectMap.values()];
		const selection = (granularity: "per-lead" | "per-project") => ({
			state: "selected" as const,
			granularity,
			setBy: "founder",
			setAt: "2026-08-28T09:00:00.000Z",
		});

		const perLead = compileSummaryAssignments(registry, selection("per-lead"));
		const perProject = compileSummaryAssignments(
			registry,
			selection("per-project"),
		);

		expect(perLead.leads.filter((row) => row.hasSummaryDuty)).toHaveLength(11);
		expect(
			perProject.leads
				.filter((row) => row.hasSummaryDuty)
				.map((row) => row.leadId),
		).toEqual([
			"flywheel-cos-lead",
			"cos-lead",
			"mufasa-lead",
			"joycon-lead",
			"belle-lead",
			"tidal-echo-cos-lead",
		]);
	});

	it("selects only explicit producers in per-lead mode", () => {
		const projection = compileSummaryAssignments(
			[
				{
					projectName: "flywheel",
					leads: [
						lead("flywheel-cos-lead", "aggregator"),
						lead("flywheel-eng-lead", "producer"),
						lead("claude-infra-bot-lead", "exempt"),
					],
				},
				{
					projectName: "raya",
					leads: [lead("raya-lead", "recipient")],
				},
			],
			{
				state: "selected",
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-08-28T09:00:00.000Z",
			},
		);

		expect(
			projection.leads
				.filter((row) => row.hasSummaryDuty)
				.map((row) => row.leadId),
		).toEqual(["flywheel-eng-lead"]);
		expect(projection.granularity).toBe("per-lead");
		expect(projection.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("selects exactly the configured project aggregator in per-project mode", () => {
		const projection = compileSummaryAssignments(
			[
				{
					projectName: "flywheel",
					summaryAggregatorLeadId: "flywheel-cos-lead",
					leads: [
						lead("flywheel-cos-lead", "aggregator"),
						lead("flywheel-eng-lead", "producer"),
						lead("raya-lead", "recipient"),
					],
				},
				{
					projectName: "growth",
					summaryAggregatorLeadId: "mufasa-lead",
					leads: [
						lead("mufasa-lead", "producer"),
						lead("rafiki-lead", "producer"),
					],
				},
			],
			{
				state: "selected",
				granularity: "per-project",
				setBy: "founder",
				setAt: "2026-08-28T09:00:00.000Z",
			},
		);

		expect(
			projection.leads
				.filter((row) => row.hasSummaryDuty)
				.map((row) => row.leadId),
		).toEqual(["flywheel-cos-lead", "mufasa-lead"]);
		expect(projection.granularity).toBe("per-project");
	});

	it.each([
		["missing", undefined],
		["empty", ""],
		["wrong type", 42],
		["not a project member", "outside-lead"],
	] as const)(
		"rejects a %s project aggregator assignment",
		(_label, summaryAggregatorLeadId) => {
			expect(() =>
				compileSummaryAssignments(
					[
						{
							projectName: "growth",
							summaryAggregatorLeadId,
							leads: [lead("mufasa-lead", "producer")],
						},
					],
					{
						state: "selected",
						granularity: "per-project",
						setBy: "founder",
						setAt: "2026-08-28T09:00:00.000Z",
					},
				),
			).toThrowError(
				expect.objectContaining<Partial<SummaryAssignmentError>>({
					code: "summary_aggregator_invalid",
				}),
			);
		},
	);

	it("validates an optional aggregator field even while per-lead mode is active", () => {
		expect(() =>
			compileSummaryAssignments(
				[
					{
						projectName: "growth",
						summaryAggregatorLeadId: "outside-lead",
						leads: [lead("mufasa-lead", "producer")],
					},
				],
				{
					state: "selected",
					granularity: "per-lead",
					setBy: "founder",
					setAt: "2026-08-28T09:00:00.000Z",
				},
			),
		).toThrowError(
			expect.objectContaining<Partial<SummaryAssignmentError>>({
				code: "summary_aggregator_invalid",
			}),
		);
	});

	it("never allows a recipient or exempt Lead to become a project aggregator", () => {
		expect(() =>
			compileSummaryAssignments(
				[
					{
						projectName: "flywheel",
						summaryAggregatorLeadId: "raya-lead",
						leads: [lead("raya-lead", "recipient")],
					},
				],
				{
					state: "selected",
					granularity: "per-project",
					setBy: "founder",
					setAt: "2026-08-28T09:00:00.000Z",
				},
			),
		).toThrowError(
			expect.objectContaining<Partial<SummaryAssignmentError>>({
				code: "summary_aggregator_invalid",
			}),
		);
	});

	it("binds aggregator assignments into the projection digest in every mode", () => {
		const registry = (summaryAggregatorLeadId: string) => [
			{
				projectName: "growth",
				summaryAggregatorLeadId,
				leads: [
					lead("mufasa-lead", "producer"),
					lead("rafiki-lead", "producer"),
				],
			},
		];
		const mode = {
			state: "selected" as const,
			granularity: "per-lead" as const,
			setBy: "founder",
			setAt: "2026-08-28T09:00:00.000Z",
		};

		const before = compileSummaryAssignments(registry("mufasa-lead"), mode);
		const after = compileSummaryAssignments(registry("rafiki-lead"), mode);

		expect(after.leads).toEqual(before.leads);
		expect(after.digest).not.toBe(before.digest);
	});
});
