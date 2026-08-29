/**
 * FLY-871 R2/C7 — the per-account state ledger (Annie's「账号状态账本」,
 * lead-instruction bd508ae5).
 *
 * A durable per-account record so the Codex Infra Bot's watch behavior reads a
 * ledger instead of re-stitching a string once per daily report, AND so v2 smart
 * account selection has a clean interface. Deliberately kept to a JSON state file
 * (the same shape/discipline as `account-store.ts` / `pending-store.ts`) — NOT a
 * new database — per the instruction "别为这个扩成大活".
 *
 * Records, per account:
 *   - balance snapshot: 5h% / 7d% + reset instants, tagged with its SOURCE and
 *     whether it was observed while the account was the live/active session (an
 *     idle account carries its LAST-known snapshot with a staleness age — the
 *     research (research.md Appendix A) found no safe way to query an idle
 *     account's remaining quota, so we annotate staleness rather than guess).
 *   - cap events: when a 5h/weekly cap was hit and when it recovered.
 *   - auth health: the R1 freshness-probe outcome (refreshed / stale).
 *   - pool freshness: the pooled credential's access-token expiry + last capture-back.
 *
 * Accurate-source policy (research.md Appendix A.5): the active account's balance
 * comes from the Claude Code statusLine `rate_limits` structured field
 * (`parseRateLimits`, format-stable) with the rendered gauge (`balanceFromGauge`)
 * as a fallback. Idle accounts keep their last snapshot + staleness. NEVER probe
 * an idle account just to read usage — a refresh on an idle pool account is the
 * 2026-07-04 incident (R1 red line).
 *
 * All the parse/record helpers are pure (clock injected as an ISO string), so the
 * module is fully unit-testable without a real clock, network, or IO beyond the
 * JSON file.
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AccountStore,
	type SelectInput,
	selectNextAccount,
} from "./account-store.js";
import type { UsageGauge } from "./usage-gauge.js";

export type BalanceSource = "statusline" | "gauge";

export interface AccountBalanceSnapshot {
	/** 5h rolling-window usage percent (0-100), or null when unresolved. */
	fivehPct: number | null;
	/** 7d rolling-week usage percent (0-100), or null when unresolved. */
	weeklyPct: number | null;
	/** ISO reset instant of the 5h window, or null. */
	fivehResetAt: string | null;
	/** ISO reset instant of the weekly window, or null. */
	weeklyResetAt: string | null;
	source: BalanceSource;
	/** ISO — when this snapshot was recorded. */
	observedAt: string;
	/**
	 * true when observed while this account was the LIVE/active session (fresh);
	 * false marks a carry-over snapshot for an account now idle (stale — read the
	 * age from `observedAt`). Idle accounts have no queryable live quota.
	 */
	observedWhileActive: boolean;
}

export interface CapEvent {
	/** ISO — when the cap was hit. */
	at: string;
	scope: "5h" | "weekly" | "both";
	/** ISO reset instant of the hit window (null when unresolved). */
	resetAt: string | null;
	/** ISO — set when the cap cleared (the window reset / account switched back). */
	recoveredAt?: string;
}

export interface AuthHealthRecord {
	/** ISO — last R1 freshness probe. */
	lastVerifiedAt?: string;
	lastFreshness?: "refreshed" | "stale";
	reason?: string;
}

export interface PoolFreshnessRecord {
	/** ISO — the pooled credential's access-token expiry (`claudeAiOauth.expiresAt`). */
	expiresAt?: string;
	/** ISO — last time the live Keychain was captured back into the pool. */
	capturedBackAt?: string;
}

export interface AccountLedgerEntry {
	name: string;
	balance?: AccountBalanceSnapshot;
	capEvents: CapEvent[];
	auth: AuthHealthRecord;
	pool?: PoolFreshnessRecord;
}

export interface AccountLedger {
	/** ISO — last mutation. */
	updatedAt: string;
	accounts: Record<string, AccountLedgerEntry>;
}

/** Cap `capEvents` growth (defense: a flapping account never bloats the file). */
const MAX_CAP_EVENTS = 50;

export function defaultLedgerPath(): string {
	return (
		process.env.FLYWHEEL_ACCOUNT_LEDGER_PATH ??
		join(homedir(), ".flywheel", "account-ledger.json")
	);
}

/** Tolerant read — a missing / malformed file yields an empty ledger. */
export function readLedger(path: string = defaultLedgerPath()): AccountLedger {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return { updatedAt: "", accounts: {} };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<AccountLedger>;
		if (!parsed || typeof parsed !== "object" || !parsed.accounts) {
			return { updatedAt: "", accounts: {} };
		}
		return { updatedAt: parsed.updatedAt ?? "", accounts: parsed.accounts };
	} catch {
		return { updatedAt: "", accounts: {} };
	}
}

export function writeLedger(
	ledger: AccountLedger,
	path: string = defaultLedgerPath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(ledger, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

function ensureEntry(ledger: AccountLedger, name: string): AccountLedgerEntry {
	const existing = ledger.accounts[name];
	if (existing) return existing;
	const created: AccountLedgerEntry = { name, capEvents: [], auth: {} };
	ledger.accounts[name] = created;
	return created;
}

/**
 * Parse the Claude Code statusLine `rate_limits` structured field into a balance
 * snapshot (the accurate, format-stable active-account source — research.md
 * Appendix A.2). Accepts either the full payload (`{ rate_limits: {...} }`) or the
 * `rate_limits` object directly. Each window (`five_hour` / `seven_day`) may be
 * independently absent (only present for Pro/Max after the first API response);
 * `resets_at` is Unix epoch SECONDS. Returns null when no usable window is present.
 */
export function parseRateLimits(
	raw: unknown,
	observedAt: string,
	observedWhileActive: boolean,
): AccountBalanceSnapshot | null {
	if (!raw || typeof raw !== "object") return null;
	const outer = raw as Record<string, unknown>;
	const rl =
		outer.rate_limits && typeof outer.rate_limits === "object"
			? (outer.rate_limits as Record<string, unknown>)
			: outer;

	const window = (
		o: unknown,
	): { pct: number | null; resetAt: string | null } => {
		if (!o || typeof o !== "object") return { pct: null, resetAt: null };
		const w = o as Record<string, unknown>;
		const pct =
			typeof w.used_percentage === "number" &&
			Number.isFinite(w.used_percentage)
				? w.used_percentage
				: null;
		const epoch =
			typeof w.resets_at === "number" && Number.isFinite(w.resets_at)
				? w.resets_at
				: null;
		const resetAt =
			epoch !== null ? new Date(epoch * 1000).toISOString() : null;
		return { pct, resetAt };
	};

	const five = window(rl.five_hour);
	const seven = window(rl.seven_day);
	// No usable rate_limits at all (e.g. absent before the first API response).
	if (
		five.pct === null &&
		seven.pct === null &&
		five.resetAt === null &&
		seven.resetAt === null
	) {
		return null;
	}
	return {
		fivehPct: five.pct,
		weeklyPct: seven.pct,
		fivehResetAt: five.resetAt,
		weeklyResetAt: seven.resetAt,
		source: "statusline",
		observedAt,
		observedWhileActive,
	};
}

/**
 * Fallback source: build a balance snapshot from a parsed rendered-gauge
 * (`usage-gauge.ts`) — used when the statusLine `rate_limits` field is absent
 * (older CLI, or before the first API response).
 */
export function balanceFromGauge(
	gauge: UsageGauge,
	observedAt: string,
	observedWhileActive: boolean,
): AccountBalanceSnapshot {
	return {
		fivehPct: gauge.fivehPct,
		weeklyPct: gauge.weeklyPct,
		fivehResetAt: gauge.fivehResetAt,
		weeklyResetAt: gauge.weeklyResetAt,
		source: "gauge",
		observedAt,
		observedWhileActive,
	};
}

/** Record the latest balance snapshot for `name`. */
export function recordBalance(
	name: string,
	snapshot: AccountBalanceSnapshot,
	path: string = defaultLedgerPath(),
): void {
	const ledger = readLedger(path);
	ensureEntry(ledger, name).balance = snapshot;
	ledger.updatedAt = snapshot.observedAt;
	writeLedger(ledger, path);
}

/** Append a cap-hit event for `name` (bounded to the most recent MAX_CAP_EVENTS). */
export function recordCapEvent(
	name: string,
	event: CapEvent,
	path: string = defaultLedgerPath(),
): void {
	const ledger = readLedger(path);
	const entry = ensureEntry(ledger, name);
	entry.capEvents.push(event);
	if (entry.capEvents.length > MAX_CAP_EVENTS) {
		entry.capEvents.splice(0, entry.capEvents.length - MAX_CAP_EVENTS);
	}
	ledger.updatedAt = event.at;
	writeLedger(ledger, path);
}

/**
 * Mark the most recent still-open cap event for `name` as recovered at
 * `recoveredAt`. No-op when there is no open cap event.
 */
export function recordCapRecovery(
	name: string,
	recoveredAt: string,
	path: string = defaultLedgerPath(),
): void {
	const ledger = readLedger(path);
	const entry = ledger.accounts[name];
	if (!entry) return;
	for (let i = entry.capEvents.length - 1; i >= 0; i--) {
		const ev = entry.capEvents[i];
		if (ev && ev.recoveredAt === undefined) {
			ev.recoveredAt = recoveredAt;
			ledger.updatedAt = recoveredAt;
			writeLedger(ledger, path);
			return;
		}
	}
}

/** Record the R1 freshness-probe outcome for `name`. */
export function recordAuthHealth(
	name: string,
	health: AuthHealthRecord,
	path: string = defaultLedgerPath(),
): void {
	const ledger = readLedger(path);
	ensureEntry(ledger, name).auth = health;
	ledger.updatedAt = health.lastVerifiedAt ?? ledger.updatedAt;
	writeLedger(ledger, path);
}

/** Record pooled-credential freshness (expiry / last capture-back) for `name`. */
export function recordPoolFreshness(
	name: string,
	pool: PoolFreshnessRecord,
	updatedAt: string,
	path: string = defaultLedgerPath(),
): void {
	const ledger = readLedger(path);
	ensureEntry(ledger, name).pool = pool;
	ledger.updatedAt = updatedAt;
	writeLedger(ledger, path);
}

/**
 * FLY-871 R2/C7 (bd508ae5) — the EXTRACTED selection function + the v2 rank hook.
 *
 * Annie eventually wants "知道每个账号状态、换最优的那个" (rank candidates by their
 * ledger state). v1 does NOT do that: it delegates to the shipped candidate-order
 * `selectNextAccount` so switch behavior is byte-identical. The optional `ledger`
 * param is the forward-compatible seam — a v2 ranker will consume it here without
 * changing any caller. Kept live (not dead scaffolding) by C7's daily summary,
 * which calls this to show "if we had to switch now, the target would be X".
 */
export function recommendNextAccount(
	store: AccountStore,
	input: SelectInput,
	// v2 ledger-rank hook (bd508ae5): intentionally accepted, unused in v1
	// (the `_` prefix marks it deliberately-unused for tsc + biome).
	_ledger?: AccountLedger,
): string | null {
	// v1: candidate order, unchanged. v2 will rank `store` accounts by `_ledger`.
	return selectNextAccount(store, input);
}

// ─────────────────────────────────────────────────────────────────────────────
// FLY-871 R2/C7 — the "看" read side. The Codex Infra Bot's daily summary reads
// the ledger (not a one-off string stitch) + the store (authoritative active /
// reset) into one terse per-account view. Pure — the bot / a CLI passes `nowIso`.
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountSummaryLine {
	name: string;
	active: boolean;
	fivehPct: number | null;
	weeklyPct: number | null;
	weeklyResetAt: string | null;
	/** Minutes since the balance snapshot (null = never recorded). */
	balanceAgeMin: number | null;
	/** true if that snapshot was taken while the account was live (else stale carry-over). */
	balanceLive: boolean;
	authHealth: "refreshed" | "stale" | "unknown";
	/** A switch would skip this account (store auth-unusable flags). */
	authUnusable: boolean;
	/** Ledger cap events hit but not yet recovered. */
	openCaps: number;
}

export function buildAccountSummary(
	ledger: AccountLedger,
	store: AccountStore,
	nowIso: string,
): AccountSummaryLine[] {
	const nowMs = Date.parse(nowIso);
	return store.accounts.map((a) => {
		const e = ledger.accounts[a.name];
		const bal = e?.balance;
		const obsMs = bal ? Date.parse(bal.observedAt) : Number.NaN;
		const ageMin =
			bal && !Number.isNaN(nowMs) && !Number.isNaN(obsMs)
				? Math.max(0, Math.round((nowMs - obsMs) / 60000))
				: null;
		return {
			name: a.name,
			active: store.activeAccount === a.name,
			fivehPct: bal?.fivehPct ?? null,
			weeklyPct: bal?.weeklyPct ?? null,
			weeklyResetAt: a.weeklyResetAt,
			balanceAgeMin: ageMin,
			balanceLive: bal?.observedWhileActive ?? false,
			authHealth: e?.auth.lastFreshness ?? "unknown",
			authUnusable: Boolean(
				a.authExpired || a.refreshTokenInvalid || a.profileVerifyFailed,
			),
			openCaps: (e?.capEvents ?? []).filter((c) => c.recoveredAt === undefined)
				.length,
		};
	});
}

/** One line per account for the daily Alerts summary (deliberately terse). */
export function formatAccountSummary(lines: AccountSummaryLine[]): string {
	if (lines.length === 0) return "No Claude accounts provisioned.";
	const rows = lines.map((l) => {
		const star = l.active ? "★" : " ";
		const five = l.fivehPct == null ? "?" : `${l.fivehPct}%`;
		const wk = l.weeklyPct == null ? "?" : `${l.weeklyPct}%`;
		const age =
			l.balanceAgeMin == null
				? "no-data"
				: l.balanceLive
					? `${l.balanceAgeMin}m live`
					: `${l.balanceAgeMin}m STALE`;
		const health = l.authUnusable ? "auth✗" : l.authHealth;
		const caps = l.openCaps > 0 ? ` caps:${l.openCaps}` : "";
		return `${star} ${l.name}: 5h ${five} · 7d ${wk} (${age}) · ${health}${caps}`;
	});
	return `Claude accounts (${lines.length}):\n${rows.join("\n")}`;
}
