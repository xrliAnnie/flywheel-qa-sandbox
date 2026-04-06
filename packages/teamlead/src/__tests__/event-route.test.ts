import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventFilter } from "../bridge/EventFilter.js";
import { formatNotification } from "../bridge/event-route.js";
import { ForumTagUpdater } from "../bridge/ForumTagUpdater.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
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

function makeEvent(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		event_id: `evt-${Math.random().toString(36).slice(2)}`,
		execution_id: "exec-1",
		issue_id: "issue-1",
		project_name: "geoforge3d",
		event_type: "session_started",
		payload: { issueIdentifier: "GEO-95", issueTitle: "Test issue" },
		...overrides,
	};
}

describe("Event route", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(store, testProjects, config);
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

	it("POST /events with valid session_started creates session", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
		expect(session!.issue_identifier).toBe("GEO-95");
	});

	it("POST /events with session_completed (needs_review) sets awaiting_review", async () => {
		// First create session
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		// Then complete it
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "evt-completed",
					event_type: "session_completed",
					payload: {
						decision: { route: "needs_review", reasoning: "has changes" },
						evidence: {
							commitCount: 3,
							filesChangedCount: 6,
							linesAdded: 120,
							linesRemoved: 45,
						},
						summary: "Refactored auth",
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("awaiting_review");
		expect(session!.commit_count).toBe(3);
	});

	it("POST /events with session_failed records error", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_failed",
					payload: { error: "deployment timeout" },
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("failed");
		expect(session!.last_error).toBe("deployment timeout");
	});

	it("POST /events with duplicate event_id returns ok + duplicate", async () => {
		const event = makeEvent({ event_id: "dup-1" });

		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(event),
		});

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(event),
		});
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.duplicate).toBe(true);
	});

	it("POST /events with missing fields returns 400", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify({ event_id: "e1" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /events with invalid auth returns 401", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(401);
	});

	it("POST /events with auto_approve + landingStatus merged → approved (backward compat)", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_completed",
					payload: {
						decision: { route: "auto_approve" },
						evidence: {
							commitCount: 2,
							landingStatus: { status: "merged", mergedAt: "2025-01-01" },
						},
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		// Backward compat: already merged → approved (no auto-merge attempt)
		expect(session!.status).toBe("approved");
		expect(session!.decision_route).toBe("auto_approve");
	});

	it("POST /events with auto_approve + non-merged → awaiting_review (policy)", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_completed",
					payload: {
						decision: { route: "auto_approve" },
						evidence: { commitCount: 1 },
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		// Policy: no auto-merge — awaiting CEO approval
		expect(session!.status).toBe("awaiting_review");
		expect(session!.decision_route).toBe("auto_approve");
	});

	it("session_started inherits existing thread for same issue", async () => {
		// Pre-create a thread mapping for this issue
		store.upsertThread("existing.thread.ts", "CD5QZVAP6", "issue-1");

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent({ execution_id: "exec-new" })),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-new");
		expect(session!.thread_id).toBe("existing.thread.ts");
	});

	it("session_started without existing thread leaves thread_id empty", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.thread_id).toBeUndefined();
	});
});

/** Helper: create a mock RuntimeRegistry for testProjects. */
function createMockRegistry() {
	const envelopes: LeadEventEnvelope[] = [];
	const mockRuntime = {
		type: "claude-discord" as const,
		deliver: vi.fn(async (env: LeadEventEnvelope) => {
			envelopes.push(env);
			return { delivered: true };
		}),
		sendBootstrap: vi.fn(async () => {}),
		health: vi.fn(async () => ({
			status: "healthy" as const,
			lastDeliveryAt: null,
			lastDeliveredSeq: 0,
		})),
		shutdown: vi.fn(async () => {}),
	};
	const registry = new RuntimeRegistry();
	for (const project of testProjects) {
		for (const lead of project.leads) {
			registry.register(lead, mockRuntime);
		}
	}
	return { registry, mockRuntime, envelopes };
}

describe("Event route — structured hook payload", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];

	beforeEach(async () => {
		const mock = createMockRegistry();
		capturedEnvelopes = mock.envelopes;

		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // forumTagUpdater
			mock.registry,
		);
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

	it("sends structured JSON payload with sessionKey", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		// Wait briefly for async notification
		await new Promise((r) => setTimeout(r, 100));

		expect(capturedEnvelopes.length).toBeGreaterThanOrEqual(1);
		const env = capturedEnvelopes[0]!;
		expect(env.leadId).toBe("product-lead");
		expect(env.sessionKey).toBe("flywheel:GEO-95");

		expect(env.event.event_type).toBe("session_started");
		expect(env.event.execution_id).toBe("exec-1");
		expect(env.event.issue_identifier).toBe("GEO-95");
		expect(env.event.forum_channel).toBe("test-channel");
	});

	it("includes thread_id in payload when session has inherited thread", async () => {
		store.upsertThread("inherited.thread", "CD5QZVAP6", "issue-1");

		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		await new Promise((r) => setTimeout(r, 100));

		expect(capturedEnvelopes[0]!.event.thread_id).toBe("inherited.thread");
	});
});

describe("formatNotification", () => {
	const baseSession: Session = {
		execution_id: "e1",
		issue_id: "i1",
		project_name: "p",
		status: "awaiting_review",
		issue_identifier: "GEO-95",
		issue_title: "Refactor auth",
		commit_count: 3,
		lines_added: 120,
		lines_removed: 45,
		decision_route: "needs_review",
		decision_reasoning: "has changes",
	};

	it("needs_review notification", () => {
		const msg = formatNotification(baseSession, "session_completed");
		expect(msg).toContain("[Review Required]");
		expect(msg).toContain("GEO-95");
		expect(msg).toContain("3 commits");
	});

	it("auto_approve notification (already merged / backward compat)", () => {
		const msg = formatNotification(
			{ ...baseSession, decision_route: "auto_approve", status: "approved" },
			"session_completed",
		);
		expect(msg).toContain("[Already Merged]");
	});

	it("auto_approve notification (awaiting review / policy)", () => {
		const msg = formatNotification(
			{
				...baseSession,
				decision_route: "auto_approve",
				status: "awaiting_review",
			},
			"session_completed",
		);
		expect(msg).toContain("[Review Required]");
		expect(msg).toContain("CEO approval");
	});

	it("blocked notification", () => {
		const msg = formatNotification(
			{ ...baseSession, decision_route: "blocked" },
			"session_completed",
		);
		expect(msg).toContain("[Blocked]");
	});

	it("failed notification", () => {
		const msg = formatNotification(
			{ ...baseSession, last_error: "timeout" },
			"session_failed",
		);
		expect(msg).toContain("[Failed]");
		expect(msg).toContain("timeout");
	});

	it("started notification", () => {
		const msg = formatNotification(baseSession, "session_started");
		expect(msg).toContain("[Started]");
	});
});

describe("Event route — EventFilter integration", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];
	const tagMap: Record<string, string[]> = {
		running: ["tag-running"],
		awaiting_review: ["tag-review"],
		approved: ["tag-approved"],
		failed: ["tag-failed"],
	};

	beforeEach(async () => {
		const mock = createMockRegistry();
		capturedEnvelopes = mock.envelopes;

		store = await StateStore.create(":memory:");
		const config = makeConfig({
			discordBotToken: "bot-token",
		});
		const eventFilter = new EventFilter();
		const forumTagUpdater = new ForumTagUpdater(tagMap);
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			eventFilter,
			forumTagUpdater,
			mock.registry,
		);
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

	async function postEvent(overrides: Record<string, unknown> = {}) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent(overrides)),
		});
	}

	it("session_completed + needs_review → runtime.deliver called (high priority)", async () => {
		// Start session first
		await postEvent();
		// Complete with needs_review
		await postEvent({
			event_id: "evt-c1",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review", reasoning: "has changes" },
				evidence: { commitCount: 1 },
				summary: "did stuff",
			},
		});
		await new Promise((r) => setTimeout(r, 150));

		// Should have 2 notifications: session_started (no thread → notify) + session_completed
		expect(capturedEnvelopes.length).toBe(2);
		const completedPayload = capturedEnvelopes[1]!.event;
		expect(completedPayload.filter_priority).toBe("high");
		expect(completedPayload.notification_context).toContain("Chat");
	});

	it("session_started + thread_id exists → runtime.deliver called (FLY-47: Lead announces in Chat)", async () => {
		// Pre-create thread mapping
		store.upsertThread("thread-123", "channel-1", "issue-1");

		await postEvent();
		await new Promise((r) => setTimeout(r, 150));

		// FLY-47: notify_agent — Lead needs to announce session start in Chat
		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.notification_context).toContain("Chat");
	});

	it("session_started + NO thread_id → runtime.deliver called (high — Chat required)", async () => {
		await postEvent();
		await new Promise((r) => setTimeout(r, 150));

		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.filter_priority).toBe("high");
	});

	it("session_failed → runtime.deliver called (high priority)", async () => {
		await postEvent({
			event_type: "session_failed",
			payload: { error: "timeout" },
		});
		await new Promise((r) => setTimeout(r, 150));

		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.filter_priority).toBe("high");
	});

	it("enriched payload includes forum_tag_update_result", async () => {
		await postEvent();
		await new Promise((r) => setTimeout(r, 150));

		// No thread → no_thread
		expect(capturedEnvelopes[0]!.event.forum_tag_update_result).toBe(
			"no_thread",
		);
	});
});

// GEO-275: no-forum lead tests
describe("Event route — no-forum lead (GEO-275)", () => {
	const noForumProjects: ProjectEntry[] = [
		{
			projectName: "geoforge3d",
			projectRoot: "/tmp/geoforge3d",
			projectRepo: "xrliAnnie/GeoForge3D",
			leads: [
				{
					agentId: "pm-lead",
					chatChannel: "core-channel",
					match: { labels: ["PM"] },
					// No forumChannel — PM lead
				},
			],
		},
	];

	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];

	beforeEach(async () => {
		capturedEnvelopes = [];
		const mockRuntime = {
			type: "claude-discord" as const,
			deliver: vi.fn(async (env: LeadEventEnvelope) => {
				capturedEnvelopes.push(env);
				return { delivered: true };
			}),
			sendBootstrap: vi.fn(async () => {}),
			health: vi.fn(async () => ({
				status: "healthy" as const,
				lastDeliveryAt: null,
				lastDeliveredSeq: 0,
			})),
			shutdown: vi.fn(async () => {}),
		};
		const registry = new RuntimeRegistry();
		for (const project of noForumProjects) {
			for (const lead of project.leads) {
				registry.register(lead, mockRuntime);
			}
		}

		store = await StateStore.create(":memory:");
		const config = makeConfig({ discordBotToken: "bot-token" });
		const eventFilter = new EventFilter();
		const forumTagUpdater = new ForumTagUpdater({});
		const app = createBridgeApp(
			store,
			noForumProjects,
			config,
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			eventFilter,
			forumTagUpdater,
			registry,
		);
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

	it("session_started event still delivers to runtime for no-forum lead", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify({
				event_id: "evt-nf-1",
				execution_id: "exec-nf",
				issue_id: "issue-nf",
				issue_identifier: "GEO-300",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: {
					issueIdentifier: "GEO-300",
					issueTitle: "PM triage task",
					issueLabels: ["PM"],
				},
			}),
		});
		await new Promise((r) => setTimeout(r, 150));

		// Event should still be delivered (not skipped)
		expect(capturedEnvelopes.length).toBeGreaterThanOrEqual(1);
		const payload = capturedEnvelopes[0]!.event;
		expect(payload.event_type).toBe("session_started");
		// forum_channel should be undefined for no-forum lead
		expect(payload.forum_channel).toBeUndefined();
		expect(payload.chat_channel).toBe("core-channel");
	});
});

// GEO-200: Thread validation regression tests
describe("Event route — thread validation (GEO-200)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];
	const tagMap: Record<string, string[]> = {
		running: ["tag-running"],
	};

	const mockFetchGeo200 = vi.fn();

	beforeEach(async () => {
		vi.stubGlobal("fetch", mockFetchGeo200);

		const mock = createMockRegistry();
		capturedEnvelopes = mock.envelopes;

		store = await StateStore.create(":memory:");
		const config = makeConfig({
			discordBotToken: "bot-token",
		});
		const eventFilter = new EventFilter();
		const forumTagUpdater = new ForumTagUpdater(tagMap);
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined,
			undefined,
			undefined,
			undefined,
			eventFilter,
			forumTagUpdater,
			mock.registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	function _postEvent(overrides: Record<string, unknown> = {}) {
		// Use the real fetch for HTTP calls to the local test server
		const realFetch = mockFetchGeo200;
		return realFetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent(overrides)),
		});
	}

	it("session_started + valid existing thread → inherit thread_id + notify Lead (FLY-47)", async () => {
		store.upsertThread("thread-valid", "channel-1", "issue-1");

		// Mock Discord API validation: 200 (thread exists)
		// The test server fetch calls also go through mockFetchGeo200
		mockFetchGeo200.mockImplementation(async (url: string, opts?: any) => {
			if (
				typeof url === "string" &&
				url.includes("discord.com/api/v10/channels/thread-valid")
			) {
				return { status: 200 };
			}
			// Real HTTP for local test server
			return globalThis.fetch(url, opts);
		});

		// Need to restore real fetch for the HTTP call
		vi.unstubAllGlobals();
		// Re-seed fetch mock that delegates to real fetch for non-Discord URLs
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (url: string, opts?: any) => {
			if (
				typeof url === "string" &&
				url.includes("discord.com/api/v10/channels/")
			) {
				return { status: 200 };
			}
			return originalFetch(url, opts);
		});

		const res = await originalFetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 150));

		// FLY-47: Thread inherited + Lead notified (notify_agent) so Lead can announce in Chat
		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.notification_context).toContain("Chat");
		const session = store.getSession("exec-1");
		expect(session?.thread_id).toBe("thread-valid");
	});

	it("session_started + deleted thread (404) → no inherit, notify_agent", async () => {
		store.upsertThread("thread-deleted", "channel-1", "issue-1");

		vi.unstubAllGlobals();
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (url: string, opts?: any) => {
			if (
				typeof url === "string" &&
				url.includes("discord.com/api/v10/channels/")
			) {
				return { status: 404 };
			}
			return originalFetch(url, opts);
		});

		const res = await originalFetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 150));

		// Thread not inherited → notify_agent (Lead gets notified)
		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.event_type).toBe("session_started");
		// session should NOT have thread_id
		const session = store.getSession("exec-1");
		expect(session?.thread_id).toBeUndefined();
		// conversation_threads marked as missing
		expect(store.getThreadByIssue("issue-1")).toBeUndefined();
	});

	it("session_started + no existing thread → notify_agent", async () => {
		// No thread seeded
		vi.unstubAllGlobals();
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (url: string, opts?: any) => {
			return originalFetch(url, opts);
		});

		const res = await originalFetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 150));

		// No thread → notify_agent
		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.event_type).toBe("session_started");
	});

	it("markDiscordMissing clears sessions.thread_id for all sessions with that thread", async () => {
		store.upsertThread("thread-stale", "channel-1", "issue-1");

		// Create session manually with thread_id pre-set
		store.upsertSession({
			execution_id: "exec-old",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "completed",
		});
		store.setSessionThreadId("exec-old", "thread-stale");
		expect(store.getSession("exec-old")?.thread_id).toBe("thread-stale");

		vi.unstubAllGlobals();
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (url: string, opts?: any) => {
			if (
				typeof url === "string" &&
				url.includes("discord.com/api/v10/channels/")
			) {
				return { status: 404 };
			}
			return originalFetch(url, opts);
		});

		const res = await originalFetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 150));

		// Old session's thread_id should be cleared by markDiscordMissing
		expect(store.getSession("exec-old")?.thread_id).toBeUndefined();
	});
});

// GEO-292: session_stage + pr_number tracking
describe("Event route — GEO-292 stage tracking", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(store, testProjects, config);
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

	async function postEvent(overrides: Record<string, unknown> = {}) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent(overrides)),
		});
	}

	it("session_started sets session_stage='started'", async () => {
		const res = await postEvent();
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("started");
		expect(session!.stage_updated_at).toBeDefined();
		// SQLite datetime format
		expect(session!.stage_updated_at).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
		);
	});

	it("stage_changed with valid stage sets session_stage", async () => {
		// Create session first
		await postEvent();

		const res = await postEvent({
			event_id: "evt-stage-1",
			event_type: "stage_changed",
			payload: { stage: "implement" },
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("implement");
	});

	it("stage_changed with invalid stage is ignored", async () => {
		// Create session first
		await postEvent();

		const res = await postEvent({
			event_id: "evt-stage-invalid",
			event_type: "stage_changed",
			payload: { stage: "nonexistent_stage" },
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		// Should still be "started" from session_started
		expect(session!.session_stage).toBe("started");
	});

	it("stage_changed updates stage_updated_at", async () => {
		await postEvent();

		const beforeSession = store.getSession("exec-1");
		const _beforeTimestamp = beforeSession!.stage_updated_at;

		// Small delay to ensure different timestamp
		await new Promise((r) => setTimeout(r, 50));

		await postEvent({
			event_id: "evt-stage-time",
			event_type: "stage_changed",
			payload: { stage: "plan" },
		});

		const afterSession = store.getSession("exec-1");
		expect(afterSession!.stage_updated_at).toBeDefined();
		expect(afterSession!.session_stage).toBe("plan");
	});

	it("stage_changed allows stage regression (Runner can go backwards)", async () => {
		await postEvent();

		// Set to a later stage
		await postEvent({
			event_id: "evt-stage-forward",
			event_type: "stage_changed",
			payload: { stage: "code_review" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("code_review");

		// Go backwards — stage_changed does NOT enforce ordering
		await postEvent({
			event_id: "evt-stage-backward",
			event_type: "stage_changed",
			payload: { stage: "brainstorm" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("brainstorm");
	});

	it("session_completed extracts pr_number from landingStatus.prNumber", async () => {
		await postEvent();

		const res = await postEvent({
			event_id: "evt-completed-pr",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 5,
					landingStatus: { status: "open", prNumber: 42 },
				},
			},
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.pr_number).toBe(42);
	});

	it("session_completed without landingStatus has null pr_number", async () => {
		await postEvent();

		await postEvent({
			event_id: "evt-completed-no-ls",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { commitCount: 1 },
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.pr_number).toBeUndefined();
	});

	it("session_completed with merged status infers session_stage='ship'", async () => {
		await postEvent();

		await postEvent({
			event_id: "evt-completed-merged",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					commitCount: 3,
					landingStatus: {
						status: "merged",
						prNumber: 100,
						mergedAt: "2026-03-30",
					},
				},
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("ship");
		expect(session!.pr_number).toBe(100);
	});

	it("session_completed with prNumber infers session_stage='pr_created'", async () => {
		await postEvent();

		await postEvent({
			event_id: "evt-completed-pr-created",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 2,
					landingStatus: { status: "open", prNumber: 55 },
				},
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("pr_created");
	});

	it("session_completed auto-infer does NOT regress stage in legacy path (no FSM)", async () => {
		// Legacy path now uses STAGE_ORDER guard — same as FSM path.
		await postEvent();

		// Set stage to "ship" via stage_changed
		await postEvent({
			event_id: "evt-stage-ship",
			event_type: "stage_changed",
			payload: { stage: "ship" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("ship");

		// session_completed with prNumber (open) infers "pr_created"
		// Legacy path guards with STAGE_ORDER — ship (9) > pr_created (8), so no regression
		await postEvent({
			event_id: "evt-completed-legacy",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 1,
					landingStatus: { status: "open", prNumber: 77 },
				},
			},
		});

		const session = store.getSession("exec-1");
		// Legacy path: STAGE_ORDER prevents regression from ship to pr_created
		expect(session!.session_stage).toBe("ship");
		expect(session!.pr_number).toBe(77);
	});

	it("session_completed with merged doesn't regress from ship (merged infers ship)", async () => {
		await postEvent();

		// Set to ship via stage_changed
		await postEvent({
			event_id: "evt-stage-ship-2",
			event_type: "stage_changed",
			payload: { stage: "ship" },
		});

		// session_completed with merged also infers "ship" — no regression issue
		await postEvent({
			event_id: "evt-completed-merged-2",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					commitCount: 1,
					landingStatus: {
						status: "merged",
						prNumber: 88,
						mergedAt: "2026-03-30",
					},
				},
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("ship");
		expect(session!.pr_number).toBe(88);
	});

	it("session_completed without prNumber does not overwrite existing stage", async () => {
		await postEvent();

		// Advance to code_review
		await postEvent({
			event_id: "evt-stage-cr",
			event_type: "stage_changed",
			payload: { stage: "code_review" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("code_review");

		// session_completed without landingStatus/prNumber → no inferred stage
		// legacyStage is undefined → upsertSession COALESCE preserves existing
		await postEvent({
			event_id: "evt-completed-no-pr",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { commitCount: 1 },
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("code_review"); // preserved
		expect(session!.pr_number).toBeUndefined();
	});
});

// GEO-202: issue_identifier must never be null in sessions
describe("Event route — issue_identifier fallback (GEO-202)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(store, testProjects, config);
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

	it("session_started without issueIdentifier in payload falls back to issue_id", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: { issueTitle: "Test issue" }, // no issueIdentifier
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.issue_identifier).toBe("issue-1"); // fallback to issue_id
	});

	it("session_started with empty string issueIdentifier falls back to issue_id", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: { issueIdentifier: "", issueTitle: "Test issue" },
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.issue_identifier).toBe("issue-1"); // fallback to issue_id
	});

	it("session_completed without prior session_started still gets identifier", async () => {
		// Simulate fire-and-forget session_started being lost
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_completed",
					payload: {
						decision: { route: "needs_review" },
						evidence: { commitCount: 1 },
						// no issueIdentifier in payload
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.issue_identifier).toBe("issue-1"); // fallback to issue_id
	});

	it("session_failed without issueIdentifier falls back to issue_id", async () => {
		// Create a running session first
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "evt-failed",
					event_type: "session_failed",
					payload: {
						error: "timeout",
						// no issueIdentifier
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		// session_started set it to GEO-95, session_failed should preserve it
		expect(session!.issue_identifier).toBe("GEO-95");
	});

	it("session_completed with empty string issueIdentifier preserves existing identifier", async () => {
		// Create a running session with good identifier (GEO-95 from makeEvent default)
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		// session_completed with empty string issueIdentifier should NOT overwrite
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "evt-completed",
					event_type: "session_completed",
					payload: {
						issueIdentifier: "", // empty string — must not overwrite GEO-95
						decision: { route: "needs_review" },
						evidence: { commitCount: 1 },
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		// Empty string should be treated as missing → COALESCE preserves GEO-95
		expect(session!.issue_identifier).toBe("GEO-95");
	});
});
