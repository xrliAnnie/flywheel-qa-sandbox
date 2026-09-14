import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../plugin.ts", import.meta.url), "utf8");
describe("FLY-2555 harvest ownership wiring", () => {
	it("consults the shared adapter registry lazily and rejects unknown external dispatch ownership", () => {
		const hook = source.slice(
			source.indexOf("harvestCodexDaemon: async"),
			source.indexOf(
				"if (result.reconciled > 0)",
				source.indexOf("harvestCodexDaemon: async"),
			),
		);
		expect(hook).toMatch(/isOwned:\s*\(\) =>/);
		expect(hook).toContain("!internalDispatcher");
		expect(hook).toContain("opts?.startDispatcher");
		expect(hook).toContain(
			"codexExecutionOwners.isExecutionOwned(executionId)",
		);
		expect(source).toMatch(
			/setupRunInfrastructure\([\s\S]*?flagStore,\s+codexExecutionOwners,/,
		);
		expect(hook).toContain("gracefulOnly: true");
		expect(hook).toContain("beforeSignal");
		expect(hook).toContain("store.getResidentHold(executionId)?.state");
	});
	it("does not enable shutdown in the legacy boot pass", () => {
		const legacy = source.slice(source.indexOf("const runLegacyCommDbFsm"));
		expect(legacy).not.toContain("harvestCodexDaemon:");
	});
});
