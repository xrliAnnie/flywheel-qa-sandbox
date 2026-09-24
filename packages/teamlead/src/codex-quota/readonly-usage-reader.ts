import { readFileSync } from "node:fs";
import type { CodexAccountPool } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { identifyCodexAuth } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { codexInstallAccountKey } from "flywheel-claude-runner/bin/codex-account-install.mjs";
import type { CodexAccountReading } from "./codex-account-quota-store.js";
import { FIVE_HOUR_WINDOW_MAX_MINUTES } from "./rate-limit-detail.js";

const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 10_000;
const EARLIEST_RESET_SECONDS = 946_684_800;
const MAX_RESET_AHEAD_MS = 366 * 86_400_000;
const BALANCE = /^\d{1,12}(?:\.\d{1,2})?$/;

type ReadonlyFields = Pick<
	CodexAccountReading,
	| "observedAt"
	| "planType"
	| "fiveH"
	| "weekly"
	| "credits"
	| "resetCredits"
	| "unclassifiedWindows"
>;

export type CodexReadonlyUsageResult =
	| { ok: ReadonlyFields }
	| {
			error:
				| "identity_mismatch"
				| "unauthorized"
				| "forbidden"
				| "network"
				| "malformed";
	  };

export interface ReadCodexReadonlyUsageOptions {
	authPath: string;
	registry: Pick<CodexAccountPool, "profiles">;
	expectedAccountKey: string;
	now?: () => number;
	fetchFn?: typeof fetch;
	/** Test-only injection. Production callers omit this fixed-origin option. */
	endpoint?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function parseWindow(
	value: unknown,
	now: number,
): CodexAccountReading["fiveH"] | "unclassified" | "invalid" | null {
	if (value == null) return null;
	if (!record(value)) return "invalid";
	const used = value.used_percent;
	if (
		!Number.isInteger(used) ||
		(used as number) < 0 ||
		(used as number) > 100
	) {
		return "invalid";
	}
	let resetAt: string | null = null;
	if (value.reset_at != null) {
		if (
			typeof value.reset_at !== "number" ||
			!Number.isSafeInteger(value.reset_at) ||
			value.reset_at < EARLIEST_RESET_SECONDS ||
			value.reset_at * 1000 > now + MAX_RESET_AHEAD_MS
		) {
			return "invalid";
		}
		resetAt = new Date(value.reset_at * 1000).toISOString();
	}
	const seconds = value.limit_window_seconds;
	if (
		!Number.isSafeInteger(seconds) ||
		(seconds as number) <= 0 ||
		(seconds as number) % 60 !== 0
	) {
		return "unclassified";
	}
	return {
		usedPercent: used as number,
		windowMinutes: (seconds as number) / 60,
		resetAt,
	};
}

function parseCredits(value: unknown): CodexAccountReading["credits"] {
	const unknown = {
		known: false,
		hasCredits: null,
		unlimited: null,
		balance: null,
	} as const;
	if (value === undefined) return unknown;
	if (!record(value)) return unknown;
	const flag = (input: unknown) => (typeof input === "boolean" ? input : null);
	const balance =
		typeof value.balance === "string" && BALANCE.test(value.balance)
			? value.balance
			: typeof value.balance === "number" && Number.isFinite(value.balance)
				? String(value.balance)
				: null;
	return {
		known: true,
		hasCredits: flag(value.has_credits),
		unlimited: flag(value.unlimited),
		balance,
	};
}

function parseCount(value: unknown): number | null {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		return value;
	}
	if (typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/.test(value)) {
		const count = Number(value);
		return Number.isSafeInteger(count) ? count : null;
	}
	return null;
}

function parsePayload(value: unknown, now: number): ReadonlyFields | null {
	if (!record(value) || !record(value.rate_limit)) return null;
	let fiveH: CodexAccountReading["fiveH"] = null;
	let weekly: CodexAccountReading["weekly"] = null;
	let unclassifiedWindows = 0;
	for (const key of ["primary_window", "secondary_window"] as const) {
		const parsed = parseWindow(value.rate_limit[key], now);
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
	if (fiveH === null && weekly === null && unclassifiedWindows === 0)
		return null;
	const planType =
		typeof value.plan_type === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.plan_type)
			? value.plan_type
			: null;
	const count = parseCount(value.reset_credit_count);
	return {
		observedAt: new Date(now).toISOString(),
		planType,
		fiveH,
		weekly,
		credits: parseCredits(value.credits),
		resetCredits:
			value.reset_credit_count === undefined || count === null
				? {
						known: false,
						value: null,
						availableCount: null,
						credits: null,
					}
				: {
						known: true,
						value: count === 0 ? null : String(count),
						availableCount: count,
						credits: null,
					},
		unclassifiedWindows,
	};
}

export async function readCodexReadonlyUsage(
	options: ReadCodexReadonlyUsageOptions,
): Promise<CodexReadonlyUsageResult> {
	if (options.endpoint !== undefined && options.fetchFn === undefined) {
		throw new Error("codex_readonly_test_origin_requires_fetch_injection");
	}
	let rawAuth: string;
	let accessToken: string;
	let accountId: string;
	try {
		rawAuth = readFileSync(options.authPath, "utf8");
		const identity = identifyCodexAuth(rawAuth, options.registry);
		if (codexInstallAccountKey(identity) !== options.expectedAccountKey) {
			return { error: "identity_mismatch" };
		}
		const parsed: unknown = JSON.parse(rawAuth);
		if (!record(parsed) || !record(parsed.tokens)) throw new Error("tokens");
		if (
			typeof parsed.tokens.access_token !== "string" ||
			parsed.tokens.access_token.length === 0 ||
			identity.accountId === null
		) {
			throw new Error("identity");
		}
		accessToken = parsed.tokens.access_token;
		accountId = identity.accountId;
	} catch {
		return { error: "identity_mismatch" };
	}

	const controller = new AbortController();
	const abortFromParent = () => controller.abort();
	options.signal?.addEventListener("abort", abortFromParent, { once: true });
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const response = await (options.fetchFn ?? fetch)(
			options.endpoint ?? DEFAULT_ENDPOINT,
			{
				method: "GET",
				redirect: "error",
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"ChatGPT-Account-Id": accountId,
					Accept: "application/json",
				},
			},
		);
		if (response.status === 401) return { error: "unauthorized" };
		if (response.status === 403) return { error: "forbidden" };
		if (!response.ok) return { error: "network" };
		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			return { error: "malformed" };
		}
		const parsed = parsePayload(raw, (options.now ?? Date.now)());
		return parsed === null ? { error: "malformed" } : { ok: parsed };
	} catch {
		return { error: "network" };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromParent);
	}
}
