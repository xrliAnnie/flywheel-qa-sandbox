import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("FLY-1441 approve_to_ship ownership fence wiring", () => {
	it("keeps the classifier on every founder and Lead presentation surface", () => {
		const admission = source("../question-admission.ts");
		const poller = source("../gate-poller.ts");
		const bootstrap = source("../bootstrap-generator.ts");
		const eventRoute = source("../event-route.ts");
		const directSink = source("../../DirectEventSink.ts");

		expect(admission).toContain("workflowGatePresentationDisposition");
		expect(
			poller.match(/workflowGatePresentationDisposition/g)?.length ?? 0,
		).toBeGreaterThanOrEqual(3);
		expect(bootstrap).toContain("workflowGatePresentationDisposition");
		expect(eventRoute).toContain("workflowGatePresentationDisposition");
		expect(directSink).toContain("workflowGatePresentationDisposition");
	});

	it("keeps QA-attempt storage dormant and decision dispatch topology-derived", () => {
		const stateStore = source("../../StateStore.ts");
		const shipEligibility = source(
			"../../../../flywheel-comm/src/ship-eligibility.ts",
		);
		const dispatcher = source("../workflow-engine-dispatcher.ts");
		const currentQaLines = stateStore
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.includes("current_qa_attempt"));

		expect(currentQaLines).toEqual([
			"current_qa_attempt INTEGER,",
			'"ALTER TABLE workflow_run ADD COLUMN current_qa_attempt INTEGER",',
			"current_qa_attempt:",
			"r.current_qa_attempt == null ? null : Number(r.current_qa_attempt),",
			"current_qa_attempt: number | null;",
		]);
		expect(shipEligibility).not.toContain("current_qa_attempt");
		expect(dispatcher).not.toMatch(
			/node\.type === "qa" \|\| node\.type === "review"/,
		);

		const epochOneSkip = stateStore.indexOf(
			"if (run.gate_carrier_epoch === 1) continue;",
		);
		const legacyQaLookup = stateStore.indexOf(
			'(node) => node.type === "qa"',
			epochOneSkip,
		);
		expect(epochOneSkip).toBeGreaterThan(-1);
		expect(legacyQaLookup).toBeGreaterThan(epochOneSkip);
	});
});
