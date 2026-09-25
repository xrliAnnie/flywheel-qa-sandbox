import { readdirSync } from "node:fs";
import { readClaudeCliVersion } from "../account-heal/claude-cli-version.js";
import { readPoolMonitorCredentialSnapshot } from "../account-heal/quota-monitor-credentials.js";
import { normalizeExternalInstant } from "../quota-external-instant.js";
import type {
	ClaudeAccountDetailReading,
	ClaudeAccountDetailStore,
	ClaudePrepaidCard,
	ClaudePrepaidDetail,
	ClaudeResetGrant,
	ClaudeResetGrants,
	ClaudeTier,
} from "./account-detail-store.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_DEADLINE_MS = 45_000;
/** Every response is capped before parsing; a real body is a few KiB. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_STATUS = /^[a-z][a-z0-9_]{0,63}$/;
const PROFILE_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const TIER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_GRANTS = 128;
const MAX_GRANT_RESETS = 1000;
/**
 * FLY-2864: the same usage read, asking for the reset-card block. The
 * card-redeeming POST (`reset_rate_limits`) is never issued by this module.
 */
const USAGE_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";

export interface ObserveClaudeAccountDetailsOptions {
	profilesRoot: string;
	previous?: ClaudeAccountDetailStore | null;
	now?: () => number;
	fetchFn?: typeof fetch;
	/** Test-only injection; production callers use the fixed Anthropic origin. */
	baseUrl?: string;
	requestTimeoutMs?: number;
	totalDeadlineMs?: number;
	signal?: AbortSignal;
	/**
	 * FLY-2864: the installed Claude Code CLI version, read once per round.
	 * The usage endpoint reports reset cards only to a current CLI surface.
	 */
	cliVersion?: () => Promise<string | null>;
}

type RequestResult =
	| { ok: unknown }
	| {
			error:
				| "unauthorized"
				| "forbidden"
				| "network"
				| "malformed"
				| "deadline";
			code: string | null;
	  };

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function iso(value: unknown): string | null {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		const millis = value < 10_000_000_000 ? value * 1000 : value;
		return Number.isFinite(new Date(millis).valueOf())
			? new Date(millis).toISOString()
			: null;
	}
	return null;
}

function parseCards(
	value: unknown,
	source: ClaudePrepaidCard["source"],
): ClaudePrepaidCard[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length > 128) return null;
	const cards: ClaudePrepaidCard[] = [];
	for (const item of value) {
		if (!record(item)) return null;
		const expiresAt = iso(
			item.expires_at ?? item.expiresAt ?? item.expires_ms ?? item.expiresMs,
		);
		if (expiresAt === null) return null;
		cards.push({ source, expiresAt });
	}
	return cards;
}

function resetCount(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= MAX_GRANT_RESETS
	);
}

/**
 * FLY-2864: reset cards from the usage response's `cedar_ember` block. Only an
 * eligible grant list, or the server's explicit `no_grant`, is a card count;
 * every other gate (surface, cli_version, tier, ...) is unknown, never 0.
 */
export function parseClaudeResetGrants(
	value: unknown,
	cliVersionKnown: boolean,
): ClaudeResetGrants {
	const unknown = (reason: string): ClaudeResetGrants => ({
		known: false,
		reason,
		grants: null,
	});
	if (!record(value) || !record(value.cedar_ember)) return unknown("absent");
	const ember = value.cedar_ember;
	if (ember.eligible === true) {
		if (!Array.isArray(ember.grants) || ember.grants.length > MAX_GRANTS) {
			return unknown("malformed");
		}
		const grants: ClaudeResetGrant[] = [];
		for (const grant of ember.grants) {
			if (
				!record(grant) ||
				!resetCount(grant.resets_left) ||
				!resetCount(grant.resets_total) ||
				grant.resets_left > grant.resets_total
			) {
				return unknown("malformed");
			}
			let endsAt: string | null = null;
			if (grant.ends_at !== null) {
				endsAt = normalizeExternalInstant(grant.ends_at);
				if (endsAt === null) return unknown("malformed");
			}
			grants.push({
				resetsLeft: grant.resets_left,
				resetsTotal: grant.resets_total,
				endsAt,
			});
		}
		return { known: true, reason: null, grants };
	}
	if (ember.eligible === false) {
		if (ember.ineligible_reason === "no_grant") {
			return { known: true, reason: "no_grant", grants: [] };
		}
		if (!cliVersionKnown) return unknown("cli_version_unknown");
		return unknown(
			typeof ember.ineligible_reason === "string" &&
				SAFE_STATUS.test(ember.ineligible_reason)
				? ember.ineligible_reason
				: "unknown",
		);
	}
	return unknown("malformed");
}

export function parseClaudePrepaidPayload(value: unknown): ClaudePrepaidDetail {
	const unknown = (): ClaudePrepaidDetail => ({ known: false, cards: null });
	if (
		!record(value) ||
		!("tranches" in value) ||
		!("promo_tranches" in value)
	) {
		return unknown();
	}
	const tranches = parseCards(value.tranches, "tranche");
	const promos = parseCards(value.promo_tranches, "promo");
	if (
		(value.tranches !== null && tranches === null) ||
		(value.promo_tranches !== null && promos === null)
	) {
		return unknown();
	}
	if (tranches === null && promos === null) return { known: true, cards: null };
	const cards = [...(tranches ?? []), ...(promos ?? [])].sort(
		(a, b) =>
			Date.parse(a.expiresAt) - Date.parse(b.expiresAt) ||
			a.source.localeCompare(b.source, "en-US"),
	);
	return { known: true, cards };
}

function safeErrorCode(value: unknown): string | null {
	if (!record(value) || !record(value.error) || !record(value.error.details)) {
		return null;
	}
	const code = value.error.details.error_code;
	return typeof code === "string" && SAFE_STATUS.test(code) ? code : null;
}

/** Reads at most MAX_RESPONSE_BYTES, then parses; oversized or invalid is null. */
async function readBoundedJson(
	response: Response,
): Promise<{ value: unknown } | null> {
	const reader = response.body?.getReader();
	if (reader === undefined) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	try {
		return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
	} catch {
		return null;
	}
}

async function requestJson(
	url: string,
	accessToken: string,
	options: ObserveClaudeAccountDetailsOptions,
	totalSignal: AbortSignal,
	userAgent: string | null = null,
): Promise<RequestResult> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	totalSignal.addEventListener("abort", abort, { once: true });
	if (totalSignal.aborted) controller.abort();
	const timer = setTimeout(
		() => controller.abort(),
		options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
	);
	try {
		const response = await (options.fetchFn ?? fetch)(url, {
			method: "GET",
			redirect: "error",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				Accept: "application/json",
				...(userAgent === null ? {} : { "User-Agent": userAgent }),
			},
		});
		const parsed = await readBoundedJson(response);
		if (parsed === null && response.ok) {
			return { error: "malformed", code: null };
		}
		const raw = parsed?.value ?? null;
		if (response.status === 401) return { error: "unauthorized", code: null };
		if (response.status === 403) {
			return { error: "forbidden", code: safeErrorCode(raw) };
		}
		if (!response.ok) return { error: "network", code: null };
		return { ok: raw };
	} catch {
		return {
			error: totalSignal.aborted ? "deadline" : "network",
			code: null,
		};
	} finally {
		clearTimeout(timer);
		totalSignal.removeEventListener("abort", abort);
	}
}

/** FLY-2864: the live tier (`claude_max` + `default_claude_max_20x`), not the login-time cache. */
function parseTier(organization: Record<string, unknown>): ClaudeTier | null {
	const type = organization.organization_type;
	if (typeof type !== "string" || !TIER_TOKEN.test(type)) return null;
	const subscriptionType = type.replace(/^claude_/, "");
	if (!TIER_TOKEN.test(subscriptionType)) return null;
	const rateLimitTier = organization.rate_limit_tier;
	return {
		subscriptionType,
		rateLimitTier:
			typeof rateLimitTier === "string" && TIER_TOKEN.test(rateLimitTier)
				? rateLimitTier
				: null,
	};
}

function parseProfile(value: unknown): {
	organizationUuid: string;
	subscription: ClaudeAccountDetailReading["subscription"];
	tier: ClaudeTier | null;
} | null {
	if (!record(value) || !record(value.organization)) return null;
	const uuid = value.organization.uuid;
	const status = value.organization.subscription_status;
	if (typeof uuid !== "string" || !UUID.test(uuid)) return null;
	return {
		organizationUuid: uuid,
		tier: parseTier(value.organization),
		subscription:
			status === "canceled"
				? "canceled"
				: status === "active"
					? "active"
					: "unknown",
	};
}

function blank(name: string, note: string): ClaudeAccountDetailReading {
	return {
		name,
		observedAt: null,
		subscription: "unknown",
		usageStatus: "unknown",
		prepaid: { known: false, cards: null },
		note,
	};
}

async function probeAccount(
	name: string,
	options: ObserveClaudeAccountDetailsOptions,
	baseUrl: string,
	totalSignal: AbortSignal,
	nowIso: string,
	previous: ClaudeAccountDetailReading | undefined,
	cliVersion: string | null,
): Promise<ClaudeAccountDetailReading> {
	const credential = readPoolMonitorCredentialSnapshot(
		options.profilesRoot,
		name,
	);
	if (credential === null) {
		return previous
			? { ...previous, note: "credential_unavailable" }
			: blank(name, "credential_unavailable");
	}
	const [usage, profileResult] = await Promise.all([
		requestJson(
			`${baseUrl}${USAGE_PATH}`,
			credential.accessToken,
			options,
			totalSignal,
			cliVersion === null ? null : `claude-cli/${cliVersion} (external, cli)`,
		),
		requestJson(
			`${baseUrl}/api/oauth/profile`,
			credential.accessToken,
			options,
			totalSignal,
		),
	]);
	const usageStatus =
		"ok" in usage
			? "ok"
			: usage.error === "forbidden"
				? `forbidden:${usage.code ?? "unknown"}`
				: usage.error;
	if (!("ok" in profileResult)) {
		if (profileResult.error === "deadline") {
			return {
				...(previous ?? blank(name, "deadline")),
				name,
				usageStatus: "deadline",
				note: "deadline",
			};
		}
		return {
			...(previous ?? blank(name, "profile_unavailable")),
			name,
			usageStatus,
			note: `profile_${profileResult.error}`,
		};
	}
	const profile = parseProfile(profileResult.ok);
	if (profile === null) {
		return {
			...(previous ?? blank(name, "profile_malformed")),
			name,
			usageStatus,
			note: "profile_malformed",
		};
	}
	const prepaidResult = await requestJson(
		`${baseUrl}/api/oauth/organizations/${profile.organizationUuid}/prepaid/credits`,
		credential.accessToken,
		options,
		totalSignal,
	);
	const prepaid =
		"ok" in prepaidResult
			? parseClaudePrepaidPayload(prepaidResult.ok)
			: { known: false, cards: null };
	const after = readPoolMonitorCredentialSnapshot(options.profilesRoot, name);
	if (after === null || after.rawDigest !== credential.rawDigest) {
		return previous
			? { ...previous, note: "credential_changed" }
			: blank(name, "credential_changed");
	}
	const resetGrants: ClaudeResetGrants =
		"ok" in usage
			? parseClaudeResetGrants(usage.ok, cliVersion !== null)
			: { known: false, reason: usage.error, grants: null };
	return {
		name,
		observedAt: nowIso,
		subscription: profile.subscription,
		usageStatus,
		prepaid,
		tier: profile.tier,
		resetGrants,
		note:
			"ok" in prepaidResult
				? prepaid.known
					? null
					: "prepaid_malformed"
				: `prepaid_${prepaidResult.error}`,
	};
}

export async function observeClaudeAccountDetails(
	options: ObserveClaudeAccountDetailsOptions,
): Promise<ClaudeAccountDetailStore> {
	if (options.baseUrl !== undefined && options.fetchFn === undefined) {
		throw new Error("claude_detail_test_origin_requires_fetch_injection");
	}
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const now = options.now ?? Date.now;
	const nowIso = new Date(now()).toISOString();
	const previous = new Map(
		(options.previous?.accounts ?? []).map((account) => [
			account.name,
			account,
		]),
	);
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => controller.abort(),
		options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS,
	);
	try {
		// Fail loud when the root cannot be enumerated. Returning an empty round
		// would atomically erase the last good subscription/card observations.
		const names = readdirSync(options.profilesRoot, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					!entry.isSymbolicLink() &&
					PROFILE_NAME.test(entry.name),
			)
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b, "en-US"));
		// One bounded `--version` per round; a failing reader is an unknown version.
		const cliVersion = await (
			options.cliVersion ?? (() => readClaudeCliVersion())
		)().catch(() => null);
		// Start every slot together so a slow alphabetic prefix cannot starve the tail.
		const accounts = await Promise.all(
			names.map((name) =>
				probeAccount(
					name,
					options,
					baseUrl,
					controller.signal,
					nowIso,
					previous.get(name),
					cliVersion,
				),
			),
		);
		return { version: 1, generatedAt: nowIso, accounts };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
