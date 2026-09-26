/**
 * FLY-2875 — the report-hosting Vercel account reading for the account page.
 *
 * One file, written by the on-demand page refresh and read by the page GET.
 * Holds no token, no plaintext email and no billing contact: only a digest of
 * the account email (for alias matching), public handles, the plan, the
 * billing period end and the report Blob store's status. A reading either has
 * facts or a fixed note for each half, never both.
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

const MAX_STORE_BYTES = 64 * 1024;

export const VERCEL_READ_NOTES = [
	"refresh_failed",
	"no_token",
	"no_store_binding",
	"registry_unreadable",
	"unauthorized",
	"forbidden",
	"not_found",
	"owner_mismatch",
	"rate_limited",
	"http_error",
	"network",
	"malformed",
	"deadline",
] as const;
export type VercelReadNote = (typeof VERCEL_READ_NOTES)[number];

export const VERCEL_EMAIL_DIGEST = /^[a-f0-9]{64}$/;
export const VERCEL_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const VERCEL_TEAM_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const VERCEL_PLAN = /^[a-z][a-z0-9_-]{0,31}$/;
export const VERCEL_BLOB_STATUS = /^[a-z][a-z0-9-]{0,63}$/;

export interface VercelAccountFacts {
	/** sha256 of the trimmed, lower-cased account email. */
	emailSha256: string;
	username: string;
	teamSlug: string;
	/** Lower-case plan token: pro, hobby, enterprise, ... */
	plan: string;
	billingStatus: string | null;
	/** End of the current billing period (canonical ISO). */
	periodEnd: string | null;
	canceled: boolean;
}

export interface VercelBlobFacts {
	status: string;
	sizeBytes: number;
	count: number;
	usageQuotaExceeded: boolean;
}

export interface VercelAccountStore {
	version: 1;
	observedAt: string;
	account: VercelAccountFacts | null;
	accountNote: VercelReadNote | null;
	/** Present only when the report store is owned by `account`'s team. */
	blob: VercelBlobFacts | null;
	blobNote: VercelReadNote | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function instant(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value
	);
}

function note(value: unknown): value is VercelReadNote {
	return (
		typeof value === "string" &&
		(VERCEL_READ_NOTES as readonly string[]).includes(value)
	);
}

function token(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && pattern.test(value);
}

function count(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validAccount(value: unknown): value is VercelAccountFacts {
	return (
		record(value) &&
		sameKeys(value, [
			"emailSha256",
			"username",
			"teamSlug",
			"plan",
			"billingStatus",
			"periodEnd",
			"canceled",
		]) &&
		token(value.emailSha256, VERCEL_EMAIL_DIGEST) &&
		token(value.username, VERCEL_USERNAME) &&
		token(value.teamSlug, VERCEL_TEAM_SLUG) &&
		token(value.plan, VERCEL_PLAN) &&
		(value.billingStatus === null || token(value.billingStatus, VERCEL_PLAN)) &&
		(value.periodEnd === null || instant(value.periodEnd)) &&
		typeof value.canceled === "boolean"
	);
}

function validBlob(value: unknown): value is VercelBlobFacts {
	return (
		record(value) &&
		sameKeys(value, ["status", "sizeBytes", "count", "usageQuotaExceeded"]) &&
		token(value.status, VERCEL_BLOB_STATUS) &&
		count(value.sizeBytes) &&
		count(value.count) &&
		typeof value.usageQuotaExceeded === "boolean"
	);
}

function exactlyOne(
	facts: unknown,
	factNote: unknown,
	valid: (value: unknown) => boolean,
): boolean {
	return facts === null ? note(factNote) : factNote === null && valid(facts);
}

export function validVercelAccountStore(
	value: unknown,
): value is VercelAccountStore {
	return (
		record(value) &&
		sameKeys(value, [
			"version",
			"observedAt",
			"account",
			"accountNote",
			"blob",
			"blobNote",
		]) &&
		value.version === 1 &&
		instant(value.observedAt) &&
		exactlyOne(value.account, value.accountNote, validAccount) &&
		exactlyOne(value.blob, value.blobNote, validBlob)
	);
}

/** Both halves unread for the same fixed reason. */
export function vercelAccountFailure(
	reason: VercelReadNote,
	now: Date,
): VercelAccountStore {
	return {
		version: 1,
		observedAt: now.toISOString(),
		account: null,
		accountNote: reason,
		blob: null,
		blobNote: reason,
	};
}

export function defaultVercelAccountStorePath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "vercel-quota", "vercel-account.json");
}

/** null on any read or validation failure; the page then shows "读不到". */
export function readVercelAccountStore(
	path: string,
): VercelAccountStore | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	if (raw.length > MAX_STORE_BYTES) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return validVercelAccountStore(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function writeVercelAccountStore(
	path: string,
	store: VercelAccountStore,
): void {
	if (!validVercelAccountStore(store)) {
		throw new Error("invalid Vercel account reading");
	}
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

/** Best effort: a stale success must not outlive a failed write. */
export function discardVercelAccountStore(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* already absent or not removable; the in-memory attempt still wins */
	}
}

/** The newest attempt of this Bridge process; wins over the file. */
export interface VercelAccountLatest {
	get(): VercelAccountStore | null;
	set(store: VercelAccountStore): void;
}

export function createVercelAccountLatest(): VercelAccountLatest {
	let latest: VercelAccountStore | null = null;
	return {
		get: () => latest,
		set: (store) => {
			latest = store;
		},
	};
}
