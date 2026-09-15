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

it.each(["complete", "no_qa", "no_linear", "no_repositories"])(
	"offers independent evidence without a model or same-run design reference: %s",
	async (scenario) => {
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
			expect(row.coverage).toBe(scenario === "no_qa" ? "undetermined" : "pass");
			expect(row.alignment).toBe(
				scenario === "no_repositories" ? "undetermined" : "pass",
			);
			expect(row.conflict).toBe(
				scenario === "no_repositories" ? "undetermined" : "pass",
			);
			expect(collectProductionJudgment).toHaveBeenCalledTimes(
				scenario === "no_repositories" ? 0 : 1,
			);
			expect(modelBin).not.toHaveBeenCalled();
			if (scenario === "no_repositories" || scenario === "no_linear") {
				expect(JSON.parse(row.evidence_json!).input.status).toBe("unavailable");
				expect(onError).toHaveBeenCalledWith(
					expect.stringMatching(/^input_unavailable:/),
				);
			}
			await runtime.stop();
		} finally {
			store.close();
			vi.restoreAllMocks();
		}
	},
);
