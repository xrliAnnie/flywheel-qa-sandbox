import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
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
				payload: {
					issueIdentifier: "GEO-95",
					issueTitle: "Refactor auth module",
				},
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
					evidence: {
						commitCount: 3,
						filesChangedCount: 6,
						linesAdded: 120,
						linesRemoved: 45,
					},
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
		expect(
			activeBody.sessions.some((s: any) => s.execution_id === "exec-e2e"),
		).toBe(true);

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

	it("notification is delivered via registry when configured", async () => {
		const capturedEnvelopes: LeadEventEnvelope[] = [];
		const mockRuntime = {
			type: "openclaw" as const,
			deliver: vi.fn(async (env: LeadEventEnvelope) => {
				capturedEnvelopes.push(env);
			}),
			sendBootstrap: vi.fn(async () => {}),
			health: vi.fn(async () => ({
				status: "healthy" as const,
				lastDeliveryAt: null,
				lastDeliveredSeq: 0,
			})),
			shutdown: vi.fn(async () => {}),
		};
		const mockRegistry = new RuntimeRegistry();
		for (const project of testProjects) {
			for (const lead of project.leads) {
				mockRegistry.register(lead, mockRuntime);
			}
		}

		// Create a bridge with registry
		const store2 = await StateStore.create(":memory:");
		const app2 = createBridgeApp(
			store2,
			testProjects,
			makeConfig(),
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // forumTagUpdater
			mockRegistry,
		);
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
					payload: {
						issueIdentifier: "GEO-102",
						issueTitle: "Test notification",
					},
				}),
			});

			// Wait briefly for async notification
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(capturedEnvelopes.length).toBeGreaterThanOrEqual(1);
			const env = capturedEnvelopes[0];
			expect(env.leadId).toBe("product-lead");
			expect(env.sessionKey).toBe("flywheel:GEO-102");
			expect(env.event.event_type).toBe("session_started");
			expect(env.event.issue_identifier).toBe("GEO-102");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server2.close((err) => (err ? reject(err) : resolve()));
			});
			store2.close();
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

	// GEO-275: full lifecycle with a no-forum PM lead
	it("full lifecycle works for lead without forumChannel", async () => {
		const noForumProjects: ProjectEntry[] = [
			{
				projectName: "geoforge3d",
				projectRoot: "/tmp/geoforge3d",
				projectRepo: "xrliAnnie/GeoForge3D",
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "test-channel",
						chatChannel: "test-chat",
						match: { labels: ["Product"] },
					},
					{
						agentId: "pm-lead",
						// No forumChannel — PM lead
						chatChannel: "core-channel",
						match: { labels: ["PM"] },
					},
				],
			},
		];

		const capturedEnvelopes: LeadEventEnvelope[] = [];
		const mockRuntime = {
			type: "openclaw" as const,
			deliver: vi.fn(async (env: LeadEventEnvelope) => {
				capturedEnvelopes.push(env);
			}),
			sendBootstrap: vi.fn(async () => {}),
			health: vi.fn(async () => ({
				status: "healthy" as const,
				lastDeliveryAt: null,
				lastDeliveredSeq: 0,
			})),
			shutdown: vi.fn(async () => {}),
		};
		const mockRegistry = new RuntimeRegistry();
		for (const project of noForumProjects) {
			for (const lead of project.leads) {
				mockRegistry.register(lead, mockRuntime);
			}
		}

		const store2 = await StateStore.create(":memory:");
		const app2 = createBridgeApp(
			store2,
			noForumProjects,
			makeConfig(),
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // forumTagUpdater
			mockRegistry,
		);
		const server2 = app2.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server2.once("listening", resolve));
		const addr2 = server2.address();
		const port2 = typeof addr2 === "object" && addr2 ? addr2.port : 0;
		const baseUrl2 = `http://127.0.0.1:${port2}`;

		try {
			// 1. session_started for PM-labelled issue → routes to pm-lead
			const startRes = await fetch(`${baseUrl2}/events`, {
				method: "POST",
				headers: ingestHeaders,
				body: JSON.stringify({
					event_id: "evt-pm-1",
					execution_id: "exec-pm",
					issue_id: "issue-pm",
					project_name: "geoforge3d",
					event_type: "session_started",
					payload: {
						issueIdentifier: "GEO-500",
						issueTitle: "PM triage task",
						labels: ["PM"],
					},
				}),
			});
			expect(startRes.status).toBe(200);

			const session = store2.getSession("exec-pm");
			expect(session).toBeDefined();
			expect(session!.status).toBe("running");

			// 2. session_completed → awaiting_review
			const completeRes = await fetch(`${baseUrl2}/events`, {
				method: "POST",
				headers: ingestHeaders,
				body: JSON.stringify({
					event_id: "evt-pm-2",
					execution_id: "exec-pm",
					issue_id: "issue-pm",
					project_name: "geoforge3d",
					event_type: "session_completed",
					payload: {
						decision: { route: "needs_review", reasoning: "done" },
						evidence: {
							commitCount: 1,
							filesChangedCount: 2,
							linesAdded: 10,
							linesRemoved: 5,
						},
						summary: "PM task completed",
						labels: ["PM"],
					},
				}),
			});
			expect(completeRes.status).toBe(200);
			expect(store2.getSession("exec-pm")!.status).toBe("awaiting_review");

			// Wait for async notification delivery
			await new Promise((r) => setTimeout(r, 200));

			// 3. Verify notifications were delivered to pm-lead
			const pmEnvelopes = capturedEnvelopes.filter(
				(e) => e.leadId === "pm-lead",
			);
			expect(pmEnvelopes.length).toBeGreaterThanOrEqual(1);

			// 4. Verify forum_channel is undefined in pm-lead envelopes
			for (const env of pmEnvelopes) {
				expect(env.event.forum_channel).toBeUndefined();
				expect(env.event.chat_channel).toBe("core-channel");
			}

			// 5. session_started for Product-labelled issue → routes to product-lead (with forum)
			const prodRes = await fetch(`${baseUrl2}/events`, {
				method: "POST",
				headers: ingestHeaders,
				body: JSON.stringify({
					event_id: "evt-prod-1",
					execution_id: "exec-prod",
					issue_id: "issue-prod",
					project_name: "geoforge3d",
					event_type: "session_started",
					payload: {
						issueIdentifier: "GEO-501",
						issueTitle: "Product feature",
						labels: ["Product"],
					},
				}),
			});
			expect(prodRes.status).toBe(200);
			await new Promise((r) => setTimeout(r, 200));

			const prodEnvelopes = capturedEnvelopes.filter(
				(e) => e.leadId === "product-lead",
			);
			expect(prodEnvelopes.length).toBeGreaterThanOrEqual(1);

			// Product lead envelopes SHOULD have forum_channel
			const prodEnv = prodEnvelopes[prodEnvelopes.length - 1]!;
			expect(prodEnv.event.forum_channel).toBe("test-channel");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server2.close((err) => (err ? reject(err) : resolve()));
			});
			store2.close();
		}
	});
});
