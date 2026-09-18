import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

const SHA256_RE = /^[a-f0-9]{64}$/;
const BUILD_SHA_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CodexHomeOwnership = "managed" | "independent";

export interface CodexHomeInventoryDigestInput {
	home: string;
	ownership: CodexHomeOwnership;
	[key: string]: unknown;
}

export type CodexHomeAttemptSource =
	| "health"
	| "updater"
	| "restart-window"
	| "manual";

export type CodexHomeAttemptResult =
	| "done"
	| "skipped"
	| "already-satisfied"
	| "failed";

export type CodexHomeAttemptReason =
	| "active_process"
	| "active_lease"
	| "lock_busy"
	| "process_unknown"
	| "lead_authority_unknown"
	| "launch_fence_unavailable"
	| "unsafe_path"
	| "backup_failed"
	| "mutation_failed"
	| "durability_uncertain"
	| "receipt_failed"
	| "linked"
	| "marker_cleared"
	| "canonical_link_verified";

export interface CodexHomeAttemptReceipt {
	schemaVersion: 1;
	attemptId: string;
	at: string;
	homeId: string;
	home: string;
	inventoryDigest: string;
	source: CodexHomeAttemptSource;
	buildSha: string;
	result: CodexHomeAttemptResult;
	reason: CodexHomeAttemptReason;
	satisfied: boolean;
	backupRef: string | null;
	postcondition: Record<string, unknown> | null;
}

export interface CodexHomeMigrationEnrollment {
	id: string;
	home: string;
	ownership: CodexHomeOwnership;
	enrolledAt: string;
}

export interface CodexHomeMigrationState {
	schemaVersion: 1;
	inventoryDigest: string;
	overdueDays: number;
	enrolledAt: string;
	homes: CodexHomeMigrationEnrollment[];
}

export interface UpdateCodexHomeMigrationStateInput {
	stateRoot: string;
	inventoryDigest: string;
	overdueDays: number;
	now: Date;
	homes: Array<{
		id: string;
		home: string;
		ownership: CodexHomeOwnership;
		pendingAt?: string;
	}>;
}

const RESULTS = new Set<CodexHomeAttemptResult>([
	"done",
	"skipped",
	"already-satisfied",
	"failed",
]);
const SOURCES = new Set<CodexHomeAttemptSource>([
	"health",
	"updater",
	"restart-window",
	"manual",
]);
const REASONS = new Set<CodexHomeAttemptReason>([
	"active_process",
	"active_lease",
	"lock_busy",
	"process_unknown",
	"lead_authority_unknown",
	"launch_fence_unavailable",
	"unsafe_path",
	"backup_failed",
	"mutation_failed",
	"durability_uncertain",
	"receipt_failed",
	"linked",
	"marker_cleared",
	"canonical_link_verified",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNormalizedAbsolutePath(path: unknown): path is string {
	return (
		typeof path === "string" &&
		isAbsolute(path) &&
		resolve(path) === path &&
		!path.includes("\0")
	);
}

function isSafeRelativeReference(value: unknown): value is string | null {
	if (value === null) return true;
	if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
		return false;
	}
	const normalized = relative(".", resolve(".", value));
	return normalized === value && value !== ".." && !value.startsWith("../");
}

function compareInventoryHomes(
	a: { home: string },
	b: { home: string },
): number {
	return a.home.localeCompare(b.home, "en");
}

export function computeCodexHomeInventoryDigest(
	homes: CodexHomeInventoryDigestInput[],
): string {
	const seen = new Set<string>();
	const normalized = homes.map(({ home, ownership }) => {
		if (
			!isNormalizedAbsolutePath(home) ||
			!(["managed", "independent"] as const).includes(ownership) ||
			seen.has(home)
		) {
			throw new Error("invalid approved Codex home inventory");
		}
		seen.add(home);
		return { home, ownership };
	});
	normalized.sort(compareInventoryHomes);
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function isCodexHomeMigrationOverdue(
	enrolledAt: string,
	days: number,
	now: Date,
	satisfied: boolean,
): boolean {
	if (satisfied) return false;
	if (
		!isIsoInstant(enrolledAt) ||
		!Number.isInteger(days) ||
		days < 1 ||
		days > 30
	) {
		throw new Error("invalid Codex home migration deadline");
	}
	const nowMs = now.getTime();
	if (!Number.isFinite(nowMs)) throw new Error("invalid current time");
	return nowMs >= Date.parse(enrolledAt) + days * 24 * 60 * 60 * 1000;
}

export function validateCodexHomeAttemptReceipt(
	value: unknown,
	expectedInventoryDigest?: string,
): value is CodexHomeAttemptReceipt {
	if (!isPlainObject(value)) return false;
	if (
		value.schemaVersion !== 1 ||
		typeof value.attemptId !== "string" ||
		!UUID_RE.test(value.attemptId) ||
		!isIsoInstant(value.at) ||
		typeof value.homeId !== "string" ||
		!SAFE_ID_RE.test(value.homeId) ||
		value.homeId.includes("..") ||
		!isNormalizedAbsolutePath(value.home) ||
		typeof value.inventoryDigest !== "string" ||
		!SHA256_RE.test(value.inventoryDigest) ||
		(expectedInventoryDigest !== undefined &&
			value.inventoryDigest !== expectedInventoryDigest) ||
		typeof value.source !== "string" ||
		!SOURCES.has(value.source as CodexHomeAttemptSource) ||
		typeof value.buildSha !== "string" ||
		!BUILD_SHA_RE.test(value.buildSha) ||
		typeof value.result !== "string" ||
		!RESULTS.has(value.result as CodexHomeAttemptResult) ||
		typeof value.reason !== "string" ||
		!REASONS.has(value.reason as CodexHomeAttemptReason) ||
		typeof value.satisfied !== "boolean" ||
		!isSafeRelativeReference(value.backupRef) ||
		!(value.postcondition === null || isPlainObject(value.postcondition))
	) {
		return false;
	}
	const successful =
		value.result === "done" || value.result === "already-satisfied";
	return value.satisfied === successful;
}

function ensurePlainDirectory(path: string, create: boolean): void {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`unsafe control directory: ${path}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create)
			throw error;
		mkdirSync(path, { mode: 0o700 });
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`unsafe control directory: ${path}`);
		}
	}
	chmodSync(path, 0o700);
}

function controlDirectory(stateRoot: string): string {
	if (!isNormalizedAbsolutePath(stateRoot)) {
		throw new Error("state root must be a normalized absolute path");
	}
	ensurePlainDirectory(stateRoot, false);
	const quotaDirectory = join(stateRoot, "codex-quota");
	ensurePlainDirectory(quotaDirectory, true);
	const directory = join(quotaDirectory, "home-migration");
	ensurePlainDirectory(directory, true);
	return directory;
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function assertPlainFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`unsafe control file: ${path}`);
	}
}

function atomicReplaceJson(path: string, value: unknown): void {
	const directory = dirname(path);
	const existing = existsSync(path);
	if (existing) assertPlainFile(path);
	const temporary = join(
		directory,
		`.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(
			temporary,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				(fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		fsyncDirectory(directory);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
		throw error;
	}
}

function parseMigrationState(value: unknown): CodexHomeMigrationState {
	if (
		!isPlainObject(value) ||
		value.schemaVersion !== 1 ||
		typeof value.inventoryDigest !== "string" ||
		!SHA256_RE.test(value.inventoryDigest) ||
		typeof value.overdueDays !== "number" ||
		!Number.isInteger(value.overdueDays) ||
		value.overdueDays < 1 ||
		value.overdueDays > 30 ||
		!isIsoInstant(value.enrolledAt) ||
		!Array.isArray(value.homes)
	) {
		throw new Error("corrupt Codex home migration state");
	}
	const seenIds = new Set<string>();
	const seenHomes = new Set<string>();
	const homes = value.homes.map((entry) => {
		if (
			!isPlainObject(entry) ||
			typeof entry.id !== "string" ||
			!SAFE_ID_RE.test(entry.id) ||
			entry.id.includes("..") ||
			!isNormalizedAbsolutePath(entry.home) ||
			!(["managed", "independent"] as const).includes(
				entry.ownership as CodexHomeOwnership,
			) ||
			!isIsoInstant(entry.enrolledAt) ||
			seenIds.has(entry.id) ||
			seenHomes.has(entry.home)
		) {
			throw new Error("corrupt Codex home migration state");
		}
		seenIds.add(entry.id);
		seenHomes.add(entry.home);
		return {
			id: entry.id,
			home: entry.home,
			ownership: entry.ownership as CodexHomeOwnership,
			enrolledAt: entry.enrolledAt,
		};
	});
	return {
		schemaVersion: 1,
		inventoryDigest: value.inventoryDigest,
		overdueDays: value.overdueDays,
		enrolledAt: value.enrolledAt,
		homes,
	};
}

export function updateCodexHomeMigrationState(
	input: UpdateCodexHomeMigrationStateInput,
): CodexHomeMigrationState {
	if (
		!SHA256_RE.test(input.inventoryDigest) ||
		!Number.isInteger(input.overdueDays) ||
		input.overdueDays < 1 ||
		input.overdueDays > 30 ||
		!Number.isFinite(input.now.getTime()) ||
		input.homes.length === 0
	) {
		throw new Error("invalid Codex home migration state input");
	}
	const directory = controlDirectory(input.stateRoot);
	const path = join(directory, "state.json");
	let previous: CodexHomeMigrationState | null = null;
	if (existsSync(path)) {
		assertPlainFile(path);
		previous = parseMigrationState(JSON.parse(readFileSync(path, "utf8")));
	}
	const priorById = new Map(previous?.homes.map((home) => [home.id, home]));
	const priorByPath = new Map(previous?.homes.map((home) => [home.home, home]));
	const now = input.now.toISOString();
	const seenIds = new Set<string>();
	const seenHomes = new Set<string>();
	const homes = input.homes.map((home) => {
		if (
			!SAFE_ID_RE.test(home.id) ||
			home.id.includes("..") ||
			!isNormalizedAbsolutePath(home.home) ||
			!(["managed", "independent"] as const).includes(home.ownership) ||
			seenIds.has(home.id) ||
			seenHomes.has(home.home) ||
			(home.pendingAt !== undefined && !isIsoInstant(home.pendingAt))
		) {
			throw new Error("invalid Codex home migration enrollment");
		}
		seenIds.add(home.id);
		seenHomes.add(home.home);
		const prior = priorById.get(home.id);
		const pathPrior = priorByPath.get(home.home);
		if (
			(prior &&
				(prior.home !== home.home || prior.ownership !== home.ownership)) ||
			(pathPrior && pathPrior.id !== home.id)
		) {
			throw new Error("Codex home migration enrollment identity changed");
		}
		const enrolledAt =
			[prior?.enrolledAt, home.pendingAt, now]
				.filter((value): value is string => value !== undefined)
				.sort()[0] ?? now;
		return { ...home, enrolledAt, pendingAt: undefined };
	});
	homes.sort((a, b) => a.id.localeCompare(b.id, "en"));
	const enrolledAt = homes.map((home) => home.enrolledAt).sort()[0] ?? now;
	const state: CodexHomeMigrationState = {
		schemaVersion: 1,
		inventoryDigest: input.inventoryDigest,
		overdueDays: input.overdueDays,
		enrolledAt,
		homes: homes.map(({ id, home, ownership, enrolledAt: enrolled }) => ({
			id,
			home,
			ownership,
			enrolledAt: enrolled,
		})),
	};
	atomicReplaceJson(path, state);
	return state;
}

export function writeCodexHomeAttemptReceipt(input: {
	stateRoot: string;
	receipt: unknown;
}): string {
	if (!validateCodexHomeAttemptReceipt(input.receipt)) {
		throw new Error("invalid Codex home attempt receipt");
	}
	const directory = controlDirectory(input.stateRoot);
	const attempts = join(directory, "attempts");
	ensurePlainDirectory(attempts, true);
	const path = join(attempts, `${input.receipt.attemptId}.json`);
	const temporary = join(
		attempts,
		`.${input.receipt.attemptId}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(
			temporary,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				(fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeFileSync(fd, `${JSON.stringify(input.receipt, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		try {
			linkSync(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error("Codex home attempt receipt already exists");
			}
			throw error;
		}
		unlinkSync(temporary);
		chmodSync(path, 0o600);
		fsyncDirectory(attempts);
		return path;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
		throw error;
	}
}
