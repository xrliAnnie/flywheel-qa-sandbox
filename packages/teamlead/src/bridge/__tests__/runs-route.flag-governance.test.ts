import { describe, expect, it } from "vitest";
import {
	FLAG_GOVERNANCE_MARKER,
	isFlagGovernanceIssue,
} from "../runs-route.js";

describe("FLY-1781 flag-governance run-start guard", () => {
	it.each([
		[["flag-governance"], ""],
		[[" FLAG-GOVERNANCE "], ""],
		[[], `${FLAG_GOVERNANCE_MARKER}scan-2026-08-16 -->`],
	])(
		"rejects a governance ledger from label or durable marker",
		(labels, body) => {
			expect(isFlagGovernanceIssue(labels, body)).toBe(true);
		},
	);

	it("keeps unrelated issues executable", () => {
		expect(
			isFlagGovernanceIssue(["Flywheel", "bug"], "ordinary issue body"),
		).toBe(false);
	});

	it("the marker path protects label-fetch failure and is independent of leadId", () => {
		const unreadableLabels: string[] = [];
		const body = `${FLAG_GOVERNANCE_MARKER}weekly-1 -->`;
		// runs-route calls this before either explicit-lead or auto-lead dispatch.
		expect(isFlagGovernanceIssue(unreadableLabels, body)).toBe(true);
	});
});
