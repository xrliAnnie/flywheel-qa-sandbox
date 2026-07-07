import { describe, expect, it } from "vitest";
import { wakeText } from "../runner-wake.js";

/**
 * FLY-939 (G-B): the feedback wake text must carry a role-neutral deferral — a
 * runner whose role prompt defines a different feedback protocol (the three-stage
 * QA kickback) follows its role prompt, not the generic re-request steps. A
 * single-session runner (no such protocol) keeps the generic steps byte-for-byte.
 */
describe("wakeText feedback deferral (FLY-939 G-B)", () => {
	it("feedback_wake carries the role-neutral deferral sentence", () => {
		const t = wakeText("feedback_wake", "exec-1", "flywheel", {
			questionId: "q-1",
			feedbackText: "tighten the copy",
		});
		expect(t).toContain(
			"If your role's prompt defines a different feedback protocol",
		);
		expect(t).toContain("three-stage QA kickback");
		// The generic re-request instruction is still present for role-less runners.
		expect(t).toContain("address the feedback, push your fixes");
	});

	it("approval_wake text is unchanged (deferral is feedback-only)", () => {
		const t = wakeText("approval_wake", "exec-1", "flywheel", {
			questionId: "q-1",
		});
		expect(t).toContain("verify-approval");
		expect(t).not.toContain("three-stage QA kickback");
	});
});
