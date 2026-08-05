import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WORKFLOW_LAUNCH_ABSOLUTE_HORIZON_MS,
	WORKFLOW_LAUNCH_HEARTBEAT_MS,
} from "../../StateStore.js";
import {
	WAIT_FOR_WORKFLOW_LAUNCH_PRECOMMIT_MS,
	waitForWorkflowLaunchOutcome,
} from "../workflow-launch-outcome.js";

afterEach(() => {
	vi.useRealTimers();
});

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

	it("keeps the generation heartbeat alive until a shared deadline below the absolute horizon", async () => {
		expect(WAIT_FOR_WORKFLOW_LAUNCH_PRECOMMIT_MS).toBe(
			WORKFLOW_LAUNCH_ABSOLUTE_HORIZON_MS - WORKFLOW_LAUNCH_HEARTBEAT_MS,
		);
		expect(WAIT_FOR_WORKFLOW_LAUNCH_PRECOMMIT_MS).toBeLessThan(
			WORKFLOW_LAUNCH_ABSOLUTE_HORIZON_MS,
		);

		vi.useFakeTimers();
		const heartbeat = vi.fn();
		let settled = false;
		const outcome = waitForWorkflowLaunchOutcome({
			outcome: new Promise(() => {}),
			heartbeat,
		}).then((result) => {
			settled = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(
			WAIT_FOR_WORKFLOW_LAUNCH_PRECOMMIT_MS - 1,
		);
		expect(settled).toBe(false);
		expect(heartbeat).toHaveBeenCalledTimes(
			Math.floor(
				(WAIT_FOR_WORKFLOW_LAUNCH_PRECOMMIT_MS - 1) /
					WORKFLOW_LAUNCH_HEARTBEAT_MS,
			),
		);
		await vi.advanceTimersByTimeAsync(1);
		await expect(outcome).resolves.toMatchObject({
			status: "precommit_failed",
			failure: { code: "LAUNCH_PRECOMMIT_TIMEOUT" },
		});
	});
});
