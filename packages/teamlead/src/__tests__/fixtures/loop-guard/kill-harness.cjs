// Test-only process harness. The guard's production source is passed unchanged.
const { spawnSync, execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { basename } = require("node:path");
const { Worker, isMainThread, workerData } = require("node:worker_threads");

if (isMainThread) {
	const [, , sourcePath, logPath, readyPath, psAvailable, delay, mode] =
		process.argv;
	const source = readFileSync(sourcePath, "utf8");
	const sab = new SharedArrayBuffer(8);
	const view = new BigInt64Array(sab);
	Atomics.store(view, 0, BigInt(Date.now()));
	const guardData = {
		sab,
		stallThresholdMs: 200,
		checkIntervalMs: 25,
		logPath,
		testMode: false,
		pid: process.pid,
		bootTs: Date.now(),
		syncOpMarkerPath: "",
	};
	let guard;
	// The no-ps case preserves the original unknown/null fallback. Legacy mode
	// exists only for the host RED probe, which models a delayed child exec.
	if (psAvailable !== "true" || mode === "legacy") {
		guard = new Worker(source, { eval: true, workerData: guardData });
	} else {
		guard = new Worker(__filename, {
			workerData: { source, guardData, readyPath },
		});
	}
	const heartbeat = setInterval(
		() => Atomics.store(view, 0, BigInt(Date.now())),
		20,
	);
	let episodes = 0;
	const blockMainLoop = () => {
		const result =
			Number(delay) > 0
				? spawnSync(process.execPath, [
						"-e",
						`
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Number(delay)});
process.execve("/bin/sleep", ["sleep", "1.2"], process.env);
`,
					])
				: spawnSync("/bin/sleep", ["1.2"]);
		if (result.error) throw result.error;
		Atomics.store(view, 0, BigInt(Date.now()));
		episodes += 1;
		// Keep advancing the heartbeat long enough to observe recovery, then
		// create an independent second stall in this same process generation.
		setTimeout(() => {
			if (episodes < 2) blockMainLoop();
			else {
				clearInterval(heartbeat);
				guard.terminate().then(() => process.exit(0));
			}
		}, 500);
	};
	setTimeout(blockMainLoop, 150);
} else {
	const { source, guardData, readyPath } = workerData;
	const deadline = Date.now() + 4000;
	let sleepPid;
	while (Date.now() < deadline) {
		const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
			encoding: "utf8",
			timeout: 1000,
		});
		for (const line of table.split(/\r?\n/)) {
			const row = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
			if (
				row &&
				Number(row[2]) === guardData.pid &&
				basename(row[3]) === "sleep"
			) {
				sleepPid = Number(row[1]);
				break;
			}
		}
		if (sleepPid) break;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	}
	if (!sleepPid) throw new Error("sleep readiness timed out after 4s");
	writeFileSync(
		readyPath,
		JSON.stringify({ pid: sleepPid, ppid: guardData.pid }),
	);
	Atomics.store(new BigInt64Array(guardData.sab), 0, BigInt(Date.now()));
	// A nested eval Worker preserves CommonJS scope and starts its clock only
	// after readiness. No production source rewriting or ps substitution.
	new Worker(source, { eval: true, workerData: guardData });
}
