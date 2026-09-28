/**
 * FLY-2896 — strict contract for Claude reset cards (internal code name
 * `cedar_ember`), read from the same usage response the monitor already uses.
 *
 * Pure: parses the status block and the redeem response. Unknown shapes are
 * `malformed`, never guessed. Server free text (`label`, `reason`) is dropped so
 * nothing provider-authored reaches a founder-facing card.
 */

import { normalizeExternalInstant } from "../quota-external-instant.js";

export const LIMIT_KEYS = [
	"five_hour",
	"seven_day",
	"seven_day_overage_included",
	"seven_day_opus",
	"seven_day_sonnet",
	"seven_day_cowork",
	"seven_day_omelette",
	"seven_day_oauth_apps",
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];

/** The CLI refuses to send any other grant id; so do we. */
export const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ITEMS = 128;
const MAX_RESETS = 1000;

export interface CedarGrant {
	id: string;
	resetsLeft: number;
	resetsTotal: number;
	startsAt: string | null;
	endsAt: string | null;
	clears: LimitKey[];
	blocking: LimitKey[];
	/** A blocking entry we do not recognise still blocks. */
	blockingUnknown: boolean;
	paused: boolean;
	usableNow: boolean;
	useRequiresLimit: boolean;
}

export interface CedarStatus {
	eligible: boolean;
	ineligibleReason: string | null;
	atLimit: boolean;
	exhausted: LimitKey[];
	/** An exhausted window we cannot name: never propose against it. */
	exhaustedUnknown: boolean;
	grants: CedarGrant[];
	nextGrantId: string | null;
	cooldownUntil: string | null;
}

export type ParsedCedarStatus =
	| { ok: CedarStatus }
	| { error: "absent" | "malformed" };

export type RedeemOutcome =
	| { kind: "reset"; resetsLeft: number | null; cleared: LimitKey[] }
	| {
			kind: "not_spent";
			cause:
				| "not_limited"
				| "cooldown"
				| "ineligible"
				| "rate_limited"
				| "auth_error";
	  }
	| { kind: "already_used" }
	| {
			kind: "unconfirmed";
			cause:
				| "unavailable"
				| "http_5xx"
				| "http_4xx_other"
				| "malformed"
				| "network"
				| "timeout";
	  };

class Malformed extends Error {}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const LIMIT_KEY_SET: ReadonlySet<string> = new Set(LIMIT_KEYS);

function isLimitKey(value: string): value is LimitKey {
	return LIMIT_KEY_SET.has(value);
}

function limitList(value: unknown): { keys: LimitKey[]; unknown: boolean } {
	if (value === undefined || value === null)
		return { keys: [], unknown: false };
	if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Malformed();
	const keys: LimitKey[] = [];
	let unknown = false;
	for (const item of value) {
		if (typeof item !== "string") throw new Malformed();
		if (isLimitKey(item)) {
			if (!keys.includes(item)) keys.push(item);
		} else {
			unknown = true;
		}
	}
	return { keys, unknown };
}

function flag(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "boolean") throw new Malformed();
	return value;
}

function count(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > MAX_RESETS
	) {
		throw new Malformed();
	}
	return value;
}

function instant(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const normalized = normalizeExternalInstant(value);
	if (normalized === null) throw new Malformed();
	return normalized;
}

function grantId(value: unknown): string {
	if (typeof value !== "string" || !GRANT_ID.test(value)) throw new Malformed();
	return value;
}

function parseGrant(value: unknown): CedarGrant {
	if (!record(value)) throw new Malformed();
	const resetsLeft = count(value.resets_left);
	const resetsTotal = count(value.resets_total);
	if (resetsLeft > resetsTotal) throw new Malformed();
	const blocking = limitList(value.blocking);
	return {
		id: grantId(value.id),
		resetsLeft,
		resetsTotal,
		startsAt: instant(value.starts_at),
		endsAt: instant(value.ends_at),
		// Unknown clears are dropped: fewer clears can only refuse more.
		clears: limitList(value.clears).keys,
		blocking: blocking.keys,
		blockingUnknown: blocking.unknown,
		paused: flag(value.paused, false),
		usableNow: flag(value.usable_now, false),
		useRequiresLimit: flag(value.use_requires_limit, true),
	};
}

/**
 * Parse the `cedar_ember` block of a usage response body. `absent` means the
 * server did not report the block at all (e.g. wrong UA surface).
 */
export function parseCedarStatus(raw: unknown): ParsedCedarStatus {
	if (!record(raw) || !record(raw.cedar_ember)) return { error: "absent" };
	const ember = raw.cedar_ember;
	try {
		if (typeof ember.eligible !== "boolean") throw new Malformed();
		const grantsRaw = ember.grants ?? [];
		if (!Array.isArray(grantsRaw) || grantsRaw.length > MAX_ITEMS) {
			throw new Malformed();
		}
		const exhausted = limitList(ember.exhausted);
		const reason = ember.ineligible_reason;
		return {
			ok: {
				eligible: ember.eligible,
				ineligibleReason:
					reason === undefined || reason === null
						? null
						: typeof reason === "string" && SAFE_REASON.test(reason)
							? reason
							: "unknown",
				atLimit: flag(ember.at_limit, false),
				exhausted: exhausted.keys,
				exhaustedUnknown: exhausted.unknown,
				grants: grantsRaw.map(parseGrant),
				nextGrantId:
					ember.next_grant_id === undefined || ember.next_grant_id === null
						? null
						: grantId(ember.next_grant_id),
				cooldownUntil: instant(ember.cooldown_until),
			},
		};
	} catch (error) {
		if (error instanceof Malformed) return { error: "malformed" };
		throw error;
	}
}

/**
 * Classify a redeem response by the CLI's evidence matrix. Only `200 +
 * result:reset` proves this request spent a card; only the listed statuses
 * prove it did not. Everything else leaves the card possibly spent.
 */
export function parseRedeemResponse(
	status: number,
	raw: unknown,
): RedeemOutcome {
	if (status === 429) return { kind: "not_spent", cause: "rate_limited" };
	if (status === 401 || status === 403) {
		return { kind: "not_spent", cause: "auth_error" };
	}
	if (status >= 500) return { kind: "unconfirmed", cause: "http_5xx" };
	if (status < 200 || status >= 300) {
		return { kind: "unconfirmed", cause: "http_4xx_other" };
	}
	if (!record(raw) || typeof raw.result !== "string") {
		return { kind: "unconfirmed", cause: "malformed" };
	}
	switch (raw.result) {
		case "reset": {
			let resetsLeft: number | null = null;
			try {
				resetsLeft = count(raw.resets_left);
			} catch {
				resetsLeft = null;
			}
			let cleared: LimitKey[] = [];
			try {
				cleared = limitList(raw.cleared).keys;
			} catch {
				cleared = [];
			}
			return { kind: "reset", resetsLeft, cleared };
		}
		case "not_limited":
		case "cooldown":
		case "ineligible":
			return { kind: "not_spent", cause: raw.result };
		case "already_used":
			return { kind: "already_used" };
		case "unavailable":
			return { kind: "unconfirmed", cause: "unavailable" };
		default:
			return { kind: "unconfirmed", cause: "malformed" };
	}
}
