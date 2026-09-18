#!/usr/bin/env node
// Deployment receipt generation is read-only toward every credential/home.
// Only an explicitly supplied approved inventory is eligible; no auto-enrollment.
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	computeCodexHomeInventoryDigest,
	evaluateCodexHomeMigrationDeadlines,
} from "../packages/claude-runner/dist/index.js";

let temporary;
try {
	const args = process.argv.slice(2),
		values = new Map();
	const keys = [
		"--approved-homes",
		"--canonical-home",
		"--state-root",
		"--build-sha",
	];
	if (args.length !== 8) throw new Error("usage");
	for (let i = 0; i < args.length; i += 2) {
		if (!keys.includes(args[i]) || values.has(args[i]) || !args[i + 1])
			throw new Error("usage");
		values.set(args[i], args[i + 1]);
	}
	const approvedPath = values.get("--approved-homes"),
		canonicalHome = values.get("--canonical-home"),
		stateRoot = values.get("--state-root"),
		buildSha = values.get("--build-sha");
	if (
		![approvedPath, canonicalHome, stateRoot].every(
			(path) => isAbsolute(path) && resolve(path) === path,
		) ||
		!/^[a-f0-9]{40}$/.test(buildSha)
	)
		throw new Error("arguments");
	const approvedStat = lstatSync(approvedPath);
	if (
		!approvedStat.isFile() ||
		approvedStat.isSymbolicLink() ||
		approvedStat.size > 1024 * 1024
	)
		throw new Error("approved_inventory");
	const input = JSON.parse(readFileSync(approvedPath, "utf8"));
	if (!Array.isArray(input) || input.length === 0 || input.length > 5000)
		throw new Error("approved_inventory");
	const canonicalPath = join(canonicalHome, "auth.json"),
		canonical = lstatSync(canonicalPath);
	if (
		!canonical.isFile() ||
		canonical.isSymbolicLink() ||
		(canonical.mode & 0o777) !== 0o600
	)
		throw new Error("canonical_unavailable");
	const seen = new Set(),
		ids = new Set(),
		checkedAt = new Date().toISOString();
	const approved = input.map((entry) => {
		if (
			typeof entry?.id !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(entry.id) ||
			entry.id.includes("..") ||
			ids.has(entry.id)
		)
			throw new Error("approved_inventory");
		ids.add(entry.id);
		return entry;
	});
	const inventoryDigest = computeCodexHomeInventoryDigest(approved);
	const migrationRoot = join(stateRoot, "codex-quota", "home-migration");
	const migrationStatePath = join(migrationRoot, "state.json");
	const migrationStateStat = lstatSync(migrationStatePath);
	if (
		!migrationStateStat.isFile() ||
		migrationStateStat.isSymbolicLink() ||
		migrationStateStat.size > 1024 * 1024
	)
		throw new Error("migration_state_unavailable");
	const attemptsPath = join(migrationRoot, "attempts");
	const attemptsStat = lstatSync(attemptsPath);
	if (!attemptsStat.isDirectory() || attemptsStat.isSymbolicLink())
		throw new Error("migration_receipts_unavailable");
	const attemptNames = readdirSync(attemptsPath)
		.filter((name) => name.endsWith(".json"))
		.sort();
	if (attemptNames.length > 50_000)
		throw new Error("migration_receipts_unbounded");
	const attempts = attemptNames.map((name) => {
		const path = join(attemptsPath, name),
			stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
			throw new Error("migration_receipt_unsafe");
		return JSON.parse(readFileSync(path, "utf8"));
	});
	const statuses = evaluateCodexHomeMigrationDeadlines(
		JSON.parse(readFileSync(migrationStatePath, "utf8")),
		attempts,
		new Date(),
	);
	const byId = new Map(statuses.map((status) => [status.homeId, status]));
	if (
		statuses.length !== approved.length ||
		approved.some((entry) => {
			const status = byId.get(entry.id);
			return (
				!status ||
				!status.satisfied ||
				status.home !== entry.home ||
				status.inventoryDigest !== inventoryDigest
			);
		})
	)
		throw new Error("migration_not_satisfied");
	const homes = input
		.map((entry) => {
			if (
				typeof entry?.home !== "string" ||
				!isAbsolute(entry.home) ||
				resolve(entry.home) !== entry.home ||
				seen.has(entry.home) ||
				!["managed", "independent"].includes(entry.ownership)
			)
				throw new Error("approved_inventory");
			seen.add(entry.home);
			const home = lstatSync(entry.home);
			if (!home.isDirectory() || home.isSymbolicLink())
				throw new Error("home_unavailable");
			let credentialShared = false;
			if (entry.ownership === "managed") {
				const auth = join(entry.home, "auth.json");
				if (
					!lstatSync(auth).isSymbolicLink() ||
					realpathSync(auth) !== realpathSync(canonicalPath)
				)
					throw new Error("credential_not_shared");
				try {
					lstatSync(join(entry.home, ".credential-copy-pending"));
					throw new Error("credential_copy_pending");
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				credentialShared = true;
			}
			return {
				home: entry.home,
				ownership: entry.ownership,
				credentialShared,
				checkedAt,
			};
		})
		.sort((a, b) => a.home.localeCompare(b.home));
	const directory = join(stateRoot, "codex-quota");
	for (const path of [stateRoot, directory]) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("output_unsafe");
	}
	const output = join(directory, "readiness-receipt.json");
	try {
		const stat = lstatSync(output);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error("output_unsafe");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	temporary = join(directory, `.readiness-${randomUUID()}.tmp`);
	writeFileSync(
		temporary,
		`${JSON.stringify({ schemaVersion: 1, buildSha, inventoryDigest, createdAt: checkedAt, homes }, null, 2)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	const fd = openSync(temporary, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, output);
	const directoryFd = openSync(directory, fsConstants.O_RDONLY);
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
	temporary = undefined;
	console.log("CODEX_READINESS_RECEIPT written");
} catch {
	if (temporary) rmSync(temporary, { force: true });
	console.error("CODEX_READINESS_RECEIPT unavailable");
	process.exitCode = 1;
}
