import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	CodexLeadOutboundHandler,
	InMemoryOutboundDedupStore,
} from "../codex/CodexLeadOutboundHandler.js";
import {
	buildAuthorizeLeadChannel,
	buildLeadOutboundExpressHandler,
	buildResolveBotToken,
	type OutboundRes,
} from "../codexLeadBridgeWiring.js";

function project(
	name: string,
	leads: ProjectEntry["leads"] = [],
): ProjectEntry {
	return { projectName: name, projectRoot: `/r/${name}`, leads };
}
function lead(
	agentId: string,
	over: Partial<ProjectEntry["leads"][number]> = {},
) {
	return {
		agentId,
		chatChannel: "c",
		match: { labels: [] },
		...over,
	} as ProjectEntry["leads"][number];
}

function fakeRes(): OutboundRes & { code?: number; body?: unknown } {
	const r: OutboundRes & { code?: number; body?: unknown } = {
		status(code) {
			r.code = code;
			return r;
		},
		json(body) {
			r.body = body;
		},
	};
	return r;
}

describe("buildResolveBotToken (mirrors LeadAlertNotifier)", () => {
	const projects = [
		project("p", [
			lead("mufasa", { botTokenEnv: "MUFASA_BOT_TOKEN" }),
			lead("inline", { botToken: "inline-tok" }),
			lead("notoken"),
		]),
	];

	it("resolves by (projectName, leadId): inline botToken, then botTokenEnv, else undefined", () => {
		const resolve = buildResolveBotToken(projects, {
			MUFASA_BOT_TOKEN: "env-tok",
		});
		expect(resolve("p", "mufasa")).toBe("env-tok");
		expect(resolve("p", "inline")).toBe("inline-tok");
		expect(resolve("p", "notoken")).toBeUndefined();
		expect(resolve("p", "missing-lead")).toBeUndefined();
		expect(resolve("other-project", "mufasa")).toBeUndefined(); // wrong project
	});

	it("missing env var → undefined (fail-closed at the send)", () => {
		const resolve = buildResolveBotToken(projects, {});
		expect(resolve("p", "mufasa")).toBeUndefined();
	});
});

describe("buildAuthorizeLeadChannel (anti-impersonation, project-scoped)", () => {
	const noTokenDeps = { resolveBotToken: () => undefined };
	const projects = [
		{
			...project("proj-a", [
				lead("mufasa", { chatChannel: "chan-mufasa" }),
				lead("belle", { chatChannel: "chan-belle" }),
			]),
			generalChannel: "chan-core",
		} as ProjectEntry,
		// A SECOND project that REUSES the agentId "mufasa" (agentId isn't global).
		{
			...project("proj-b", [lead("mufasa", { chatChannel: "chan-b-mufasa" })]),
			generalChannel: "chan-b-core",
		} as ProjectEntry,
	];

	it("allows a (project, lead) its own chatChannel + the project core, denies others", async () => {
		const authz = buildAuthorizeLeadChannel(projects, noTokenDeps);
		await expect(authz("proj-a", "mufasa", "chan-mufasa")).resolves.toBe(true); // own channel
		await expect(authz("proj-a", "mufasa", "chan-core")).resolves.toBe(true); // project core
		await expect(authz("proj-a", "mufasa", "chan-belle")).resolves.toBe(false); // other lead's
		await expect(authz("proj-a", "belle", "chan-belle")).resolves.toBe(true);
		await expect(authz("proj-a", "unknown-lead", "chan-mufasa")).resolves.toBe(
			false,
		); // unknown
	});

	it("tolerates a project with no `leads` array (minimal config / tests) — no crash", async () => {
		// A bare project object (no `leads`) must not throw at construction.
		const bare = [{ projectName: "x", projectRoot: "/x" } as ProjectEntry];
		expect(() => buildAuthorizeLeadChannel(bare, noTokenDeps)).not.toThrow();
		const authz = buildAuthorizeLeadChannel(bare, noTokenDeps);
		await expect(authz("x", "any", "any")).resolves.toBe(false);
		const resolve = buildResolveBotToken(bare, {});
		expect(resolve("x", "any")).toBeUndefined();
	});

	it("a REUSED agentId is PROJECT-SCOPED — proj-a's mufasa cannot reach proj-b's channel", async () => {
		const authz = buildAuthorizeLeadChannel(projects, noTokenDeps);
		// proj-b's mufasa owns chan-b-mufasa; proj-a's mufasa does NOT
		await expect(authz("proj-b", "mufasa", "chan-b-mufasa")).resolves.toBe(
			true,
		);
		await expect(authz("proj-a", "mufasa", "chan-b-mufasa")).resolves.toBe(
			false,
		); // no cross-project
		await expect(authz("proj-b", "mufasa", "chan-mufasa")).resolves.toBe(false); // nor the reverse
	});

	it("allows only the declared roundtable and its child threads", async () => {
		const lookupThreadParent = vi
			.fn()
			.mockResolvedValue({ state: "resolved", parentId: "roundtable-a" });
		const authz = buildAuthorizeLeadChannel(
			[
				project("growth", [
					lead("mufasa", { roundtableChannel: "roundtable-a" }),
				]),
			],
			{
				resolveBotToken: () => "bot-token",
				lookupThreadParent,
			},
		);

		await expect(authz("growth", "mufasa", "roundtable-a")).resolves.toBe(true);
		await expect(authz("growth", "mufasa", "thread-a")).resolves.toBe(true);
		await expect(authz("growth", "mufasa", "thread-a")).resolves.toBe(true);
		expect(lookupThreadParent).toHaveBeenCalledTimes(1);
		expect(lookupThreadParent).toHaveBeenCalledWith("thread-a", "bot-token");
	});

	it("fails closed without a token and does not cache failed parent lookups", async () => {
		const lookupThreadParent = vi
			.fn()
			.mockResolvedValueOnce({ state: "transient", status: 503 })
			.mockResolvedValueOnce({ state: "resolved", parentId: "other" });
		const configured = [
			project("growth", [
				lead("mufasa", { roundtableChannel: "roundtable-a" }),
			]),
		];
		const noToken = buildAuthorizeLeadChannel(configured, {
			resolveBotToken: () => undefined,
			lookupThreadParent,
		});
		await expect(noToken("growth", "mufasa", "thread-a")).resolves.toBe(false);
		expect(lookupThreadParent).not.toHaveBeenCalled();

		const authz = buildAuthorizeLeadChannel(configured, {
			resolveBotToken: () => "bot-token",
			lookupThreadParent,
		});
		await expect(authz("growth", "mufasa", "thread-a")).resolves.toBe(
			"unavailable",
		);
		await expect(authz("growth", "mufasa", "thread-a")).resolves.toBe(false);
		expect(lookupThreadParent).toHaveBeenCalledTimes(2);
	});

	it("returns 403 before dedup/send for an undeclared channel", async () => {
		const store = new InMemoryOutboundDedupStore();
		const send = vi.fn(async () => "msg-1");
		const handler = buildLeadOutboundExpressHandler(
			new CodexLeadOutboundHandler({
				store,
				send,
				expectedApiToken: "api-secret",
				authorizeLeadChannel: buildAuthorizeLeadChannel(
					[
						project("growth", [
							lead("mufasa", { roundtableChannel: "roundtable-a" }),
						]),
					],
					{
						resolveBotToken: () => undefined,
					},
				),
			}),
		);
		const res = fakeRes();
		await handler(
			{
				body: {
					projectName: "growth",
					leadId: "mufasa",
					channelId: "roundtable-b",
					text: "hello",
					idempotencyKey: "k-403",
					nonce: "n-403",
				},
				headers: { authorization: "Bearer api-secret" },
			},
			res,
		);

		expect(res.code).toBe(403);
		expect(res.body).toMatchObject({
			status: "rejected",
			reason: "lead_channel_unauthorized",
		});
		expect(store.get("k-403")).toBeUndefined();
		expect(send).not.toHaveBeenCalled();

		const allowed = fakeRes();
		await handler(
			{
				body: {
					projectName: "growth",
					leadId: "mufasa",
					channelId: "roundtable-a",
					text: "hello",
					idempotencyKey: "k-200",
					nonce: "n-200",
				},
				headers: { authorization: "Bearer api-secret" },
			},
			allowed,
		);
		expect(allowed.code).toBe(200);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ state: "resolved", parentId: "another-channel" },
		{ state: "denied", status: 401 },
		{ state: "denied", status: 403 },
	] as const)(
		"returns 403 for a deterministic thread-parent denial: %j",
		async (lookupResult) => {
			const store = new InMemoryOutboundDedupStore();
			const send = vi.fn(async () => "msg-1");
			const handler = buildLeadOutboundExpressHandler(
				new CodexLeadOutboundHandler({
					store,
					send,
					expectedApiToken: "api-secret",
					authorizeLeadChannel: buildAuthorizeLeadChannel(
						[
							project("growth", [
								lead("mufasa", { roundtableChannel: "roundtable-a" }),
							]),
						],
						{
							resolveBotToken: () => "bot-token",
							lookupThreadParent: vi.fn().mockResolvedValue(lookupResult),
						},
					),
				}),
			);
			const res = fakeRes();
			await handler(
				{
					body: {
						projectName: "growth",
						leadId: "mufasa",
						channelId: "thread-a",
						text: "hello",
						idempotencyKey: "k-thread",
						nonce: "n-thread",
					},
					headers: { authorization: "Bearer api-secret" },
				},
				res,
			);

			expect(res.code).toBe(403);
			expect(store.get("k-thread")).toBeUndefined();
			expect(send).not.toHaveBeenCalled();
		},
	);

	it("returns retryable 503 when thread-parent lookup is transient", async () => {
		const store = new InMemoryOutboundDedupStore();
		const send = vi.fn(async () => "msg-1");
		const handler = buildLeadOutboundExpressHandler(
			new CodexLeadOutboundHandler({
				store,
				send,
				expectedApiToken: "api-secret",
				authorizeLeadChannel: buildAuthorizeLeadChannel(
					[
						project("growth", [
							lead("mufasa", { roundtableChannel: "roundtable-a" }),
						]),
					],
					{
						resolveBotToken: () => "bot-token",
						lookupThreadParent: vi
							.fn()
							.mockResolvedValue({ state: "transient", status: 429 }),
					},
				),
			}),
		);
		const res = fakeRes();
		await handler(
			{
				body: {
					projectName: "growth",
					leadId: "mufasa",
					channelId: "thread-a",
					text: "hello",
					idempotencyKey: "k-transient",
					nonce: "n-transient",
				},
				headers: { authorization: "Bearer api-secret" },
			},
			res,
		);

		expect(res.code).toBe(503);
		expect(res.body).toMatchObject({
			status: "rejected",
			reason: "channel_parent_lookup_unavailable",
		});
		expect(store.get("k-transient")).toBeUndefined();
		expect(send).not.toHaveBeenCalled();
	});
});

describe("buildLeadOutboundExpressHandler", () => {
	function makeHandler() {
		let n = 0;
		return new CodexLeadOutboundHandler({
			store: new InMemoryOutboundDedupStore(),
			send: async () => `msg-${++n}`,
			expectedApiToken: "api-secret",
		});
	}

	const goodBody = {
		projectName: "p",
		leadId: "mufasa",
		channelId: "chan",
		text: "hi",
		idempotencyKey: "k1",
		nonce: "n1",
	};

	it("maps a valid request → 200 sent + messageId", async () => {
		const h = buildLeadOutboundExpressHandler(makeHandler());
		const res = fakeRes();
		await h(
			{ body: goodBody, headers: { authorization: "Bearer api-secret" } },
			res,
		);
		expect(res.code).toBe(200);
		expect(res.body).toMatchObject({ status: "sent", messageId: "msg-1" });
	});

	it("writes a metadata-only audit line for the response", async () => {
		const logger = { info: vi.fn() };
		const h = buildLeadOutboundExpressHandler(makeHandler(), logger);
		const res = fakeRes();
		await h(
			{ body: goodBody, headers: { authorization: "Bearer api-secret" } },
			res,
		);

		const line = logger.info.mock.calls[0]?.[0] ?? "";
		expect(line).toContain(
			"[lead-outbound] project=p lead=mufasa channel=chan probe=0 status=sent",
		);
		expect(line).toContain("messageId=msg-1 idempotencyKey=k1");
		expect(line).not.toContain(goodBody.text);
	});

	it("accepts a raw (non-Bearer) token too; wrong token → 401", async () => {
		const h = buildLeadOutboundExpressHandler(makeHandler());
		const ok = fakeRes();
		await h({ body: goodBody, headers: { authorization: "api-secret" } }, ok);
		expect(ok.code).toBe(200);
		const bad = fakeRes();
		await h(
			{ body: goodBody, headers: { authorization: "Bearer wrong" } },
			bad,
		);
		expect(bad.code).toBe(401);
	});

	it("missing body → 400 (handler validation surfaces)", async () => {
		const h = buildLeadOutboundExpressHandler(makeHandler());
		const res = fakeRes();
		await h({ headers: { authorization: "Bearer api-secret" } }, res);
		expect(res.code).toBe(400);
	});
});
