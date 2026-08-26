import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchAccountUsage,
	findModelScopedQuota,
} from "../account-heal/quota-usage-api.js";

const TOKEN = "sk-ant-oat01-super-secret";
const ORIGINAL_QUOTA_API_BASE = process.env.FLYWHEEL_QUOTA_API_BASE;
const VALID_USAGE = {
	five_hour: {
		utilization: 91.5,
		resets_at: "2026-07-15T04:00:00.420Z",
	},
	seven_day: {
		utilization: 22,
		resets_at: "2026-07-21T14:00:00.420Z",
	},
	limits: [
		{ kind: "session", percent: 91.5 },
		{
			kind: "weekly_scoped",
			percent: 63.5,
			resets_at: "2026-07-19T15:00:00.000Z",
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
	],
};

/**
 * Shape recorded 2026-07-18 from a live read-only GET /api/oauth/usage against the
 * idle `school` pool account (engineering/doc/FLY-1366-quota-probe-panorama-fix/
 * exploration.md). An account with no active 5h window reports `resets_at: null`,
 * and the dollar fields alongside it are null too. Every field this validator reads
 * is reproduced verbatim from that capture.
 */
const IDLE_FIVE_HOUR_USAGE = {
	five_hour: {
		utilization: 0,
		resets_at: null,
		limit_dollars: null,
		spend_dollars: null,
	},
	seven_day: {
		utilization: 88,
		resets_at: "2026-07-20T15:59:59Z",
		limit_dollars: null,
		spend_dollars: null,
	},
	limits: [{ kind: "session", percent: 0 }],
};

afterEach(() => {
	if (ORIGINAL_QUOTA_API_BASE === undefined) {
		delete process.env.FLYWHEEL_QUOTA_API_BASE;
	} else {
		process.env.FLYWHEEL_QUOTA_API_BASE = ORIGINAL_QUOTA_API_BASE;
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("fetchAccountUsage", () => {
	it("reads the self-describing Fable quota from limits[] without guessing opaque top-level keys", () => {
		expect(findModelScopedQuota(VALID_USAGE, "Fable")).toEqual({
			displayName: "Fable",
			pct: 63.5,
			resetsAt: "2026-07-19T15:00:00.000Z",
		});
		expect(findModelScopedQuota(VALID_USAGE, "fable")).toEqual({
			displayName: "Fable",
			pct: 63.5,
			resetsAt: "2026-07-19T15:00:00.000Z",
		});
		expect(
			findModelScopedQuota(
				{
					...VALID_USAGE,
					limits: [{ ...VALID_USAGE.limits[1], kind: "future_model_scope" }],
				},
				"Fable",
			),
		).toEqual({
			displayName: "Fable",
			pct: 63.5,
			resetsAt: "2026-07-19T15:00:00.000Z",
		});
	});

	it("fails soft when a named model-scoped quota is absent or malformed", () => {
		expect(findModelScopedQuota({ ...VALID_USAGE, limits: [] }, "Fable")).toBe(
			null,
		);
		expect(
			findModelScopedQuota(
				{
					...VALID_USAGE,
					limits: [
						{
							kind: "weekly_scoped",
							percent: "63",
							resets_at: "not-a-date",
							scope: { model: { display_name: "Fable" } },
						},
					],
				},
				"Fable",
			),
		).toBe(null);
	});

	it("requests the OAuth usage endpoint with the beta contract and returns validated raw usage", async () => {
		const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Bearer ${TOKEN}`,
			);
			expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
				"oauth-2025-04-20",
			);
			expect(new Headers(init?.headers).get("accept")).toBe("application/json");
			return new Response(JSON.stringify(VALID_USAGE), { status: 200 });
		});

		const result = await fetchAccountUsage(TOKEN, {
			baseUrl: "https://quota.example.test/root/",
			fetchFn: fetchFn as typeof fetch,
		});

		expect(fetchFn).toHaveBeenCalledWith(
			"https://quota.example.test/api/oauth/usage",
			expect.any(Object),
		);
		expect(result).toEqual({
			ok: {
				raw: VALID_USAGE,
				fiveH: {
					pct: 91.5,
					resetsAt: "2026-07-15T04:00:00.420Z",
				},
				sevenD: {
					pct: 22,
					resetsAt: "2026-07-21T14:00:00.420Z",
				},
			},
		});
	});

	it("uses FLYWHEEL_QUOTA_API_BASE when no explicit baseUrl is supplied", async () => {
		process.env.FLYWHEEL_QUOTA_API_BASE = "http://127.0.0.1:43210/mock/";
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify(VALID_USAGE), { status: 200 }),
		);

		await fetchAccountUsage(TOKEN, { fetchFn: fetchFn as typeof fetch });

		expect(fetchFn).toHaveBeenCalledWith(
			"http://127.0.0.1:43210/api/oauth/usage",
			expect.any(Object),
		);
	});

	it("accepts an idle account whose 5h window has not opened (resets_at null) and passes the null through", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify(IDLE_FIVE_HOUR_USAGE), { status: 200 }),
		);

		const result = await fetchAccountUsage(TOKEN, {
			fetchFn: fetchFn as typeof fetch,
		});

		expect(result).toEqual({
			ok: {
				raw: IDLE_FIVE_HOUR_USAGE,
				fiveH: { pct: 0, resetsAt: null },
				sevenD: { pct: 88, resetsAt: "2026-07-20T15:59:59Z" },
			},
		});
	});

	it.each([
		["a numeric reset", 1_784_456_950_522],
		["an unparseable reset string", "whenever"],
		["a boolean reset", false],
		["an object reset", { at: "2026-07-20T15:59:59Z" }],
	])(
		"still rejects a five-hour window carrying %s",
		async (_label, resets_at) => {
			const fetchFn = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							...IDLE_FIVE_HOUR_USAGE,
							five_hour: { ...IDLE_FIVE_HOUR_USAGE.five_hour, resets_at },
						}),
						{ status: 200 },
					),
			);
			expect(
				await fetchAccountUsage(TOKEN, { fetchFn: fetchFn as typeof fetch }),
			).toEqual({ error: "malformed" });
		},
	);

	it("classifies unauthorized responses without exposing response details", async () => {
		const fetchFn = vi.fn(
			async () => new Response(`bad credential ${TOKEN}`, { status: 401 }),
		);
		const result = await fetchAccountUsage(TOKEN, {
			fetchFn: fetchFn as typeof fetch,
		});
		expect(result).toEqual({ error: "unauthorized" });
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("parses Retry-After seconds and clamps the backoff to 60s..30min", async () => {
		const tooShort = vi.fn(
			async () =>
				new Response("limited", {
					status: 429,
					headers: { "retry-after": "3" },
				}),
		);
		const tooLong = vi.fn(
			async () =>
				new Response("limited", {
					status: 429,
					headers: { "retry-after": "99999" },
				}),
		);

		expect(
			await fetchAccountUsage(TOKEN, { fetchFn: tooShort as typeof fetch }),
		).toEqual({ error: "rate_limited", retryAfterMs: 60_000 });
		expect(
			await fetchAccountUsage(TOKEN, { fetchFn: tooLong as typeof fetch }),
		).toEqual({ error: "rate_limited", retryAfterMs: 1_800_000 });
	});

	it("parses an HTTP-date Retry-After and uses 60s when the header is absent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-14T20:00:00.000Z"));
		const dated = vi.fn(
			async () =>
				new Response("limited", {
					status: 429,
					headers: { "retry-after": "Tue, 14 Jul 2026 20:05:00 GMT" },
				}),
		);
		const absent = vi.fn(async () => new Response("limited", { status: 429 }));

		expect(
			await fetchAccountUsage(TOKEN, { fetchFn: dated as typeof fetch }),
		).toEqual({ error: "rate_limited", retryAfterMs: 300_000 });
		expect(
			await fetchAccountUsage(TOKEN, { fetchFn: absent as typeof fetch }),
		).toEqual({ error: "rate_limited", retryAfterMs: 60_000 });
	});

	it.each([
		["invalid JSON", new Response("not-json", { status: 200 })],
		[
			"missing seven-day window",
			new Response(JSON.stringify({ five_hour: VALID_USAGE.five_hour }), {
				status: 200,
			}),
		],
		[
			"invalid reset instant",
			new Response(
				JSON.stringify({
					...VALID_USAGE,
					five_hour: { utilization: 1, resets_at: "not-a-date" },
				}),
				{ status: 200 },
			),
		],
	])("classifies a malformed 200 response: %s", async (_label, response) => {
		const fetchFn = vi.fn(async () => response);
		expect(
			await fetchAccountUsage(TOKEN, { fetchFn: fetchFn as typeof fetch }),
		).toEqual({ error: "malformed" });
	});

	it("classifies non-401/429 HTTP failures and thrown fetch errors as network errors without leaking the token", async () => {
		const serverError = vi.fn(
			async () => new Response(`server echoed ${TOKEN}`, { status: 503 }),
		);
		const thrown = vi.fn(async () => {
			throw new Error(`socket failed while sending ${TOKEN}`);
		});

		const results = [
			await fetchAccountUsage(TOKEN, {
				fetchFn: serverError as typeof fetch,
			}),
			await fetchAccountUsage(TOKEN, { fetchFn: thrown as typeof fetch }),
		];
		expect(results).toEqual([{ error: "network" }, { error: "network" }]);
		expect(JSON.stringify(results)).not.toContain(TOKEN);
	});

	it("keeps the timeout active until the response body has been consumed", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.fn(async () => {
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				json: () => new Promise<unknown>(() => undefined),
			} as Response;
		});

		const pending = fetchAccountUsage(TOKEN, {
			fetchFn: fetchFn as typeof fetch,
			timeoutMs: 25,
		});
		await vi.advanceTimersByTimeAsync(25);

		await expect(pending).resolves.toEqual({ error: "network" });
	});
});
