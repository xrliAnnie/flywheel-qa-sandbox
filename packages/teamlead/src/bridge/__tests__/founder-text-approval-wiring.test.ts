import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
	return readFileSync(
		fileURLToPath(new URL(relativePath, import.meta.url)),
		"utf8",
	);
}

describe("FLY-1448 founder text approval production wiring", () => {
	it("builds the text callback from the shared approval guards", () => {
		const body = source("../plugin.ts");

		expect(body).toContain("makeFounderShipApprovalCallback");
		expect(body).toContain("makeDeferralSupport");
		expect(body).toContain("const founderShipApprovalCallback =");
		expect(body).toContain("gateAuthorityView,");
		expect(body).toContain("mergedGateGuard,");
		expect(body).toContain("projectRootFor,");
		expect(body).toContain("deferralSupport:");
	});

	it("injects the text callback and current card binding into GatePoller", () => {
		const plugin = source("../plugin.ts");
		const poller = source("../gate-poller.ts");

		expect(plugin).toContain(
			"tryFounderShipApproval: founderShipApprovalCallback",
		);
		expect(plugin).toContain(
			"readCurrentBinding: (executionId, questionId, prHeadSha)",
		);
		expect(poller).toContain(
			'FounderReplyDeliverDeps["tryFounderShipApproval"]',
		);
		expect(poller).toContain('FounderReplyDeliverDeps["readCurrentBinding"]');
		expect(poller).toContain(
			"tryFounderShipApproval: this.config.tryFounderShipApproval",
		);
		expect(poller).toContain(
			"readCurrentBinding: this.config.readCurrentBinding",
		);
	});
});
