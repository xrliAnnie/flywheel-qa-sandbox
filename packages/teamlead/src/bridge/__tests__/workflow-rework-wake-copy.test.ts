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
});
