import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type http from "node:http";

const testProjects: ProjectEntry[] = [
	{ projectName: "geoforge3d", projectRoot: "/tmp/geoforge3d", projectRepo: "xrliAnnie/GeoForge3D" },
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		...overrides,
	};
}

/**
 * End-to-end bridge lifecycle test.
 * Exercises the full event → query → action flow without OpenClaw or real Slack.
 */
describe("Bridge E2E lifecycle", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, testProjects, makeConfig());
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("full lifecycle: start → complete → query → approve", async () => {
		// 1. POST /events session_started → creates session
		const startRes = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-start-1",
				execution_id: "exec-e2e",
				issue_id: "issue-e2e",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-95", issueTitle: "Refactor auth module" },
			}),
		});
		expect(startRes.status).toBe(200);
		expect((await startRes.json()).ok).toBe(true);

		const session = store.getSession("exec-e2e");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
		expect(session!.issue_identifier).toBe("GEO-95");

		// 2. POST /events session_completed (needs_review) → awaiting_review
		const completeRes = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-complete-1",
				execution_id: "exec-e2e",
				issue_id: "issue-e2e",
				project_name: "geoforge3d",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review", reasoning: "has changes" },
					evidence: { commitCount: 3, filesChangedCount: 6, linesAdded: 120, linesRemoved: 45 },
					summary: "Refactored auth module",
				},
			}),
		});
		expect(completeRes.status).toBe(200);
		expect(store.getSession("exec-e2e")!.status).toBe("awaiting_review");

		// 3. GET /api/sessions → active sessions include our session
		const activeRes = await fetch(`${baseUrl}/api/sessions`);
		expect(activeRes.status).toBe(200);
		const activeBody = await activeRes.json();
		expect(activeBody.count).toBeGreaterThanOrEqual(1);
		expect(activeBody.sessions.some((s: any) => s.execution_id === "exec-e2e")).toBe(true);

		// 4. GET /api/sessions/GEO-95 → session detail by identifier
		const detailRes = await fetch(`${baseUrl}/api/sessions/GEO-95`);
		expect(detailRes.status).toBe(200);
		const detailBody = await detailRes.json();
		expect(detailBody.execution_id).toBe("exec-e2e");
		expect(detailBody.identifier).toBe("GEO-95");
		expect(detailBody.issue_id).toBeUndefined();

		// 5. GET /api/sessions/GEO-95/history → execution history
		const histRes = await fetch(`${baseUrl}/api/sessions/GEO-95/history`);
		expect(histRes.status).toBe(200);
		const histBody = await histRes.json();
		expect(histBody.identifier).toBe("GEO-95");
		expect(histBody.count).toBe(1);
		expect(histBody.history[0].execution_id).toBe("exec-e2e");

		// 6. POST /api/actions/approve → domain logic runs (gh CLI not available in test env)
		const approveRes = await fetch(`${baseUrl}/api/actions/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-e2e", identifier: "GEO-95" }),
		});
		// In test env, ApproveHandler fails (no gh CLI) so bridge returns 400 with success: false
		const approveBody = await approveRes.json();
		expect(approveBody).toHaveProperty("success", false);
		expect(approveBody.action).toBe("approve");
		// Session remains awaiting_review since merge failed
		expect(store.getSession("exec-e2e")!.status).toBe("awaiting_review");
	});

	it("duplicate event_id is idempotent", async () => {
		const event = {
			event_id: "evt-dup-e2e",
			execution_id: "exec-dup",
			issue_id: "issue-dup",
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-100" },
		};

		const first = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(event),
		});
		expect(first.status).toBe(200);
		expect((await first.json()).ok).toBe(true);

		const second = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(event),
		});
		expect(second.status).toBe(200);
		const body = await second.json();
		expect(body.ok).toBe(true);
		expect(body.duplicate).toBe(true);
	});

	it("session_failed records error and is queryable", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-fail-1",
				execution_id: "exec-fail",
				issue_id: "issue-fail",
				project_name: "geoforge3d",
				event_type: "session_failed",
				payload: { error: "test timeout", issueIdentifier: "GEO-101" },
			}),
		});

		// Query by identifier
		const res = await fetch(`${baseUrl}/api/sessions/GEO-101`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("failed");
		expect(body.last_error).toBe("test timeout");
	});

	it("notification webhook is called when gatewayUrl is configured", async () => {
		// Set up a mock HTTP server to receive notifications
		const { createServer } = await import("node:http");
		const receivedBodies: string[] = [];

		const mockGateway = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				receivedBodies.push(body);
				res.writeHead(200);
				res.end("ok");
			});
		});
		mockGateway.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => mockGateway.once("listening", resolve));
		const gwAddr = mockGateway.address();
		const gwPort = typeof gwAddr === "object" && gwAddr ? gwAddr.port : 0;
		const gatewayUrl = `http://127.0.0.1:${gwPort}`;

		// Create a bridge with gateway config
		const store2 = await StateStore.create(":memory:");
		const app2 = createBridgeApp(store2, testProjects, makeConfig({
			gatewayUrl,
			hooksToken: "hooks-secret",
		}));
		const server2 = app2.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server2.once("listening", resolve));
		const addr2 = server2.address();
		const port2 = typeof addr2 === "object" && addr2 ? addr2.port : 0;
		const baseUrl2 = `http://127.0.0.1:${port2}`;

		try {
			await fetch(`${baseUrl2}/events`, {
				method: "POST",
				headers: ingestHeaders,
				body: JSON.stringify({
					event_id: "evt-notify-1",
					execution_id: "exec-notify",
					issue_id: "issue-notify",
					project_name: "geoforge3d",
					event_type: "session_started",
					payload: { issueIdentifier: "GEO-102", issueTitle: "Test notification" },
				}),
			});

			// Wait briefly for async notification
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(receivedBodies.length).toBeGreaterThanOrEqual(1);
			const parsed = JSON.parse(receivedBodies[0]);
			expect(parsed.agentId).toBe("product-lead");
			expect(parsed.message).toContain("[Started]");
			expect(parsed.message).toContain("GEO-102");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server2.close((err) => (err ? reject(err) : resolve()));
			});
			store2.close();
			await new Promise<void>((resolve, reject) => {
				mockGateway.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});

	it("multiple executions for same issue appear in history", async () => {
		// First execution — completed
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-hist-1",
				execution_id: "exec-hist-1",
				issue_id: "issue-hist",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-200" },
			}),
		});
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-hist-2",
				execution_id: "exec-hist-1",
				issue_id: "issue-hist",
				project_name: "geoforge3d",
				event_type: "session_failed",
				payload: { error: "first attempt failed" },
			}),
		});

		// Second execution — running
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-hist-3",
				execution_id: "exec-hist-2",
				issue_id: "issue-hist",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-200" },
			}),
		});

		const res = await fetch(`${baseUrl}/api/sessions/GEO-200/history`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(2);
	});
});
