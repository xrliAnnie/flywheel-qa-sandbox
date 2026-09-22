/**
 * FLY-2688 — full `account/rateLimits/read` payload reader for the account quota page.
 *
 * Deliberately separate from `parseCodexRateLimits`: that parser feeds failover
 * candidate selection and must keep its exact semantics. This one keeps the
 * fields the page needs (window duration, plan, credits, reset credits) and
 * refuses to guess a window whose duration the RPC did not state.
 */

const FIVE_HOUR_WINDOW_MAX_MINUTES = 600;
const EARLIEST_RESET_SECONDS = 946_684_800; // 2000-01-01, same floor as the failover parser
const MAX_RESET_AHEAD_MS = 366 * 86_400_000;
const BALANCE = /^\d{1,12}(?:\.\d{1,2})?$/;

export interface CodexRateLimitWindow {
	usedPercent: number;
	windowMinutes: number;
	resetAt: string | null;
}

export interface CodexCreditsDetail {
	/** false = the RPC did not expose credits at all; the page must say so, not guess. */
	known: boolean;
	hasCredits: boolean | null;
	unlimited: boolean | null;
	balance: string | null;
}

export interface CodexResetCreditsDetail {
	/** false = field absent from the RPC result; true + null value = present and empty. */
	known: boolean;
	value: string | null;
}

export interface CodexRateLimitDetail {
	planType: string | null;
	fiveH: CodexRateLimitWindow | null;
	weekly: CodexRateLimitWindow | null;
	credits: CodexCreditsDetail;
	resetCredits: CodexResetCreditsDetail;
	reachedType: string | null;
	/** Windows the RPC returned without a usable duration; surfaced, never bucketed. */
	unclassifiedWindows: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function boundedText(value: unknown): string | null {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
		? value
		: null;
}

function parseWindow(
	value: unknown,
	now: number,
): CodexRateLimitWindow | "unclassified" | "invalid" | null {
	if (value == null) return null;
	if (!record(value)) return "invalid";
	const used = value.usedPercent;
	if (
		!Number.isInteger(used) ||
		(used as number) < 0 ||
		(used as number) > 100
	) {
		return "invalid";
	}
	let resetAt: string | null = null;
	if (value.resetsAt != null) {
		const seconds = value.resetsAt;
		if (
			typeof seconds !== "number" ||
			!Number.isSafeInteger(seconds) ||
			seconds < EARLIEST_RESET_SECONDS ||
			seconds * 1000 > now + MAX_RESET_AHEAD_MS
		) {
			return "invalid";
		}
		resetAt = new Date(seconds * 1000).toISOString();
	}
	const minutes = value.windowDurationMins;
	if (
		!Number.isInteger(minutes) ||
		(minutes as number) <= 0 ||
		(minutes as number) > 525_600
	) {
		return "unclassified";
	}
	return {
		usedPercent: used as number,
		windowMinutes: minutes as number,
		resetAt,
	};
}

function parseCredits(value: unknown): CodexCreditsDetail {
	const unknown: CodexCreditsDetail = {
		known: false,
		hasCredits: null,
		unlimited: null,
		balance: null,
	};
	if (value === undefined) return unknown;
	if (value === null) {
		return { known: true, hasCredits: null, unlimited: null, balance: null };
	}
	if (!record(value)) return unknown;
	const flag = (raw: unknown) => (typeof raw === "boolean" ? raw : null);
	const balance =
		typeof value.balance === "string" && BALANCE.test(value.balance)
			? value.balance
			: typeof value.balance === "number" && Number.isFinite(value.balance)
				? String(value.balance)
				: null;
	return {
		known: true,
		hasCredits: flag(value.hasCredits),
		unlimited: flag(value.unlimited),
		balance,
	};
}

function parseResetCredits(
	container: Record<string, unknown>,
): CodexResetCreditsDetail {
	if (!("rateLimitResetCredits" in container)) {
		return { known: false, value: null };
	}
	const value = container.rateLimitResetCredits;
	if (value === null) return { known: true, value: null };
	if (typeof value === "number" && Number.isFinite(value)) {
		return { known: true, value: String(value) };
	}
	if (typeof value === "string" && BALANCE.test(value)) {
		return { known: true, value };
	}
	return { known: false, value: null };
}

export function parseCodexRateLimitDetail(
	value: unknown,
	limitId: string,
	now: number,
): CodexRateLimitDetail | null {
	if (!record(value)) return null;
	const bucket = record(value.rateLimitsByLimitId)
		? value.rateLimitsByLimitId[limitId]
		: value.rateLimits;
	if (!record(bucket)) return null;
	if (bucket.limitId != null && bucket.limitId !== limitId) return null;

	let fiveH: CodexRateLimitWindow | null = null;
	let weekly: CodexRateLimitWindow | null = null;
	let unclassifiedWindows = 0;
	for (const name of ["primary", "secondary"] as const) {
		const parsed = parseWindow(bucket[name], now);
		if (parsed === null) continue;
		if (parsed === "invalid") return null;
		if (parsed === "unclassified") {
			unclassifiedWindows += 1;
			continue;
		}
		if (parsed.windowMinutes <= FIVE_HOUR_WINDOW_MAX_MINUTES) {
			if (fiveH !== null) return null;
			fiveH = parsed;
		} else {
			if (weekly !== null) return null;
			weekly = parsed;
		}
	}
	if (fiveH === null && weekly === null && unclassifiedWindows === 0) {
		return null;
	}
	return {
		planType: boundedText(bucket.planType),
		fiveH,
		weekly,
		credits: parseCredits(bucket.credits),
		resetCredits: parseResetCredits(value),
		reachedType: boundedText(bucket.rateLimitReachedType),
		unclassifiedWindows,
	};
}
