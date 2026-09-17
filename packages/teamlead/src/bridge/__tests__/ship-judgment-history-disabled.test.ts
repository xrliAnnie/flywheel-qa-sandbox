import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("has no production history publisher or Epic refresh wiring", () => {
	const source = readFileSync(new URL("../plugin.ts", import.meta.url), "utf8");
	const stateStore = readFileSync(
		new URL("../../StateStore.ts", import.meta.url),
		"utf8",
	);

	expect(source).not.toContain("createShipJudgmentHistoryRuntime");
	expect(source).not.toContain("shipJudgmentHistoryRuntime");
	expect(source).not.toContain(
		'requestRefresh("flywheel", "ship_judgment_history")',
	);
	expect(stateStore).not.toContain("getShipJudgmentHistoryState");
});
