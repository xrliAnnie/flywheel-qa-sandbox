import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { StateStore, OUTCOME_STATUSES } from "../StateStore.js";
import type { SessionUpsert } from "../StateStore.js";
import { buildDashboardPayload } from "../bridge/dashboard-data.js";
import { createBridgeApp, SseBroadcaster } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type http from "node:http";

// --- Helpers ---

const toSqlite = (d: Date) =>
	d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

function makeSession(overrides: Partial<SessionUpsert> = {}): SessionUpsert {
	return {
		execution_id: `exec-${Math.random().toString(36).slice(2, 8)}`,
		issue_id: "GEO-95",
		project_name: "geoforge3d",
		status: "running",
		last_activity_at: toSqlite(new Date()),
		...overrides,
	};
}

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		...overrides,
	};
}

// --- StateStore: TERMINAL_STATUSES monotonic guard ---

describe("TERMINAL_STATUSES monotonic guard", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("rejected → running is blocked", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "rejected" }));
		expect(store.getSession("e1")!.status).toBe("rejected");
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		expect(store.getSession("e1")!.status).toBe("rejected");
	});

	it("deferred → running is blocked", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "deferred" }));
		expect(store.getSession("e1")!.status).toBe("deferred");
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		expect(store.getSession("e1")!.status).toBe("deferred");
	});

	it("shelved → running is blocked", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "shelved" }));
		expect(store.getSession("e1")!.status).toBe("shelved");
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		expect(store.getSession("e1")!.status).toBe("shelved");
	});
});

// --- StateStore: getTerminalSessionsSince ---

describe("getTerminalSessionsSince", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("returns terminal sessions since the given timestamp", () => {
		const now = new Date();
		store.upsertSession(makeSession({ execution_id: "e1", status: "completed", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "failed", last_activity_at: toSqlite(now) }));
		// Before the timestamp
		store.upsertSession(makeSession({
			execution_id: "e3", status: "approved",
			last_activity_at: toSqlite(new Date(now.getTime() - 48 * 60 * 60 * 1000)),
		}));

		const sinceTs = toSqlite(new Date(now.getTime() - 60 * 1000)); // 1 minute ago
		const results = store.getTerminalSessionsSince(sinceTs);
		const ids = results.map((s) => s.execution_id).sort();
		expect(ids).toEqual(["e1", "e2"]);
	});

	it("includes rejected, deferred, shelved statuses", () => {
		const now = new Date();
		store.upsertSession(makeSession({ execution_id: "e1", status: "rejected", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "deferred", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e3", status: "shelved", last_activity_at: toSqlite(now) }));

		const sinceTs = toSqlite(new Date(now.getTime() - 60 * 1000));
		const results = store.getTerminalSessionsSince(sinceTs);
		expect(results).toHaveLength(3);
	});

	it("does not return running/awaiting_review sessions", () => {
		const now = new Date();
		store.upsertSession(makeSession({ execution_id: "e1", status: "running", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "awaiting_review", last_activity_at: toSqlite(now) }));

		const sinceTs = toSqlite(new Date(now.getTime() - 60 * 1000));
		const results = store.getTerminalSessionsSince(sinceTs);
		expect(results).toHaveLength(0);
	});
});

// --- StateStore: getRecentOutcomeSessions ---

describe("getRecentOutcomeSessions", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("returns terminal sessions, not running/awaiting_review", () => {
		const now = new Date();
		store.upsertSession(makeSession({ execution_id: "e1", status: "running", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "completed", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e3", status: "failed", last_activity_at: toSqlite(now) }));

		const results = store.getRecentOutcomeSessions(10);
		const ids = results.map((s) => s.execution_id).sort();
		expect(ids).toEqual(["e2", "e3"]);
	});

	it("respects limit", () => {
		const now = new Date();
		for (let i = 0; i < 5; i++) {
			store.upsertSession(makeSession({
				execution_id: `e${i}`,
				status: "completed",
				last_activity_at: toSqlite(new Date(now.getTime() + i * 1000)),
			}));
		}

		const results = store.getRecentOutcomeSessions(3);
		expect(results).toHaveLength(3);
	});

	it("orders by last_activity_at descending", () => {
		const now = new Date();
		store.upsertSession(makeSession({
			execution_id: "old", status: "completed",
			last_activity_at: toSqlite(new Date(now.getTime() - 10000)),
		}));
		store.upsertSession(makeSession({
			execution_id: "new", status: "completed",
			last_activity_at: toSqlite(now),
		}));

		const results = store.getRecentOutcomeSessions(10);
		expect(results[0]!.execution_id).toBe("new");
		expect(results[1]!.execution_id).toBe("old");
	});
});

// --- buildDashboardPayload ---

describe("buildDashboardPayload", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("empty store returns zero metrics and empty arrays", () => {
		const payload = buildDashboardPayload(store, 15);
		expect(payload.metrics).toEqual({
			running: 0,
			awaiting_review: 0,
			completed_today: 0,
			failed_today: 0,
		});
		expect(payload.active).toEqual([]);
		expect(payload.recent).toEqual([]);
		expect(payload.stuck).toEqual([]);
		expect(payload.generated_at).toBeTruthy();
	});

	it("running session appears in metrics and active", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		const payload = buildDashboardPayload(store, 15);
		expect(payload.metrics.running).toBe(1);
		expect(payload.active).toHaveLength(1);
		expect(payload.active[0]!.execution_id).toBe("e1");
	});

	it("awaiting_review session appears in metrics and active", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "awaiting_review" }));
		const payload = buildDashboardPayload(store, 15);
		expect(payload.metrics.awaiting_review).toBe(1);
		expect(payload.active).toHaveLength(1);
	});

	it("today's completed/approved sessions count in completed_today", () => {
		const now = new Date();
		store.upsertSession(makeSession({ execution_id: "e1", status: "completed", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "approved", last_activity_at: toSqlite(now) }));
		const payload = buildDashboardPayload(store, 15);
		expect(payload.metrics.completed_today).toBe(2);
	});

	it("today's failed sessions count in failed_today", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "failed", last_activity_at: toSqlite(new Date()) }));
		const payload = buildDashboardPayload(store, 15);
		expect(payload.metrics.failed_today).toBe(1);
	});

	it("rejected/deferred/shelved sessions appear in recent outcomes", () => {
		const now = new Date();
		store.upsertSession(makeSession({ execution_id: "e1", status: "rejected", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "deferred", last_activity_at: toSqlite(now) }));
		store.upsertSession(makeSession({ execution_id: "e3", status: "shelved", last_activity_at: toSqlite(now) }));
		const payload = buildDashboardPayload(store, 15);
		expect(payload.recent).toHaveLength(3);
		const statuses = payload.recent.map((s) => s.status).sort();
		expect(statuses).toEqual(["deferred", "rejected", "shelved"]);
	});

	it("recent does not include running/awaiting_review", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "awaiting_review" }));
		const payload = buildDashboardPayload(store, 15);
		expect(payload.recent).toHaveLength(0);
	});

	it("stuck only includes sessions running beyond threshold", () => {
		const now = new Date();
		store.upsertSession(makeSession({
			execution_id: "stuck", status: "running",
			last_activity_at: toSqlite(new Date(now.getTime() - 30 * 60 * 1000)),
		}));
		store.upsertSession(makeSession({
			execution_id: "fresh", status: "running",
			last_activity_at: toSqlite(now),
		}));
		const payload = buildDashboardPayload(store, 15);
		expect(payload.stuck.map((s) => s.execution_id)).toEqual(["stuck"]);
	});

	it("payload does not leak issue_id field", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "running", issue_id: "secret-id" }));
		const payload = buildDashboardPayload(store, 15);
		const session = payload.active[0]!;
		expect(session).not.toHaveProperty("issue_id");
	});
});

// --- SseBroadcaster lifecycle ---

describe("SseBroadcaster", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	function mockResponse(): express.Response & { chunks: string[]; ended: boolean } {
		const chunks: string[] = [];
		const res = {
			chunks,
			ended: false,
			write(data: string) { chunks.push(data); return true; },
			end() { (res as any).ended = true; },
		} as any;
		return res;
	}

	it("poller does not start with 0 clients", () => {
		const b = new SseBroadcaster(store, 15);
		expect(b.isPolling).toBe(false);
		expect(b.clientCount).toBe(0);
	});

	it("addClient starts poller and sends initial state", () => {
		const b = new SseBroadcaster(store, 15);
		const res = mockResponse();
		b.addClient(res as any);
		expect(b.isPolling).toBe(true);
		expect(b.clientCount).toBe(1);
		expect(res.chunks.length).toBe(1);
		expect(res.chunks[0]).toContain("event: state");
		b.destroy();
	});

	it("removeClient last client stops poller", () => {
		const b = new SseBroadcaster(store, 15);
		const res = mockResponse();
		b.addClient(res as any);
		expect(b.isPolling).toBe(true);
		b.removeClient(res as any);
		expect(b.isPolling).toBe(false);
		expect(b.clientCount).toBe(0);
	});

	it("multiple clients share one poller", () => {
		const b = new SseBroadcaster(store, 15);
		const r1 = mockResponse();
		const r2 = mockResponse();
		b.addClient(r1 as any);
		b.addClient(r2 as any);
		expect(b.clientCount).toBe(2);
		expect(b.isPolling).toBe(true);
		b.removeClient(r1 as any);
		expect(b.isPolling).toBe(true); // still has r2
		b.removeClient(r2 as any);
		expect(b.isPolling).toBe(false);
	});

	it("destroy ends all clients and stops poller", () => {
		const b = new SseBroadcaster(store, 15);
		const r1 = mockResponse();
		const r2 = mockResponse();
		b.addClient(r1 as any);
		b.addClient(r2 as any);
		b.destroy();
		expect(r1.ended).toBe(true);
		expect(r2.ended).toBe(true);
		expect(b.clientCount).toBe(0);
		expect(b.isPolling).toBe(false);
	});
});

// --- Route integration tests ---

describe("Dashboard routes", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, [], makeConfig());
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

	it("GET / returns 200 + text/html", async () => {
		const res = await fetch(`${baseUrl}/`);
		expect(res.status).toBe(200);
		const ct = res.headers.get("content-type")!;
		expect(ct).toContain("html");
		const body = await res.text();
		expect(body).toContain("Flywheel Operations Dashboard");
	});

	it("GET /sse returns 200 + text/event-stream with state event (snapshot mode)", async () => {
		const res = await fetch(`${baseUrl}/sse`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const body = await res.text();
		expect(body).toContain("event: state");
		const dataLine = body.split("\n").find((l) => l.startsWith("data: "));
		expect(dataLine).toBeTruthy();
		const payload = JSON.parse(dataLine!.slice(6));
		expect(payload).toHaveProperty("metrics");
		expect(payload).toHaveProperty("active");
		expect(payload).toHaveProperty("recent");
		expect(payload).toHaveProperty("stuck");
	});

	it("GET /health still works", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	it("dashboard and SSE accessible without apiToken auth", async () => {
		// Create app with apiToken configured
		const app = createBridgeApp(store, [], makeConfig({ apiToken: "secret" }));
		const s = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => s.once("listening", resolve));
		const addr = s.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const url = `http://127.0.0.1:${port}`;

		try {
			// Dashboard — no auth needed
			const dashRes = await fetch(`${url}/`);
			expect(dashRes.status).toBe(200);

			// SSE — no auth needed
			const sseRes = await fetch(`${url}/sse`);
			expect(sseRes.status).toBe(200);

			// API — requires auth
			const apiRes = await fetch(`${url}/api/sessions`);
			expect(apiRes.status).toBe(401);
		} finally {
			await new Promise<void>((resolve, reject) => {
				s.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});
});

// --- OUTCOME_STATUSES export ---

describe("OUTCOME_STATUSES", () => {
	it("includes all expected terminal statuses", () => {
		expect(OUTCOME_STATUSES).toContain("completed");
		expect(OUTCOME_STATUSES).toContain("approved");
		expect(OUTCOME_STATUSES).toContain("blocked");
		expect(OUTCOME_STATUSES).toContain("failed");
		expect(OUTCOME_STATUSES).toContain("rejected");
		expect(OUTCOME_STATUSES).toContain("deferred");
		expect(OUTCOME_STATUSES).toContain("shelved");
	});

	it("does not include active statuses", () => {
		expect(OUTCOME_STATUSES).not.toContain("running");
		expect(OUTCOME_STATUSES).not.toContain("awaiting_review");
	});
});
