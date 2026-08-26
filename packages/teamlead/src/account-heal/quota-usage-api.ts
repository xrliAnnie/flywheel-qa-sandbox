const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 30 * 60_000;

export interface QuotaWindow {
	utilization: number;
	/**
	 * `null` when the window has not opened yet — the API's normal shape for an
	 * idle account (FLY-1366). Never fabricate an instant for it; downstream
	 * consumers must stay null-safe.
	 */
	resets_at: string | null;
}

export type ValidatedUsagePayload = Record<string, unknown> & {
	five_hour: QuotaWindow;
	seven_day: QuotaWindow;
};

export type AccountUsageResult =
	| {
			ok: {
				raw: ValidatedUsagePayload;
				fiveH: { pct: number; resetsAt: string | null };
				sevenD: { pct: number; resetsAt: string | null };
			};
	  }
	| {
			error: "unauthorized" | "rate_limited" | "network" | "malformed";
			retryAfterMs?: number;
	  };

export interface ModelScopedQuota {
	displayName: string;
	pct: number;
	resetsAt: string | null;
}

export interface FetchAccountUsageOptions {
	baseUrl?: string;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuotaWindow(value: unknown): value is QuotaWindow {
	if (!isRecord(value)) return false;
	if (
		typeof value.utilization !== "number" ||
		!Number.isFinite(value.utilization) ||
		value.utilization < 0
	) {
		return false;
	}
	// An unopened window reports `resets_at: null`; anything other than null or a
	// parseable instant is still a contract violation.
	if (value.resets_at === null) return true;
	return (
		typeof value.resets_at === "string" &&
		!Number.isNaN(Date.parse(value.resets_at))
	);
}

/**
 * Read a named model quota from the API's self-describing `limits[]` surface.
 * Opaque top-level keys are deliberately ignored because their meaning is not
 * part of this contract.
 */
export function findModelScopedQuota(
	payload: unknown,
	displayName: string,
): ModelScopedQuota | null {
	if (!isRecord(payload) || !Array.isArray(payload.limits)) return null;
	const wanted = displayName.trim().toLocaleLowerCase("en-US");
	if (!wanted) return null;
	for (const candidate of payload.limits.slice(0, 200)) {
		if (!isRecord(candidate)) continue;
		if (!isRecord(candidate.scope) || !isRecord(candidate.scope.model))
			continue;
		const actualName = candidate.scope.model.display_name;
		if (
			typeof actualName !== "string" ||
			actualName.trim().toLocaleLowerCase("en-US") !== wanted
		) {
			continue;
		}
		if (
			typeof candidate.percent !== "number" ||
			!Number.isFinite(candidate.percent) ||
			candidate.percent < 0 ||
			candidate.percent > 100
		) {
			return null;
		}
		const reset = candidate.resets_at;
		if (
			reset !== null &&
			(typeof reset !== "string" || Number.isNaN(Date.parse(reset)))
		) {
			return null;
		}
		return {
			displayName: actualName.trim(),
			pct: candidate.percent,
			resetsAt: reset,
		};
	}
	return null;
}

function validatePayload(value: unknown): ValidatedUsagePayload | null {
	if (!isRecord(value)) return null;
	if (!isQuotaWindow(value.five_hour) || !isQuotaWindow(value.seven_day)) {
		return null;
	}
	return value as ValidatedUsagePayload;
}

function clampRetryAfter(ms: number): number {
	return Math.max(MIN_RETRY_AFTER_MS, Math.min(MAX_RETRY_AFTER_MS, ms));
}

function parseRetryAfter(value: string | null): number {
	if (value === null) return MIN_RETRY_AFTER_MS;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return clampRetryAfter(seconds * 1_000);
	}
	const instant = Date.parse(value);
	if (!Number.isNaN(instant)) {
		return clampRetryAfter(Math.max(0, instant - Date.now()));
	}
	return MIN_RETRY_AFTER_MS;
}

async function requestUsage(
	accessToken: string,
	opts: FetchAccountUsageOptions,
	signal: AbortSignal,
): Promise<AccountUsageResult> {
	const fetchFn = opts.fetchFn ?? fetch;
	const endpoint = new URL(
		"/api/oauth/usage",
		opts.baseUrl ?? process.env.FLYWHEEL_QUOTA_API_BASE ?? DEFAULT_BASE_URL,
	).toString();
	const response = await fetchFn(endpoint, {
		method: "GET",
		signal,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
		},
	});

	if (response.status === 401) return { error: "unauthorized" };
	if (response.status === 429) {
		return {
			error: "rate_limited",
			retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
		};
	}
	if (!response.ok) return { error: "network" };

	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		return { error: "malformed" };
	}
	const payload = validatePayload(raw);
	if (payload === null) return { error: "malformed" };
	return {
		ok: {
			raw: payload,
			fiveH: {
				pct: payload.five_hour.utilization,
				resetsAt: payload.five_hour.resets_at,
			},
			sevenD: {
				pct: payload.seven_day.utilization,
				resetsAt: payload.seven_day.resets_at,
			},
		},
	};
}

/** Read account quota without ever returning credential or response details. */
export async function fetchAccountUsage(
	accessToken: string,
	opts: FetchAccountUsageOptions = {},
): Promise<AccountUsageResult> {
	const controller = new AbortController();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<AccountUsageResult>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve({ error: "network" });
		}, timeoutMs);
	});

	try {
		return await Promise.race([
			requestUsage(accessToken, opts, controller.signal).catch(() => ({
				error: "network" as const,
			})),
			timedOut,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
