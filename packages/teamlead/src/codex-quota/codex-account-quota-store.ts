/**
 * FLY-2688 — durable store for real Codex per-account quota readings.
 *
 * Mirrors the Claude account store contract: an atomically written JSON file
 * holding only non-sensitive readings. No token, id_token or email ever lands
 * here — the page renders slot aliases and the capacity snapshot projects this
 * file verbatim.
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
import { isCodexSlotName } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import type {
	CodexCreditsDetail,
	CodexRateLimitWindow,
	CodexResetCreditDetail,
	CodexResetCreditsDetail,
} from "./rate-limit-detail.js";

const MAX_STORE_BYTES = 256 * 1024;
/** Same bound as the occupancy answer's detail (occupancy.ts). */
const NOTE_DETAIL_RE = /^[a-z0-9_:.-]{1,80}$/;
const MAX_ACCOUNTS = 64;

export type CodexAccountAuthHealth =
	| "valid"
	| "refresh_invalid"
	| "in_use_unshared"
	| "recovery_uncertain"
	| "missing"
	| "unknown";

export interface CodexAccountReading {
	/** Profile slot directory name under `<codex home>/profiles`. */
	name: string;
	/** Registry profile name when the account is registered; null otherwise. */
	registeredProfile: string | null;
	/** Non-PII credential identity binding used to reject stale readings after re-login. */
	identityKey?: string;
	observedAt: string | null;
	authHealth: CodexAccountAuthHealth;
	/** Machine token explaining a missing reading (`deadline`, `read_failed`, …). */
	note: string | null;
	/**
	 * FLY-2830: bounded reason code behind `note` (e.g. why the occupancy
	 * inventory was unavailable). Never a path, stack or free text.
	 */
	noteDetail?: string;
	planType: string | null;
	fiveH: CodexRateLimitWindow | null;
	weekly: CodexRateLimitWindow | null;
	credits: CodexCreditsDetail;
	/** Field-level provenance; optional only for version-1 legacy stores. */
	creditsObservedAt?: string | null;
	resetCredits: CodexResetCreditsDetail;
	/** Field-level provenance; optional only for version-1 legacy stores. */
	resetCreditsObservedAt?: string | null;
	unclassifiedWindows: number;
}

export interface CodexAccountQuotaStore {
	version: 1;
	generatedAt: string;
	/** Slot whose identity equals the canonical Codex home; null when unprovable. */
	activeAccount: string | null;
	accounts: CodexAccountReading[];
}

const AUTH_HEALTH: readonly CodexAccountAuthHealth[] = [
	"valid",
	"refresh_invalid",
	"in_use_unshared",
	"recovery_uncertain",
	"missing",
	"unknown",
];

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function instant(value: unknown): boolean {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value
	);
}

function text(value: unknown, max: number): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validWindow(value: unknown): boolean {
	if (value === null) return true;
	if (!record(value)) return false;
	return (
		Number.isInteger(value.usedPercent) &&
		(value.usedPercent as number) >= 0 &&
		(value.usedPercent as number) <= 100 &&
		Number.isInteger(value.windowMinutes) &&
		(value.windowMinutes as number) > 0 &&
		(value.resetAt === null || instant(value.resetAt))
	);
}

function validCredits(value: unknown): boolean {
	if (!record(value)) return false;
	const flag = (raw: unknown) => raw === null || typeof raw === "boolean";
	return (
		typeof value.known === "boolean" &&
		flag(value.hasCredits) &&
		flag(value.unlimited) &&
		(value.balance === null || text(value.balance, 32))
	);
}

function validResetCredit(value: unknown): value is CodexResetCreditDetail {
	return (
		record(value) &&
		text(value.id, 128) &&
		text(value.status, 64) &&
		(value.expiresAt === null || instant(value.expiresAt))
	);
}

function normalizeResetCredits(value: unknown): CodexResetCreditsDetail | null {
	if (
		!record(value) ||
		typeof value.known !== "boolean" ||
		(value.value !== null && !text(value.value, 32))
	) {
		return null;
	}
	const legacyUnknown = (): CodexResetCreditsDetail => ({
		known: false,
		value: null,
		availableCount: null,
		credits: null,
	});
	const hasStructured = "availableCount" in value || "credits" in value;
	if (!hasStructured) {
		if (!value.known) return legacyUnknown();
		const legacyValue = value.value;
		if (legacyValue === null) {
			return {
				known: true,
				value: null,
				availableCount: 0,
				credits: [],
			};
		}
		if (
			typeof legacyValue !== "string" ||
			!/^(?:0|[1-9]\d{0,15})$/.test(legacyValue)
		) {
			return legacyUnknown();
		}
		const count = Number(legacyValue);
		return Number.isSafeInteger(count)
			? {
					known: true,
					value: count === 0 ? null : String(count),
					availableCount: count,
					credits: null,
				}
			: legacyUnknown();
	}
	if (!value.known) {
		return value.availableCount === null && value.credits === null
			? legacyUnknown()
			: null;
	}
	if (
		(value.availableCount !== null &&
			(!Number.isSafeInteger(value.availableCount) ||
				(value.availableCount as number) < 0)) ||
		(value.credits !== null && !Array.isArray(value.credits))
	) {
		return null;
	}
	if (value.availableCount === null) {
		return value.credits === null ? legacyUnknown() : null;
	}
	const credits = value.credits as unknown[] | null;
	if (credits === null) {
		return {
			known: true,
			value:
				(value.availableCount as number) === 0
					? null
					: String(value.availableCount),
			availableCount: value.availableCount as number,
			credits: null,
		};
	}
	if (
		credits.length > (value.availableCount as number) ||
		!credits.every(validResetCredit)
	) {
		return null;
	}
	const ids = credits.map((credit) => (credit as CodexResetCreditDetail).id);
	if (new Set(ids).size !== ids.length) return null;
	return {
		known: true,
		value:
			(value.availableCount as number) === 0
				? null
				: String(value.availableCount),
		availableCount: value.availableCount as number,
		credits: credits as CodexResetCreditDetail[],
	};
}

function validReading(value: unknown): value is CodexAccountReading {
	if (!record(value)) return false;
	return (
		typeof value.name === "string" &&
		isCodexSlotName(value.name) &&
		(value.registeredProfile === null ||
			(typeof value.registeredProfile === "string" &&
				isCodexSlotName(value.registeredProfile))) &&
		(value.identityKey === undefined ||
			(typeof value.identityKey === "string" &&
				/^[a-f0-9]{64}$/.test(value.identityKey))) &&
		(value.observedAt === null || instant(value.observedAt)) &&
		AUTH_HEALTH.includes(value.authHealth as CodexAccountAuthHealth) &&
		(value.note === null || text(value.note, 128)) &&
		(value.noteDetail === undefined ||
			(typeof value.noteDetail === "string" &&
				NOTE_DETAIL_RE.test(value.noteDetail))) &&
		(value.planType === null || text(value.planType, 64)) &&
		validWindow(value.fiveH) &&
		validWindow(value.weekly) &&
		validCredits(value.credits) &&
		(value.creditsObservedAt === undefined ||
			value.creditsObservedAt === null ||
			instant(value.creditsObservedAt)) &&
		normalizeResetCredits(value.resetCredits) !== null &&
		(value.resetCreditsObservedAt === undefined ||
			value.resetCreditsObservedAt === null ||
			instant(value.resetCreditsObservedAt)) &&
		Number.isInteger(value.unclassifiedWindows) &&
		(value.unclassifiedWindows as number) >= 0
	);
}

export function defaultCodexAccountQuotaStorePath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "codex-quota", "codex-accounts.json");
}

export function readCodexAccountQuotaStore(
	path: string,
): CodexAccountQuotaStore | null {
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
	const names = (parsed.accounts as CodexAccountReading[]).map(
		(account) => account.name,
	);
	if (new Set(names).size !== names.length) return null;
	const active = parsed.activeAccount;
	if (
		active !== null &&
		(typeof active !== "string" || !names.includes(active))
	)
		return null;
	const normalized = parsed as unknown as CodexAccountQuotaStore;
	return {
		...normalized,
		accounts: normalized.accounts.map((account) => ({
			...account,
			resetCredits: normalizeResetCredits(account.resetCredits)!,
		})),
	};
}

export function writeCodexAccountQuotaStore(
	path: string,
	store: CodexAccountQuotaStore,
): void {
	// FLY-2830: the same structural check the reader applies; an invalid
	// reading never reaches disk (the caller records refresh_failed).
	if (!store.accounts.every(validReading))
		throw new Error("codex_account_store_invalid");
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
			/* the temp file is already gone */
		}
		throw error;
	}
}
