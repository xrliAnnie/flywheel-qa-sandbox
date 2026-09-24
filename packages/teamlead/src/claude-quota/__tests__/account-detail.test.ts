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
} from "../account-detail-observer.js";
import {
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
				if (url.endsWith("/api/oauth/usage")) {
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
		});

		expect(store.accounts).toEqual([
			{
				name: "personal1",
				observedAt: "2026-09-23T00:00:00.000Z",
				subscription: "canceled",
				usageStatus: "forbidden:oauth_not_allowed_for_organization",
				prepaid: { known: false, cards: null },
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
			if (url.endsWith("/api/oauth/usage")) {
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
