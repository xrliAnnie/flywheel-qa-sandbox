import type { LaunchPrecommitOutcome } from "flywheel-core";
import {
	WORKFLOW_LAUNCH_ABSOLUTE_HORIZON_MS,
	WORKFLOW_LAUNCH_HEARTBEAT_MS,
} from "../StateStore.js";

/** Leave one full heartbeat interval before the launch owner's hard horizon. */
export const WAIT_FOR_WORKFLOW_LAUNCH_PRECOMMIT_MS =
	WORKFLOW_LAUNCH_ABSOLUTE_HORIZON_MS - WORKFLOW_LAUNCH_HEARTBEAT_MS;

export async function waitForWorkflowLaunchOutcome(input: {
	outcome: Promise<LaunchPrecommitOutcome>;
	timeoutMs?: number;
	heartbeat: () => void;
}): Promise<LaunchPrecommitOutcome | undefined> {
	const timeoutMs = input.timeoutMs ?? WAIT_FOR_WORKFLOW_LAUNCH_PRECOMMIT_MS;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const heartbeat = setInterval(() => {
		try {
			input.heartbeat();
		} catch {
			// A lost heartbeat is observed by the generation fence at commit.
		}
	}, WORKFLOW_LAUNCH_HEARTBEAT_MS);
	heartbeat.unref?.();
	try {
		return await Promise.race([
			input.outcome,
			new Promise<LaunchPrecommitOutcome>((resolve) => {
				timeout = setTimeout(
					() =>
						resolve({
							status: "precommit_failed",
							failure: {
								code: "LAUNCH_PRECOMMIT_TIMEOUT",
								reason: "deadline_exhausted",
								physicalEvidence: "unknown",
							},
						}),
					timeoutMs,
				);
				timeout.unref?.();
			}),
		]);
	} finally {
		clearInterval(heartbeat);
		if (timeout) clearTimeout(timeout);
	}
}
