import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { withMkdirLock } from "../account-heal/mkdir-lock.js";

const MAX_BYTES = 64 * 1024;
const MAX_CONFIRMATIONS = 128;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDENTITY_KEY = /^[a-f0-9]{64}$/;
const PROVIDERS = new Set(["Claude", "Codex"]);
const STATUSES = new Set(["active", "canceled", "unknown"]);
const CONFIRMATION_KEYS = [
	"confirmedAt",
	"confirmedBy",
	"expiresOn",
	"identityKey",
	"profile",
	"provider",
	"sourceRef",
	"status",
] as const;

export type SubscriptionProvider = "Claude" | "Codex";
export type SubscriptionStatus = "active" | "canceled" | "unknown";

export interface SubscriptionConfirmation {
	provider: SubscriptionProvider;
	profile: string;
	identityKey: string;
	status: SubscriptionStatus;
	expiresOn: string | null;
	confirmedBy: string;
	confirmedAt: string;
	sourceRef: string;
}

export interface ManualSubscriptions {
	version: 1;
	confirmations: SubscriptionConfirmation[];
}

export type AccountSubscriptionManualErrorCode =
	| "missing_file"
	| "path_escape"
	| "unsafe_file"
	| "file_too_large"
	| "invalid_json"
	| "invalid_schema"
	| "future_confirmation"
	| "duplicate_confirmation"
	| "identity_missing"
	| "identity_mismatch"
	| "capacity_exceeded";

export class AccountSubscriptionManualError extends Error {
	constructor(readonly code: AccountSubscriptionManualErrorCode) {
		super(code);
		this.name = "AccountSubscriptionManualError";
	}
}

export interface AccountSubscriptionManualReadResult {
	data: ManualSubscriptions | null;
	error: AccountSubscriptionManualErrorCode | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function canonicalInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function calendarDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return (
		Number.isFinite(parsed) &&
		new Date(parsed).toISOString().slice(0, 10) === value
	);
}

function boundedText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const hasControl = [...trimmed].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
	return trimmed.length > 0 && trimmed.length <= max && !hasControl
		? trimmed
		: null;
}

function sameKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function confirmationKey(value: SubscriptionConfirmation): string {
	return [
		value.provider,
		value.profile,
		value.identityKey,
		value.confirmedAt,
	].join(":");
}

function parseConfirmation(
	value: unknown,
	generatedAtMs: number,
): SubscriptionConfirmation {
	if (!record(value) || !sameKeys(value, CONFIRMATION_KEYS)) {
		throw new AccountSubscriptionManualError("invalid_schema");
	}
	const confirmedBy = boundedText(value.confirmedBy, 128);
	const sourceRef = boundedText(value.sourceRef, 512);
	if (
		!PROVIDERS.has(String(value.provider)) ||
		typeof value.profile !== "string" ||
		!ACCOUNT_NAME.test(value.profile) ||
		typeof value.identityKey !== "string" ||
		!IDENTITY_KEY.test(value.identityKey) ||
		!STATUSES.has(String(value.status)) ||
		!canonicalInstant(value.confirmedAt) ||
		confirmedBy === null ||
		sourceRef === null
	) {
		throw new AccountSubscriptionManualError("invalid_schema");
	}
	if (Date.parse(value.confirmedAt) > generatedAtMs) {
		throw new AccountSubscriptionManualError("future_confirmation");
	}
	const status = value.status as SubscriptionStatus;
	if (
		!(
			(value.expiresOn === null && status !== "canceled") ||
			(status === "canceled" &&
				(value.expiresOn === null || calendarDate(value.expiresOn)))
		)
	) {
		throw new AccountSubscriptionManualError("invalid_schema");
	}
	return {
		provider: value.provider as SubscriptionProvider,
		profile: value.profile,
		identityKey: value.identityKey,
		status,
		expiresOn: value.expiresOn as string | null,
		confirmedBy,
		confirmedAt: value.confirmedAt,
		sourceRef,
	};
}

export function validateAccountSubscriptionManualValue(
	value: unknown,
	generatedAt: string,
): ManualSubscriptions {
	if (!canonicalInstant(generatedAt)) {
		throw new AccountSubscriptionManualError("invalid_schema");
	}
	if (
		!record(value) ||
		!sameKeys(value, ["version", "confirmations"]) ||
		value.version !== 1 ||
		!Array.isArray(value.confirmations) ||
		value.confirmations.length > MAX_CONFIRMATIONS
	) {
		throw new AccountSubscriptionManualError("invalid_schema");
	}
	const generatedAtMs = Date.parse(generatedAt);
	const confirmations = value.confirmations.map((item) =>
		parseConfirmation(item, generatedAtMs),
	);
	const keys = confirmations.map(confirmationKey);
	if (new Set(keys).size !== keys.length) {
		throw new AccountSubscriptionManualError("duplicate_confirmation");
	}
	return { version: 1, confirmations };
}

function assertWithinState(path: string, stateDir: string): void {
	const root = resolve(stateDir);
	const target = resolve(path);
	const lexical = relative(root, target);
	if (lexical === "" || lexical.startsWith("..") || lexical.startsWith("/")) {
		throw new AccountSubscriptionManualError("path_escape");
	}
	try {
		const stat = lstatSync(target);
		if (stat.isSymbolicLink()) {
			throw new AccountSubscriptionManualError("unsafe_file");
		}
		const realRelative = relative(realpathSync(root), realpathSync(target));
		if (
			realRelative === "" ||
			realRelative.startsWith("..") ||
			realRelative.startsWith("/")
		) {
			throw new AccountSubscriptionManualError("path_escape");
		}
	} catch (error) {
		if (error instanceof AccountSubscriptionManualError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new AccountSubscriptionManualError("unsafe_file");
		}
	}
}

function readSafeFile(path: string): string {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		throw new AccountSubscriptionManualError("missing_file");
	}
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o022) !== 0 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())
	) {
		throw new AccountSubscriptionManualError("unsafe_file");
	}
	if (stat.size > MAX_BYTES) {
		throw new AccountSubscriptionManualError("file_too_large");
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new AccountSubscriptionManualError("unsafe_file");
	}
	try {
		const opened = fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.dev !== stat.dev ||
			opened.ino !== stat.ino ||
			opened.size > MAX_BYTES
		) {
			throw new AccountSubscriptionManualError(
				opened.size > MAX_BYTES ? "file_too_large" : "unsafe_file",
			);
		}
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (count === 0) break;
			offset += count;
		}
		return bytes.subarray(0, offset).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new AccountSubscriptionManualError("invalid_json");
	}
}

export function defaultAccountSubscriptionManualPath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "account-subscriptions", "manual.json");
}

export function readAccountSubscriptionManual(input: {
	path: string;
	stateDir: string;
	generatedAt: string;
}): AccountSubscriptionManualReadResult {
	try {
		assertWithinState(input.path, input.stateDir);
		const raw = readSafeFile(input.path);
		return {
			data: validateAccountSubscriptionManualValue(
				parseJson(raw),
				input.generatedAt,
			),
			error: null,
		};
	} catch (error) {
		return {
			data: null,
			error:
				error instanceof AccountSubscriptionManualError
					? error.code
					: "unsafe_file",
		};
	}
}

export function resolveAccountSubscriptionConfirmation(
	confirmations: readonly SubscriptionConfirmation[],
	input: {
		provider: SubscriptionProvider;
		profile: string;
		identityKey: string | null;
	},
): {
	confirmation: SubscriptionConfirmation | null;
	error: "identity_missing" | "identity_mismatch" | null;
} {
	const named = confirmations.filter(
		(item) =>
			item.provider === input.provider && item.profile === input.profile,
	);
	if (named.length === 0) return { confirmation: null, error: null };
	if (input.identityKey === null) {
		return { confirmation: null, error: "identity_missing" };
	}
	const matched = named.filter(
		(item) => item.identityKey === input.identityKey,
	);
	if (matched.length === 0) {
		return { confirmation: null, error: "identity_mismatch" };
	}
	return {
		confirmation: [...matched].sort(
			(left, right) =>
				Date.parse(right.confirmedAt) - Date.parse(left.confirmedAt),
		)[0]!,
		error: null,
	};
}

function assertInputIdentities(
	confirmations: readonly SubscriptionConfirmation[],
	identityKeys: Readonly<Record<string, string>>,
): void {
	for (const confirmation of confirmations) {
		const current =
			identityKeys[`${confirmation.provider}:${confirmation.profile}`];
		if (current === undefined) {
			throw new AccountSubscriptionManualError("identity_missing");
		}
		if (current !== confirmation.identityKey) {
			throw new AccountSubscriptionManualError("identity_mismatch");
		}
	}
}

export function validateAccountSubscriptionManualInput(input: {
	inputPath: string;
	identityKeys: Readonly<Record<string, string>>;
	generatedAt: string;
}): ManualSubscriptions {
	const parsed = validateAccountSubscriptionManualValue(
		parseJson(readSafeFile(input.inputPath)),
		input.generatedAt,
	);
	assertInputIdentities(parsed.confirmations, input.identityKeys);
	return parsed;
}

function serialized(data: ManualSubscriptions): string {
	const output = `${JSON.stringify(data, null, 2)}\n`;
	if (
		data.confirmations.length > MAX_CONFIRMATIONS ||
		Buffer.byteLength(output) > MAX_BYTES
	) {
		throw new AccountSubscriptionManualError("capacity_exceeded");
	}
	return output;
}

function writeAtomic(path: string, output: string): void {
	const temporary = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		const bytes = Buffer.from(output);
		let offset = 0;
		while (offset < bytes.length) {
			offset += writeSync(fd, bytes, offset, bytes.length - offset);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		try {
			const directoryFd = openSync(dirname(path), constants.O_RDONLY);
			try {
				fsyncSync(directoryFd);
			} finally {
				closeSync(directoryFd);
			}
		} catch {
			// The file fsync+rename is authoritative on filesystems that reject dir fsync.
		}
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch {
			// Missing is the expected state after a successful rename.
		}
		throw error;
	}
}

export async function installAccountSubscriptionManual(input: {
	inputPath: string;
	targetPath: string;
	stateDir: string;
	identityKeys: Readonly<Record<string, string>>;
	generatedAt: string;
	lockTimeoutMs?: number;
}): Promise<{ installed: number; total: number }> {
	const incoming = validateAccountSubscriptionManualInput(input);
	assertWithinState(input.targetPath, input.stateDir);
	mkdirSync(dirname(input.targetPath), { recursive: true, mode: 0o700 });
	const parentRelative = relative(
		realpathSync(resolve(input.stateDir)),
		realpathSync(dirname(input.targetPath)),
	);
	if (parentRelative.startsWith("..") || parentRelative.startsWith("/")) {
		throw new AccountSubscriptionManualError("path_escape");
	}
	return withMkdirLock(
		`${input.targetPath}.lock`,
		async () => {
			const current = readAccountSubscriptionManual({
				path: input.targetPath,
				stateDir: input.stateDir,
				generatedAt: input.generatedAt,
			});
			if (current.error !== null && current.error !== "missing_file") {
				throw new AccountSubscriptionManualError(current.error);
			}
			const existing = current.data?.confirmations ?? [];
			const byKey = new Map(
				existing.map((item) => [confirmationKey(item), item]),
			);
			let installed = 0;
			for (const candidate of incoming.confirmations) {
				const key = confirmationKey(candidate);
				const previous = byKey.get(key);
				if (previous !== undefined) {
					if (JSON.stringify(previous) !== JSON.stringify(candidate)) {
						throw new AccountSubscriptionManualError("duplicate_confirmation");
					}
					continue;
				}
				byKey.set(key, candidate);
				installed += 1;
			}
			const merged: ManualSubscriptions = {
				version: 1,
				confirmations: [...byKey.values()].sort((left, right) =>
					confirmationKey(left).localeCompare(confirmationKey(right), "en-US"),
				),
			};
			writeAtomic(input.targetPath, serialized(merged));
			return { installed, total: merged.confirmations.length };
		},
		{ timeoutMs: input.lockTimeoutMs },
	);
}
