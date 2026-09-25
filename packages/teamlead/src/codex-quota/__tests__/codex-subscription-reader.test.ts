import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	identifyCodexAuth,
	loadCodexAccountPool,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { codexInstallAccountKey } from "flywheel-claude-runner/bin/codex-account-install.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodexSubscriptionRequest,
	type CodexSubscriptionResponse,
	createCodexSubscriptionTransport,
	observeCodexSubscriptions,
	parseCodexSubscriptionResponse,
} from "../codex-subscription-reader.js";
import {
	type CodexSubscriptionStore,
	readCodexSubscriptionStore,
	writeCodexSubscriptionStore,
} from "../codex-subscription-store.js";

const NOW = Date.parse("2026-09-24T23:30:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const ACCOUNT_IDS: Record<string, string> = {
	business: "0a1b2c3d-1111-4222-8333-444455556666",
	personal: "1a1b2c3d-1111-4222-8333-444455556666",
	school: "2a1b2c3d-1111-4222-8333-444455556666",
	shopping: "3a1b2c3d-1111-4222-8333-444455556666",
};

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

function auth(local: string, accountId = ACCOUNT_IDS[local] ?? local) {
	return JSON.stringify({
		tokens: {
			access_token: `access-${local}`,
			refresh_token: `refresh-${local}`,
			id_token: `x.${Buffer.from(
				JSON.stringify({
					email: `${local}@example.test`,
					"https://api.openai.com/auth": {
						chatgpt_account_id: accountId,
						chatgpt_plan_type: "pro",
					},
				}),
			).toString("base64url")}.x`,
		},
	});
}

/** Research §3 sample (business), verbatim shape. */
function subscriptionBody(overrides: {
	entitlement?: Record<string, unknown>;
	top?: Record<string, unknown>;
}) {
	return {
		entitlement: {
			has_active_subscription: true,
			subscription_plan: "chatgptpro",
			expires_at: "2026-10-23T09:59:39+00:00",
			renews_at: "2026-10-23T03:59:39+00:00",
			cancels_at: null,
			billing_period: "monthly",
			is_delinquent: false,
			...overrides.entitlement,
		},
		plan_type: "pro",
		will_renew: true,
		active_until: "2026-10-23T03:59:39Z",
		active_start: "2026-08-19T15:39:26Z",
		cancellation_outcome: null,
		...overrides.top,
	};
}

const ok = (body: unknown): CodexSubscriptionResponse => ({
	status: 200,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

function fixture(slots: readonly string[], canonical = "business") {
	const root = mkdtempSync(join(tmpdir(), "fly2864-codex-sub-"));
	roots.push(root);
	const codexHome = join(root, "codex");
	const profilesRoot = join(codexHome, "profiles");
	const registryPath = join(root, "codex-account-registry.json");
	writeFileSync(
		registryPath,
		JSON.stringify({ version: 2, primary: "business" }),
	);
	mkdirSync(profilesRoot, { recursive: true });
	for (const slot of slots) {
		mkdirSync(join(profilesRoot, slot));
		writeFileSync(join(profilesRoot, slot, "auth.json"), auth(slot), {
			mode: 0o600,
		});
	}
	writeFileSync(join(codexHome, "auth.json"), auth(canonical), {
		mode: 0o600,
	});
	const pool = () => loadCodexAccountPool({ profilesRoot, registryPath });
	const keyOf = (slot: string) =>
		codexInstallAccountKey(
			identifyCodexAuth(
				readFileSync(join(profilesRoot, slot, "auth.json"), "utf8"),
				pool(),
			),
		);
	return {
		root,
		codexHome,
		profilesRoot,
		pool,
		keyOf,
		options: {
			profilesRoot,
			canonicalAuthPath: join(codexHome, "auth.json"),
			pool,
			now: () => NOW,
		},
	};
}

function recorder(
	respond: (
		input: Parameters<CodexSubscriptionRequest>[0],
	) => CodexSubscriptionResponse | Promise<CodexSubscriptionResponse>,
) {
	const calls: Array<Parameters<CodexSubscriptionRequest>[0]> = [];
	const request: CodexSubscriptionRequest = async (input) => {
		calls.push(input);
		return respond(input);
	};
	return { request, calls };
}

describe("FLY-2864 — Codex subscription response parsing", () => {
	it("reads the renewal date of an active subscription (research sample)", () => {
		expect(parseCodexSubscriptionResponse(ok(subscriptionBody({})))).toEqual({
			ok: { status: "active", renewsAt: "2026-10-23T03:59:39.000Z" },
		});
	});

	it("reads cancellation from cancels_at or will_renew=false", () => {
		expect(
			parseCodexSubscriptionResponse(
				ok(
					subscriptionBody({
						entitlement: { cancels_at: "2026-10-19T04:02:27+00:00" },
					}),
				),
			),
		).toEqual({
			ok: { status: "canceled", endsAt: "2026-10-19T04:02:27.000Z" },
		});
		expect(
			parseCodexSubscriptionResponse(
				ok(subscriptionBody({ top: { will_renew: false } })),
			),
		).toEqual({
			ok: { status: "canceled", endsAt: "2026-10-23T03:59:39.000Z" },
		});
		expect(
			parseCodexSubscriptionResponse(
				ok(
					subscriptionBody({
						top: { will_renew: false, active_until: null },
						entitlement: { cancels_at: null, expires_at: null },
					}),
				),
			),
		).toEqual({ ok: { status: "canceled", endsAt: null } });
	});

	it("reports no active subscription as none, never as canceled", () => {
		expect(
			parseCodexSubscriptionResponse(
				ok(
					subscriptionBody({
						entitlement: { has_active_subscription: false },
						top: { will_renew: false },
					}),
				),
			),
		).toEqual({ ok: { status: "none" } });
	});

	it("rejects a subscription whose instants are present but invalid instead of deciding cancellation", () => {
		for (const overrides of [
			{
				entitlement: { cancels_at: "2026-10-19T04:02:27" },
			},
			{ entitlement: { cancels_at: "garbage" } },
			{ entitlement: { renews_at: "2026-02-30T00:00:00Z" } },
			{ entitlement: { expires_at: 1_792_000_000 } },
			{ top: { active_until: "tomorrow" } },
		]) {
			expect(
				parseCodexSubscriptionResponse(ok(subscriptionBody(overrides))),
			).toEqual({ error: "malformed" });
		}
		// Missing renewal date on a renewing subscription is unknown, not a date.
		expect(
			parseCodexSubscriptionResponse(
				ok(subscriptionBody({ entitlement: { renews_at: null } })),
			),
		).toEqual({ error: "malformed" });
		expect(
			parseCodexSubscriptionResponse(
				ok(subscriptionBody({ entitlement: { renews_at: undefined } })),
			),
		).toEqual({ error: "malformed" });
		for (const body of [
			[],
			"x",
			{ entitlement: "x" },
			{ entitlement: { has_active_subscription: "yes" } },
		]) {
			expect(parseCodexSubscriptionResponse(ok(body))).toEqual({
				error: "malformed",
			});
		}
		expect(
			parseCodexSubscriptionResponse({
				status: 200,
				headers: {},
				body: "{not json",
			}),
		).toEqual({ error: "malformed" });
	});

	it("maps HTTP failures, including the Cloudflare challenge, to safe errors", () => {
		const cases: Array<[CodexSubscriptionResponse, string]> = [
			[{ status: 401, headers: {}, body: "{}" }, "unauthorized"],
			[
				{
					status: 403,
					headers: { "cf-mitigated": "challenge" },
					body: "{}",
				},
				"blocked",
			],
			[
				{
					status: 403,
					headers: { "content-type": "text/html; charset=UTF-8" },
					body: "<!DOCTYPE html><html>Just a moment...</html>",
				},
				"blocked",
			],
			[
				{
					status: 403,
					headers: { "content-type": "application/json" },
					body: '{"detail":"forbidden"}',
				},
				"forbidden",
			],
			[{ status: 500, headers: {}, body: "{}" }, "network"],
			[
				{ status: 302, headers: { location: "https://elsewhere" }, body: "" },
				"network",
			],
		];
		for (const [response, error] of cases) {
			expect(parseCodexSubscriptionResponse(response)).toEqual({ error });
		}
	});
});

describe("FLY-2864 — Codex subscription observer", () => {
	it("reads every slot once with a GET to the fixed host and the declared UA", async () => {
		const f = fixture(["business", "school"]);
		const { request, calls } = recorder(() => ok(subscriptionBody({})));
		const store = await observeCodexSubscriptions({
			...f.options,
			request,
		});
		expect(store).toEqual({
			version: 1,
			generatedAt: NOW_ISO,
			accounts: [
				{
					name: "business",
					identityKey: f.keyOf("business"),
					observedAt: NOW_ISO,
					status: "active",
					renewsAt: "2026-10-23T03:59:39.000Z",
					endsAt: null,
					note: null,
				},
				{
					name: "school",
					identityKey: f.keyOf("school"),
					observedAt: NOW_ISO,
					status: "active",
					renewsAt: "2026-10-23T03:59:39.000Z",
					endsAt: null,
					note: null,
				},
			],
		});
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.method).toBe("GET");
			const url = new URL(call.url);
			expect(url.protocol).toBe("https:");
			expect(url.host).toBe("chatgpt.com");
			expect(url.pathname).toBe("/backend-api/subscriptions");
			expect(call.url).not.toContain("reset_rate_limits");
			expect(call.headers["User-Agent"]).toBe("flywheel-accounts-page/1");
			expect(call.headers.Accept).toBe("application/json");
			expect(call.timeoutMs).toBe(10_000);
			expect(call.maxBytes).toBe(256 * 1024);
		}
		const school = calls.find(
			(call) => call.headers["ChatGPT-Account-Id"] === ACCOUNT_IDS.school,
		);
		expect(school?.url).toBe(
			`https://chatgpt.com/backend-api/subscriptions?account_id=${ACCOUNT_IDS.school}`,
		);
		expect(school?.headers.Authorization).toBe("Bearer access-school");
		const serialized = JSON.stringify(store);
		for (const secret of [
			"access-",
			"refresh-",
			"@example.test",
			...Object.values(ACCOUNT_IDS),
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("uses the canonical auth for the account currently in use", async () => {
		const f = fixture(["business", "school"], "school");
		// The live home holds a newer access token than the parked slot copy.
		const live = JSON.parse(auth("school")) as {
			tokens: Record<string, string>;
		};
		live.tokens.access_token = "access-school-live";
		writeFileSync(f.options.canonicalAuthPath, JSON.stringify(live));
		const { request, calls } = recorder(() => ok(subscriptionBody({})));
		await observeCodexSubscriptions({ ...f.options, request });
		const school = calls.find(
			(call) => call.headers["ChatGPT-Account-Id"] === ACCOUNT_IDS.school,
		);
		expect(school?.headers.Authorization).toBe("Bearer access-school-live");
		const business = calls.find(
			(call) => call.headers["ChatGPT-Account-Id"] === ACCOUNT_IDS.business,
		);
		expect(business?.headers.Authorization).toBe("Bearer access-business");
	});

	it("never calls the network for problem slots and writes identity-less rows without facts", async () => {
		const f = fixture(["business"]);
		mkdirSync(join(f.profilesRoot, "empty"));
		mkdirSync(join(f.profilesRoot, "broken"));
		writeFileSync(join(f.profilesRoot, "broken", "auth.json"), "{}", {
			mode: 0o600,
		});
		const previous: CodexSubscriptionStore = {
			version: 1,
			generatedAt: "2026-09-20T00:00:00.000Z",
			accounts: [
				{
					name: "broken",
					identityKey: "e".repeat(64),
					observedAt: "2026-09-20T00:00:00.000Z",
					status: "active",
					renewsAt: "2026-10-20T00:00:00.000Z",
					endsAt: null,
					note: null,
				},
			],
		};
		const { request, calls } = recorder(() => ok(subscriptionBody({})));
		const store = await observeCodexSubscriptions({
			...f.options,
			previous,
			request,
		});
		expect(calls).toHaveLength(1);
		expect(store.accounts.find((a) => a.name === "broken")).toEqual({
			name: "broken",
			observedAt: null,
			status: "unknown",
			renewsAt: null,
			endsAt: null,
			note: "problem:invalid_credential",
		});
		expect(store.accounts.find((a) => a.name === "empty")).toEqual({
			name: "empty",
			observedAt: null,
			status: "unknown",
			renewsAt: null,
			endsAt: null,
			note: "problem:not_logged_in",
		});
		// The whole mixed round survives a write/read cycle.
		const path = join(f.root, "state", "codex-subscriptions.json");
		writeCodexSubscriptionStore(path, store);
		expect(readCodexSubscriptionStore(path)).toEqual(store);
	});

	it("does not send a request when the account id is not a UUID or the identity does not match", async () => {
		const f = fixture(["business", "odd"]);
		writeFileSync(
			join(f.profilesRoot, "odd", "auth.json"),
			auth("odd", "not-a-uuid"),
		);
		const { request, calls } = recorder(() => ok(subscriptionBody({})));
		const store = await observeCodexSubscriptions({ ...f.options, request });
		expect(calls.map((call) => call.headers["ChatGPT-Account-Id"])).toEqual([
			ACCOUNT_IDS.business,
		]);
		expect(store.accounts.find((a) => a.name === "odd")).toMatchObject({
			status: "unknown",
			note: "account_id_invalid",
			renewsAt: null,
		});

		// A slot whose credentials cannot be bound to its identity (here: no
		// access token) is never sent.
		const g = fixture(["business", "tokenless"]);
		const tokenless = JSON.parse(auth("tokenless", ACCOUNT_IDS.school)) as {
			tokens: Record<string, string>;
		};
		delete tokenless.tokens.access_token;
		writeFileSync(
			join(g.profilesRoot, "tokenless", "auth.json"),
			JSON.stringify(tokenless),
		);
		const second = recorder(() => ok(subscriptionBody({})));
		const mismatch = await observeCodexSubscriptions({
			...g.options,
			request: second.request,
		});
		expect(second.calls).toHaveLength(1);
		expect(mismatch.accounts.find((a) => a.name === "tokenless")).toEqual({
			name: "tokenless",
			identityKey: g.keyOf("tokenless"),
			observedAt: null,
			status: "unknown",
			renewsAt: null,
			endsAt: null,
			note: "identity_mismatch",
		});
		// An unreadable canonical home only means "no slot is provably in use".
		const h = fixture(["business"]);
		writeFileSync(h.options.canonicalAuthPath, "{}");
		const third = recorder(() => ok(subscriptionBody({})));
		const unproven = await observeCodexSubscriptions({
			...h.options,
			request: third.request,
		});
		expect(third.calls).toHaveLength(1);
		expect(unproven.accounts[0]?.status).toBe("active");
	});

	it("records safe errors and carries the same identity's last reading", async () => {
		const f = fixture(["business", "school", "shopping"]);
		const previous: CodexSubscriptionStore = {
			version: 1,
			generatedAt: "2026-09-20T00:00:00.000Z",
			accounts: [
				{
					name: "business",
					identityKey: f.keyOf("business"),
					observedAt: "2026-09-20T00:00:00.000Z",
					status: "active",
					renewsAt: "2026-10-23T03:59:39.000Z",
					endsAt: null,
					note: null,
				},
				{
					name: "school",
					// Same slot name, different login: must not be carried.
					identityKey: "f".repeat(64),
					observedAt: "2026-09-20T00:00:00.000Z",
					status: "active",
					renewsAt: "2026-10-03T23:37:58.000Z",
					endsAt: null,
					note: null,
				},
			],
		};
		const { request } = recorder((input) =>
			input.headers["ChatGPT-Account-Id"] === ACCOUNT_IDS.shopping
				? ok(
						subscriptionBody({
							entitlement: { cancels_at: "not-a-date" },
							top: { will_renew: true },
						}),
					)
				: {
						status: 403,
						headers: { "cf-mitigated": "challenge" },
						body: "",
					},
		);
		const store = await observeCodexSubscriptions({
			...f.options,
			previous,
			request,
		});
		expect(store.accounts).toEqual([
			{
				...previous.accounts[0],
				note: "blocked",
			},
			{
				name: "school",
				identityKey: f.keyOf("school"),
				observedAt: null,
				status: "unknown",
				renewsAt: null,
				endsAt: null,
				note: "blocked",
			},
			{
				// No history + invalid non-null cancels_at: unknown, never canceled.
				name: "shopping",
				identityKey: f.keyOf("shopping"),
				observedAt: null,
				status: "unknown",
				renewsAt: null,
				endsAt: null,
				note: "malformed",
			},
		]);
	});

	it("turns a thrown transport and a spent round into network and deadline notes", async () => {
		const f = fixture(["business", "school"]);
		const request: CodexSubscriptionRequest = (input) =>
			input.headers["ChatGPT-Account-Id"] === ACCOUNT_IDS.business
				? Promise.reject(new Error("ECONNRESET"))
				: new Promise((_resolve, reject) => {
						input.signal?.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					});
		const store = await observeCodexSubscriptions({
			...f.options,
			request,
			totalDeadlineMs: 20,
		});
		expect(store.accounts.map((a) => [a.name, a.status, a.note])).toEqual([
			["business", "unknown", "network"],
			["school", "unknown", "deadline"],
		]);
	});

	it("never writes to auth files", async () => {
		const f = fixture(["business"]);
		const before = readFileSync(
			join(f.profilesRoot, "business", "auth.json"),
			"utf8",
		);
		const canonicalBefore = readFileSync(f.options.canonicalAuthPath, "utf8");
		await observeCodexSubscriptions({
			...f.options,
			request: recorder(() => ({ status: 401, headers: {}, body: "" })).request,
		});
		expect(
			readFileSync(join(f.profilesRoot, "business", "auth.json"), "utf8"),
		).toBe(before);
		expect(readFileSync(f.options.canonicalAuthPath, "utf8")).toBe(
			canonicalBefore,
		);
	});
});

describe("FLY-2864 — Codex subscription transport", () => {
	async function serve(
		handler: Parameters<typeof createServer>[1],
	): Promise<string> {
		const server = createServer(handler);
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api/subscriptions`;
	}
	const transport = createCodexSubscriptionTransport(
		httpRequest as unknown as Parameters<
			typeof createCodexSubscriptionTransport
		>[0],
	);

	it("sends a GET with the given headers and returns status, headers and body", async () => {
		const seen = vi.fn();
		const url = await serve((req, res) => {
			seen(req.method, req.headers["user-agent"], req.headers.authorization);
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
		});
		const response = await transport({
			method: "GET",
			url,
			headers: {
				Authorization: "Bearer t",
				"User-Agent": "flywheel-accounts-page/1",
			},
			timeoutMs: 2_000,
			maxBytes: 1_024,
		});
		expect(seen).toHaveBeenCalledWith(
			"GET",
			"flywheel-accounts-page/1",
			"Bearer t",
		);
		expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
		expect(response.headers["content-type"]).toBe("application/json");
	});

	it("does not follow redirects", async () => {
		const url = await serve((_req, res) => {
			res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
			res.end();
		});
		const response = await transport({
			method: "GET",
			url,
			headers: {},
			timeoutMs: 2_000,
			maxBytes: 1_024,
		});
		expect(response.status).toBe(302);
		expect(parseCodexSubscriptionResponse(response)).toEqual({
			error: "network",
		});
	});

	it("rejects an oversized body and a response that never finishes", async () => {
		const big = await serve((_req, res) => {
			res.writeHead(200);
			res.end("x".repeat(4_096));
		});
		await expect(
			transport({
				method: "GET",
				url: big,
				headers: {},
				timeoutMs: 2_000,
				maxBytes: 1_024,
			}),
		).rejects.toThrow("codex_subscription_response_too_large");
		const hang = await serve((_req, res) => {
			res.writeHead(200);
			res.write("{");
		});
		await expect(
			transport({
				method: "GET",
				url: hang,
				headers: {},
				timeoutMs: 50,
				maxBytes: 1_024,
			}),
		).rejects.toThrow("codex_subscription_timeout");
	});
});
