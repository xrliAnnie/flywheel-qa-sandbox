import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	BridgeClient,
	EndpointNotAllowedError,
	isWhitelistedEndpoint,
} from "../tools/bridge-client.js";
import { createToolRegistry } from "../tools/registry.js";
import type { AuditLog, ToolExecCtx } from "../types.js";
import { type MockBridge, startMockBridge } from "./fixtures/mock-bridge.js";

const TOKEN = "test-token";

function noopAudit(): AuditLog {
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

function ctx(): ToolExecCtx {
	return { signal: new AbortController().signal, audit: noopAudit() };
}

describe("endpoint whitelist (guardrail layer 3, client side)", () => {
	it("allows exactly the 6+1 tool routes", () => {
		expect(isWhitelistedEndpoint("POST", "/api/linear/create-issue")).toBe(
			true,
		);
		expect(isWhitelistedEndpoint("POST", "/api/runs/start")).toBe(true);
		expect(isWhitelistedEndpoint("GET", "/api/sessions/exec-1/status")).toBe(
			true,
		);
		expect(isWhitelistedEndpoint("POST", "/api/memory/search")).toBe(true);
		expect(isWhitelistedEndpoint("POST", "/api/memory/add")).toBe(true);
		expect(isWhitelistedEndpoint("POST", "/api/ship-approval-request")).toBe(
			true,
		);
	});

	it("rejects reserved and arbitrary endpoints", () => {
		expect(isWhitelistedEndpoint("POST", "/api/actions/approve")).toBe(false);
		expect(isWhitelistedEndpoint("POST", "/actions/approve")).toBe(false);
		expect(isWhitelistedEndpoint("POST", "/api/runs/close-tmux")).toBe(false);
		expect(isWhitelistedEndpoint("GET", "/api/dashboard")).toBe(false);
		expect(isWhitelistedEndpoint("POST", "/api/sessions/x/status")).toBe(false); // wrong method
	});

	it("throws BEFORE fetch for /actions/approve (representative reserved path)", async () => {
		let fetched = false;
		const client = new BridgeClient({
			baseUrl: "http://127.0.0.1:1",
			token: TOKEN,
			timeoutMs: 1000,
			fetchFn: (async () => {
				fetched = true;
				return new Response("{}");
			}) as typeof fetch,
		});
		await expect(
			client.request("POST", "/actions/approve", {}),
		).rejects.toBeInstanceOf(EndpointNotAllowedError);
		await expect(
			client.request("POST", "/api/actions/approve", {}),
		).rejects.toBeInstanceOf(EndpointNotAllowedError);
		expect(fetched).toBe(false);
	});
});

describe("BridgeClient transport", () => {
	it("sends the Bearer header", async () => {
		let seenAuth: string | null = null;
		const client = new BridgeClient({
			baseUrl: "http://bridge.test",
			token: TOKEN,
			timeoutMs: 1000,
			fetchFn: (async (_url: unknown, init?: RequestInit) => {
				seenAuth = (init?.headers as Record<string, string>).authorization;
				return new Response('{"ok":true}', { status: 200 });
			}) as typeof fetch,
		});
		await client.request("POST", "/api/runs/start", { issueId: "X" });
		expect(seenAuth).toBe(`Bearer ${TOKEN}`);
	});

	it("passes error bodies through verbatim with ok=false (no retry on HTTP >=400)", async () => {
		let calls = 0;
		const client = new BridgeClient({
			baseUrl: "http://bridge.test",
			token: TOKEN,
			timeoutMs: 1000,
			fetchFn: (async () => {
				calls += 1;
				return new Response('{"error":"title is required"}', { status: 400 });
			}) as typeof fetch,
		});
		const out = await client.request("POST", "/api/linear/create-issue", {});
		expect(out).toEqual({
			ok: false,
			httpStatus: 400,
			body: '{"error":"title is required"}',
		});
		expect(calls).toBe(1);
	});

	it("retries transport failure exactly once then succeeds", async () => {
		let calls = 0;
		const client = new BridgeClient({
			baseUrl: "http://bridge.test",
			token: TOKEN,
			timeoutMs: 1000,
			sleep: async () => {},
			fetchFn: (async () => {
				calls += 1;
				if (calls === 1) throw new TypeError("fetch failed");
				return new Response('{"ok":true}', { status: 200 });
			}) as typeof fetch,
		});
		const out = await client.request("POST", "/api/runs/start", {});
		expect(out.ok).toBe(true);
		expect(calls).toBe(2);
	});

	it("propagates the original error after the single transport retry", async () => {
		let calls = 0;
		const client = new BridgeClient({
			baseUrl: "http://bridge.test",
			token: TOKEN,
			timeoutMs: 1000,
			sleep: async () => {},
			fetchFn: (async () => {
				calls += 1;
				throw new TypeError("fetch failed forever");
			}) as typeof fetch,
		});
		await expect(client.request("POST", "/api/runs/start", {})).rejects.toThrow(
			"fetch failed forever",
		);
		expect(calls).toBe(2);
	});

	it("wraps a non-JSON response body", async () => {
		const client = new BridgeClient({
			baseUrl: "http://bridge.test",
			token: TOKEN,
			timeoutMs: 1000,
			fetchFn: (async () =>
				new Response("<html>gateway error</html>", {
					status: 502,
				})) as typeof fetch,
		});
		const out = await client.request("POST", "/api/runs/start", {});
		expect(JSON.parse(out.body)).toMatchObject({ error: "non-JSON response" });
	});
});

describe("contract tests against the ported mock-bridge fixture", () => {
	let bridge: MockBridge;
	let client: BridgeClient;

	beforeAll(async () => {
		bridge = await startMockBridge(TOKEN);
	});
	afterAll(async () => {
		await bridge.close();
	});
	beforeEach(() => {
		bridge.reset();
		client = new BridgeClient({
			baseUrl: bridge.url,
			token: TOKEN,
			timeoutMs: 5_000,
		});
	});

	function registry() {
		return createToolRegistry(client, {
			projectName: "geoforge3d",
			leadId: "flywheel-eng-lead",
		});
	}

	it("wrong token → 401 unauthorized contract body", async () => {
		const bad = new BridgeClient({
			baseUrl: bridge.url,
			token: "wrong",
			timeoutMs: 5_000,
		});
		const out = await bad.request("POST", "/api/runs/start", { issueId: "X" });
		expect(out.httpStatus).toBe(401);
		expect(JSON.parse(out.body)).toEqual({ error: "unauthorized" });
	});

	it("create_issue: title-only succeeds (production contract, spike-strict reverted)", async () => {
		const out = await registry().create_issue?.execute(
			{ title: "just a title" },
			ctx(),
		);
		expect(out?.ok).toBe(true);
		const parsed = JSON.parse(out?.body ?? "");
		expect(parsed.ok).toBe(true);
		expect(parsed.issue.identifier).toBe("MOCK-1");
		expect(parsed.issue.url).toContain("MOCK-1");
	});

	it("create_issue: 400 error bodies verbatim (title missing / bad priority / bad labels)", async () => {
		const r = registry();
		const missing = await r.create_issue?.execute({ title: "" }, ctx());
		// NOTE: empty title passes local validateArgs only at the loop layer;
		// here we call execute directly to test the Bridge contract body
		expect(missing?.httpStatus).toBe(400);
		expect(JSON.parse(missing?.body ?? "")).toEqual({
			error: "title is required",
		});
		const badPriority = await r.create_issue?.execute(
			{ title: "t", priority: 9 },
			ctx(),
		);
		expect(JSON.parse(badPriority?.body ?? "")).toEqual({
			error: "priority must be 0-4",
		});
		const badLabels = await r.create_issue?.execute(
			{ title: "t", labels: [1] },
			ctx(),
		);
		expect(JSON.parse(badLabels?.body ?? "")).toEqual({
			error: "labels must be a string array",
		});
	});

	it("dispatch_runner: success shape + 409 dedup message verbatim", async () => {
		const r = registry();
		const ok = await r.dispatch_runner?.execute(
			{ issueId: "MOCK-9", projectName: "geoforge3d" },
			ctx(),
		);
		expect(ok?.ok).toBe(true);
		const parsed = JSON.parse(ok?.body ?? "");
		expect(parsed.executionId).toBe("exec-mock-001");
		const dup = await r.dispatch_runner?.execute(
			{ issueId: "MOCK-9", projectName: "geoforge3d" },
			ctx(),
		);
		expect(dup?.httpStatus).toBe(409);
		expect(JSON.parse(dup?.body ?? "").message).toContain(
			'already has an active session for role "main"',
		);
	});

	it("dispatch_runner: INVALID_AGENT_NAME contract body on empty agentName", async () => {
		// bypass local validateArgs (which treats "" as missing) — direct call
		const out = await client.request("POST", "/api/runs/start", {
			issueId: "M",
			projectName: "p",
			agentName: "",
		});
		expect(out.httpStatus).toBe(400);
		expect(JSON.parse(out.body)).toMatchObject({
			code: "INVALID_AGENT_NAME",
			reason: "empty_string",
		});
	});

	it("query_status: running → completed progression + 404 contract", async () => {
		const r = registry();
		await r.dispatch_runner?.execute(
			{ issueId: "MOCK-5", projectName: "p" },
			ctx(),
		);
		const first = await r.query_status?.execute(
			{ executionId: "exec-mock-001" },
			ctx(),
		);
		expect(JSON.parse(first?.body ?? "").status).toBe("running");
		const second = await r.query_status?.execute(
			{ executionId: "exec-mock-001" },
			ctx(),
		);
		const parsed = JSON.parse(second?.body ?? "");
		expect(parsed.status).toBe("completed");
		expect(parsed.pr_url).toContain("github.com");
		const missing = await r.query_status?.execute(
			{ executionId: "nope" },
			ctx(),
		);
		expect(missing?.httpStatus).toBe(404);
		expect(JSON.parse(missing?.body ?? "")).toEqual({
			error: "Session not found",
		});
	});

	it("search_memory: shared-bucket success + dual-bucket 400 contract", async () => {
		const r = registry();
		const ok = await r.search_memory?.execute(
			{
				query: "conventions",
				project_name: "geoforge3d",
				user_id: "geoforge3d",
			},
			ctx(),
		);
		expect(ok?.ok).toBe(true);
		expect(JSON.parse(ok?.body ?? "").memories).toHaveLength(2);
		const bad = await r.search_memory?.execute(
			{ query: "q", project_name: "geoforge3d", user_id: "someone-else" },
			ctx(),
		);
		expect(bad?.httpStatus).toBe(400);
		expect(JSON.parse(bad?.body ?? "").error).toContain(
			"user_id must equal project_name",
		);
	});

	// FLY-1060 QA R2 F4: identity comes from the binding (the whitelisted lead
	// agentId + shared project bucket) — the model only supplies content. The
	// old contract advertised agent_id "gemini-agent", which the real route
	// (GEO-204 validateMemoryIds) rejects forever.
	it("save_memory: content adapted to messages[]; identity attached from the binding", async () => {
		const r = registry();
		const out = await r.save_memory?.execute(
			{ content: "the outcome fact" },
			ctx(),
		);
		expect(out?.ok).toBe(true);
		expect(JSON.parse(out?.body ?? "").results[0]?.event).toBe("ADD");
		expect(bridge.state.memories[0]).toMatchObject({
			messages: [{ role: "assistant", content: "the outcome fact" }],
			project_name: "geoforge3d",
			agent_id: "flywheel-eng-lead",
			user_id: "geoforge3d",
		});
	});

	it("request_ship_approval: binding projectName+leadId auto-attached; note verbatim in result", async () => {
		const r = registry();
		const out = await r.request_ship_approval?.execute(
			{
				prUrl: "https://github.com/org/repo/pull/12",
				summary: "ready to ship",
			},
			ctx(),
		);
		expect(out?.ok).toBe(true);
		const parsed = JSON.parse(out?.body ?? "");
		expect(parsed.requestId).toBe("ship-req-mock-001");
		expect(parsed.note).toBe(
			"Ship approval requested. Nothing has been merged; founder approval and the owning runner's verified ship flow are still required.",
		);
		// the wire body carried the session binding, NOT model-supplied values
		expect(bridge.state.shipApprovalRequests[0]).toMatchObject({
			prUrl: "https://github.com/org/repo/pull/12",
			projectName: "geoforge3d",
			leadId: "flywheel-eng-lead",
		});
	});

	it("502 fault injection body passes through", async () => {
		bridge.state.faults.createIssue502 = true;
		const out = await registry().create_issue?.execute({ title: "t" }, ctx());
		expect(out?.httpStatus).toBe(502);
		expect(JSON.parse(out?.body ?? "")).toEqual({ error: "Linear API error" });
	});
});
