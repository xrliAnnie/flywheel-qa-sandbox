#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_OUTPUT = 4 * 1024 * 1024;

function fail(reason, code = 75) {
	process.stderr.write(
		`CODEX_HOME_RECONCILE_PROCESS unavailable reason=${reason}\n`,
	);
	process.exit(code);
}

function parse(argv) {
	const separator = argv.indexOf("--");
	if (separator < 0 || separator === argv.length - 1) fail("usage", 2);
	const values = new Map();
	for (let index = 0; index < separator; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (
			!value ||
			!["--fence", "--timeout-ms", "--kill-grace-ms", "--proof-ms"].includes(
				key,
			) ||
			values.has(key)
		)
			fail("usage", 2);
		values.set(key, value);
	}
	const fence = values.get("--fence");
	const timeoutMs = Number(values.get("--timeout-ms") ?? "25000");
	const killGraceMs = Number(values.get("--kill-grace-ms") ?? "1000");
	const proofMs = Number(values.get("--proof-ms") ?? "4000");
	if (
		!fence ||
		!isAbsolute(fence) ||
		resolve(fence) !== fence ||
		!fence.includes("/codex-quota/home-migration/") ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 25000 ||
		!Number.isInteger(killGraceMs) ||
		killGraceMs < 1 ||
		killGraceMs > 1000 ||
		!Number.isInteger(proofMs) ||
		proofMs < 1 ||
		proofMs > 4000
	)
		fail("arguments", 2);
	return {
		fence,
		timeoutMs,
		killGraceMs,
		proofMs,
		command: argv.slice(separator + 1),
	};
}

function readProcessStart(pid) {
	const psBin =
		process.env.FLYWHEEL_CODEX_RECONCILE_PS_BIN?.trim() || "/bin/ps";
	const result = spawnSync(psBin, ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 64 * 1024,
	});
	return result.status === 0 && !result.error
		? result.stdout.trim() || null
		: null;
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function sameProcess(pid, start) {
	if (!processAlive(pid)) return false;
	const observed = readProcessStart(pid);
	return observed === null ? null : observed === start;
}

function groupAlive(pgid) {
	if (process.env.FLYWHEEL_CODEX_RECONCILE_FORCE_GROUP_UNKNOWN === "1")
		return null;
	const probeBin = process.env.FLYWHEEL_CODEX_RECONCILE_GROUP_PROBE_BIN?.trim();
	if (probeBin) {
		const result = spawnSync(probeBin, [String(pgid)], {
			env: process.env,
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: 64 * 1024,
		});
		if (result.error) return null;
		if (result.status === 0) return true;
		if (result.status === 1) return false;
		return null;
	}
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		return null;
	}
}

function ensureParent(path) {
	const parent = dirname(path);
	const stat = lstatSync(parent);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("fence_parent_unsafe");
}

function fsyncDirectory(path) {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function atomicJson(path, value) {
	const directory = dirname(path);
	const temporary = join(
		directory,
		`.owner.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		const fd = openSync(temporary, fsConstants.O_RDONLY);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		fsyncDirectory(directory);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function readOwner(path) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
		throw new Error("fence_owner_unsafe");
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (
		value?.schemaVersion !== 1 ||
		!Number.isInteger(value.managerPid) ||
		value.managerPid <= 0 ||
		typeof value.managerStart !== "string" ||
		!value.managerStart ||
		(value.childPid !== null &&
			(!Number.isInteger(value.childPid) || value.childPid <= 0)) ||
		(value.childStart !== null &&
			(typeof value.childStart !== "string" || !value.childStart))
	)
		throw new Error("fence_owner_invalid");
	return value;
}

function releaseFence(fence) {
	const owner = join(fence, "owner.json");
	unlinkSync(owner);
	rmdirSync(fence);
	fsyncDirectory(dirname(fence));
}

function acquireFence(fence, managerStart) {
	ensureParent(fence);
	try {
		mkdirSync(fence, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		const stat = lstatSync(fence);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("fence_unsafe");
		const owner = readOwner(join(fence, "owner.json"));
		const manager = sameProcess(owner.managerPid, owner.managerStart);
		const child =
			owner.childPid && owner.childStart
				? sameProcess(owner.childPid, owner.childStart)
				: false;
		if (manager === null || child === null)
			throw new Error("fence_identity_unknown");
		if (manager || child) throw new Error("fence_busy");
		releaseFence(fence);
		mkdirSync(fence, { mode: 0o700 });
	}
	chmodSync(fence, 0o700);
	const owner = {
		schemaVersion: 1,
		managerPid: process.pid,
		managerStart,
		childPid: null,
		childStart: null,
		pgid: null,
		status: "starting",
		startedAt: new Date().toISOString(),
	};
	atomicJson(join(fence, "owner.json"), owner);
	return owner;
}

function signalGroup(pgid, signal) {
	const signalBin = process.env.FLYWHEEL_CODEX_RECONCILE_SIGNAL_BIN?.trim();
	if (signalBin) {
		const result = spawnSync(signalBin, [String(pgid), signal], {
			env: process.env,
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: 64 * 1024,
		});
		return !result.error && (result.status === 0 || result.status === 1);
	}
	try {
		process.kill(-pgid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") return false;
	}
	return true;
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function proveStopped(pgid, proofMs) {
	const deadline = Date.now() + proofMs;
	do {
		const group = groupAlive(pgid);
		if (group === false) return true;
		if (group === null) return false;
		await delay(50);
	} while (Date.now() < deadline);
	return groupAlive(pgid) === false;
}

const args = parse(process.argv.slice(2));
const managerStart = readProcessStart(process.pid);
if (!managerStart) fail("manager_identity_unavailable", 75);
let owner;
try {
	owner = acquireFence(args.fence, managerStart);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error), 75);
}

let child;
try {
	child = spawn(args.command[0], args.command.slice(1), {
		env: process.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
} catch (_error) {
	releaseFence(args.fence);
	fail("spawn_failed", 74);
}

let outputBytes = 0;
let forcedReason = null;
let closed = false;
let exitCode = null;
let exitSignal = null;
child.stdout.on("data", (chunk) => {
	outputBytes += chunk.length;
	if (outputBytes <= MAX_OUTPUT) process.stdout.write(chunk);
	else forcedReason ??= "output_unbounded";
});
child.stderr.on("data", (chunk) => {
	outputBytes += chunk.length;
	if (outputBytes <= MAX_OUTPUT) process.stderr.write(chunk);
	else forcedReason ??= "output_unbounded";
});
child.on("error", () => {
	forcedReason ??= "spawn_failed";
});
child.on("close", (code, signal) => {
	closed = true;
	exitCode = code;
	exitSignal = signal;
});

if (!child.pid) {
	releaseFence(args.fence);
	fail("spawn_failed", 74);
}
const childStart = readProcessStart(child.pid);
if (!childStart) {
	signalGroup(child.pid, "SIGKILL");
	owner.status = "exit_unproven";
	owner.childPid = child.pid;
	owner.childStart = null;
	owner.pgid = child.pid;
	atomicJson(join(args.fence, "owner.json"), owner);
	fail("child_identity_unavailable", 75);
}
owner.childPid = child.pid;
owner.childStart = childStart;
owner.pgid = child.pid;
owner.status = "running";
atomicJson(join(args.fence, "owner.json"), owner);

const deadline = Date.now() + args.timeoutMs;
while (!closed && !forcedReason && Date.now() < deadline) await delay(20);
if (!closed || forcedReason) {
	forcedReason ??= "timeout";
	owner.status = "terminating";
	atomicJson(join(args.fence, "owner.json"), owner);
	signalGroup(child.pid, "SIGTERM");
	await delay(args.killGraceMs);
	// This timer belongs to the manager, not the direct child: it always fires
	// even if that child exited immediately after TERM while a descendant stayed.
	signalGroup(child.pid, "SIGKILL");
}

if (closed && groupAlive(child.pid) === true) {
	forcedReason ??= "descendant_residue";
	signalGroup(child.pid, "SIGTERM");
	await delay(args.killGraceMs);
	signalGroup(child.pid, "SIGKILL");
}

const stopped = await proveStopped(child.pid, args.proofMs);
if (!stopped) {
	owner.status = "exit_unproven";
	owner.reason = forcedReason ?? "group_exit_unproven";
	atomicJson(join(args.fence, "owner.json"), owner);
	fail(owner.reason, 75);
}
releaseFence(args.fence);
if (forcedReason === "timeout") process.exit(124);
if (forcedReason) fail(forcedReason, 74);
if (exitSignal || exitCode === null) fail("child_signal", 74);
process.exit(exitCode);
