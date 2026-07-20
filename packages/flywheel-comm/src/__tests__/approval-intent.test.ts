import { describe, expect, it } from "vitest";
import { classifyApprovalIntent } from "../approval-intent.js";

describe("FLY-1373 approval intent classifier", () => {
	it.each([
		'{"approved":true}',
		"APPROVE — founder approved",
		"Approved, go ahead",
		"LGTM",
		"可以 merge",
		"批准",
		"同意",
	])("classifies approval intent: %s", (answer) => {
		expect(classifyApprovalIntent(answer)).toBe("approve");
	});

	it.each([
		'{"approved":false}',
		'{"decision":"changes_requested"}',
		"not approved",
		"request changes",
		"needs more tests",
	])("classifies rejection intent: %s", (answer) => {
		expect(classifyApprovalIntent(answer)).toBe("reject");
	});

	it("leaves ordinary comments neutral", () => {
		expect(classifyApprovalIntent("please attach the benchmark output")).toBe(
			"neutral",
		);
	});
});
