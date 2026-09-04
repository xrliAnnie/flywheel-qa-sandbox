import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { defaultAsyncExecFile } from "../../packages/claude-runner/dist/TmuxAdapter.js";
import { BridgeEventLoopGuard } from "../../packages/teamlead/dist/bridge/BridgeEventLoopGuard.js";

const [mode, logPath] = process.argv.slice(2);

function result(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runGuardArm(blocking) {
	const stallThresholdMs = Number(process.env.FLY2331_GUARD_STALL_MS ?? 60_000);
	const guard = new BridgeEventLoopGuard({
		heartbeatIntervalMs: Math.min(1_000, Math.max(25, stallThresholdMs / 4)),
		stallThresholdMs,
		checkIntervalMs: Math.min(1_000, Math.max(25, stallThresholdMs / 4)),
		logPath,
		testMode: false,
	});
	let heartbeats = 0;
	const heartbeat = setInterval(() => {
		heartbeats += 1;
	}, 1_000);
	guard.start();
	if (blocking) {
		execFileSync("git", ["worktree", "add", "fake-target"], {
			encoding: "utf8",
			timeout: 120_000,
		});
		throw new Error("blocking mutant unexpectedly survived the guard");
	}
	const child = await defaultAsyncExecFile(
		"git",
		["worktree", "add", "fake-target"],
		{ timeoutMs: 120_000 },
	);
	clearInterval(heartbeat);
	guard.stop();
	result({ mode: "async", heartbeats, child: child.stdout.trim() });
}

async function processExists(pid) {
	let visibleToPs = false;
	try {
		execFileSync("/bin/ps", ["-p", String(pid)], {
			stdio: "ignore",
			timeout: 2_000,
		});
		visibleToPs = true;
	} catch {
		// The managed test sandbox can deny ps; kill(0) remains the second proof.
	}
	let visibleToSignal = false;
	try {
		process.kill(pid, 0);
		visibleToSignal = true;
	} catch (error) {
		if (error?.code !== "ESRCH") visibleToSignal = true;
	}
	return visibleToPs || visibleToSignal;
}

async function waitAbsent(pid, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (!(await processExists(pid))) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

async function runProcessGroupArm() {
	let error;
	try {
		await defaultAsyncExecFile("git", ["group-fixture"], {
			timeoutMs: 250,
		});
	} catch (caught) {
		error = caught;
	}
	if (!error || error.code !== "ETIMEDOUT" || error.timedOut !== true) {
		throw new Error(`unexpected process-group timeout: ${String(error)}`);
	}
	const pids = readFileSync(process.env.FLY2331_PID_LOG, "utf8")
		.trim()
		.split("\n")
		.map(Number);
	if (pids.length !== 2 || pids.some((pid) => !Number.isSafeInteger(pid))) {
		throw new Error(`invalid process-group pids: ${JSON.stringify(pids)}`);
	}
	const reaped = await Promise.all(pids.map((pid) => waitAbsent(pid, 3_000)));
	if (reaped.some((absent) => !absent)) {
		throw new Error(
			`process group residue: ${JSON.stringify({ pids, reaped })}`,
		);
	}
	result({ mode: "group", pids, reaped });
}

async function runDetachedReapArm() {
	const child = spawn(
		process.execPath,
		["-e", "process.stdout.write(''); process.exit(0)"],
		{ detached: true, stdio: "ignore" },
	);
	let settleTerminal;
	const terminal = new Promise((resolve) => {
		settleTerminal = resolve;
	});
	let childError;
	let exitObserved = false;
	child.once("error", (error) => {
		childError = error;
		settleTerminal("error");
	});
	child.once("exit", () => {
		exitObserved = true;
		settleTerminal("exit");
	});
	child.unref();
	if (!child.pid) throw new Error("detached child had no pid");
	const terminalKind = await Promise.race([
		terminal,
		new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
	]);
	const absent = await waitAbsent(child.pid, 3_000);
	if (terminalKind !== "exit" || childError || !exitObserved || !absent) {
		throw new Error(
			`detached child not reaped: ${JSON.stringify({ childError: String(childError), terminalKind, exitObserved, absent })}`,
		);
	}
	result({ mode: "reap", pid: child.pid, exitObserved, absent });
}

if (mode === "async") await runGuardArm(false);
else if (mode === "sync") await runGuardArm(true);
else if (mode === "group") await runProcessGroupArm();
else if (mode === "reap") await runDetachedReapArm();
else throw new Error(`unknown mode: ${mode}`);
