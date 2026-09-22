import { expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	bindingFixture,
	CHANNEL,
} from "../../ship-judgment/__tests__/binding-fixture.js";
import { evidenceMaterials } from "../../ship-judgment/__tests__/evidence-fixture.js";
import { collectProductionJudgment } from "../../ship-judgment/production-collect.js";
import { createShipJudgmentBridgeRuntime } from "../ship-judgment-runtime.js";

vi.mock("../../ship-judgment/production-collect.js", () => ({
	collectProductionJudgment: vi.fn(),
}));

const scenarios = [
	{
		name: "complete",
		alignmentMissing: ["input"],
		conflict: "pass",
		conflictMissing: [],
		coverageMissing: ["input"],
		input: { status: "ready", reason: "evidence_complete" },
		collectCalls: 1,
		reportsInputError: false,
	},
	{
		name: "no_qa",
		alignmentMissing: ["input"],
		conflict: "pass",
		conflictMissing: [],
		coverageMissing: ["qa_claim", "input"],
		input: { status: "ready", reason: "evidence_complete" },
		collectCalls: 1,
		reportsInputError: false,
	},
	{
		name: "no_linear",
		alignmentMissing: ["input"],
		conflict: "pass",
		conflictMissing: [],
		coverageMissing: ["input"],
		input: { status: "unavailable", reason: "linear_credentials_missing" },
		collectCalls: 1,
		reportsInputError: true,
	},
	{
		name: "no_repositories",
		alignmentMissing: [
			"design_review",
			"plan_at_head",
			"code_review_at_head",
			"pr_diff",
			"input",
		],
		conflict: "undetermined",
		conflictMissing: ["mechanical_snapshot"],
		coverageMissing: ["qa_report", "input"],
		input: { status: "unavailable", reason: "repositories_unavailable" },
		collectCalls: 0,
		reportsInputError: true,
	},
] as const;

it.each(scenarios)(
	"preserves independent evidence while requiring semantic input: $name",
	async ({
		name: scenario,
		alignmentMissing,
		conflict,
		conflictMissing,
		coverageMissing,
		input,
		collectCalls,
		reportsInputError,
	}) => {
		const { store, db } = await bindingFixture();
		try {
			vi.spyOn(store, "getSessionLabels").mockReturnValue(["Engineering"]);
			const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
			const materials = evidenceMaterials(binding, new Date().toISOString());
			if (scenario === "no_qa") delete materials.targets[0]!.qaAuthority;
			if (scenario === "no_repositories")
				vi.spyOn(store, "readShipJudgmentRepositories").mockReturnValue(
					undefined,
				);
			vi.spyOn(store, "readShipJudgmentQaAuthority").mockReturnValue(
				evidenceMaterials(binding, new Date().toISOString()).targets[0]!
					.qaAuthority!,
			);
			vi.mocked(collectProductionJudgment)
				.mockReset()
				.mockResolvedValue({
					collection: {
						status: "undetermined",
						reason: "qa_report_unretained",
					},
					mechanical: materials.mechanical,
					materials,
				});
			const project: ProjectEntry = {
				projectName: "flywheel",
				projectRoot: "/tmp/fixture",
				projectRepo: "Owner/Repo",
				leads: [
					{
						agentId: "lead",
						summaryRole: "engineering",
						chatChannel: CHANNEL,
						match: { labels: ["Engineering"] },
					},
				],
			};
			const onError = vi.fn(),
				modelBin = vi.fn(() => "must-not-run");
			const runtime = createShipJudgmentBridgeRuntime({
				store,
				projects: [project],
				mode: () => "dry_run",
				linearApiKey: scenario === "no_linear" ? undefined : "fixture",
				registry: { readReportHtml: () => "" },
				hosting: {},
				token: async () => "fixture",
				modelBin,
				onError,
			})!;
			await runtime.scanner.tick();
			await runtime.worker.tick();
			const row = db
				.prepare(
					"SELECT overall,alignment,conflict,coverage,evidence_json FROM ship_judgment_opinion",
				)
				.get() as Record<string, string>;
			expect(row.evidence_json).toBeTruthy();
			expect({
				overall: row.overall,
				alignment: row.alignment,
				conflict: row.conflict,
				coverage: row.coverage,
			}).toEqual({
				overall: "undetermined",
				alignment: "undetermined",
				conflict,
				coverage: "undetermined",
			});
			const evidence = JSON.parse(row.evidence_json) as {
				alignment: { missing: string[] };
				conflict: { missing: string[] };
				coverage: { missing: string[] };
				semantic: { status: string };
				input: { status: string; reason: string };
			};
			expect({
				alignmentMissing: evidence.alignment.missing,
				conflictMissing: evidence.conflict.missing,
				coverageMissing: evidence.coverage.missing,
				semanticStatus: evidence.semantic.status,
				input: evidence.input,
			}).toEqual({
				alignmentMissing,
				conflictMissing,
				coverageMissing,
				semanticStatus: "not_run",
				input,
			});
			expect(collectProductionJudgment).toHaveBeenCalledTimes(collectCalls);
			expect(modelBin).not.toHaveBeenCalled();
			if (reportsInputError) {
				expect(onError).toHaveBeenCalledWith(
					expect.stringMatching(/^input_unavailable:/),
				);
			} else {
				expect(onError).not.toHaveBeenCalled();
			}
			await runtime.stop();
		} finally {
			store.close();
			vi.restoreAllMocks();
		}
	},
);
