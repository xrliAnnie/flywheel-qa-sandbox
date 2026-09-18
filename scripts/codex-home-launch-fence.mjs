#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { processAlive, withMkdirLock } from "../packages/config/dist/index.js";

function fail(reason, code = 2) {
	process.stderr.write(
		`CODEX_HOME_LAUNCH_FENCE unavailable reason=${reason}\n`,
	);
	process.exit(code);
}

function parse(argv) {
	if (argv[0] !== "acquire") fail("usage");
	const values = new Map();
	for (let index = 1; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (
			!["--home", "--lead", "--state-root"].includes(key) ||
			!value ||
			values.has(key)
		)
			fail("usage");
		values.set(key, value);
	}
	const home = values.get("--home");
	const lead = values.get("--lead");
	const stateRoot = values.get("--state-root");
	if (
		!home ||
		!stateRoot ||
		!isAbsolute(home) ||
		resolve(home) !== home ||
		!isAbsolute(stateRoot) ||
		resolve(stateRoot) !== stateRoot ||
		!/^[-A-Za-z0-9._]+\/[-A-Za-z0-9._]+$/.test(lead ?? "")
	)
		fail("arguments");
	return { home, lead, stateRoot };
}

function ensureDirectory(path) {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("unsafe_directory");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		mkdirSync(path, { mode: 0o700 });
	}
	chmodSync(path, 0o700);
}

function fsyncDirectory(path) {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function readLease(path) {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
			throw new Error("lease_unsafe");
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (
			value?.schemaVersion !== 1 ||
			!Number.isInteger(value.pid) ||
			value.pid <= 0 ||
			typeof value.processStartTime !== "string" ||
			!value.processStartTime ||
			typeof value.home !== "string" ||
			typeof value.lead !== "string"
		)
			throw new Error("lease_invalid");
		return value;
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function writeLease(path, value) {
	const directory = dirname(path);
	const temporary = join(
		directory,
		`.lease.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
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

function readProcessStart(pid) {
	const psBin = process.env.FLYWHEEL_CODEX_FENCE_PS_BIN?.trim() || "/bin/ps";
	const result = spawnSync(psBin, ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: 2_000,
		maxBuffer: 64 * 1024,
	});
	return result.status === 0 && !result.error
		? result.stdout.trim() || null
		: null;
}

const args = parse(process.argv.slice(2));
const ownerPid = process.ppid;
const ownerStart = readProcessStart(ownerPid);
if (!ownerStart) fail("owner_identity_unavailable", 5);
const migrationRoot = join(args.stateRoot, "codex-quota", "home-migration");
const fences = join(migrationRoot, "lead-fences");
const leases = join(migrationRoot, "lead-leases");
try {
	ensureDirectory(args.stateRoot);
	ensureDirectory(join(args.stateRoot, "codex-quota"));
	ensureDirectory(migrationRoot);
	ensureDirectory(fences);
	ensureDirectory(leases);
} catch {
	fail("control_state_unavailable", 5);
}
const key = createHash("sha256").update(args.home).digest("hex");
const lockPath = join(fences, key);
const leasePath = join(leases, `${key}.json`);
try {
	await withMkdirLock(
		lockPath,
		async () => {
			const existing = readLease(leasePath);
			if (existing) {
				if (existing.home !== args.home || existing.lead !== args.lead)
					throw new Error("lease_identity_mismatch");
				const liveStart = processAlive(existing.pid)
					? readProcessStart(existing.pid)
					: null;
				if (
					existing.pid === ownerPid &&
					existing.processStartTime === ownerStart &&
					liveStart === ownerStart
				)
					return;
				if (liveStart === null && processAlive(existing.pid))
					throw new Error("lease_owner_unknown");
				if (liveStart === existing.processStartTime)
					throw new Error("lease_busy");
				unlinkSync(leasePath);
				fsyncDirectory(leases);
			}
			writeLease(leasePath, {
				schemaVersion: 1,
				pid: ownerPid,
				processStartTime: ownerStart,
				home: args.home,
				lead: args.lead,
				acquiredAt: new Date().toISOString(),
			});
		},
		{ timeoutMs: 5_000, bare: true },
	);
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	fail(reason.replace(/[\r\n]/g, " "), reason === "lease_busy" ? 3 : 5);
}
process.stdout.write(
	`CODEX_HOME_LAUNCH_FENCE acquired home=${args.home} lead=${args.lead}\n`,
);
