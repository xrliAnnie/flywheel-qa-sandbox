import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("FLY-2278 legacy rework-stall retirement", () => {
	it("removes the retired scanner, mutator, thresholds, and env knobs", () => {
		const sources = [
			"src/bridge/workflow-engine-dispatcher.ts",
			"src/StateStore.ts",
			"../config/src/feature-flags/truth.ts",
		]
			.map((path) => readFileSync(resolve(process.cwd(), path), "utf8"))
			.join("\n");

		expect(sources).not.toMatch(/FLYWHEEL_ENGINE_REWORK_(?:ALERT|HOLD)_MS/);
		expect(sources).not.toContain("reconcileWorkflowReworkStalls");
		expect(sources).not.toContain("reworkThresholdMs");
		expect(sources).not.toContain("escalateWorkflowReworkStall");
	});
});
