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

export interface AccountEntry {
	name: string;
	/** ISO instant this account is quota-unusable until; null = usable now. */
	quotaExhaustedUntil: string | null;
	/** ISO instant of this account's weekly reset; null = unknown. */
	weeklyResetAt: string | null;
	/** Auth-expiry family (M3) — not a quota-switch target while true. */
	authExpired?: boolean;
	refreshTokenInvalid?: boolean;
	profileVerifyFailed?: boolean;
}

export interface AccountStore {
	/** Monotonic counter bumped on every committed switch (CAS token). */
	generation: number;
	/** The pool account currently written into the machine credential source. */
	activeAccount: string | null;
	accounts: AccountEntry[];
}

export interface SelectInput {
	scope: "5h" | "weekly" | "both" | null;
	currentName: string;
	now: Date;
}

function isAuthUnusable(a: AccountEntry): boolean {
	return Boolean(
		a.authExpired || a.refreshTokenInvalid || a.profileVerifyFailed,
	);
}

function isQuotaUsable(a: AccountEntry, nowMs: number): boolean {
	if (a.quotaExhaustedUntil === null) return true;
	const until = Date.parse(a.quotaExhaustedUntil);
	return Number.isNaN(until) || until <= nowMs;
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
	const candidates = store.accounts.filter(
		(a) =>
			a.name !== input.currentName &&
			!isAuthUnusable(a) &&
			isQuotaUsable(a, nowMs),
	);
	if (candidates.length === 0) return null;

	if (input.scope === "weekly" || input.scope === "both") {
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

	// 5h (or ambiguous): any usable account, chosen deterministically.
	const byName = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
	return byName[0]?.name ?? null;
}

/** A fresh, empty pool state. */
export function emptyStore(): AccountStore {
	return { generation: 0, activeAccount: null, accounts: [] };
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
		return parsed;
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

/**
 * Earliest reset moment across all quota-exhausted accounts — for the
 * "all accounts exhausted, wait until X" message to Annie. Returns null if
 * nothing has a known reset.
 */
export function earliestReset(store: AccountStore): string | null {
	let best: number | null = null;
	let bestIso: string | null = null;
	for (const a of store.accounts) {
		const iso = a.quotaExhaustedUntil ?? a.weeklyResetAt;
		if (!iso) continue;
		const ms = Date.parse(iso);
		if (Number.isNaN(ms)) continue;
		if (best === null || ms < best) {
			best = ms;
			bestIso = iso;
		}
	}
	return bestIso;
}
