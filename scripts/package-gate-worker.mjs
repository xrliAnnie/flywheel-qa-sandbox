import { renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGateCore } from "./lib/package-gate-core.mjs";

function integer(value) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function runWorker(config) {
	const result = await runGateCore(config);
	const submittedAtMs = integer(
		process.env.FLYWHEEL_PACKAGE_GATE_SUBMITTED_AT_MS,
	);
	const admittedAtMs = integer(
		process.env.FLYWHEEL_PACKAGE_GATE_ADMITTED_AT_MS,
	);
	const finishedAtMs = Date.now();
	if (
		process.env.FLYWHEEL_PACKAGE_GATE_REQUEST_ID &&
		submittedAtMs &&
		admittedAtMs
	) {
		result.hostQueue = {
			requestId: process.env.FLYWHEEL_PACKAGE_GATE_REQUEST_ID,
			state: "finished",
			submittedAt: new Date(submittedAtMs).toISOString(),
			admittedAt: new Date(admittedAtMs).toISOString(),
			finishedAt: new Date(finishedAtMs).toISOString(),
			queueWaitMs: admittedAtMs - submittedAtMs,
			serviceMs: finishedAtMs - admittedAtMs,
			totalWallMs: finishedAtMs - submittedAtMs,
		};
	}
	return result;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const configPath = process.argv[2];
	if (!configPath) throw new Error("worker config path is required");
	const { readFileSync } = await import("node:fs");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const result = await runWorker(config);
	const temporary = `${config.resultPath}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
	renameSync(temporary, config.resultPath);
	process.exitCode = result.exitCode;
}
