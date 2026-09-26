/**
 * FLY-2897 — `claude-quota/charge-receipts.json`: what each Claude account's
 * receipt mailbox said about its next charge, as fields only.
 *
 * No field can hold a subject, sender, receipt number, address or body: the
 * shape is closed (unknown keys reject the file) and every string is a date,
 * an instant, an enum or a digest. The reader and the writer share one
 * validator, so the writer can never produce a file the reader throws away.
 */

import { createHash } from "node:crypto";
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
const MAX_ACCOUNTS = 64;
export const MAX_RECEIPTS_PER_PERIOD = 6;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAILBOX_KEY = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const CLAUDE_CHARGE_STATUSES = [
	"ok",
	"canceled",
	"no_mailbox",
	"auth_missing",
	"auth_invalid",
	"no_receipt",
	"parse_failed",
	"read_failed",
] as const;
export type ClaudeChargeStatus = (typeof CLAUDE_CHARGE_STATUSES)[number];

export const CLAUDE_CHARGE_REASONS = [
	"invalid_grant",
	"unauthorized",
	"permission_denied",
	"rate_limited",
	"retryable",
	"not_found",
	"gog_config",
	"gog_missing",
	"timeout",
	"output_too_large",
	"malformed",
	"candidate_limit",
	"search_truncated",
	"error",
] as const;
export type ClaudeChargeReason = (typeof CLAUDE_CHARGE_REASONS)[number];

/**
 * The one mailbox identity both sides use: the observer stamps it on a
 * reading, the page refuses a reading whose stamp is not the current mailbox.
 */
export function claudeChargeMailboxKey(email: string): string {
	return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

const MAILBOX = /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/;

/** The trimmed mailbox when it is a plausible address (never an option). */
export function normalizeClaudeChargeMailbox(
	email: string | null | undefined,
): string | null {
	const trimmed = typeof email === "string" ? email.trim() : "";
	return trimmed.length <= 254 && MAILBOX.test(trimmed) ? trimmed : null;
}

export interface ClaudeChargeFacts {
	/** YYYY-MM-DD, the Pacific calendar day printed on the receipt. */
	periodStart: string;
	/** Next charge day (ok) or the day access ends (canceled). */
	periodEnd: string;
	paidOn: string | null;
	/**
	 * Sum of "Amount paid" over the period's receipts; null if any lacked it or
	 * the scan could not prove it read every receipt of the period.
	 */
	amountCents: number | null;
	/** The period's receipt count; null exactly when the scan was incomplete. */
	receiptCount: number | null;
	/** Email time of the newest subscription receipt. */
	receiptAt: string;
	/** A cancellation after that receipt that no later resubscription undid. */
	canceledAt: string | null;
	/** The newest resubscription notice after that receipt. */
	resumedAt: string | null;
}

export interface ClaudeChargeGood {
	readAt: string;
	status: "ok" | "canceled";
	facts: ClaudeChargeFacts;
}

export interface ClaudeChargeReading {
	name: string;
	/** sha256 of the lower-cased mailbox; a new mailbox drops `lastGood`. */
	mailboxKey: string | null;
	readAt: string;
	status: ClaudeChargeStatus;
	reason: ClaudeChargeReason | null;
	/** Present exactly for ok / canceled. */
	facts: ClaudeChargeFacts | null;
	/** The newest ok / canceled reading of this mailbox, for a failed round. */
	lastGood: ClaudeChargeGood | null;
}

export interface ClaudeChargeStore {
	version: 1;
	generatedAt: string;
	accounts: ClaudeChargeReading[];
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => key in value);
}

function instant(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value
	);
}

function day(value: unknown): value is string {
	if (typeof value !== "string" || !DAY.test(value)) return false;
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return (
		Number.isFinite(parsed) &&
		new Date(parsed).toISOString().slice(0, 10) === value
	);
}

const FACT_KEYS = [
	"periodStart",
	"periodEnd",
	"paidOn",
	"amountCents",
	"receiptCount",
	"receiptAt",
	"canceledAt",
	"resumedAt",
] as const;

function validFacts(
	value: unknown,
	status: "ok" | "canceled",
): value is ClaudeChargeFacts {
	return (
		record(value) &&
		exactKeys(value, FACT_KEYS) &&
		day(value.periodStart) &&
		day(value.periodEnd) &&
		value.periodStart < value.periodEnd &&
		(value.paidOn === null || day(value.paidOn)) &&
		(value.amountCents === null ||
			(typeof value.amountCents === "number" &&
				Number.isSafeInteger(value.amountCents))) &&
		// An incomplete period (null count) never claims a total.
		(value.receiptCount === null
			? value.amountCents === null
			: typeof value.receiptCount === "number" &&
				Number.isSafeInteger(value.receiptCount) &&
				value.receiptCount >= 1 &&
				value.receiptCount <= MAX_RECEIPTS_PER_PERIOD) &&
		instant(value.receiptAt) &&
		(value.resumedAt === null || instant(value.resumedAt)) &&
		(status === "canceled"
			? instant(value.canceledAt)
			: value.canceledAt === null)
	);
}

function validGood(value: unknown): value is ClaudeChargeGood {
	return (
		record(value) &&
		exactKeys(value, ["readAt", "status", "facts"]) &&
		instant(value.readAt) &&
		(value.status === "ok" || value.status === "canceled") &&
		validFacts(value.facts, value.status)
	);
}

const READING_KEYS = [
	"name",
	"mailboxKey",
	"readAt",
	"status",
	"reason",
	"facts",
	"lastGood",
] as const;

function validReading(value: unknown): value is ClaudeChargeReading {
	if (!record(value) || !exactKeys(value, READING_KEYS)) return false;
	const status = value.status;
	if (
		typeof status !== "string" ||
		!(CLAUDE_CHARGE_STATUSES as readonly string[]).includes(status)
	) {
		return false;
	}
	const withFacts = status === "ok" || status === "canceled";
	return (
		typeof value.name === "string" &&
		ACCOUNT_NAME.test(value.name) &&
		(value.mailboxKey === null ||
			(typeof value.mailboxKey === "string" &&
				MAILBOX_KEY.test(value.mailboxKey))) &&
		instant(value.readAt) &&
		(value.reason === null ||
			(typeof value.reason === "string" &&
				(CLAUDE_CHARGE_REASONS as readonly string[]).includes(value.reason))) &&
		(withFacts
			? validFacts(value.facts, status as "ok" | "canceled")
			: value.facts === null) &&
		(value.lastGood === null || validGood(value.lastGood))
	);
}

/** The one shape check shared by the reader and the writer. */
export function validateClaudeChargeStore(
	value: unknown,
): value is ClaudeChargeStore {
	if (
		!record(value) ||
		!exactKeys(value, ["version", "generatedAt", "accounts"]) ||
		value.version !== 1 ||
		!instant(value.generatedAt) ||
		!Array.isArray(value.accounts) ||
		value.accounts.length > MAX_ACCOUNTS ||
		!value.accounts.every(validReading)
	) {
		return false;
	}
	const names = (value.accounts as ClaudeChargeReading[]).map(
		(account) => account.name,
	);
	return new Set(names).size === names.length;
}

export function defaultClaudeChargeStorePath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "claude-quota", "charge-receipts.json");
}

export function readClaudeChargeStore(path: string): ClaudeChargeStore | null {
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
	return validateClaudeChargeStore(parsed) ? parsed : null;
}

export function writeClaudeChargeStore(
	path: string,
	store: ClaudeChargeStore,
): void {
	const text = `${JSON.stringify(store, null, 2)}\n`;
	if (!validateClaudeChargeStore(store) || text.length > MAX_STORE_BYTES) {
		throw new Error("store_invalid");
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}`;
	const handle = openSync(temp, "w", 0o600);
	try {
		writeSync(handle, text);
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
