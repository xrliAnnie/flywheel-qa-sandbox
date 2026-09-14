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
	// The no-ps case preserves the original unknown/null fallback. Legacy mode
	// exists only for the host RED probe, which models a delayed child exec.
	if (psAvailable !== "true" || mode === "legacy") {
		new Worker(source, { eval: true, workerData: guardData });
	} else {
		new Worker(__filename, { workerData: { source, guardData, readyPath } });
	}
	setInterval(() => Atomics.store(view, 0, BigInt(Date.now())), 20);
	setTimeout(() => {
		const result =
			Number(delay) > 0
				? spawnSync(process.execPath, [
						"-e",
						`
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Number(delay)});
process.execve("/bin/sleep", ["sleep", "30"], process.env);
`,
					])
				: spawnSync("/bin/sleep", ["30"]);
		// Reaching here means no guard kill; do not leave the heartbeat alive.
		if (result.error) console.error(result.error);
		process.exit(2);
	}, 150);
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
