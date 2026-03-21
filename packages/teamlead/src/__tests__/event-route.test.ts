import type http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventFilter } from "../bridge/EventFilter.js";
import { formatNotification } from "../bridge/event-route.js";
import { ForumTagUpdater } from "../bridge/ForumTagUpdater.js";
import { createBridgeApp } from "../bridge/plugin.js";
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

describe("Event route — structured hook payload", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedPayloads: Record<string, unknown>[];

	beforeEach(async () => {
		capturedPayloads = [];
		// Mock gateway server to capture hook payloads
		const gatewayApp = express();
		gatewayApp.use(express.json());
		gatewayApp.post("/hooks/ingest", (req, res) => {
			capturedPayloads.push(req.body);
			res.json({ ok: true });
		});
		const gatewayServer = gatewayApp.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) =>
			gatewayServer.once("listening", resolve),
		);
		const gatewayAddr = gatewayServer.address();
		const gatewayPort =
			typeof gatewayAddr === "object" && gatewayAddr ? gatewayAddr.port : 0;

		store = await StateStore.create(":memory:");
		const config = makeConfig({
			gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
			hooksToken: "hooks-secret",
		});
		const app = createBridgeApp(store, testProjects, config);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		// Store gateway server for cleanup
		(server as any).__gatewayServer = gatewayServer;
	});

	afterEach(async () => {
		const gatewayServer = (server as any).__gatewayServer;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		if (gatewayServer) {
			await new Promise<void>((resolve, reject) => {
				gatewayServer.close((err: Error | undefined) =>
					err ? reject(err) : resolve(),
				);
			});
		}
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

		expect(capturedPayloads.length).toBeGreaterThanOrEqual(1);
		const payload = capturedPayloads[0]!;
		expect(payload.agentId).toBe("product-lead");
		expect(payload.sessionKey).toBe("flywheel:GEO-95");
		expect(typeof payload.message).toBe("string");

		const parsed = JSON.parse(payload.message as string);
		expect(parsed.event_type).toBe("session_started");
		expect(parsed.execution_id).toBe("exec-1");
		expect(parsed.issue_identifier).toBe("GEO-95");
		expect(parsed.forum_channel).toBe("test-channel");
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

		const parsed = JSON.parse(capturedPayloads[0]!.message as string);
		expect(parsed.thread_id).toBe("inherited.thread");
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
	let capturedPayloads: Record<string, unknown>[];
	const tagMap: Record<string, string[]> = {
		running: ["tag-running"],
		awaiting_review: ["tag-review"],
		approved: ["tag-approved"],
		failed: ["tag-failed"],
	};

	beforeEach(async () => {
		capturedPayloads = [];
		const gatewayApp = express();
		gatewayApp.use(express.json());
		gatewayApp.post("/hooks/ingest", (req, res) => {
			capturedPayloads.push(req.body);
			res.json({ ok: true });
		});
		const gatewayServer = gatewayApp.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) =>
			gatewayServer.once("listening", resolve),
		);
		const gatewayAddr = gatewayServer.address();
		const gatewayPort =
			typeof gatewayAddr === "object" && gatewayAddr ? gatewayAddr.port : 0;

		store = await StateStore.create(":memory:");
		const config = makeConfig({
			gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
			hooksToken: "hooks-secret",
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
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		(server as any).__gatewayServer = gatewayServer;
	});

	afterEach(async () => {
		const gatewayServer = (server as any).__gatewayServer;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		if (gatewayServer) {
			await new Promise<void>((resolve, reject) => {
				gatewayServer.close((err: Error | undefined) =>
					err ? reject(err) : resolve(),
				);
			});
		}
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

	it("session_completed + needs_review → notifyAgent called (high priority)", async () => {
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
		expect(capturedPayloads.length).toBe(2);
		const completedPayload = JSON.parse(capturedPayloads[1]!.message as string);
		expect(completedPayload.filter_priority).toBe("high");
		expect(completedPayload.notification_context).toContain("needs_review");
	});

	it("session_started + thread_id exists → notifyAgent NOT called (forum_only)", async () => {
		// Pre-create thread mapping
		store.upsertThread("thread-123", "channel-1", "issue-1");

		await postEvent();
		await new Promise((r) => setTimeout(r, 150));

		// forum_only — no notification sent
		expect(capturedPayloads.length).toBe(0);
	});

	it("session_started + NO thread_id → notifyAgent called (agent creates Forum Post)", async () => {
		await postEvent();
		await new Promise((r) => setTimeout(r, 150));

		expect(capturedPayloads.length).toBe(1);
		const parsed = JSON.parse(capturedPayloads[0]!.message as string);
		expect(parsed.filter_priority).toBe("normal");
	});

	it("session_failed → notifyAgent called (high priority)", async () => {
		await postEvent({
			event_type: "session_failed",
			payload: { error: "timeout" },
		});
		await new Promise((r) => setTimeout(r, 150));

		expect(capturedPayloads.length).toBe(1);
		const parsed = JSON.parse(capturedPayloads[0]!.message as string);
		expect(parsed.filter_priority).toBe("high");
	});

	it("enriched payload includes forum_tag_update_result", async () => {
		await postEvent();
		await new Promise((r) => setTimeout(r, 150));

		const parsed = JSON.parse(capturedPayloads[0]!.message as string);
		// No thread → no_thread
		expect(parsed.forum_tag_update_result).toBe("no_thread");
	});
});
