import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderAccountQuotaPageHtml } from "../../bridge/account-quota-page.js";
import { buildVercelQuotaSection } from "../../bridge/account-quota-vercel.js";
import { observeVercelAccount } from "../vercel-account-reader.js";
import { validVercelAccountStore } from "../vercel-account-store.js";

// A marked fake credential: no fragment of it may surface anywhere.
const TOKEN = "vcp_FAKE7777SECRET_do_not_leak_0123456789";
const TOKEN_PREFIX = TOKEN.slice(0, 8);
const TEAM = "team_TESTTEAM000000000000001";
const STORE = "store_TESTSTORE0000001";
const EMAIL = "Owner.Person@Example.test";
const NOW = new Date("2026-09-25T08:00:00.000Z");

// Sanitized shapes of the real read-only responses (research.md §2).
const userBody = {
	user: {
		id: "user_1",
		email: EMAIL,
		name: "Owner",
		username: "xrliannie",
		avatar: null,
		defaultTeamId: TEAM,
		version: "northstar",
		limited: false,
	},
};
const teamBody = {
	id: TEAM,
	slug: "xrliannies-projects",
	name: "xrliannie's projects",
	softBlock: null,
	billing: {
		plan: "pro",
		status: "active",
		platform: "stripe",
		planIteration: "plus",
		period: { start: 1790233200000, end: 1792825200000 },
		planChangedAt: 1790319299000,
		cancelation: null,
		trial: null,
		email: "billing-contact@example.test",
		address: { line1: "must not be read" },
		invoiceItems: { pro: { price: 2000, quantity: 1 } },
	},
};
const storeBody = {
	store: {
		id: STORE,
		ownerId: TEAM,
		type: "blob",
		name: "fw-reports-6da062-blob",
		billingState: "active",
		status: "available",
		size: 1051925,
		count: 23,
		usageQuotaExceeded: false,
		access: "private",
		projectsMetadata: [],
	},
};

type Reply =
	| { status: number; body?: unknown; raw?: string; headers?: HeadersInit }
	| "throw-type"
	| "hang";

interface Call {
	url: string;
	init: RequestInit;
}

function fakeFetch(routes: { user?: Reply; team?: Reply; store?: Reply }): {
	fetchImpl: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, init });
		const path = new URL(url).pathname;
		const reply: Reply | undefined =
			path === "/v2/user"
				? (routes.user ?? { status: 200, body: userBody })
				: path.startsWith("/v2/teams/")
					? (routes.team ?? { status: 200, body: teamBody })
					: path.startsWith("/v1/storage/stores/")
						? (routes.store ?? { status: 200, body: storeBody })
						: undefined;
		if (reply === undefined) throw new Error("unexpected path");
		if (reply === "throw-type") throw new TypeError("fetch failed");
		if (reply === "hang") {
			return await new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		}
		return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
			status: reply.status,
			headers: reply.headers ?? { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function observe(
	routes: Parameters<typeof fakeFetch>[0] = {},
	options: Partial<Parameters<typeof observeVercelAccount>[0]> = {},
) {
	const fake = fakeFetch(routes);
	return {
		calls: fake.calls,
		result: observeVercelAccount({
			token: TOKEN,
			resolveStoreApiId: () => STORE,
			fetchImpl: fake.fetchImpl,
			now: () => NOW,
			...options,
		}),
	};
}

describe("FLY-2875 Vercel account reader", () => {
	it("reads plan, billing period and the owned report store from real-shaped responses", async () => {
		const { result, calls } = observe();
		const store = await result;
		expect(store).toEqual({
			version: 1,
			observedAt: "2026-09-25T08:00:00.000Z",
			account: {
				emailSha256: createHash("sha256")
					.update("owner.person@example.test")
					.digest("hex"),
				username: "xrliannie",
				teamSlug: "xrliannies-projects",
				plan: "pro",
				billingStatus: "active",
				periodEnd: "2026-10-24T07:00:00.000Z",
				canceled: false,
			},
			accountNote: null,
			blob: {
				status: "available",
				sizeBytes: 1051925,
				count: 23,
				usageQuotaExceeded: false,
			},
			blobNote: null,
		});
		expect(validVercelAccountStore(store)).toBe(true);
		const serialized = JSON.stringify(store);
		expect(serialized).not.toContain("@");
		expect(serialized).not.toContain("billing-contact");
		expect(serialized).not.toContain("must not be read");
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v2/user",
			`/v2/teams/${TEAM}`,
			`/v1/storage/stores/${STORE}`,
		]);
	});

	it("sends only whitelisted read-only GETs with a bearer header", async () => {
		const { result, calls } = observe();
		await result;
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			const url = new URL(call.url);
			expect(url.origin).toBe("https://api.vercel.com");
			expect(call.init.method).toBe("GET");
			expect(call.init.redirect).toBe("error");
			expect(call.init.body).toBeUndefined();
			expect(call.init.headers).toEqual({
				Authorization: `Bearer ${TOKEN}`,
				Accept: "application/json",
			});
			expect(call.init.signal).toBeInstanceOf(AbortSignal);
		}
		expect(new URL(calls[2]!.url).search).toBe(`?teamId=${TEAM}`);
		expect(new URL(calls[0]!.url).search).toBe("");
		expect(new URL(calls[1]!.url).search).toBe("");
	});

	it("reads nothing without a token", async () => {
		for (const token of [undefined, "", "   "]) {
			const { result, calls } = observe({}, { token });
			expect(await result).toEqual({
				version: 1,
				observedAt: NOW.toISOString(),
				account: null,
				accountNote: "no_token",
				blob: null,
				blobNote: "no_token",
			});
			expect(calls).toHaveLength(0);
		}
	});

	it.each<[string, Reply, string]>([
		[
			"invalid token 403",
			{
				status: 403,
				body: {
					error: {
						code: "forbidden",
						message: "Not authorized",
						invalidToken: true,
					},
				},
			},
			"unauthorized",
		],
		["401", { status: 401, body: {} }, "unauthorized"],
		[
			"plain 403",
			{ status: 403, body: { error: { code: "forbidden" } } },
			"forbidden",
		],
		["404", { status: 404, body: {} }, "not_found"],
		["429", { status: 429, body: {} }, "rate_limited"],
		["500", { status: 500, raw: `boom ${TOKEN}` }, "http_error"],
		["bad JSON", { status: 200, raw: "{not json" }, "malformed"],
		[
			"declared oversize body",
			{
				status: 200,
				raw: JSON.stringify(userBody),
				headers: { "content-length": String(2 * 1024 * 1024) },
			},
			"malformed",
		],
		[
			"actual oversize body",
			{ status: 200, raw: `{"x":"${"a".repeat(1024 * 1024 + 10)}"}` },
			"malformed",
		],
		["transport failure", "throw-type", "network"],
		[
			"bad email",
			{ status: 200, body: { user: { ...userBody.user, email: "nope" } } },
			"malformed",
		],
		[
			"bad team id",
			{
				status: 200,
				body: { user: { ...userBody.user, defaultTeamId: "../../x" } },
			},
			"malformed",
		],
		[
			"bad username",
			{
				status: 200,
				body: { user: { ...userBody.user, username: "a b" } },
			},
			"malformed",
		],
	])("maps a user-read %s to %s and stops", async (_label, user, reason) => {
		const { result, calls } = observe({ user });
		const store = await result;
		expect(store.account).toBeNull();
		expect(store.accountNote).toBe(reason);
		expect(store.blob).toBeNull();
		expect(store.blobNote).toBe(reason);
		expect(calls).toHaveLength(1);
		expect(JSON.stringify(store)).not.toContain(TOKEN_PREFIX);
	});

	it("maps an external abort and a per-request timeout to deadline", async () => {
		const controller = new AbortController();
		const aborted = observe(
			{ user: "hang" },
			{ signal: controller.signal, requestTimeoutMs: 60_000 },
		);
		setTimeout(() => controller.abort(), 5);
		expect((await aborted.result).accountNote).toBe("deadline");

		const timedOut = observe({ team: "hang" }, { requestTimeoutMs: 20 });
		const store = await timedOut.result;
		expect(store.accountNote).toBe("deadline");
		expect(store.blob).toBeNull();
		expect(store.blobNote).toBe("deadline");
	});

	it("drops the store facts when the team read fails, keeping one reason", async () => {
		const { result, calls } = observe({ team: { status: 500, body: {} } });
		const store = await result;
		expect(store).toMatchObject({
			account: null,
			accountNote: "http_error",
			blob: null,
			blobNote: "http_error",
		});
		expect(calls).toHaveLength(3);
	});

	it.each<[string, Parameters<typeof fakeFetch>[0], string]>([
		["store 404", { store: { status: 404, body: {} } }, "not_found"],
		[
			"store owned by another team",
			{
				store: {
					status: 200,
					body: { store: { ...storeBody.store, ownerId: "team_OTHER" } },
				},
			},
			"owner_mismatch",
		],
		[
			"negative store size",
			{
				store: {
					status: 200,
					body: { store: { ...storeBody.store, size: -1 } },
				},
			},
			"malformed",
		],
		[
			"non-boolean quota flag",
			{
				store: {
					status: 200,
					body: { store: { ...storeBody.store, usageQuotaExceeded: "no" } },
				},
			},
			"malformed",
		],
		["store transport failure", { store: "throw-type" }, "network"],
	])(
		"keeps the account but not the Blob for %s",
		async (_label, routes, reason) => {
			const store = await observe(routes).result;
			expect(store.account?.plan).toBe("pro");
			expect(store.blob).toBeNull();
			expect(store.blobNote).toBe(reason);
		},
	);

	it("reports the store binding without requesting a store", async () => {
		for (const [resolveStoreApiId, reason] of [
			[() => undefined, "no_store_binding"],
			[() => "store_../../v2/user", "no_store_binding"],
			[
				() => {
					throw new Error(`registry corrupted ${TOKEN}`);
				},
				"registry_unreadable",
			],
		] as const) {
			const { result, calls } = observe({}, { resolveStoreApiId });
			const store = await result;
			expect(store.account?.plan).toBe("pro");
			expect(store.blob).toBeNull();
			expect(store.blobNote).toBe(reason);
			expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
				"/v2/user",
				`/v2/teams/${TEAM}`,
			]);
			expect(JSON.stringify(store)).not.toContain(TOKEN_PREFIX);
		}
	});

	it("reads cancelation, null status and a missing period as facts", async () => {
		const billing = {
			...teamBody.billing,
			status: null,
			period: null,
			cancelation: 1791000000000,
		};
		const store = await observe({
			team: { status: 200, body: { ...teamBody, billing } },
		}).result;
		expect(store.account).toMatchObject({
			plan: "pro",
			billingStatus: null,
			periodEnd: null,
			canceled: true,
		});
		const hobby = await observe({
			team: {
				status: 200,
				body: {
					...teamBody,
					billing: { ...teamBody.billing, plan: "Hobby", status: "Active" },
				},
			},
		}).result;
		expect(hobby.account).toMatchObject({
			plan: "hobby",
			billingStatus: "active",
		});
	});

	it.each<[string, unknown]>([
		["missing billing", { ...teamBody, billing: undefined }],
		[
			"non-string plan",
			{ ...teamBody, billing: { ...teamBody.billing, plan: 1 } },
		],
		[
			"fractional period end",
			{
				...teamBody,
				billing: { ...teamBody.billing, period: { start: 0, end: 1.5 } },
			},
		],
		[
			"period end before 2020",
			{
				...teamBody,
				billing: { ...teamBody.billing, period: { start: 0, end: 1000 } },
			},
		],
		[
			"period end after 2100",
			{
				...teamBody,
				billing: {
					...teamBody.billing,
					period: { start: 0, end: Date.UTC(2100, 0, 1) },
				},
			},
		],
		[
			"ISO period end",
			{
				...teamBody,
				billing: {
					...teamBody.billing,
					period: { start: 0, end: "2026-10-24T07:00:00Z" },
				},
			},
		],
		["bad slug", { ...teamBody, slug: "Bad Slug" }],
		[
			"bad status",
			{ ...teamBody, billing: { ...teamBody.billing, status: "a b" } },
		],
	])("rejects a team response with %s", async (_label, body) => {
		const store = await observe({ team: { status: 200, body } }).result;
		expect(store.account).toBeNull();
		expect(store.accountNote).toBe("malformed");
		expect(store.blobNote).toBe("malformed");
	});

	it.each<[string, Parameters<typeof fakeFetch>[0]]>([
		[
			"username equal to the token",
			{
				user: {
					status: 200,
					body: { user: { ...userBody.user, username: TOKEN } },
				},
			},
		],
		[
			"username carrying the token prefix",
			{
				user: {
					status: 200,
					body: { user: { ...userBody.user, username: `x${TOKEN_PREFIX}y` } },
				},
			},
		],
		[
			"plan carrying the token prefix",
			{
				team: {
					status: 200,
					body: {
						...teamBody,
						billing: { ...teamBody.billing, plan: TOKEN_PREFIX },
					},
				},
			},
		],
		[
			"billing status carrying the token prefix",
			{
				team: {
					status: 200,
					body: {
						...teamBody,
						billing: { ...teamBody.billing, status: `${TOKEN_PREFIX}_x` },
					},
				},
			},
		],
	])(
		"fails closed on a %s and never persists or renders it",
		async (_label, routes) => {
			const store = await observe(routes).result;
			expect(store.account).toBeNull();
			expect(store.accountNote).toBe("malformed");
			expect(store.blob).toBeNull();
			const html = renderAccountQuotaPageHtml(
				{
					generatedAt: "2026-09-25T08:30:00.000Z",
					staleAfterMinutes: 30,
					claude: [],
					codex: [],
					codexSourceLabel: "无数值源",
					discrepancies: [],
					warnings: [],
					claudeUnavailable: [],
					codexUnavailable: [],
				},
				buildVercelQuotaSection(store, {
					generatedAt: "2026-09-25T08:30:00.000Z",
					claudeEmails: {},
				}),
			);
			for (const text of [JSON.stringify(store), html]) {
				expect(text).not.toContain(TOKEN_PREFIX);
				expect(text.toLowerCase()).not.toContain(TOKEN_PREFIX.toLowerCase());
			}
		},
	);

	it("drops a Blob status that echoes the credential", async () => {
		const token = "abcdefgh0123456789secret";
		const store = await observe(
			{
				store: {
					status: 200,
					body: { store: { ...storeBody.store, status: "abcdefgh-x" } },
				},
			},
			{ token },
		).result;
		expect(store.account?.plan).toBe("pro");
		expect(store.blob).toBeNull();
		expect(store.blobNote).toBe("malformed");
		expect(JSON.stringify(store)).not.toContain("abcdefgh");
	});
});
