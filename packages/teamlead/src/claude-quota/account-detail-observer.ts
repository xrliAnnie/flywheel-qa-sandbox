import { readdirSync } from "node:fs";
import { readPoolMonitorCredentialSnapshot } from "../account-heal/quota-monitor-credentials.js";
import type {
	ClaudeAccountDetailReading,
	ClaudeAccountDetailStore,
	ClaudePrepaidCard,
	ClaudePrepaidDetail,
} from "./account-detail-store.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_DEADLINE_MS = 45_000;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_STATUS = /^[a-z][a-z0-9_]{0,63}$/;
const PROFILE_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;

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

async function requestJson(
	url: string,
	accessToken: string,
	options: ObserveClaudeAccountDetailsOptions,
	totalSignal: AbortSignal,
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
			},
		});
		let raw: unknown = null;
		try {
			raw = await response.json();
		} catch {
			if (response.ok) return { error: "malformed", code: null };
		}
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

function parseProfile(value: unknown): {
	organizationUuid: string;
	subscription: ClaudeAccountDetailReading["subscription"];
} | null {
	if (!record(value) || !record(value.organization)) return null;
	const uuid = value.organization.uuid;
	const status = value.organization.subscription_status;
	if (typeof uuid !== "string" || !UUID.test(uuid)) return null;
	return {
		organizationUuid: uuid,
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
			`${baseUrl}/api/oauth/usage`,
			credential.accessToken,
			options,
			totalSignal,
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
	return {
		name,
		observedAt: nowIso,
		subscription: profile.subscription,
		usageStatus,
		prepaid,
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
				),
			),
		);
		return { version: 1, generatedAt: nowIso, accounts };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
