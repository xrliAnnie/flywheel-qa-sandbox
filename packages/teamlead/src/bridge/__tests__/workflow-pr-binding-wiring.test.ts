import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
	return readFileSync(
		fileURLToPath(new URL(relativePath, import.meta.url)),
		"utf8",
	);
}

describe("FLY-1434 workflow PR binding wiring", () => {
	it("uses the exact-head authority resolver at every Bridge ship/land production reader", () => {
		for (const file of [
			"../approval-signal/gate-authority-view.ts",
			"../workflow-engine-dispatcher.ts",
			"../land-executor.ts",
			"../plugin.ts",
		]) {
			const body = source(file);
			expect(body).toContain("resolveWorkflowExactHeadAuthority");
			expect(body).not.toContain("getWorkflowRunPrNumber");
		}
	});

	it("refuses generalized PR completion through DirectEventSink", () => {
		const body = source("../../DirectEventSink.ts");
		expect(body).toContain("generalizedExecution.node.capabilities.creates_pr");
		expect(body).toContain("generalized PR completion rejected");
	});
});
