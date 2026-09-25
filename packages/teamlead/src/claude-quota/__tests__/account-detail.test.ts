import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	observeClaudeAccountDetails,
	parseClaudePrepaidPayload,
	parseClaudeResetGrants,
} from "../account-detail-observer.js";
import {
	type ClaudeAccountDetailStore,
	readClaudeAccountDetailStore,
	writeClaudeAccountDetailStore,
} from "../account-detail-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("FLY-2807 — Claude prepaid payload", () => {
	it("keeps null, empty and multiple cards distinct without using next_expires_at", () => {
		expect(
			parseClaudePrepaidPayload({
				tranches: null,
				promo_tranches: null,
				next_expires_at: "2026-10-01T00:00:00.000Z",
			}),
		).toEqual({ known: true, cards: null });
		expect(
			parseClaudePrepaidPayload({ tranches: [], promo_tranches: [] }),
		).toEqual({ known: true, cards: [] });
		expect(
			parseClaudePrepaidPayload({
				tranches: [
					{ expires_at: "2026-10-03T00:00:00.000Z" },
					{ expires_at: "2026-10-01T00:00:00.000Z" },
				],
				promo_tranches: [{ expires_at: "2026-10-02T00:00:00.000Z" }],
			}),
		).toEqual({
			known: true,
			cards: [
				{ source: "tranche", expiresAt: "2026-10-01T00:00:00.000Z" },
				{ source: "promo", expiresAt: "2026-10-02T00:00:00.000Z" },
				{ source: "tranche", expiresAt: "2026-10-03T00:00:00.000Z" },
			],
		});
	});

	it("rejects malformed card arrays instead of deriving cards from balance or next expiry", () => {
		for (const payload of [
			{ amount: 20, next_expires_at: "2026-10-01T00:00:00.000Z" },
			{ tranches: [{ expires_at: "not-a-date" }], promo_tranches: [] },
			{ tranches: "secret", promo_tranches: [] },
		]) {
			expect(parseClaudePrepaidPayload(payload)).toEqual({
				known: false,
				cards: null,
			});
		}
	});
});

describe("FLY-2807 — Claude account detail observer", () => {
	it("records server-confirmed cancellation after usage 403 without changing credentials", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2807-claude-detail-"));
		roots.push(root);
		const profilesRoot = join(root, "profiles");
		const slot = join(profilesRoot, "personal1");
		mkdirSync(slot, { recursive: true });
		const credentialPath = join(slot, ".credentials.json");
		writeFileSync(
			credentialPath,
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "secret",
					expiresAt: Date.now() + 60_000,
				},
			}),
			{ mode: 0o600 },
		);
		const before = readFileSync(credentialPath, "utf8");
		const fetchFn = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				expect(init?.method).toBe("GET");
				expect(init?.redirect).toBe("error");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer secret",
				);
				const url = String(input);
				if (url.includes("/api/oauth/usage?")) {
					return new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "permission_error",
								details: { error_code: "oauth_not_allowed_for_organization" },
							},
						}),
						{ status: 403 },
					);
				}
				if (url.endsWith("/api/oauth/profile")) {
					return new Response(
						JSON.stringify({
							account: { email: "hidden@example.test", uuid: "account-secret" },
							organization: {
								uuid: "11111111-2222-4333-8444-555555555555",
								subscription_status: "canceled",
								organization_type: "claude_free",
							},
						}),
						{ status: 200 },
					);
				}
				return new Response("forbidden", { status: 403 });
			},
		);

		const store = await observeClaudeAccountDetails({
			profilesRoot,
			now: () => Date.parse("2026-09-23T00:00:00.000Z"),
			fetchFn: fetchFn as typeof fetch,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});

		expect(store.accounts).toEqual([
			{
				name: "personal1",
				observedAt: "2026-09-23T00:00:00.000Z",
				subscription: "canceled",
				usageStatus: "forbidden:oauth_not_allowed_for_organization",
				prepaid: { known: false, cards: null },
				tier: { subscriptionType: "free", rateLimitTier: null },
				resetGrants: { known: false, reason: "forbidden", grants: null },
				note: "prepaid_forbidden",
			},
		]);
		expect(readFileSync(credentialPath, "utf8")).toBe(before);
		expect(JSON.stringify(store)).not.toContain("secret");
		expect(JSON.stringify(store)).not.toContain("hidden@example.test");
	});

	it("self-heals canceled to active on the next profile observation", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2807-claude-detail-"));
		roots.push(root);
		const profilesRoot = join(root, "profiles");
		const slot = join(profilesRoot, "personal1");
		mkdirSync(slot, { recursive: true });
		writeFileSync(
			join(slot, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "new-token",
					expiresAt: Date.now() + 60_000,
				},
			}),
		);
		const previous = {
			version: 1 as const,
			generatedAt: "2026-09-22T00:00:00.000Z",
			accounts: [
				{
					name: "personal1",
					observedAt: "2026-09-22T00:00:00.000Z",
					subscription: "canceled" as const,
					usageStatus: "forbidden:oauth_not_allowed_for_organization",
					prepaid: { known: false, cards: null },
					note: "prepaid_forbidden",
				},
			],
		};
		const fetchFn = async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/api/oauth/usage?")) {
				return new Response(JSON.stringify({ five_hour: {}, seven_day: {} }), {
					status: 200,
				});
			}
			if (url.endsWith("/api/oauth/profile")) {
				return new Response(
					JSON.stringify({
						account: { email: "hidden@example.test", uuid: "hidden" },
						organization: {
							uuid: "11111111-2222-4333-8444-555555555555",
							subscription_status: "active",
							organization_type: "claude_max",
						},
					}),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({ tranches: [], promo_tranches: [] }),
				{ status: 200 },
			);
		};

		const store = await observeClaudeAccountDetails({
			profilesRoot,
			previous,
			fetchFn: fetchFn as typeof fetch,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(store.accounts[0]).toMatchObject({
			subscription: "active",
			prepaid: { known: true, cards: [] },
		});
	});

	it("discards a result when the credential changes during the readonly round", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2807-claude-detail-"));
		roots.push(root);
		const profilesRoot = join(root, "profiles");
		const slot = join(profilesRoot, "personal1");
		mkdirSync(slot, { recursive: true });
		const credentialPath = join(slot, ".credentials.json");
		const writeCredential = (accessToken: string) =>
			writeFileSync(
				credentialPath,
				JSON.stringify({
					claudeAiOauth: { accessToken, expiresAt: Date.now() + 60_000 },
				}),
			);
		writeCredential("old-token");
		const fetchFn = async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/api/oauth/profile")) {
				return new Response(
					JSON.stringify({
						organization: {
							uuid: "11111111-2222-4333-8444-555555555555",
							subscription_status: "canceled",
						},
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/prepaid/credits")) writeCredential("new-token");
			return new Response(
				JSON.stringify({ tranches: [], promo_tranches: [] }),
				{ status: 200 },
			);
		};

		const store = await observeClaudeAccountDetails({
			profilesRoot,
			fetchFn: fetchFn as typeof fetch,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(store.accounts[0]).toMatchObject({
			name: "personal1",
			observedAt: null,
			subscription: "unknown",
			note: "credential_changed",
		});
	});

	it("carries the previous observation with an explicit deadline note", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2807-claude-detail-"));
		roots.push(root);
		const profilesRoot = join(root, "profiles");
		const slot = join(profilesRoot, "personal1");
		mkdirSync(slot, { recursive: true });
		writeFileSync(
			join(slot, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "secret",
					expiresAt: Date.now() + 60_000,
				},
			}),
		);
		const previous = {
			version: 1 as const,
			generatedAt: "2026-09-22T00:00:00.000Z",
			accounts: [
				{
					name: "personal1",
					observedAt: "2026-09-22T00:00:00.000Z",
					subscription: "canceled" as const,
					usageStatus: "forbidden:oauth_not_allowed_for_organization",
					prepaid: { known: false, cards: null },
					note: "prepaid_forbidden",
				},
			],
		};
		const fetchFn = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
				}),
		);

		const store = await observeClaudeAccountDetails({
			profilesRoot,
			previous,
			fetchFn: fetchFn as typeof fetch,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
			requestTimeoutMs: 1_000,
			totalDeadlineMs: 5,
		});

		expect(store.accounts[0]).toEqual({
			...previous.accounts[0],
			usageStatus: "deadline",
			note: "deadline",
		});
	});

	it("rejects a production endpoint override without an injected fetch", async () => {
		await expect(
			observeClaudeAccountDetails({
				profilesRoot: "/unused",
				baseUrl: "https://example.test",
			}),
		).rejects.toThrow("claude_detail_test_origin_requires_fetch_injection");
	});

	it("does not replace the previous store with an empty round when the pool root is unreadable", async () => {
		await expect(
			observeClaudeAccountDetails({
				profilesRoot: join(tmpdir(), `fly2807-missing-pool-${process.pid}`),
			}),
		).rejects.toThrow();
	});

	it("round-trips the secret-free store", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2807-claude-store-"));
		roots.push(root);
		const path = join(root, "detail.json");
		const store = {
			version: 1 as const,
			generatedAt: "2026-09-23T00:00:00.000Z",
			accounts: [
				{
					name: "personal",
					observedAt: "2026-09-23T00:00:00.000Z",
					subscription: "active" as const,
					usageStatus: "ok",
					prepaid: {
						known: true,
						cards: [
							{
								source: "tranche" as const,
								expiresAt: "2026-10-01T00:00:00.000Z",
							},
						],
					},
					note: null,
				},
			],
		};
		writeClaudeAccountDetailStore(path, store);
		expect(readClaudeAccountDetailStore(path)).toEqual(store);
	});
});

// ---------------------------------------------------------------------------
// FLY-2864 — live tier + reset grants
// ---------------------------------------------------------------------------

const ORG = "11111111-2222-4333-8444-555555555555";

function poolWith(names: readonly string[]): string {
	const root = mkdtempSync(join(tmpdir(), "fly2864-claude-detail-"));
	roots.push(root);
	const profilesRoot = join(root, "profiles");
	for (const name of names) {
		mkdirSync(join(profilesRoot, name), { recursive: true });
		writeFileSync(
			join(profilesRoot, name, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: `token-${name}`,
					expiresAt: Date.now() + 60_000,
				},
			}),
			{ mode: 0o600 },
		);
	}
	return profilesRoot;
}

/** Research §2 sample (business), verbatim shape with ids redacted. */
const BUSINESS_USAGE = {
	five_hour: { utilization: 3 },
	seven_day: { utilization: 7 },
	cedar_ember: {
		eligible: true,
		ineligible_reason: null,
		at_limit: false,
		exhausted: [],
		grants: [
			{
				id: "grant-secret-id",
				label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
				resets_total: 1,
				resets_left: 1,
				starts_at: "2026-09-22T16:00:00+00:00",
				ends_at: "2026-10-22T16:00:00+00:00",
				clears: ["five_hour", "seven_day", "seven_day_overage_included"],
				paused: false,
				usable_now: true,
			},
		],
		next_grant_id: "opus55-launch-promax-20260921",
		weekly_resets_at: "2026-10-01T02:00:00+00:00",
		event_props: {
			surface: "claude_code_cli",
			tier: "claude_max_20x",
			billing_period: "unknown",
		},
	},
};

const BUSINESS_PROFILE = {
	account: { has_claude_max: true, email: "hidden@example.test" },
	organization: {
		organization_type: "claude_max",
		billing_type: "stripe_subscription",
		rate_limit_tier: "default_claude_max_20x",
		subscription_status: "active",
		subscription_created_at: "2026-06-25T22:49:57.967771Z",
		uuid: ORG,
		name: "Hidden Org",
	},
};

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function router(routes: { usage?: Route; profile?: Route; prepaid?: Route }): {
	fetchFn: typeof fetch;
	calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status });
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		calls.push({ url, init });
		if (url.includes("/api/oauth/usage")) {
			return routes.usage ? routes.usage(url, init) : json(BUSINESS_USAGE);
		}
		if (url.includes("/api/oauth/profile")) {
			return routes.profile
				? routes.profile(url, init)
				: json(BUSINESS_PROFILE);
		}
		if (url.includes("/prepaid/credits")) {
			return routes.prepaid
				? routes.prepaid(url, init)
				: json({ tranches: null, promo_tranches: null });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetchFn, calls };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("FLY-2864 — reset grant parsing", () => {
	const ember = (value: unknown) => ({ cedar_ember: value });
	const grant = (overrides: Record<string, unknown> = {}) => ({
		id: "g",
		label: "l",
		resets_total: 1,
		resets_left: 1,
		starts_at: "2026-09-22T16:00:00+00:00",
		ends_at: "2026-10-22T16:00:00+00:00",
		...overrides,
	});

	it("reads eligible grants with canonical expiry and keeps null expiry as unknown", () => {
		expect(parseClaudeResetGrants(BUSINESS_USAGE, true)).toEqual({
			known: true,
			reason: null,
			grants: [
				{ resetsLeft: 1, resetsTotal: 1, endsAt: "2026-10-22T16:00:00.000Z" },
			],
		});
		expect(
			parseClaudeResetGrants(
				ember({
					eligible: true,
					grants: [
						grant({ resets_total: 2, resets_left: 2 }),
						grant({ resets_left: 0, ends_at: "2026-10-23T03:59:39Z" }),
						grant({ ends_at: null }),
					],
				}),
				true,
			),
		).toEqual({
			known: true,
			reason: null,
			grants: [
				{ resetsLeft: 2, resetsTotal: 2, endsAt: "2026-10-22T16:00:00.000Z" },
				{ resetsLeft: 0, resetsTotal: 1, endsAt: "2026-10-23T03:59:39.000Z" },
				{ resetsLeft: 1, resetsTotal: 1, endsAt: null },
			],
		});
		expect(
			parseClaudeResetGrants(ember({ eligible: true, grants: [] }), true),
		).toEqual({ known: true, reason: null, grants: [] });
	});

	it("marks malformed grants unknown instead of guessing a count", () => {
		for (const grants of [
			[grant({ resets_left: 1.5 })],
			[grant({ resets_left: -1 })],
			[grant({ resets_left: 2, resets_total: 1 })],
			[grant({ resets_total: 1001, resets_left: 1 })],
			[grant({ resets_left: "1" })],
			[grant({ ends_at: "2026-10-22T16:00:00" })],
			[grant({ ends_at: "2026-02-30T00:00:00Z" })],
			[grant({ ends_at: 1_792_000_000 })],
			[grant({ ends_at: undefined })],
			["not-a-grant"],
			"not-an-array",
			Array.from({ length: 129 }, () => grant()),
		]) {
			expect(
				parseClaudeResetGrants(ember({ eligible: true, grants }), true),
			).toEqual({ known: false, reason: "malformed", grants: null });
		}
	});

	it("treats only no_grant as zero cards; every other gate is unknown", () => {
		expect(
			parseClaudeResetGrants(
				ember({ eligible: false, ineligible_reason: "no_grant", grants: [] }),
				true,
			),
		).toEqual({ known: true, reason: "no_grant", grants: [] });
		for (const reason of [
			"tier",
			"seat",
			"tenure",
			"other_experiment",
			"config_off",
			"surface",
			"cli_version",
			"mobile",
			"unavailable",
			"unknown",
		]) {
			const parsed = parseClaudeResetGrants(
				ember({ eligible: false, ineligible_reason: reason, grants: [] }),
				true,
			);
			expect(parsed).toEqual({ known: false, reason, grants: null });
			// Negative: an ineligible empty list is never "0 cards".
			expect(parsed.grants).toBeNull();
		}
		for (const reason of [null, 7, "Not A Token!", undefined]) {
			expect(
				parseClaudeResetGrants(
					ember({ eligible: false, ineligible_reason: reason, grants: [] }),
					true,
				),
			).toEqual({ known: false, reason: "unknown", grants: null });
		}
	});

	it("names an unknown local CLI version as the reason when the gate refuses", () => {
		expect(
			parseClaudeResetGrants(
				ember({ eligible: false, ineligible_reason: "surface", grants: [] }),
				false,
			),
		).toEqual({ known: false, reason: "cli_version_unknown", grants: null });
	});

	it("reports an absent or malformed cedar_ember block without inventing cards", () => {
		for (const body of [
			{},
			{ cedar_ember: null },
			{ cedar_ember: "x" },
			null,
			[],
		]) {
			expect(parseClaudeResetGrants(body, true)).toEqual({
				known: false,
				reason: "absent",
				grants: null,
			});
		}
		expect(
			parseClaudeResetGrants(ember({ eligible: "yes", grants: [] }), true),
		).toEqual({ known: false, reason: "malformed", grants: null });
	});
});

describe("FLY-2864 — Claude account detail observer (tier + grants)", () => {
	it("stores the live 20x tier and the real reset card from one readonly round", async () => {
		const profilesRoot = poolWith(["business"]);
		const { fetchFn, calls } = router({});
		const store = await observeClaudeAccountDetails({
			profilesRoot,
			now: () => Date.parse("2026-09-24T23:30:00.000Z"),
			fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(store.accounts[0]).toMatchObject({
			name: "business",
			subscription: "active",
			usageStatus: "ok",
			tier: {
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
			resetGrants: {
				known: true,
				reason: null,
				grants: [
					{
						resetsLeft: 1,
						resetsTotal: 1,
						endsAt: "2026-10-22T16:00:00.000Z",
					},
				],
			},
		});
		const serialized = JSON.stringify(store);
		for (const secret of [
			"token-business",
			"hidden@example.test",
			ORG,
			"grant-secret-id",
			"Hidden Org",
			"Opus 5.5 launch",
		]) {
			expect(serialized).not.toContain(secret);
		}
		const usage = calls.find((call) => call.url.includes("/api/oauth/usage"));
		expect(usage?.url).toBe(
			"https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
		);
		expect((usage?.init?.headers as Record<string, string>)["User-Agent"]).toBe(
			"claude-cli/2.1.282 (external, cli)",
		);
		for (const call of calls.filter(
			(entry) => !entry.url.includes("/api/oauth/usage"),
		)) {
			expect(
				(call.init?.headers as Record<string, string>)["User-Agent"],
			).toBeUndefined();
		}
	});

	it("only ever issues GETs and never touches the grant-redeeming endpoint", async () => {
		const profilesRoot = poolWith(["business", "school"]);
		const { fetchFn, calls } = router({});
		await observeClaudeAccountDetails({
			profilesRoot,
			fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.init?.method).toBe("GET");
			expect(call.init?.redirect).toBe("error");
			expect(call.url).not.toContain("reset_rate_limits");
			expect(call.url.startsWith("https://api.anthropic.com/api/")).toBe(true);
		}
	});

	it("reads the local CLI version once per round and omits the UA when it is unknown", async () => {
		const profilesRoot = poolWith(["business", "school", "shopping"]);
		const cliVersion = vi.fn(async () => "2.1.282");
		await observeClaudeAccountDetails({
			profilesRoot,
			fetchFn: router({}).fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion,
		});
		expect(cliVersion).toHaveBeenCalledTimes(1);

		const { fetchFn, calls } = router({
			usage: () =>
				json({
					five_hour: {},
					cedar_ember: {
						eligible: false,
						ineligible_reason: "surface",
						grants: [],
					},
				}),
		});
		const store = await observeClaudeAccountDetails({
			profilesRoot: poolWith(["business"]),
			fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => null,
		});
		const usage = calls.find((call) => call.url.includes("/api/oauth/usage"));
		expect(
			(usage?.init?.headers as Record<string, string>)["User-Agent"],
		).toBeUndefined();
		expect(store.accounts[0]?.resetGrants).toEqual({
			known: false,
			reason: "cli_version_unknown",
			grants: null,
		});
		// A failing version reader is the same as an unknown version.
		const failing = await observeClaudeAccountDetails({
			profilesRoot: poolWith(["business"]),
			fetchFn: router({
				usage: () =>
					json({
						cedar_ember: {
							eligible: false,
							ineligible_reason: "cli_version",
							grants: [],
						},
					}),
			}).fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => {
				throw new Error("spawn failed");
			},
		});
		expect(failing.accounts[0]?.resetGrants?.reason).toBe(
			"cli_version_unknown",
		);
	});

	it("parses free and malformed organization types without breaking the profile", async () => {
		const free = await observeClaudeAccountDetails({
			profilesRoot: poolWith(["personal1"]),
			fetchFn: router({
				profile: () =>
					json({
						organization: {
							uuid: ORG,
							subscription_status: "canceled",
							organization_type: "claude_free",
							rate_limit_tier: "default_claude_ai",
						},
					}),
			}).fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(free.accounts[0]?.tier).toEqual({
			subscriptionType: "free",
			rateLimitTier: "default_claude_ai",
		});
		for (const organization_type of [
			undefined,
			42,
			"claude max!",
			"x".repeat(80),
		]) {
			const store = await observeClaudeAccountDetails({
				profilesRoot: poolWith(["business"]),
				fetchFn: router({
					profile: () =>
						json({
							organization: {
								uuid: ORG,
								subscription_status: "active",
								organization_type,
								rate_limit_tier: "default_claude_max_20x",
							},
						}),
				}).fetchFn,
				baseUrl: "https://api.anthropic.com",
				cliVersion: async () => "2.1.282",
			});
			expect(store.accounts[0]).toMatchObject({
				subscription: "active",
				tier: null,
			});
		}
		const badTier = await observeClaudeAccountDetails({
			profilesRoot: poolWith(["business"]),
			fetchFn: router({
				profile: () =>
					json({
						organization: {
							uuid: ORG,
							subscription_status: "active",
							organization_type: "claude_max",
							rate_limit_tier: "bad tier!",
						},
					}),
			}).fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(badTier.accounts[0]?.tier).toEqual({
			subscriptionType: "max",
			rateLimitTier: null,
		});
	});

	it("records a usage failure as the card reason while keeping the live tier", async () => {
		for (const [status, reason] of [
			[401, "unauthorized"],
			[403, "forbidden"],
			[500, "network"],
		] as const) {
			const store = await observeClaudeAccountDetails({
				profilesRoot: poolWith(["business"]),
				fetchFn: router({ usage: () => json({}, status) }).fetchFn,
				baseUrl: "https://api.anthropic.com",
				cliVersion: async () => "2.1.282",
			});
			expect(store.accounts[0]).toMatchObject({
				tier: {
					subscriptionType: "max",
					rateLimitTier: "default_claude_max_20x",
				},
				resetGrants: { known: false, reason, grants: null },
			});
		}
	});

	it("rejects an oversized response before parsing it", async () => {
		const huge = JSON.stringify({
			...BUSINESS_USAGE,
			padding: "x".repeat(300 * 1024),
		});
		const store = await observeClaudeAccountDetails({
			profilesRoot: poolWith(["business"]),
			fetchFn: router({
				usage: () => new Response(huge, { status: 200 }),
			}).fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(store.accounts[0]).toMatchObject({
			usageStatus: "malformed",
			resetGrants: { known: false, reason: "malformed", grants: null },
			tier: {
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
		});
		// Oversized error bodies still map by status.
		const refused = await observeClaudeAccountDetails({
			profilesRoot: poolWith(["business"]),
			fetchFn: router({
				usage: () => new Response(huge, { status: 401 }),
			}).fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(refused.accounts[0]?.usageStatus).toBe("unauthorized");
	});

	it("carries the previous tier and grants whole when the profile read fails", async () => {
		const previous: ClaudeAccountDetailStore = {
			version: 1,
			generatedAt: "2026-09-23T00:00:00.000Z",
			accounts: [
				{
					name: "business",
					observedAt: "2026-09-23T00:00:00.000Z",
					subscription: "active",
					usageStatus: "ok",
					prepaid: { known: true, cards: null },
					tier: {
						subscriptionType: "max",
						rateLimitTier: "default_claude_max_20x",
					},
					resetGrants: {
						known: true,
						reason: null,
						grants: [
							{
								resetsLeft: 1,
								resetsTotal: 1,
								endsAt: "2026-10-22T16:00:00.000Z",
							},
						],
					},
					note: null,
				},
			],
		};
		const store = await observeClaudeAccountDetails({
			profilesRoot: poolWith(["business"]),
			previous,
			fetchFn: router({ profile: () => json({}, 500) }).fetchFn,
			baseUrl: "https://api.anthropic.com",
			cliVersion: async () => "2.1.282",
		});
		expect(store.accounts[0]).toEqual({
			...previous.accounts[0],
			usageStatus: "ok",
			note: "profile_network",
		});
	});

	describe("usage and profile both 401 (revoked token)", () => {
		const both401 = () =>
			router({
				usage: () => json({}, 401),
				profile: () => json({}, 401),
			}).fetchFn;

		it("keeps an old-format history readable without inventing new fields", async () => {
			const previous = {
				version: 1 as const,
				generatedAt: "2026-09-23T00:00:00.000Z",
				accounts: [
					{
						name: "personal",
						observedAt: "2026-09-22T00:00:00.000Z",
						subscription: "active" as const,
						usageStatus: "ok",
						prepaid: { known: true, cards: null },
						note: null,
					},
				],
			};
			const store = await observeClaudeAccountDetails({
				profilesRoot: poolWith(["personal"]),
				previous,
				fetchFn: both401(),
				baseUrl: "https://api.anthropic.com",
				cliVersion: async () => "2.1.282",
			});
			expect(store.accounts[0]).toEqual({
				...previous.accounts[0],
				usageStatus: "unauthorized",
				note: "profile_unauthorized",
			});
			expect(store.accounts[0]).not.toHaveProperty("resetGrants");
			expect(store.accounts[0]).not.toHaveProperty("tier");
		});

		it("writes a blank row with no grants on a first observation", async () => {
			const store = await observeClaudeAccountDetails({
				profilesRoot: poolWith(["personal"]),
				fetchFn: both401(),
				baseUrl: "https://api.anthropic.com",
				cliVersion: async () => "2.1.282",
			});
			expect(store.accounts[0]).toEqual({
				name: "personal",
				observedAt: null,
				subscription: "unknown",
				usageStatus: "unauthorized",
				prepaid: { known: false, cards: null },
				note: "profile_unauthorized",
			});
		});

		it("carries historical grants but records the dead usage status", async () => {
			const previous: ClaudeAccountDetailStore = {
				version: 1,
				generatedAt: "2026-09-23T00:00:00.000Z",
				accounts: [
					{
						name: "personal",
						observedAt: "2026-09-22T00:00:00.000Z",
						subscription: "active",
						usageStatus: "ok",
						prepaid: { known: true, cards: null },
						tier: {
							subscriptionType: "max",
							rateLimitTier: "default_claude_max_20x",
						},
						resetGrants: {
							known: true,
							reason: null,
							grants: [
								{
									resetsLeft: 1,
									resetsTotal: 1,
									endsAt: "2026-10-22T16:00:00.000Z",
								},
							],
						},
						note: null,
					},
				],
			};
			const store = await observeClaudeAccountDetails({
				profilesRoot: poolWith(["personal"]),
				previous,
				fetchFn: both401(),
				baseUrl: "https://api.anthropic.com",
				cliVersion: async () => "2.1.282",
			});
			expect(store.accounts[0]).toEqual({
				...previous.accounts[0],
				usageStatus: "unauthorized",
				note: "profile_unauthorized",
			});
		});
	});
});

describe("FLY-2864 — detail store compatibility", () => {
	/** Frozen copy of the FLY-2807 validator: what a rolled-back Bridge runs. */
	function legacyValidReading(value: unknown): boolean {
		const record = (input: unknown): input is Record<string, unknown> =>
			typeof input === "object" && input !== null && !Array.isArray(input);
		const instant = (input: unknown) =>
			typeof input === "string" &&
			Number.isFinite(Date.parse(input)) &&
			new Date(Date.parse(input)).toISOString() === input;
		const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
		const SAFE_STATUS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
		if (!record(value) || !record(value.prepaid)) return false;
		const cards = value.prepaid.cards;
		if (cards !== null && !Array.isArray(cards)) return false;
		if (
			Array.isArray(cards) &&
			(cards.length > 128 ||
				!cards.every(
					(card) =>
						record(card) &&
						(card.source === "tranche" || card.source === "promo") &&
						instant(card.expiresAt),
				))
		) {
			return false;
		}
		return (
			typeof value.name === "string" &&
			ACCOUNT_NAME.test(value.name) &&
			(value.observedAt === null || instant(value.observedAt)) &&
			(value.subscription === "active" ||
				value.subscription === "canceled" ||
				value.subscription === "unknown") &&
			typeof value.usageStatus === "string" &&
			SAFE_STATUS.test(value.usageStatus) &&
			typeof value.prepaid.known === "boolean" &&
			(value.prepaid.known || cards === null) &&
			(value.note === null ||
				(typeof value.note === "string" && SAFE_STATUS.test(value.note)))
		);
	}

	const withNewFields: ClaudeAccountDetailStore = {
		version: 1,
		generatedAt: "2026-09-24T23:30:00.000Z",
		accounts: [
			{
				name: "business",
				observedAt: "2026-09-24T23:30:00.000Z",
				subscription: "active",
				usageStatus: "ok",
				prepaid: { known: true, cards: null },
				tier: {
					subscriptionType: "max",
					rateLimitTier: "default_claude_max_20x",
				},
				resetGrants: {
					known: true,
					reason: null,
					grants: [
						{
							resetsLeft: 1,
							resetsTotal: 1,
							endsAt: "2026-10-22T16:00:00.000Z",
						},
						{ resetsLeft: 0, resetsTotal: 2, endsAt: null },
					],
				},
				note: null,
			},
			{
				name: "personal",
				observedAt: null,
				subscription: "unknown",
				usageStatus: "unauthorized",
				prepaid: { known: false, cards: null },
				tier: null,
				resetGrants: { known: false, reason: "unauthorized", grants: null },
				note: "profile_unauthorized",
			},
		],
	};

	it("round-trips the new optional fields and stays readable by the rolled-back validator", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2864-claude-store-"));
		roots.push(root);
		const path = join(root, "detail.json");
		writeClaudeAccountDetailStore(path, withNewFields);
		expect(readClaudeAccountDetailStore(path)).toEqual(withNewFields);
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			accounts: unknown[];
		};
		expect(raw.accounts.every(legacyValidReading)).toBe(true);
	});

	it("rejects invalid new fields when present", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2864-claude-store-"));
		roots.push(root);
		const path = join(root, "detail.json");
		const base = withNewFields.accounts[0]!;
		for (const reading of [
			{ ...base, tier: { subscriptionType: "max plan!", rateLimitTier: null } },
			{ ...base, tier: { subscriptionType: "max", rateLimitTier: 5 } },
			{ ...base, tier: "max" },
			{
				...base,
				resetGrants: { known: false, reason: "tier", grants: [] },
			},
			{
				...base,
				resetGrants: {
					known: true,
					reason: null,
					grants: [{ resetsLeft: 2, resetsTotal: 1, endsAt: null }],
				},
			},
			{
				...base,
				resetGrants: {
					known: true,
					reason: null,
					grants: [
						{
							resetsLeft: 1,
							resetsTotal: 1,
							endsAt: "2026-10-22T16:00:00+00:00",
						},
					],
				},
			},
			{
				...base,
				resetGrants: {
					known: true,
					reason: null,
					grants: [{ resetsLeft: 1.5, resetsTotal: 2, endsAt: null }],
				},
			},
			{
				...base,
				resetGrants: {
					known: true,
					reason: "Bad Reason!",
					grants: [],
				},
			},
			{ ...base, resetGrants: { known: true, reason: null, grants: null } },
		]) {
			writeFileSync(
				path,
				JSON.stringify({ ...withNewFields, accounts: [reading] }),
			);
			expect(readClaudeAccountDetailStore(path)).toBeNull();
		}
	});
});
