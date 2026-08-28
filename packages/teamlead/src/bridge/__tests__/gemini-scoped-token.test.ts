/**
 * FLY-1018 M4 — scoped gemini-agent token (plan §4):
 *   - master token: full access, byte-unchanged;
 *   - scoped token: reaches EXACTLY the 6+1 tool routes; everything else
 *     403 "forbidden for scoped token" (incl. /api/actions spot-check);
 *   - unknown bearer: 401 unchanged;
 *   - scoped unset: byte-compatible sentinel (scoped bearer = plain 401);
 *   - loadConfig fail-closed: scoped == master → throw at boot; scoped
 *     without master → ERROR log + ignored.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { isGeminiScopedReachable, tokenAuthMiddleware } from "../plugin.js";

const MASTER = "master-token";
// distinct from the middleware's "[scoped-token]" log prefix so the
// "never log the token VALUE" assertion is meaningful
const SCOPED = "sk-scoped-9f3a7c";

describe("isGeminiScopedReachable (server-side reachable set)", () => {
	it("contains exactly the 6+1 tool routes", () => {
		expect(isGeminiScopedReachable("POST", "/api/linear/create-issue")).toBe(
			true,
		);
		expect(isGeminiScopedReachable("POST", "/api/runs/start")).toBe(true);
		expect(isGeminiScopedReachable("GET", "/api/sessions/e-1/status")).toBe(
			true,
		);
		expect(isGeminiScopedReachable("POST", "/api/memory/search")).toBe(true);
		expect(isGeminiScopedReachable("POST", "/api/memory/add")).toBe(true);
		expect(isGeminiScopedReachable("POST", "/api/ship-approval-request")).toBe(
			true,
		);
	});

	it("excludes reserved and arbitrary endpoints", () => {
		expect(isGeminiScopedReachable("POST", "/api/actions/approve")).toBe(false);
		expect(isGeminiScopedReachable("POST", "/api/actions/retry")).toBe(false);
		expect(isGeminiScopedReachable("POST", "/api/runs/close-tmux")).toBe(false);
		expect(isGeminiScopedReachable("GET", "/api/query/sessions")).toBe(false);
		expect(isGeminiScopedReachable("POST", "/api/bootstrap/lead-1")).toBe(
			false,
		);
		// wrong method on a reachable path is NOT reachable
		expect(isGeminiScopedReachable("POST", "/api/sessions/e-1/status")).toBe(
			false,
		);
		expect(isGeminiScopedReachable("GET", "/api/runs/start")).toBe(false);
	});
});

describe("tokenAuthMiddleware with a scoped token", () => {
	let server: Server | null = null;
	let baseUrl = "";

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => {
				server?.close(() => resolve());
			});
			server = null;
		}
	});

	/** Mount style mirrors plugin.ts: route-level AND app.use-mounted. */
	async function mountApp(master?: string, scoped?: string) {
		const app = express();
		app.use(express.json());
		// route-level mount (like /api/runs/start, /api/ship-approval-request)
		app.post(
			"/api/runs/start",
			tokenAuthMiddleware(master, scoped),
			(_req, res) => {
				res.json({ ok: "runs" });
			},
		);
		app.post(
			"/api/actions/retry",
			tokenAuthMiddleware(master, scoped),
			(_req, res) => {
				res.json({ ok: "actions" });
			},
		);
		// app.use-mounted router (like /api/memory) — baseUrl+path resolution
		const memory = express.Router();
		memory.post("/search", (_req, res) => {
			res.json({ ok: "memory" });
		});
		app.use("/api/memory", tokenAuthMiddleware(master, scoped), memory);
		server = createServer(app);
		await new Promise<void>((resolve) => {
			server?.listen(0, "127.0.0.1", () => resolve());
		});
		baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
	}

	async function post(path: string, bearer?: string) {
		const res = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(bearer && { authorization: `Bearer ${bearer}` }),
			},
			body: "{}",
		});
		return { status: res.status, json: await res.json() };
	}

	it("master token reaches everything (unchanged)", async () => {
		await mountApp(MASTER, SCOPED);
		expect((await post("/api/runs/start", MASTER)).status).toBe(200);
		expect((await post("/api/actions/retry", MASTER)).status).toBe(200);
		expect((await post("/api/memory/search", MASTER)).status).toBe(200);
	});

	it("scoped token reaches the tool routes — including app.use-mounted ones (baseUrl+path)", async () => {
		await mountApp(MASTER, SCOPED);
		expect((await post("/api/runs/start", SCOPED)).status).toBe(200);
		expect((await post("/api/memory/search", SCOPED)).status).toBe(200);
	});

	it("scoped token gets 403 outside its set (reserved /api/actions spot-check)", async () => {
		await mountApp(MASTER, SCOPED);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const out = await post("/api/actions/retry", SCOPED);
			expect(out.status).toBe(403);
			expect(out.json).toEqual({ error: "forbidden for scoped token" });
			// audit log line carries path + time, never the token
			const line = spy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(line).toContain("POST /api/actions/retry");
			expect(line).not.toContain(SCOPED);
		} finally {
			spy.mockRestore();
		}
	});

	it("unknown bearer stays 401", async () => {
		await mountApp(MASTER, SCOPED);
		expect((await post("/api/runs/start", "wrong")).status).toBe(401);
		expect((await post("/api/runs/start")).status).toBe(401);
	});

	it("byte-compat sentinel: scoped NOT configured → scoped bearer is a plain 401", async () => {
		await mountApp(MASTER, undefined);
		const out = await post("/api/runs/start", SCOPED);
		expect(out.status).toBe(401);
		expect(out.json).toEqual({ error: "unauthorized" });
	});

	it("byte-compat sentinel: no master token → middleware no-ops (pre-existing posture)", async () => {
		await mountApp(undefined, undefined);
		expect((await post("/api/runs/start")).status).toBe(200);
	});
});

describe("loadConfig — TEAMLEAD_GEMINI_AGENT_TOKEN validation", () => {
	const SAVED = { ...process.env };

	beforeEach(() => {
		process.env.TEAMLEAD_DEFAULT_LEAD_AGENT = "product-lead";
		process.env.DISCORD_OWNER_USER_ID = "founder-owner";
		delete process.env.FLYWHEEL_FOUNDER_USER_ID;
		delete process.env.TEAMLEAD_API_TOKEN;
		delete process.env.TEAMLEAD_INGEST_TOKEN;
		delete process.env.TEAMLEAD_GEMINI_AGENT_TOKEN;
		delete process.env.FLYWHEEL_ALERT_DUTY_TOKEN;
		delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
	});

	afterEach(() => {
		process.env = { ...SAVED };
	});

	it("unset scoped token → geminiAgentToken undefined (byte-compat)", () => {
		process.env.TEAMLEAD_API_TOKEN = MASTER;
		expect(loadConfig().geminiAgentToken).toBeUndefined();
	});

	it("scoped + master set and distinct → geminiAgentToken populated", () => {
		process.env.TEAMLEAD_API_TOKEN = MASTER;
		process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = SCOPED;
		expect(loadConfig().geminiAgentToken).toBe(SCOPED);
	});

	it("distinct alert-duty bearer is exposed only as alertDutyToken", () => {
		process.env.TEAMLEAD_API_TOKEN = MASTER;
		process.env.TEAMLEAD_INGEST_TOKEN = "ingest-secret";
		process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = SCOPED;
		process.env.FLYWHEEL_ALERT_DUTY_TOKEN = " alert-duty-secret ";
		expect(loadConfig().alertDutyToken).toBe("alert-duty-secret");
	});

	it.each([
		["TEAMLEAD_API_TOKEN", MASTER],
		["TEAMLEAD_INGEST_TOKEN", "ingest-secret"],
		["TEAMLEAD_GEMINI_AGENT_TOKEN", SCOPED],
	])(
		"alert-duty bearer collision with %s refuses startup",
		(_name, collision) => {
			process.env.TEAMLEAD_API_TOKEN = MASTER;
			process.env.TEAMLEAD_INGEST_TOKEN = "ingest-secret";
			process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = SCOPED;
			process.env.FLYWHEEL_ALERT_DUTY_TOKEN = collision;
			expect(() => loadConfig()).toThrow(
				new RegExp(`FLYWHEEL_ALERT_DUTY_TOKEN.*${_name}`),
			);
		},
	);

	it("collision (scoped == master, trim-compared) → loadConfig THROWS, Bridge refuses to start", () => {
		process.env.TEAMLEAD_API_TOKEN = MASTER;
		process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = `  ${MASTER}  `;
		expect(() => loadConfig()).toThrow(/must differ from TEAMLEAD_API_TOKEN/);
	});

	it("scoped set but master unset → ERROR log + scoped ignored", () => {
		process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = SCOPED;
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const cfg = loadConfig();
			expect(cfg.geminiAgentToken).toBeUndefined();
			const line = spy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(line).toContain("TEAMLEAD_GEMINI_AGENT_TOKEN is set but");
		} finally {
			spy.mockRestore();
		}
	});

	it("blank scoped token is treated as unset", () => {
		process.env.TEAMLEAD_API_TOKEN = MASTER;
		process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = "   ";
		expect(loadConfig().geminiAgentToken).toBeUndefined();
	});

	it("FLY-1715: tokenless remains legal, but a provided master token with outer whitespace fails start", () => {
		expect(loadConfig().apiToken).toBeUndefined();
		process.env.TEAMLEAD_API_TOKEN = ` ${MASTER} `;
		expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN.*outer whitespace/i);
		process.env.TEAMLEAD_API_TOKEN = "   ";
		expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN.*outer whitespace/i);
	});

	it("FLY-1715: ingest and scoped bearers normalize at the config boundary", () => {
		process.env.TEAMLEAD_API_TOKEN = MASTER;
		process.env.TEAMLEAD_INGEST_TOKEN = "  ingest-secret  ";
		process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = `  ${SCOPED}  `;
		const cfg = loadConfig();
		expect(cfg.apiToken).toBe(MASTER);
		expect(cfg.ingestToken).toBe("ingest-secret");
		expect(cfg.geminiAgentToken).toBe(SCOPED);
	});

	it.each([
		["master/ingest", MASTER, ` ${MASTER} `, SCOPED],
		["master/gemini", MASTER, "ingest-secret", ` ${MASTER} `],
		["ingest/gemini", MASTER, " ingest-secret ", "ingest-secret"],
	])(
		"FLY-1715: rejects normalized %s bearer collision",
		(_name, master, ingest, gemini) => {
			process.env.TEAMLEAD_API_TOKEN = master;
			process.env.TEAMLEAD_INGEST_TOKEN = ingest;
			process.env.TEAMLEAD_GEMINI_AGENT_TOKEN = gemini;
			expect(() => loadConfig()).toThrow(/must differ/i);
		},
	);

	it("FLY-1715: whitespace-only ingest remains absent and gemini unset remains legal", () => {
		process.env.TEAMLEAD_API_TOKEN = MASTER;
		process.env.TEAMLEAD_INGEST_TOKEN = "  ";
		expect(loadConfig()).toMatchObject({
			apiToken: MASTER,
			ingestToken: undefined,
			geminiAgentToken: undefined,
		});
	});
});
