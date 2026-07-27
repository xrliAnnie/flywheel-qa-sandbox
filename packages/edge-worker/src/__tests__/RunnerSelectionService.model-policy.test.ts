import type { EdgeWorkerConfig, ILogger } from "flywheel-core";
import { describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../RunnerSelectionService.js";

function service(config: Partial<EdgeWorkerConfig> = {}) {
	return new RunnerSelectionService(config as EdgeWorkerConfig, {} as ILogger);
}

describe("RunnerSelectionService model policy", () => {
	it("keeps Sonnet and Haiku recognizable without using either as a Claude default", () => {
		const selection = service();

		expect(selection.getDefaultModelForRunner("claude")).toBe("fable");
		expect(selection.getDefaultFallbackModelForRunner("claude")).toBe("opus");
		for (const model of ["fable", "opus", "sonnet", "haiku"]) {
			expect(
				selection.determineRunnerSelection([], `[model=${model}]`),
			).toMatchObject({
				runnerType: "claude",
				modelOverride: model,
				fallbackModelOverride: "opus",
			});
		}
	});
});
