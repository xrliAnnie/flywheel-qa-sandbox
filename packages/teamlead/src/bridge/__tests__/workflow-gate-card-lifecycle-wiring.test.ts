import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("workflow gate card lifecycle wiring", () => {
	it("runs the old-card void pass before materializing replacement cards", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../plugin.ts", import.meta.url)),
			"utf8",
		);
		const tickStart = source.indexOf(
			"const workflowGateMaterializeTick = async",
		);
		const tickEnd = source.indexOf("let landOperationSweepRunning", tickStart);
		const tick = source.slice(tickStart, tickEnd);
		const materializationListIndex = tick.indexOf(
			".listWorkflowGateHoldersForMaterialization",
		);
		expect(source).toContain("voidSupersededWorkflowGateCards,");
		expect(source).toContain("watchVoidedWorkflowGateCards,");
		expect(
			tick.indexOf("await voidSupersededWorkflowGateCards"),
		).toBeGreaterThan(-1);
		expect(tick.indexOf("await voidSupersededWorkflowGateCards")).toBeLessThan(
			materializationListIndex,
		);
		expect(tick.indexOf("await watchVoidedWorkflowGateCards")).toBeGreaterThan(
			materializationListIndex,
		);
	});
});
