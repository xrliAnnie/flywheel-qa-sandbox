/**
 * FLY-2864 — per-account Codex (ChatGPT) subscription readings for the account
 * page's "next charge" column. A separate file so the Codex quota store's
 * schema and validator stay untouched. Holds no token, email or account id:
 * only the slot name, the install identity digest, and dates.
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_STORE_BYTES = 256 * 1024;
const MAX_ACCOUNTS = 64;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDENTITY_KEY = /^[a-f0-9]{64}$/;
const SAFE_NOTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROBLEM_NOTE = /^problem:[a-z][a-z0-9_]{0,63}$/;

export type CodexSubscriptionStatus =
	| "active"
	| "canceled"
	| "none"
	| "unknown";

export interface CodexSubscriptionReading {
	name: string;
	/** `codexInstallAccountKey(identity)`; absent only for identity-less problem slots. */
	identityKey?: string;
	observedAt: string | null;
	status: CodexSubscriptionStatus;
	/** The next charge; only for an active, renewing subscription. */
	renewsAt: string | null;
	/** Service end of a canceled subscription, when the provider gave one. */
	endsAt: string | null;
	/** Why this round did not read it (unauthorized, blocked, problem:<code>, ...). */
	note: string | null;
}

export interface CodexSubscriptionStore {
	version: 1;
	generatedAt: string;
	accounts: CodexSubscriptionReading[];
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function instant(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value
	);
}

function validReading(value: unknown): value is CodexSubscriptionReading {
	if (
		!record(value) ||
		typeof value.name !== "string" ||
		!ACCOUNT_NAME.test(value.name) ||
		(value.note !== null &&
			(typeof value.note !== "string" || !SAFE_NOTE.test(value.note))) ||
		(value.observedAt !== null && !instant(value.observedAt)) ||
		(value.renewsAt !== null && !instant(value.renewsAt)) ||
		(value.endsAt !== null && !instant(value.endsAt))
	) {
		return false;
	}
	if (!("identityKey" in value)) {
		// Identity-less rows are problem markers only: no facts, no carry-over.
		return (
			value.status === "unknown" &&
			value.observedAt === null &&
			value.renewsAt === null &&
			value.endsAt === null &&
			typeof value.note === "string" &&
			PROBLEM_NOTE.test(value.note)
		);
	}
	if (
		typeof value.identityKey !== "string" ||
		!IDENTITY_KEY.test(value.identityKey)
	) {
		return false;
	}
	switch (value.status) {
		case "active":
			return (
				value.observedAt !== null &&
				value.renewsAt !== null &&
				value.endsAt === null
			);
		case "canceled":
			return value.observedAt !== null && value.renewsAt === null;
		case "none":
			return (
				value.observedAt !== null &&
				value.renewsAt === null &&
				value.endsAt === null
			);
		case "unknown":
			return (
				value.observedAt === null &&
				value.renewsAt === null &&
				value.endsAt === null
			);
		default:
			return false;
	}
}

export function defaultCodexSubscriptionStorePath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "codex-quota", "codex-subscriptions.json");
}

/** null on any read or validation failure; the page then shows "读不到". */
export function readCodexSubscriptionStore(
	path: string,
): CodexSubscriptionStore | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	if (raw.length > MAX_STORE_BYTES) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		!record(parsed) ||
		parsed.version !== 1 ||
		!instant(parsed.generatedAt) ||
		!Array.isArray(parsed.accounts) ||
		parsed.accounts.length > MAX_ACCOUNTS ||
		!parsed.accounts.every(validReading)
	) {
		return null;
	}
	const names = (parsed.accounts as CodexSubscriptionReading[]).map(
		(account) => account.name,
	);
	return new Set(names).size === names.length
		? (parsed as unknown as CodexSubscriptionStore)
		: null;
}

export function writeCodexSubscriptionStore(
	path: string,
	store: CodexSubscriptionStore,
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}`;
	const handle = openSync(temp, "w", 0o600);
	try {
		writeSync(handle, `${JSON.stringify(store, null, 2)}\n`);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	try {
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* temp is already gone */
		}
		throw error;
	}
}
