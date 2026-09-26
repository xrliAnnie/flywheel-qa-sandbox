import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { createBridgeApp } from "../../../../dist/bridge/plugin.js";
import { RunnerAdmissionController } from "../../../../dist/bridge/runner-admission.js";
import { StateStore } from "../../../../dist/StateStore.js";

const [, , sourcePath, logPath, stalledPath, resumePath] = process.argv;
const store = await StateStore.create(":memory:");
const app = createBridgeApp(store, [], {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	notificationChannel: "test",
	defaultLeadAgentId: "test",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
});
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const sab = new SharedArrayBuffer(8);
const heartbeat = new BigInt64Array(sab);
Atomics.store(heartbeat, 0, BigInt(Date.now()));
const guard = new Worker(readFileSync(sourcePath, "utf8"), {
	eval: true,
	workerData: {
		sab,
		stallThresholdMs: 200,
		checkIntervalMs: 25,
		logPath,
		testMode: false,
		pid: process.pid,
		bootTs: Date.now(),
		syncOpMarkerPath: "",
	},
});
const timer = setInterval(
	() => Atomics.store(heartbeat, 0, BigInt(Date.now())),
	20,
);
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	clearInterval(timer);
	await guard.terminate();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	store.close();
	process.exit(0);
}
// Bounded fixture lifetime even if the test caller fails before cleanup.
setTimeout(close, 30_000).unref();
process.on("message", (message) => {
	if (message === "close") void close();
	if (message !== "stall") return;
	writeFileSync(stalledPath, "stalled");
	const deadline = Date.now() + 15_000;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	while (!existsSync(resumePath) && Date.now() < deadline) {
		Atomics.wait(sleeper, 0, 0, 20);
	}
	Atomics.store(heartbeat, 0, BigInt(Date.now()));
});
process.send({ port: server.address().port, pid: process.pid });
