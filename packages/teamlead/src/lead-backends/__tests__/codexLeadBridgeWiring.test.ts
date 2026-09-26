import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleBackendMap } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	CodexLeadOutboundHandler,
	InMemoryOutboundDedupStore,
} from "../codex/CodexLeadOutboundHandler.js";
import {
	buildAuthorizeLeadChannel,
	buildLeadOutboundExpressHandler,
	buildResolveBotToken,
	loadProjectLeadRoles,
	type OutboundRes,
	paneWatchdogProjects,
	resolveLeadBackendFromRoles,
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

const CODEX_ROLES: RoleBackendMap = { lead: { backend: "codex-tmux" } };
const CLAUDE_ROLES: RoleBackendMap = { lead: { backend: "claude-tmux" } };

describe("resolveLeadBackendFromRoles (real source: roles.lead.backend)", () => {
	it("roles.lead vendor=codex → codex-app-server", () => {
		expect(resolveLeadBackendFromRoles(CODEX_ROLES, {})).toBe(
			"codex-app-server",
		);
	});
	it("roles.lead claude / absent roles / no env → claude-code (byte-compat default)", () => {
		expect(resolveLeadBackendFromRoles(CLAUDE_ROLES, {})).toBe("claude-code");
		expect(resolveLeadBackendFromRoles(undefined, {})).toBe("claude-code");
	});
	it("FLYWHEEL_LEAD_BACKEND env path also resolves (codex → codex-app-server)", () => {
		expect(
			resolveLeadBackendFromRoles(undefined, {
				FLYWHEEL_LEAD_BACKEND: "codex",
			}),
		).toBe("codex-app-server");
	});
});

describe("paneWatchdogProjects — byte-compat (real source)", () => {
	const projects = [project("a"), project("mufasa-project"), project("c")];

	it("all default (getRoles → undefined) → identical list (no-op)", () => {
		const out = paneWatchdogProjects(projects, () => undefined, {});
		expect(out).toEqual(projects);
		expect(out).toHaveLength(3);
	});

	it("excludes a project whose roles.lead is codex, keeps the rest in order", () => {
		const getRoles = (p: { projectName: string }) =>
			p.projectName === "mufasa-project" ? CODEX_ROLES : undefined;
		const out = paneWatchdogProjects(projects, getRoles, {});
		expect(out.map((p) => p.projectName)).toEqual(["a", "c"]);
	});
});

describe("loadProjectLeadRoles (sync .flywheel/config.yaml read)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-roles-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function writeConfig(yaml: string) {
		mkdirSync(join(dir, ".flywheel"), { recursive: true });
		writeFileSync(join(dir, ".flywheel", "config.yaml"), yaml, "utf8");
	}

	it("reads roles.lead.backend from config.yaml", () => {
		writeConfig("project: mufasa\nroles:\n  lead:\n    backend: codex-tmux\n");
		const roles = loadProjectLeadRoles(dir);
		expect(roles?.lead?.backend).toBe("codex-tmux");
		expect(resolveLeadBackendFromRoles(roles, {})).toBe("codex-app-server");
	});

	it("missing file / no roles → undefined (byte-compat default claude-code)", () => {
		expect(loadProjectLeadRoles(dir)).toBeUndefined(); // no config.yaml
		writeConfig("project: x\n");
		expect(loadProjectLeadRoles(dir)).toBeUndefined(); // no roles block
		expect(resolveLeadBackendFromRoles(loadProjectLeadRoles(dir), {})).toBe(
			"claude-code",
		);
	});

	it("malformed YAML → undefined (no throw)", () => {
		writeConfig("project: : : bad\n  - nope\n");
		expect(loadProjectLeadRoles(dir)).toBeUndefined();
	});
});

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
