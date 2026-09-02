/**
 * FLY-696 M1/C2 — Claude account-pool state + next-account selection.
 *
 * Tracks, per pooled Claude account, whether it is currently unusable (quota
 * exhausted until a reset moment, or auth-expired) and its weekly reset moment,
 * so a cap on the active account can be self-healed by rotating to the best
 * available account.
 *
 * Selection follows Annie's "maximize quota" rule:
 *   - 5h cap    → temporary; the current account recovers in a few hours, so any
 *                 usable account will do (don't burn the weekly pool).
 *   - weekly/both cap → switch to the account whose WEEKLY reset is soonest
 *                 ("周五先用周一 reset 的"); unknown weekly-reset accounts are
 *                 deprioritized; an account still exhausted this week is never
 *                 chosen.
 *
 * NOTE: auth-expiry (`authExpired`/`refreshTokenInvalid`/`profileVerifyFailed`)
 * is DELIBERATELY separate from quota exhaustion — an auth-expired account is not
 * a valid quota-switch target and is only fixed by re-login (M3), never by
 * waiting for a quota reset.
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_MODEL_CAP_TTL_MS, type ModelCapState } from "./model-cap.js";

export interface AccountEntry {
	name: string;
	/** ISO instant this account is quota-unusable until; null = usable now. */
	quotaExhaustedUntil: string | null;
	/** Intentional hysteresis after rotating away; live reads must not erase it. */
	switchCooldownUntil?: string;
	/** ISO instant of this account's weekly reset; null = unknown. */
	weeklyResetAt: string | null;
	/** ISO instant when the quota daemon/guard last observed both usage windows. */
	lastObservedAt?: string;
	/** Last observed rolling 5-hour usage percentage. */
	observedFiveHPct?: number;
	/** Last observed rolling 7-day usage percentage. */
	observedSevenDPct?: number;
	/** Auth-expiry family (M3) — not a quota-switch target while true. */
	authExpired?: boolean;
	refreshTokenInvalid?: boolean;
	profileVerifyFailed?: boolean;
	/** Per-model finite retry benches. Missing means no model-specific bench. */
	modelCaps?: Record<string, ModelCapState>;
	/** Trusted operator-provided identity expectation; never learned from a probe. */
	identity?: { email: string; uuid?: string; setAt: string };
	/** Identity-domain exclusion marker; does not change switch generation. */
	identityMismatch?: {
		actualDigest: string;
		markedBy: "audit" | "executor";
		markedAt: string;
	};
}

export interface AccountStore {
	/** Monotonic counter bumped on every committed switch (CAS token). */
	generation: number;
	/** The pool account currently written into the machine credential source. */
	activeAccount: string | null;
	/** Recorded fact: the last profile switch could not sync display identity. */
	identityStale?: boolean;
	accounts: AccountEntry[];
	/** Durable success notifications awaiting confirmed sender delivery. */
	pendingSwitchNotifications?: SwitchNotificationIntent[];
}

export const MAX_SWITCH_NOTIFICATION_OUTBOX = 64;
const MAX_SWITCH_NOTIFICATION_EVENT_ID = 256;
const MAX_SWITCH_NOTIFICATION_TITLE = 256;
const MAX_SWITCH_NOTIFICATION_BODY = 4_000;
const MAX_SWITCH_NOTIFICATION_SIGNATURE = 256;

export interface SwitchNotificationIntent {
	eventId: string;
	generation: number;
	createdAt: number;
	alert: {
		kind: "account_switched";
		severity: "info" | "warning" | "severe";
		title: string;
		body: string;
		signature: string;
	};
}

export class SwitchNotificationOutboxFullError extends Error {
	constructor() {
		super(
			`switch notification outbox is full (${MAX_SWITCH_NOTIFICATION_OUTBOX})`,
		);
		this.name = "SwitchNotificationOutboxFullError";
	}
}

export interface SelectInput {
	scope: "5h" | "weekly" | "both" | "model" | null;
	currentName: string;
	now: Date;
	models?: readonly string[];
	/** Authoritative quota-verified ranking. Present means unlisted accounts are ineligible. */
	preferredOrder?: string[];
	/** Start instant of the live verification round that produced preferredOrder. */
	verifiedAt?: string;
	/** Attempt-local exclusions; never persisted to the account store. */
	excludeNames?: ReadonlySet<string>;
	/** Per-target authority issued only by the manual switch executor. */
	eligibilityOverrides?: ReadonlyMap<
		string,
		{
			ignoreCooldown: boolean;
		}
	>;
}

export interface AccountQuotaObservation {
	fiveHPct: number;
	sevenDPct: number;
	/** `null` when the window has not opened yet (FLY-1366). */
	fiveHResetAt: string | null;
	sevenDResetAt: string | null;
	observedAt: string;
}

export type RecordObservationResult =
	| "updated"
	| "stale_generation"
	| "older_observation"
	| "missing_account"
	| "invalid_store"
	| "write_failed";

export type SyncActiveAccountResult =
	| "synced"
	| "noop"
	| "invalid_name"
	| "missing_account"
	| "invalid_store"
	| "write_failed";

export interface FreshenedIdentityProof {
	email: string;
	uuid?: string;
}

const VALID_ACCOUNT_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;

export function isAuthUnusable(a: AccountEntry): boolean {
	return Boolean(
		a.authExpired ||
			a.refreshTokenInvalid ||
			a.profileVerifyFailed ||
			a.identityMismatch,
	);
}

export function isQuotaUsable(a: AccountEntry, nowMs: number): boolean {
	if (isSwitchCooldownActive(a, nowMs)) return false;
	if (a.quotaExhaustedUntil === null) return true;
	const until = Date.parse(a.quotaExhaustedUntil);
	return Number.isNaN(until) || until <= nowMs;
}

export type ModelSetBenchVerdict =
	| { state: "clear" }
	| { state: "benched"; retryAt: string }
	| { state: "malformed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function validBoundedString(
	value: unknown,
	maxLength: number,
): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maxLength
	);
}

function isSwitchNotificationIntent(
	value: unknown,
): value is SwitchNotificationIntent {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["eventId", "generation", "createdAt", "alert"]) ||
		!validBoundedString(value.eventId, MAX_SWITCH_NOTIFICATION_EVENT_ID) ||
		!Number.isSafeInteger(value.generation) ||
		(value.generation as number) < 0 ||
		!Number.isSafeInteger(value.createdAt) ||
		(value.createdAt as number) < 0 ||
		!isRecord(value.alert) ||
		!hasOnlyKeys(value.alert, [
			"kind",
			"severity",
			"title",
			"body",
			"signature",
		])
	) {
		return false;
	}
	return (
		value.alert.kind === "account_switched" &&
		(value.alert.severity === "info" ||
			value.alert.severity === "warning" ||
			value.alert.severity === "severe") &&
		validBoundedString(value.alert.title, MAX_SWITCH_NOTIFICATION_TITLE) &&
		validBoundedString(value.alert.body, MAX_SWITCH_NOTIFICATION_BODY) &&
		validBoundedString(value.alert.signature, MAX_SWITCH_NOTIFICATION_SIGNATURE)
	);
}

function normalizeSwitchNotificationOutbox(
	value: unknown,
): SwitchNotificationIntent[] | null {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.length > MAX_SWITCH_NOTIFICATION_OUTBOX ||
		value.some((intent) => !isSwitchNotificationIntent(intent))
	) {
		return null;
	}
	const eventIds = new Set(value.map((intent) => intent.eventId));
	return eventIds.size === value.length ? value : null;
}

export function enqueueSwitchNotification(
	store: AccountStore,
	intent: SwitchNotificationIntent,
): AccountStore {
	if (!isSwitchNotificationIntent(intent)) {
		throw new TypeError("invalid switch notification intent");
	}
	const pending = store.pendingSwitchNotifications ?? [];
	if (pending.some((item) => item.eventId === intent.eventId)) return store;
	if (pending.length >= MAX_SWITCH_NOTIFICATION_OUTBOX) {
		throw new SwitchNotificationOutboxFullError();
	}
	return { ...store, pendingSwitchNotifications: [...pending, intent] };
}

export function peekSwitchNotification(
	store: AccountStore,
): SwitchNotificationIntent | null {
	return store.pendingSwitchNotifications?.[0] ?? null;
}

export function ackSwitchNotification(
	store: AccountStore,
	eventId: string,
): AccountStore {
	const pending = store.pendingSwitchNotifications ?? [];
	if (!pending.some((intent) => intent.eventId === eventId)) return store;
	return {
		...store,
		pendingSwitchNotifications: pending.filter(
			(intent) => intent.eventId !== eventId,
		),
	};
}

export function inspectModelSetBench(
	a: AccountEntry,
	models: readonly string[],
	nowMs: number,
): ModelSetBenchVerdict {
	if (models.length === 0) return { state: "clear" };
	const raw: unknown = (a as { modelCaps?: unknown }).modelCaps;
	if (raw === undefined) return { state: "clear" };
	if (!isRecord(raw)) {
		return { state: "malformed", reason: "modelCaps is not an object" };
	}

	const parsed = new Map<string, ModelCapState>();
	for (const [model, value] of Object.entries(raw)) {
		if (
			model.length === 0 ||
			model.trim() !== model ||
			!isRecord(value) ||
			Object.keys(value).some(
				(key) => key !== "until" && key !== "backoffMs",
			) ||
			typeof value.until !== "string" ||
			!Number.isFinite(Date.parse(value.until)) ||
			typeof value.backoffMs !== "number" ||
			!Number.isFinite(value.backoffMs) ||
			value.backoffMs <= 0 ||
			value.backoffMs > MAX_MODEL_CAP_TTL_MS
		) {
			return {
				state: "malformed",
				reason: `invalid model bench for ${model || "<empty>"}`,
			};
		}
		parsed.set(model, {
			until: value.until,
			backoffMs: value.backoffMs,
		});
	}

	let retryAtMs = Number.NEGATIVE_INFINITY;
	for (const model of models) {
		const cap = parsed.get(model);
		if (cap === undefined) continue;
		const until = Date.parse(cap.until);
		if (until > nowMs) retryAtMs = Math.max(retryAtMs, until);
	}
	return retryAtMs === Number.NEGATIVE_INFINITY
		? { state: "clear" }
		: { state: "benched", retryAt: new Date(retryAtMs).toISOString() };
}

export function isModelSetUsable(
	a: AccountEntry,
	models: readonly string[],
	nowMs: number,
): boolean {
	return inspectModelSetBench(a, models, nowMs).state === "clear";
}

export function summarizeModelBenchPool(
	accounts: readonly AccountEntry[],
	models: readonly string[],
	nowMs: number,
): {
	eligibleAccounts: string[];
	nextRetryAt: string | null;
	hasUnknown: boolean;
} {
	const eligibleAccounts: string[] = [];
	let nextRetryMs = Number.POSITIVE_INFINITY;
	let hasUnknown = false;
	for (const account of accounts) {
		const verdict = inspectModelSetBench(account, models, nowMs);
		if (verdict.state === "clear") {
			eligibleAccounts.push(account.name);
			continue;
		}
		if (verdict.state === "malformed") {
			hasUnknown = true;
			continue;
		}
		nextRetryMs = Math.min(nextRetryMs, Date.parse(verdict.retryAt));
	}
	return {
		eligibleAccounts,
		nextRetryAt: Number.isFinite(nextRetryMs)
			? new Date(nextRetryMs).toISOString()
			: null,
		hasUnknown,
	};
}

export function isSwitchCooldownActive(
	a: AccountEntry,
	nowMs: number,
): boolean {
	if (a.switchCooldownUntil === undefined) return false;
	const until = Date.parse(a.switchCooldownUntil);
	return !Number.isNaN(until) && until > nowMs;
}

/**
 * Pick the next usable account, or null if none is available (caller pages Annie
 * with the earliest reset). Pure — depends only on its arguments.
 */
export function selectNextAccount(
	store: AccountStore,
	input: SelectInput,
): string | null {
	const nowMs = input.now.getTime();
	if (input.preferredOrder !== undefined) {
		const verifiedAtMs =
			input.verifiedAt === undefined
				? Number.NaN
				: Date.parse(input.verifiedAt);
		const rank = new Map(
			input.preferredOrder.map((name, index) => [name, index]),
		);
		const verified = store.accounts
			.filter((account) => {
				const override = input.eligibilityOverrides?.get(account.name);
				if (
					account.name === input.currentName ||
					input.excludeNames?.has(account.name) ||
					isAuthUnusable(account) ||
					!isModelSetUsable(account, input.models ?? [], nowMs) ||
					!rank.has(account.name)
				) {
					return false;
				}
				// Live verification may invalidate a stale quota fact, but it must never
				// erase intentional post-switch hysteresis and re-admit the account we
				// just rotated away from.
				if (
					isSwitchCooldownActive(account, nowMs) &&
					override?.ignoreCooldown !== true
				) {
					return false;
				}
				const quotaUntil =
					account.quotaExhaustedUntil === null
						? Number.NEGATIVE_INFINITY
						: Date.parse(account.quotaExhaustedUntil);
				if (Number.isNaN(quotaUntil) || quotaUntil <= nowMs) return true;
				if (Number.isNaN(verifiedAtMs)) return false;
				if (account.lastObservedAt === undefined) return true;
				const observedAtMs = Date.parse(account.lastObservedAt);
				return !Number.isNaN(observedAtMs) && observedAtMs <= verifiedAtMs;
			})
			.sort(
				(a, b) => (rank.get(a.name) as number) - (rank.get(b.name) as number),
			);
		return verified[0]?.name ?? null;
	}
	const candidates = store.accounts.filter(
		(a) =>
			a.name !== input.currentName &&
			!input.excludeNames?.has(a.name) &&
			!isAuthUnusable(a) &&
			isQuotaUsable(a, nowMs) &&
			isModelSetUsable(a, input.models ?? [], nowMs),
	);
	if (candidates.length === 0) return null;

	if (
		input.scope === "5h" ||
		input.scope === "weekly" ||
		input.scope === "both"
	) {
		// Soonest weekly reset first; unknown (null) reset sorts last.
		const sorted = [...candidates].sort((a, b) => {
			const ra = a.weeklyResetAt
				? Date.parse(a.weeklyResetAt)
				: Number.POSITIVE_INFINITY;
			const rb = b.weeklyResetAt
				? Date.parse(b.weeklyResetAt)
				: Number.POSITIVE_INFINITY;
			if (ra !== rb) return ra - rb;
			return a.name.localeCompare(b.name);
		});
		return sorted[0]?.name ?? null;
	}

	// Ambiguous scope: any usable account, chosen deterministically.
	const byName = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
	return byName[0]?.name ?? null;
}

/** A fresh, empty pool state. */
export function emptyStore(): AccountStore {
	return {
		generation: 0,
		activeAccount: null,
		accounts: [],
		pendingSwitchNotifications: [],
	};
}

/** Default state-file path (override via FLYWHEEL_CLAUDE_ACCOUNTS_PATH for tests). */
export function defaultStorePath(): string {
	return (
		process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH ??
		join(homedir(), ".flywheel", "claude-accounts.json")
	);
}

/** FLY-1243: account self-heal is固化 default-on but gated on a provisioned pool.
 * Presence of the pool state file (env-overridable via defaultStorePath) is the
 * de-facto switch — production has one; QA slots / sub / joycon never provisioned
 * one, so self-heal stays dormant there (byte-compat). */
export function accountPoolConfigured(): boolean {
	return existsSync(defaultStorePath());
}

/**
 * Read the pool state. Missing file → empty store. Corrupt JSON → empty store
 * (fail-soft: a garbled state file must not crash the Bridge; the next switch
 * re-derives it). All writes hold the flock (see C5), so reads are consistent.
 */
export function readStore(path: string = defaultStorePath()): AccountStore {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return emptyStore();
	}
	try {
		const parsed = JSON.parse(raw) as AccountStore;
		if (
			typeof parsed?.generation !== "number" ||
			!Array.isArray(parsed?.accounts)
		) {
			return emptyStore();
		}
		const pending = normalizeSwitchNotificationOutbox(
			parsed.pendingSwitchNotifications,
		);
		return pending === null
			? emptyStore()
			: { ...parsed, pendingSwitchNotifications: pending };
	} catch {
		return emptyStore();
	}
}

/**
 * Atomically persist the pool state (temp + fsync + rename), 0600. Callers MUST
 * hold `~/.flywheel/claude-accounts.lock` across read→mutate→write (C5).
 */
export function writeStore(
	store: AccountStore,
	path: string = defaultStorePath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(store, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

function validFutureReset(
	resetAt: string | null,
	observedAtMs: number,
): boolean {
	// A null reset parses to NaN and falls through the existing guard: an
	// unopened window can never stamp an exhaustion deadline.
	const resetMs = Date.parse(resetAt ?? "");
	return (
		!Number.isNaN(observedAtMs) &&
		!Number.isNaN(resetMs) &&
		resetMs > observedAtMs
	);
}

/** Project one validated live quota observation onto an existing account. */
export function applyObservation(
	entry: AccountEntry,
	observation: AccountQuotaObservation,
): AccountEntry {
	const observedAtMs = Date.parse(observation.observedAt);
	const weeklyExhausted =
		observation.sevenDPct >= 100 &&
		validFutureReset(observation.sevenDResetAt, observedAtMs);
	const fiveHExhausted =
		observation.fiveHPct >= 100 &&
		validFutureReset(observation.fiveHResetAt, observedAtMs);
	const parsedWeeklyReset = Date.parse(observation.sevenDResetAt ?? "");

	return {
		...entry,
		quotaExhaustedUntil: weeklyExhausted
			? observation.sevenDResetAt
			: fiveHExhausted
				? observation.fiveHResetAt
				: null,
		weeklyResetAt: Number.isNaN(parsedWeeklyReset)
			? entry.weeklyResetAt
			: observation.sevenDResetAt,
		lastObservedAt: observation.observedAt,
		observedFiveHPct: observation.fiveHPct,
		observedSevenDPct: observation.sevenDPct,
	};
}

export function readStoreStrict(path: string): AccountStore | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as AccountStore;
		const pending = normalizeSwitchNotificationOutbox(
			parsed?.pendingSwitchNotifications,
		);
		if (
			typeof parsed?.generation !== "number" ||
			(parsed.activeAccount !== null &&
				typeof parsed.activeAccount !== "string") ||
			!Array.isArray(parsed.accounts) ||
			pending === null ||
			parsed.accounts.some(
				(entry) =>
					typeof entry?.name !== "string" ||
					(entry.quotaExhaustedUntil !== null &&
						typeof entry.quotaExhaustedUntil !== "string") ||
					(entry.weeklyResetAt !== null &&
						typeof entry.weeklyResetAt !== "string") ||
					(entry.switchCooldownUntil !== undefined &&
						typeof entry.switchCooldownUntil !== "string"),
			)
		) {
			return null;
		}
		return { ...parsed, pendingSwitchNotifications: pending };
	} catch {
		return null;
	}
}

/**
 * Persist one observation while the caller holds the account lock. This never
 * throws and never manufactures an empty store over missing/corrupt input.
 */
export function recordObservationInStore(
	storePath: string,
	name: string,
	observation: AccountQuotaObservation,
	opts: { expectedGeneration?: number } = {},
): RecordObservationResult {
	const store = readStoreStrict(storePath);
	if (store === null) return "invalid_store";
	if (
		opts.expectedGeneration !== undefined &&
		store.generation !== opts.expectedGeneration
	) {
		return "stale_generation";
	}
	const index = store.accounts.findIndex((entry) => entry.name === name);
	if (index === -1) return "missing_account";
	const entry = store.accounts[index] as AccountEntry;
	if (entry.lastObservedAt !== undefined) {
		const existingMs = Date.parse(entry.lastObservedAt);
		const incomingMs = Date.parse(observation.observedAt);
		if (
			!Number.isNaN(existingMs) &&
			!Number.isNaN(incomingMs) &&
			existingMs > incomingMs
		) {
			return "older_observation";
		}
	}
	const accounts = [...store.accounts];
	accounts[index] = applyObservation(entry, observation);
	try {
		writeStore({ ...store, accounts }, storePath);
		return "updated";
	} catch {
		return "write_failed";
	}
}

/**
 * Reconcile the machine's active profile marker into the account store while
 * the caller holds the shared account lock. Invalid input never manufactures
 * or overwrites a store.
 */
export function syncActiveAccountInStore(
	storePath: string,
	name: string,
): SyncActiveAccountResult {
	if (!VALID_ACCOUNT_NAME.test(name)) return "invalid_name";
	const store = readStoreStrict(storePath);
	if (store === null) return "invalid_store";
	if (store.accounts.filter((entry) => entry.name === name).length !== 1) {
		return "missing_account";
	}
	if (store.activeAccount === name) return "noop";
	try {
		writeStore(
			{
				...store,
				activeAccount: name,
				generation: store.generation + 1,
			},
			storePath,
		);
		return "synced";
	} catch {
		return "write_failed";
	}
}

/**
 * Commit a live, identity-verified capture into the ledger. Unlike the legacy
 * best-effort active projection, every invalid state is surfaced to the caller.
 */
export function syncFreshenedActiveAccountInStore(
	storePath: string,
	name: string,
	proof: FreshenedIdentityProof,
): SyncActiveAccountResult {
	if (!VALID_ACCOUNT_NAME.test(name)) return "invalid_name";
	const store = readStoreStrict(storePath);
	if (store === null) return "invalid_store";
	const matches = store.accounts.filter((entry) => entry.name === name);
	if (matches.length !== 1) return "missing_account";
	const account = matches[0] as AccountEntry;
	const updated = { ...account };
	delete updated.authExpired;
	delete updated.refreshTokenInvalid;
	delete updated.profileVerifyFailed;
	if (
		account.identity &&
		account.identity.email.toLowerCase() === proof.email.toLowerCase() &&
		(account.identity.uuid === undefined ||
			account.identity.uuid.toLowerCase() === proof.uuid?.toLowerCase())
	) {
		delete updated.identityMismatch;
	}
	const changed =
		store.activeAccount !== name ||
		JSON.stringify(updated) !== JSON.stringify(account);
	if (!changed) return "noop";
	try {
		writeStore(
			{
				...store,
				activeAccount: name,
				generation: store.generation + 1,
				accounts: store.accounts.map((entry) =>
					entry.name === name ? updated : entry,
				),
			},
			storePath,
		);
		return "synced";
	} catch {
		return "write_failed";
	}
}

/**
 * Earliest reset moment across all quota-exhausted accounts — for the
 * "all accounts exhausted, wait until X" message to Annie. Returns null if
 * nothing has a known reset.
 */
export function earliestReset(
	store: AccountStore,
	nowMs = Date.now(),
): string | null {
	let best: number | null = null;
	let bestIso: string | null = null;
	for (const a of store.accounts) {
		const future = (iso: string | null | undefined) => {
			if (!iso) return null;
			const ms = Date.parse(iso);
			return Number.isNaN(ms) || ms <= nowMs ? null : { iso, ms };
		};
		const cooldown = future(a.switchCooldownUntil);
		const quota = future(a.quotaExhaustedUntil);
		// Cooldown and exhaustion are simultaneous usability constraints, so report
		// when both have cleared. weeklyResetAt is only a fallback when neither
		// active constraint has a future timestamp.
		const accountReset =
			cooldown && quota
				? cooldown.ms >= quota.ms
					? cooldown
					: quota
				: (cooldown ?? quota ?? future(a.weeklyResetAt));
		if (accountReset && (best === null || accountReset.ms < best)) {
			best = accountReset.ms;
			bestIso = accountReset.iso;
		}
	}
	return bestIso;
}
