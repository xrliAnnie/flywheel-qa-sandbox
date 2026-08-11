#!/usr/bin/env node
/** Small deploy-script adapter for the FLY-1573 readiness barrier. */

import {
	applyMailboxQueueOperatorOff,
	beginMailboxQueueDeployBarrier,
	holdMailboxQueueDeployBarrier,
	markMailboxQueueDeployBarrierReady,
} from "./mailbox-queue-deploy-barrier.js";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const action = process.argv[2];
const envPath = arg("env");
const targetSha = arg("target");
const token = arg("token");
const message = arg("message") ?? "";

let result: ReturnType<typeof beginMailboxQueueDeployBarrier>;
if (!envPath) {
	result = { ok: false, code: 400, reason: "--env is required" };
} else {
	switch (action) {
		case "begin":
			result = beginMailboxQueueDeployBarrier({ envPath }, targetSha ?? "");
			break;
		case "ready":
			result = markMailboxQueueDeployBarrierReady(
				{ envPath },
				targetSha ?? "",
				token ?? "",
				message,
			);
			break;
		case "hold":
			result = holdMailboxQueueDeployBarrier(
				{ envPath },
				targetSha ?? "",
				token ?? "",
				message,
			);
			break;
		case "operator-off":
			result = applyMailboxQueueOperatorOff({
				envPath,
				reason: message || "out-of-band operator rollback",
			});
			break;
		default:
			result = {
				ok: false,
				code: 400,
				reason: "action must be begin|ready|hold|operator-off",
			};
	}
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 1;
