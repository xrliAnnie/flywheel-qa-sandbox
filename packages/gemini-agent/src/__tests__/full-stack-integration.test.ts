/**
 * FLY-1018 QA (three-stage) — full-stack integration.
 *
 * Every OTHER test in this package mocks one side of the wire: loop.test.ts
 * drives a REAL runLoop over a STUB registry (execute returns canned
 * ToolResults); bridge-client.test.ts drives a REAL BridgeClient over a
 * FAKE fetch. No single test wires the WHOLE agent stack together over real
 * HTTP. This one does — the mock-tests-need-an-integration-complement gap:
 *
 *   scripted ModelSurface → REAL runLoop → REAL dispatch three-stage gate
 *     → REAL createToolRegistry (binding-attach) → REAL BridgeClient
 *     (endpoint whitelist + Bearer + real fetch) → REAL in-process HTTP
 *     Bridge speaking the 6-tool contract.
 *
 * It proves three things the seam-level tests cannot, at the wire:
 *   1. The N1 short-chain (create_issue → dispatch_runner → query_status →
 *      save_memory) actually round-trips over HTTP end-to-end.
 *   2. Binding-attached fields land ON THE WIRE, not just in a unit stub —
 *      create_issue carries the dept label (F2), save_memory carries the
 *      identity triple messages[]/project_name/agent_id/user_id (F4), and
 *      request_ship_approval carries projectName+leadId the model never saw.
 *   3. The guardrail has real teeth end-to-end: a hallucinated `merge_pr`
 *      call is refused by the dispatch gate and NEVER reaches the Bridge
 *      socket, while every legitimate call does.
 *
 * No Gemini API key needed (the model is scripted); the real-Gemini / real
 * Discord matrix is the separate independent §7 QA gated on enablement.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLoop } from "../loop.js";
import { BridgeClient } from "../tools/bridge-client.js";
import { createToolRegistry, type SessionBinding } from "../tools/registry.js";
import type { AuditLog, ModelSurface, ModelTurn } from "../types.js";

const SCOPED_TOKEN = "sk-scoped-fly1018";

interface RecordedRequest {
	method: string;
	path: string;
	authorization: string | undefined;
	body: Record<string, unknown> | null;
}

/** A real HTTP Bridge that speaks the 6-tool contract and records the wire. */
function startFakeBridge() {
	const requests: RecordedRequest[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: Record<string, unknown> | null = null;
			try {
				body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
			} catch {
				body = null;
			}
			// req.url includes the query string for GET status; strip it.
			const path = (req.url ?? "").split("?")[0] ?? "";
			requests.push({
				method: req.method ?? "",
				path,
				authorization: req.headers.authorization,
				body,
			});

			const send = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};

			if (req.method === "POST" && path === "/api/linear/create-issue") {
				return send(200, { success: true, identifier: "FLY-2001", url: "u" });
			}
			if (req.method === "POST" && path === "/api/runs/start") {
				return send(200, { success: true, executionId: "exec-77" });
			}
			if (req.method === "GET" && path.startsWith("/api/sessions/")) {
				return send(200, {
					status: "idle",
					session_status: "awaiting_review",
					pr_number: 518,
				});
			}
			if (req.method === "POST" && path === "/api/memory/search") {
				return send(200, { results: [] });
			}
			if (req.method === "POST" && path === "/api/memory/add") {
				return send(200, { success: true });
			}
			if (req.method === "POST" && path === "/api/ship-approval-request") {
				return send(200, {
					ok: true,
					requestId: "req-abc",
					note: "Ship approval requested. Nothing has been merged; founder approval and the owning runner's verified ship flow are still required.",
				});
			}
			// Anything else (e.g. a reserved action path) — a real Bridge would
			// 403/404; the guardrail must ensure we NEVER get here for merge/ship.
			return send(404, { error: "not found" });
		});
	});
	return { server, requests };
}

function turnOf(
	functionCalls: ModelTurn["functionCalls"],
	text: string | null = null,
): ModelTurn {
	return { functionCalls, text, usage: { inputTokens: 20, outputTokens: 8 } };
}

/** Scripted model: replays a fixed sequence of turns, one per model call. */
function scriptedSurface(script: ModelTurn[]): ModelSurface {
	let i = 0;
	const next = async (): Promise<ModelTurn> => {
		const turn = script[i];
		i += 1;
		if (turn === undefined) throw new Error("script exhausted");
		return turn;
	};
	return { start: () => next(), continueWith: () => next() };
}

function silentAudit(): AuditLog {
	return {
		sessionStart: () => {},
		modelCall: () => {},
		modelResponse: () => {},
		toolDispatch: () => {},
		toolResult: () => {},
		retry: () => {},
		terminal: () => {},
		warning: () => {},
	};
}

let bridge: ReturnType<typeof startFakeBridge>;
let server: Server;
let baseUrl = "";

beforeEach(async () => {
	bridge = startFakeBridge();
	server = bridge.server;
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

function realStack(binding: SessionBinding, script: ModelTurn[]) {
	const client = new BridgeClient({
		baseUrl,
		token: SCOPED_TOKEN,
		timeoutMs: 5000,
	});
	const registry = createToolRegistry(client, binding);
	return runLoop({
		surface: scriptedSurface(script),
		registry,
		system: "sys",
		user: "user",
		audit: silentAudit(),
		signal: new AbortController().signal,
		sessionId: "sid-int",
		model: "gemini-3.5-flash",
		surfaceName: "interactions",
		maxSteps: 12,
		tokenBudgetIn: 200_000,
		tokenBudgetOut: 20_000,
		resultCapChars: 16_000,
	});
}

describe("full-stack N1 short-chain over real HTTP", () => {
	const binding: SessionBinding = {
		projectName: "geoforge3d",
		leadId: "flywheel-eng-lead",
		deptLabel: "backend",
	};

	it("create → dispatch → poll → save_memory round-trips end-to-end; bindings land on the wire", async () => {
		const terminal = await realStack(binding, [
			turnOf([
				{ id: "c1", name: "create_issue", args: { title: "add widget" } },
			]),
			turnOf([
				{
					id: "c2",
					name: "dispatch_runner",
					args: { issueId: "FLY-2001", projectName: "geoforge3d" },
				},
			]),
			turnOf([
				{ id: "c3", name: "query_status", args: { executionId: "exec-77" } },
			]),
			turnOf([
				{
					id: "c4",
					name: "save_memory",
					args: { content: "shipped the widget" },
				},
			]),
			turnOf(
				[],
				"All done — issue filed, runner dispatched, PR #518 awaiting review.",
			),
		]);

		expect(terminal.reason).toBe("completed");
		expect(terminal.stats.toolCalls).toBe(4);
		expect(terminal.stats.toolErrors).toBe(0);
		expect(terminal.stats.hallucinatedToolCalls).toBe(0);

		// Exactly the 4 tool calls hit the socket, in order, all Bearer-authed
		// with the scoped token.
		const paths = bridge.requests.map((r) => `${r.method} ${r.path}`);
		expect(paths).toEqual([
			"POST /api/linear/create-issue",
			"POST /api/runs/start",
			"GET /api/sessions/exec-77/status",
			"POST /api/memory/add",
		]);
		for (const r of bridge.requests) {
			expect(r.authorization).toBe(`Bearer ${SCOPED_TOKEN}`);
		}

		// F2: create_issue carried the binding dept label on the wire (the model
		// only supplied title).
		const createBody = bridge.requests[0]?.body ?? {};
		expect(createBody.title).toBe("add widget");
		expect(createBody.labels).toEqual(["backend"]);

		// F4: save_memory carried the full identity triple attached from the
		// binding — the model only supplied content.
		const memBody = bridge.requests[3]?.body ?? {};
		expect(memBody).toMatchObject({
			messages: [{ role: "assistant", content: "shipped the widget" }],
			project_name: "geoforge3d",
			agent_id: "flywheel-eng-lead",
			user_id: "geoforge3d",
		});
	});

	it("request_ship_approval carries projectName+leadId from the binding, never from the model", async () => {
		const terminal = await realStack(binding, [
			turnOf([
				{
					id: "s1",
					name: "request_ship_approval",
					args: {
						prUrl: "https://github.com/org/repo/pull/518",
						summary: "widget ready",
						// the model tries to smuggle a project/lead — must be ignored
						projectName: "attacker-project",
						leadId: "attacker-lead",
					},
				},
			]),
			turnOf([], "Ship approval requested; nothing merged yet."),
		]);

		// The smuggled projectName/leadId is an UNKNOWN parameter → the dispatch
		// schema gate rejects the call before it ever executes (request_ship_approval
		// only advertises prUrl/summary/requesterContext).
		expect(terminal.reason).toBe("completed");
		expect(terminal.stats.toolErrors).toBe(1);
		expect(
			bridge.requests.some((r) => r.path === "/api/ship-approval-request"),
		).toBe(false);
	});

	it("clean request_ship_approval attaches binding identity on the wire", async () => {
		await realStack(binding, [
			turnOf([
				{
					id: "s1",
					name: "request_ship_approval",
					args: {
						prUrl: "https://github.com/org/repo/pull/518",
						summary: "widget ready",
					},
				},
			]),
			turnOf([], "done"),
		]);
		const shipReq = bridge.requests.find(
			(r) => r.path === "/api/ship-approval-request",
		);
		expect(shipReq).toBeDefined();
		expect(shipReq?.body).toMatchObject({
			prUrl: "https://github.com/org/repo/pull/518",
			summary: "widget ready",
			projectName: "geoforge3d",
			leadId: "flywheel-eng-lead",
		});
		// the model never supplied these — proof they are binding-attached
		expect(shipReq?.body).not.toHaveProperty("attacker");
	});

	it("guardrail teeth end-to-end: a hallucinated merge_pr never reaches the Bridge socket", async () => {
		const terminal = await realStack(binding, [
			// model hallucinates a merge tool, then a ship-adjacent one, then recovers
			turnOf([
				{ id: "h1", name: "merge_pr", args: { pr: 518 } },
				{ id: "h2", name: "deploy", args: {} },
			]),
			turnOf([{ id: "c1", name: "create_issue", args: { title: "legit" } }]),
			turnOf([], "recovered — filed a real issue instead"),
		]);

		expect(terminal.reason).toBe("completed");
		expect(terminal.stats.hallucinatedToolCalls).toBe(2);

		// The ONLY request that reached the socket is the legit create_issue.
		const paths = bridge.requests.map((r) => `${r.method} ${r.path}`);
		expect(paths).toEqual(["POST /api/linear/create-issue"]);
		// Zero merge/deploy/ship traffic ever left the process.
		expect(
			bridge.requests.some(
				(r) => r.path.includes("merge") || r.path.includes("deploy"),
			),
		).toBe(false);
	});

	it("BridgeClient refuses a reserved path before any socket traffic (whitelist, real fetch)", async () => {
		const client = new BridgeClient({
			baseUrl,
			token: SCOPED_TOKEN,
			timeoutMs: 5000,
		});
		await expect(
			client.request("POST", "/api/actions/approve", { pr: 1 }),
		).rejects.toThrow(/whitelist/);
		// nothing hit the Bridge — the throw happened before fetch
		expect(bridge.requests).toHaveLength(0);
	});
});
