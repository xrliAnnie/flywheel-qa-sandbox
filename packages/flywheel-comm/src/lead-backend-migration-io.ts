import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BackendMigrationPlan } from "./lead-backend-migration.js";

function reject(reason: string): never {
	throw new Error(`lead_backend_migration: ${reason}`);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return reject("invalid intent object");
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !keys.includes(key)))
		return reject("unexpected intent field");
	return row;
}
const fields = [
	"backend",
	"codexProfile",
	"model",
	"effort",
	"canSpawnRunners",
	"codexRunnerActions",
];
/** Intent is immutable planning input; mutable execution evidence lives in a separate receipt. */
export function parseMigrationIntent(value: unknown): BackendMigrationPlan {
	const row = record(value, [
		"version",
		"migrationId",
		"issue",
		"projectName",
		"leadId",
		"deploymentSha",
		"createdAt",
		"phase",
		"expected",
		"previous",
		"target",
	]);
	if (
		row.version !== 1 ||
		row.migrationId !== "FLY-2459-honey-lemon" ||
		row.issue !== "FLY-2459" ||
		row.projectName !== "flywheel" ||
		row.leadId !== "flywheel-product-lead" ||
		row.phase !== "prepared"
	)
		return reject("unsupported intent identity or phase");
	if (
		typeof row.deploymentSha !== "string" ||
		!/^[a-f0-9]{40}$/.test(row.deploymentSha)
	)
		return reject("invalid deployment hash");
	if (
		typeof row.createdAt !== "string" ||
		!Number.isFinite(Date.parse(row.createdAt)) ||
		new Date(row.createdAt).toISOString() !== row.createdAt
	)
		return reject("invalid creation time");
	const expected = record(row.expected, [
		"rowSha",
		"projectSha",
		"manifestSha",
		"plistSha",
	]);
	for (const key of ["rowSha", "projectSha", "manifestSha", "plistSha"])
		if (
			typeof expected[key] !== "string" ||
			!/^[a-f0-9]{64}$/.test(expected[key] as string)
		)
			return reject("invalid expected hash");
	const previous = record(row.previous, fields);
	for (const [key, value] of Object.entries(previous)) {
		if (key === "canSpawnRunners" || key === "codexRunnerActions") {
			if (typeof value !== "boolean") return reject("invalid previous boolean");
		} else if (
			typeof value !== "string" ||
			!/^[a-zA-Z0-9_.[\]-]{1,128}$/.test(value)
		)
			return reject("invalid previous field");
	}
	if (
		previous.canSpawnRunners !== true ||
		(previous.backend !== undefined && previous.backend !== "claude-code")
	)
		return reject("unsupported source fields");
	const target = record(row.target, fields);
	if (
		!isDeepStrictEqual(target, {
			backend: "codex-app-server",
			codexProfile: "full-access",
			model: "gpt-6-astra",
			effort: "high",
			canSpawnRunners: true,
			codexRunnerActions: true,
		})
	)
		return reject("unsupported target fields");
	return structuredClone(row) as unknown as BackendMigrationPlan;
}
function inspectDirectory(path: string, privateMode = false): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		reject("invalid directory path");
	if (
		stat.uid !== process.getuid?.() ||
		(privateMode ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)
	)
		reject("unsafe directory permissions");
}
function validatePath(home: string, path: string, create: boolean): string {
	const root = resolve(home);
	const state = join(root, ".flywheel");
	const dir = join(state, "lead-backend-migrations");
	if (path !== join(dir, "FLY-2459-honey-lemon.json"))
		return reject("unsupported intent path");
	inspectDirectory(root);
	inspectDirectory(state);
	if (create && !existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
	inspectDirectory(dir, true);
	return dir;
}
function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
export function readMigrationIntent(
	home: string,
	path: string,
): BackendMigrationPlan {
	return readMigrationIntentRecord(home, path).plan;
}
/** Parse and hash one no-follow read; every execution artifact binds to these exact bytes. */
export function readMigrationIntentRecord(
	home: string,
	path: string,
): { plan: BackendMigrationPlan; intentSha: string } {
	validatePath(home, path, false);
	return readPrivateIntent(path);
}
export function readCommittedMigrationIntent(home: string): {
	plan: BackendMigrationPlan;
	intentSha: string;
} {
	return readPrivateIntent(
		join(
			migrationArtifactDirectory(home),
			"FLY-2459-honey-lemon.committed.json",
		),
	);
}
function readPrivateIntent(path: string): {
	plan: BackendMigrationPlan;
	intentSha: string;
} {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > 65536
		)
			return reject("unsafe intent file permissions or size");
		const bytes = readFileSync(fd);
		const plan = parseMigrationIntent(JSON.parse(bytes.toString("utf8")));
		return {
			plan,
			intentSha: createHash("sha256").update(bytes).digest("hex"),
		};
	} finally {
		closeSync(fd);
	}
}
export function writeMigrationIntent(
	home: string,
	path: string,
	value: unknown,
): "created" | "unchanged" {
	const plan = parseMigrationIntent(value);
	const dir = validatePath(home, path, true);
	// link() publishes atomically without replacing any existing path, including a symlink.
	const temp = join(dir, `.intent-${randomUUID()}.tmp`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(plan, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		try {
			linkSync(temp, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!isDeepStrictEqual(readMigrationIntent(home, path), plan))
				return reject("intent conflict");
			return "unchanged";
		}
	} finally {
		unlinkSync(temp);
		syncDirectory(dir);
	}
	syncDirectory(dirname(dir));
	return "created";
}

/** Internal receipt writers share the immutable intent directory's path/owner checks. */
export function migrationArtifactDirectory(home: string): string {
	return validatePath(
		home,
		join(
			resolve(home),
			".flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json",
		),
		false,
	);
}
