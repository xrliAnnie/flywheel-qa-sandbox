import type { LaunchPrecommitOutcome } from "flywheel-core";
import { WORKFLOW_LAUNCH_HEARTBEAT_MS } from "../StateStore.js";

export async function waitForWorkflowLaunchOutcome(input: {
	outcome: Promise<LaunchPrecommitOutcome>;
	timeoutMs: number;
	heartbeat: () => void;
}): Promise<LaunchPrecommitOutcome | undefined> {
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
					input.timeoutMs,
				);
				timeout.unref?.();
			}),
		]);
	} finally {
		clearInterval(heartbeat);
		if (timeout) clearTimeout(timeout);
	}
}
