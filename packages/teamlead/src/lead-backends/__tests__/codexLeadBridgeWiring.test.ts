import { describe, expect, it } from "vitest";
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

	it("allows a (project, lead) its own chatChannel + the project core, denies others", () => {
		const authz = buildAuthorizeLeadChannel(projects);
		expect(authz("proj-a", "mufasa", "chan-mufasa")).toBe(true); // own channel
		expect(authz("proj-a", "mufasa", "chan-core")).toBe(true); // project core
		expect(authz("proj-a", "mufasa", "chan-belle")).toBe(false); // other lead's
		expect(authz("proj-a", "belle", "chan-belle")).toBe(true);
		expect(authz("proj-a", "unknown-lead", "chan-mufasa")).toBe(false); // unknown
	});

	it("tolerates a project with no `leads` array (minimal config / tests) — no crash", () => {
		// A bare project object (no `leads`) must not throw at construction.
		const bare = [{ projectName: "x", projectRoot: "/x" } as ProjectEntry];
		expect(() => buildAuthorizeLeadChannel(bare)).not.toThrow();
		const authz = buildAuthorizeLeadChannel(bare);
		expect(authz("x", "any", "any")).toBe(false);
		const resolve = buildResolveBotToken(bare, {});
		expect(resolve("x", "any")).toBeUndefined();
	});

	it("a REUSED agentId is PROJECT-SCOPED — proj-a's mufasa cannot reach proj-b's channel", () => {
		const authz = buildAuthorizeLeadChannel(projects);
		// proj-b's mufasa owns chan-b-mufasa; proj-a's mufasa does NOT
		expect(authz("proj-b", "mufasa", "chan-b-mufasa")).toBe(true);
		expect(authz("proj-a", "mufasa", "chan-b-mufasa")).toBe(false); // no cross-project
		expect(authz("proj-b", "mufasa", "chan-mufasa")).toBe(false); // nor the reverse
	});
});

describe("buildLeadOutboundExpressHandler", () => {
	function fakeRes(): OutboundRes & { code?: number; body?: unknown } {
		const r: OutboundRes & { code?: number; body?: unknown } = {
			status(c) {
				r.code = c;
				return r;
			},
			json(p) {
				r.body = p;
			},
		};
		return r;
	}

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
