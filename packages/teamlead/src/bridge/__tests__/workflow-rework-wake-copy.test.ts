import { describe, expect, it } from "vitest";
import { renderWorkflowReworkWakeContent } from "../workflow-rework-wake-copy.js";

describe("workflow rework wake copy", () => {
	it("names node reuse as a new verification round", () => {
		expect(
			renderWorkflowReworkWakeContent({
				wakeId: "wake-1",
				activationId: "activation-1",
				epoch: 7,
				executionId: "qa-exec",
				context: {
					authorityContext: { kind: "node_reuse" },
				},
			}),
		).toContain("New verification round");
	});

	it("keeps legacy rework language for other request families", () => {
		expect(
			renderWorkflowReworkWakeContent({
				wakeId: "wake-2",
				activationId: "activation-2",
				epoch: 8,
				executionId: "implement-exec",
				context: { authorityContext: { authority: "qa" } },
			}),
		).toContain("Workflow rework activation");
	});

	it("labels Lead attribution and keeps founder quote separate", () => {
		const content = renderWorkflowReworkWakeContent({
			wakeId: "wake-lead",
			activationId: "activation-lead",
			epoch: 9,
			executionId: "implement-exec",
			context: {
				authority: "lead",
				authorityContext: {
					authority: "lead",
					actor: "flywheel-eng-lead",
					lead_feedback: "repair the implementation",
					founder_quote: {
						message_id: "22345678901234567",
						text: "founder verbatim",
					},
				},
			},
		});
		expect(content).toContain("Rework submitted by lead:flywheel-eng-lead");
		expect(content).toContain("Lead feedback: repair the implementation");
		expect(content).toContain(
			"Founder quote (message 22345678901234567): founder verbatim",
		);
		expect(content).not.toContain("Founder feedback");
	});

	it.each([
		[null, "Founder quote: none (Lead submitted independently)"],
		[
			{ message_id: "empty-message", text: "" },
			"Founder quote (message empty-message): [empty text]",
		],
	] as const)(
		"renders an explicit empty founder quote state",
		(quote, expected) => {
			const content = renderWorkflowReworkWakeContent({
				wakeId: "wake-empty",
				activationId: "activation-empty",
				epoch: 10,
				executionId: "implement-exec",
				context: {
					authority: "lead",
					authorityContext: {
						authority: "lead",
						actor: "flywheel-eng-lead",
						lead_feedback: "Lead correction",
						founder_quote: quote,
					},
				},
			});
			expect(content).toContain(expected);
		},
	);
});
