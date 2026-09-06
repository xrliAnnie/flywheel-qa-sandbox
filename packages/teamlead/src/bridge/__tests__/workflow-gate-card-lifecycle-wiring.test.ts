import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("workflow gate card lifecycle wiring", () => {
	it("closes sessionless gates, voids old cards, then materializes and watches", () => {
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
		const reconcileIndex = tick.indexOf(
			"await reconcileSessionlessWorkflowGates",
		);
		const voidIndex = tick.indexOf("await voidSupersededWorkflowGateCards");
		expect(source).toContain("reconcileSessionlessWorkflowGates");
		expect(source).toContain("voidSupersededWorkflowGateCards,");
		expect(source).toContain("watchVoidedWorkflowGateCards,");
		expect(reconcileIndex).toBeGreaterThan(-1);
		expect(voidIndex).toBeGreaterThan(reconcileIndex);
		expect(voidIndex).toBeLessThan(materializationListIndex);
		expect(tick.indexOf("await watchVoidedWorkflowGateCards")).toBeGreaterThan(
			materializationListIndex,
		);
	});
});
