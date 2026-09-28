/**
 * FLY-2896 — pure selection for the reset-card proposal.
 *
 * A card refills an exhausted window now; the account's own reset instant does
 * not move. So the card is worth most on the account that would otherwise stay
 * exhausted the longest: pick the latest natural recovery.
 */

import { createHash } from "node:crypto";
import type { AccountUsageResult } from "./quota-usage-api.js";
import type {
	CedarGrant,
	CedarStatus,
	LimitKey,
} from "./reset-card-contract.js";

type SuccessfulUsage = Extract<AccountUsageResult, { ok: unknown }>["ok"];

/**
 * v1 reads back and verifies the 5h and weekly windows. The weekly
 * overage-included limit rides on the weekly window (Lead ruling 2026-09-25:
 * a weekly-capped account reports it too, and the founder approves every
 * spend), so it is accepted; any other limit fails closed.
 */
const SUPPORTED_EXHAUSTED: ReadonlySet<LimitKey> = new Set([
	"five_hour",
	"seven_day",
	"seven_day_overage_included",
]);
const FIVE_HOURS_MS = 5 * 60 * 60_000;
const RUNWAY_MIN_ELAPSED_MS = 15 * 60_000;

export type GrantRefusal =
	| "ineligible"
	| "not_at_limit"
	| "no_next_grant"
	| "paused"
	| "not_usable_now"
	| "no_resets_left"
	| "grant_expired"
	| "grant_not_started"
	| "blocking"
	| "no_exhausted"
	| "unsupported_limit"
	| "exhausted_not_cleared";

export type CandidateRefusal =
	| GrantRefusal
	| "subscription_canceled"
	| "recovery_unknown";

export interface CardCandidateInput {
	name: string;
	usage: SuccessfulUsage;
	cedar: CedarStatus;
	subscription: "active" | "canceled" | "unknown";
}

export interface ResetCardSelection {
	target: CardCandidateInput;
	grant: CedarGrant;
	recoveryAt: string;
	/** Sum of resets left across every grant this account holds. */
	cardsLeft: number;
}

export type ResetCardRunway =
	| { fiveHourMinutes: number }
	| { unknown: "too_early" | "no_reset_time" };

/** The only card the client would offer, and only while the account is capped. */
export function usableGrant(
	cedar: CedarStatus,
	nowMs: number,
): { grant: CedarGrant } | { none: GrantRefusal } {
	if (!cedar.eligible) return { none: "ineligible" };
	// This feature never spends a card ahead of a limit, whatever the grant allows.
	if (!cedar.atLimit) return { none: "not_at_limit" };
	const grant =
		cedar.nextGrantId === null
			? undefined
			: cedar.grants.find((candidate) => candidate.id === cedar.nextGrantId);
	if (grant === undefined) return { none: "no_next_grant" };
	if (grant.paused) return { none: "paused" };
	if (!grant.usableNow) return { none: "not_usable_now" };
	if (grant.resetsLeft < 1) return { none: "no_resets_left" };
	if (grant.endsAt !== null && Date.parse(grant.endsAt) <= nowMs) {
		return { none: "grant_expired" };
	}
	if (grant.startsAt !== null && Date.parse(grant.startsAt) > nowMs) {
		return { none: "grant_not_started" };
	}
	if (grant.blocking.length > 0 || grant.blockingUnknown) {
		return { none: "blocking" };
	}
	if (cedar.exhaustedUnknown) return { none: "unsupported_limit" };
	if (cedar.exhausted.length === 0) return { none: "no_exhausted" };
	if (cedar.exhausted.some((key) => !SUPPORTED_EXHAUSTED.has(key))) {
		return { none: "unsupported_limit" };
	}
	if (cedar.exhausted.some((key) => !grant.clears.includes(key))) {
		return { none: "exhausted_not_cleared" };
	}
	return { grant };
}

/** Latest reset among the windows that are at 100%; null if any is undated. */
export function naturalRecoveryAt(usage: SuccessfulUsage): string | null {
	const exhausted = [usage.fiveH, usage.sevenD].filter(
		(window) => window.pct >= 100,
	);
	if (exhausted.length === 0) return null;
	let latest: { ms: number; iso: string } | null = null;
	for (const window of exhausted) {
		if (window.resetsAt === null) return null;
		const ms = Date.parse(window.resetsAt);
		if (!Number.isFinite(ms)) return null;
		if (latest === null || ms > latest.ms) {
			latest = { ms, iso: window.resetsAt };
		}
	}
	return latest === null ? null : new Date(latest.ms).toISOString();
}

export function cardsLeftTotal(cedar: CedarStatus): number {
	return cedar.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0);
}

export function selectResetCardTarget(
	inputs: readonly CardCandidateInput[],
	nowMs: number,
):
	| ResetCardSelection
	| { none: Array<{ name: string; reason: CandidateRefusal }> } {
	const refused: Array<{ name: string; reason: CandidateRefusal }> = [];
	const eligible: ResetCardSelection[] = [];
	for (const input of inputs) {
		if (input.subscription === "canceled") {
			refused.push({ name: input.name, reason: "subscription_canceled" });
			continue;
		}
		const usable = usableGrant(input.cedar, nowMs);
		if ("none" in usable) {
			refused.push({ name: input.name, reason: usable.none });
			continue;
		}
		const recoveryAt = naturalRecoveryAt(input.usage);
		if (recoveryAt === null) {
			refused.push({ name: input.name, reason: "recovery_unknown" });
			continue;
		}
		eligible.push({
			target: input,
			grant: usable.grant,
			recoveryAt,
			cardsLeft: cardsLeftTotal(input.cedar),
		});
	}
	const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000);
	eligible.sort(
		(a, b) =>
			minute(b.recoveryAt) - minute(a.recoveryAt) ||
			b.cardsLeft - a.cardsLeft ||
			a.target.name.localeCompare(b.target.name, "en-US"),
	);
	return eligible[0] ?? { none: refused };
}

/** Rough 5h runway at the active account's current burn rate. */
export function estimateRunway(
	activeUsage: SuccessfulUsage,
	nowMs: number,
): ResetCardRunway {
	if (activeUsage.fiveH.resetsAt === null) return { unknown: "no_reset_time" };
	const resetMs = Date.parse(activeUsage.fiveH.resetsAt);
	if (!Number.isFinite(resetMs)) return { unknown: "no_reset_time" };
	const elapsed = Math.min(FIVE_HOURS_MS, nowMs - (resetMs - FIVE_HOURS_MS));
	if (elapsed < RUNWAY_MIN_ELAPSED_MS) return { unknown: "too_early" };
	const cap = FIVE_HOURS_MS / 60_000;
	if (activeUsage.fiveH.pct <= 0) return { fiveHourMinutes: cap };
	const minutes = (100 / activeUsage.fiveH.pct) * (elapsed / 60_000);
	return { fiveHourMinutes: Math.min(cap, Math.floor(minutes)) };
}

/** The active window that crossed the ask threshold; earlier reset if both did. */
export function drivingWindow(
	usage: SuccessfulUsage,
	askPct: number,
): { window: "5h" | "7d"; resetAt: string | null } | null {
	const five = usage.fiveH.pct >= askPct;
	const seven = usage.sevenD.pct >= askPct;
	if (!five && !seven) return null;
	if (five && !seven) return { window: "5h", resetAt: usage.fiveH.resetsAt };
	if (seven && !five) return { window: "7d", resetAt: usage.sevenD.resetsAt };
	const fiveMs = Date.parse(usage.fiveH.resetsAt ?? "");
	const sevenMs = Date.parse(usage.sevenD.resetsAt ?? "");
	if (
		Number.isFinite(sevenMs) &&
		(!Number.isFinite(fiveMs) || sevenMs < fiveMs)
	) {
		return { window: "7d", resetAt: usage.sevenD.resetsAt };
	}
	return { window: "5h", resetAt: usage.fiveH.resetsAt };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function episodeKey(
	activeName: string,
	generation: number,
	window: "5h" | "7d",
	resetAt: string,
): string {
	// The API jitters a window's reset by fractions of a second, including
	// either side of the minute boundary. Round (do not floor) so evaluation
	// and execution bind consent to the same window across fresh reads.
	const resetMinute = new Date(
		Math.round(Date.parse(resetAt) / 60_000) * 60_000,
	).toISOString();
	return sha256(JSON.stringify([activeName, generation, window, resetMinute]));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [
					key,
					canonical((value as Record<string, unknown>)[key]),
				]),
		);
	}
	return value;
}

/** sha256 over canonical JSON (sorted keys; array order is significant). */
export function proposalDigest(core: unknown): string {
	return sha256(JSON.stringify(canonical(core)));
}
