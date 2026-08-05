import { describe, expect, it } from "vitest";
import { waitForWorkflowLaunchOutcome } from "../workflow-launch-outcome.js";

describe("waitForWorkflowLaunchOutcome", () => {
	it("returns a structured timeout instead of an ambiguous missing outcome", async () => {
		const result = await waitForWorkflowLaunchOutcome({
			outcome: new Promise(() => {}),
			timeoutMs: 1,
			heartbeat: () => {},
		});
		expect(result).toEqual({
			status: "precommit_failed",
			failure: {
				code: "LAUNCH_PRECOMMIT_TIMEOUT",
				reason: "deadline_exhausted",
				physicalEvidence: "unknown",
			},
		});
	});
});
