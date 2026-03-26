import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { StateStore } from "../StateStore.js";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

function toSqlite(d: Date): string {
	return d
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

describe("Query tools", () => {
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

	it("GET /api/sessions (active mode) returns running + awaiting_review sessions", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-1",
		});
		store.upsertSession({
			execution_id: "e2",
			issue_id: "i2",
			project_name: "p",
			status: "awaiting_review",
			issue_identifier: "GEO-2",
		});
		store.upsertSession({
			execution_id: "e3",
			issue_id: "i3",
			project_name: "p",
			status: "failed",
			issue_identifier: "GEO-3",
		});

		const res = await fetch(`${baseUrl}/api/sessions`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(2);
		expect(body.sessions.map((s: any) => s.execution_id).sort()).toEqual([
			"e1",
			"e2",
		]);
	});

	it("GET /api/sessions?mode=recent returns most recent N sessions", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "completed",
			last_activity_at: toSqlite(new Date(2026, 0, 1)),
		});
		store.upsertSession({
			execution_id: "e2",
			issue_id: "i2",
			project_name: "p",
			status: "running",
			last_activity_at: toSqlite(new Date(2026, 0, 3)),
		});
		store.upsertSession({
			execution_id: "e3",
			issue_id: "i3",
			project_name: "p",
			status: "failed",
			last_activity_at: toSqlite(new Date(2026, 0, 2)),
		});

		const res = await fetch(`${baseUrl}/api/sessions?mode=recent&limit=2`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(2);
		expect(body.sessions[0].execution_id).toBe("e2");
	});

	it("GET /api/sessions?mode=stuck returns stuck sessions", async () => {
		store.upsertSession({
			execution_id: "stuck-1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			last_activity_at: toSqlite(new Date(Date.now() - 30 * 60_000)),
		});
		store.upsertSession({
			execution_id: "recent-1",
			issue_id: "i2",
			project_name: "p",
			status: "running",
			last_activity_at: toSqlite(new Date()),
		});

		const res = await fetch(
			`${baseUrl}/api/sessions?mode=stuck&stuck_threshold=15`,
		);
		const body = await res.json();
		expect(body.sessions.map((s: any) => s.execution_id)).toContain("stuck-1");
		expect(body.sessions.map((s: any) => s.execution_id)).not.toContain(
			"recent-1",
		);
	});

	it("GET /api/sessions?mode=by_identifier returns matching session", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-95",
		});

		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-95`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].identifier).toBe("GEO-95");
	});

	it("GET /api/sessions/:id returns session by execution_id", async () => {
		store.upsertSession({
			execution_id: "exec-uuid",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-95",
		});

		const res = await fetch(`${baseUrl}/api/sessions/exec-uuid`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.execution_id).toBe("exec-uuid");
		expect(body.identifier).toBe("GEO-95");
	});

	it("GET /api/sessions/GEO-95 returns session by identifier (fallback)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-95",
		});

		const res = await fetch(`${baseUrl}/api/sessions/GEO-95`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.execution_id).toBe("exec-1");
	});

	it("GET /api/sessions/nonexistent returns 404", async () => {
		const res = await fetch(`${baseUrl}/api/sessions/nonexistent`);
		expect(res.status).toBe(404);
	});

	it("GET /api/sessions/GEO-95/history returns execution history", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "completed",
			issue_identifier: "GEO-95",
			started_at: toSqlite(new Date(2026, 0, 1)),
		});
		store.upsertSession({
			execution_id: "e2",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-95",
			started_at: toSqlite(new Date(2026, 0, 2)),
		});

		const res = await fetch(`${baseUrl}/api/sessions/GEO-95/history`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.identifier).toBe("GEO-95");
		expect(body.count).toBe(2);
		expect(body.history[0].execution_id).toBe("e1");
	});

	it("Response format omits issue_id, uses identifier field", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "internal-uuid",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-95",
		});

		const res = await fetch(`${baseUrl}/api/sessions/e1`);
		const body = await res.json();
		expect(body.issue_id).toBeUndefined();
		expect(body.identifier).toBe("GEO-95");
	});

	it("GET /api/sessions/:id includes thread fallback when thread_id is empty", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
		});
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/sessions/e1`);
		const body = await res.json();
		expect(body.thread_id).toBe("1234.5678");
	});

	it("GET /api/sessions/:id uses session thread_id when present", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			thread_id: "direct.9999",
		});
		store.upsertThread("old.1111", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/sessions/e1`);
		const body = await res.json();
		expect(body.thread_id).toBe("direct.9999");
	});
});

describe("Thread & action endpoints", () => {
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

	// --- POST /api/threads/upsert ---

	it("POST /api/threads/upsert succeeds with valid data", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
		});
		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				thread_id: "1234.5678",
				channel: "C07XXX",
				issue_id: "i1",
				execution_id: "exec-1",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		// Verify thread was stored
		expect(store.getThreadIssue("1234.5678")).toBe("i1");
		// Verify session was updated
		expect(store.getSession("exec-1")!.thread_id).toBe("1234.5678");
	});

	it("POST /api/threads/upsert returns 400 for missing fields", async () => {
		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ thread_id: "1234.5678" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/threads/upsert returns 404 for unknown execution_id", async () => {
		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				thread_id: "1234.5678",
				channel: "C07XXX",
				issue_id: "i1",
				execution_id: "nonexistent",
			}),
		});
		expect(res.status).toBe(404);
	});

	it("POST /api/threads/upsert returns 400 for mismatched issue_id", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
		});
		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				thread_id: "1234.5678",
				channel: "C07XXX",
				issue_id: "WRONG",
				execution_id: "exec-1",
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("mismatch");
	});

	it("POST /api/threads/upsert returns 409 for thread bound to different issue", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
		});
		store.upsertThread("1234.5678", "C07XXX", "OTHER-ISSUE");

		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				thread_id: "1234.5678",
				channel: "C07XXX",
				issue_id: "i1",
				execution_id: "exec-1",
			}),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toContain("already bound");
	});

	it("POST /api/threads/upsert idempotent for same thread + same issue", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
		});
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				thread_id: "1234.5678",
				channel: "C07XXX",
				issue_id: "i1",
				execution_id: "exec-1",
			}),
		});
		expect(res.status).toBe(200);
	});

	// --- GET /api/thread/:thread_id ---

	it("GET /api/thread/:thread_id returns issue info for known thread", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "awaiting_review",
			issue_identifier: "GEO-42",
		});
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/thread/1234.5678`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.found).toBe(true);
		expect(body.issue_id).toBe("i1");
		expect(body.issue_identifier).toBe("GEO-42");
		expect(body.latest_execution).toBeDefined();
		expect(body.latest_execution.execution_id).toBe("exec-1");
	});

	it("GET /api/thread/:thread_id returns found:false for unknown thread", async () => {
		const res = await fetch(`${baseUrl}/api/thread/9999.0000`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.found).toBe(false);
	});

	it("GET /api/thread/:thread_id returns latest execution for issue", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "failed",
			last_activity_at: "2024-01-01 10:00:00",
		});
		store.upsertSession({
			execution_id: "e2",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			last_activity_at: "2024-01-01 12:00:00",
		});
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/thread/1234.5678`);
		const body = await res.json();
		expect(body.latest_execution.execution_id).toBe("e2");
	});

	// --- GET /api/resolve-action ---

	it("GET /api/resolve-action returns can_execute:true for valid action", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "awaiting_review",
			last_activity_at: "2024-01-01 10:00:00",
		});

		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i1&action=approve`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("exec-1");
		expect(body.status).toBe("awaiting_review");
	});

	it("GET /api/resolve-action returns can_execute:false when no matching session", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
		});

		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i1&action=approve`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(false);
		expect(body.reason).toContain("No session found");
	});

	it("GET /api/resolve-action returns 400 for unknown action", async () => {
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i1&action=nuke`,
		);
		expect(res.status).toBe(400);
	});

	it("GET /api/resolve-action returns 400 for missing params", async () => {
		const res = await fetch(`${baseUrl}/api/resolve-action`);
		expect(res.status).toBe(400);
	});

	it("GET /api/resolve-action works with multi-status actions (shelve)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "p",
			status: "failed",
			last_activity_at: "2024-01-01 10:00:00",
		});

		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i1&action=shelve`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("exec-1");
	});
});

// --- GEO-259: Lead scope filtering tests ---

const multiLeadProjects = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "111",
				chatChannel: "111-chat",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "222",
				chatChannel: "222-chat",
				match: { labels: ["Operations"] },
			},
		],
	},
];

describe("GEO-259: leadId filtering on query routes", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, multiLeadProjects, makeConfig());
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		// Seed sessions: 2 for product-lead, 1 for ops-lead
		store.upsertSession({
			execution_id: "prod-1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
			issue_identifier: "GEO-100",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertSession({
			execution_id: "prod-2",
			issue_id: "i2",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-101",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertSession({
			execution_id: "ops-1",
			issue_id: "i3",
			project_name: "geoforge3d",
			status: "running",
			issue_identifier: "GEO-102",
			issue_labels: JSON.stringify(["Operations"]),
		});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("GET /api/sessions without leadId returns all sessions (backwards compat)", async () => {
		const res = await fetch(`${baseUrl}/api/sessions`);
		const body = await res.json();
		expect(body.count).toBe(3);
	});

	it("GET /api/sessions?leadId=product-lead returns only product-lead sessions", async () => {
		const res = await fetch(`${baseUrl}/api/sessions?leadId=product-lead`);
		const body = await res.json();
		expect(body.count).toBe(2);
		const ids = body.sessions.map((s: any) => s.execution_id).sort();
		expect(ids).toEqual(["prod-1", "prod-2"]);
	});

	it("GET /api/sessions?leadId=ops-lead returns only ops-lead sessions", async () => {
		const res = await fetch(`${baseUrl}/api/sessions?leadId=ops-lead`);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].execution_id).toBe("ops-1");
	});

	it("GET /api/sessions?leadId=unknown-lead returns empty array", async () => {
		const res = await fetch(`${baseUrl}/api/sessions?leadId=unknown-lead`);
		const body = await res.json();
		expect(body.count).toBe(0);
		expect(body.sessions).toEqual([]);
	});

	it("GET /api/sessions?mode=recent&leadId=product-lead returns filtered recent", async () => {
		const res = await fetch(
			`${baseUrl}/api/sessions?mode=recent&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.count).toBe(2);
		expect(
			body.sessions.every((s: any) =>
				["prod-1", "prod-2"].includes(s.execution_id),
			),
		).toBe(true);
	});

	it("GET /api/sessions?mode=by_identifier is NOT affected by leadId", async () => {
		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-102&leadId=product-lead`,
		);
		const body = await res.json();
		// Should return ops-1 even though leadId is product-lead (by_identifier ignores leadId)
		expect(body.count).toBe(1);
		expect(body.sessions[0].execution_id).toBe("ops-1");
	});

	it("GET /api/sessions/:id/history?leadId=product-lead returns filtered history", async () => {
		// Create two sessions for same issue with different labels
		store.upsertSession({
			execution_id: "hist-prod",
			issue_id: "i-shared",
			project_name: "geoforge3d",
			status: "failed",
			issue_labels: JSON.stringify(["Product"]),
			last_activity_at: "2026-01-01 10:00:00",
		});
		store.upsertSession({
			execution_id: "hist-ops",
			issue_id: "i-shared",
			project_name: "geoforge3d",
			status: "failed",
			issue_labels: JSON.stringify(["Operations"]),
			last_activity_at: "2026-01-02 10:00:00",
		});

		const res = await fetch(
			`${baseUrl}/api/sessions/hist-prod/history?leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.history[0].execution_id).toBe("hist-prod");
	});

	it("GET /api/resolve-action without leadId uses existing behavior", async () => {
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i3&action=terminate`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("ops-1");
	});

	it("GET /api/resolve-action?leadId=product-lead in scope returns can_execute true", async () => {
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i2&action=approve&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("prod-2");
	});

	it("GET /api/resolve-action?leadId=product-lead out of scope returns can_execute false", async () => {
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i3&action=terminate&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(false);
		expect(body.reason).toContain("No in-scope session");
	});

	it("resolve-action with leadId selects in-scope candidate (label drift)", async () => {
		// Same issue, two sessions with different labels
		store.upsertSession({
			execution_id: "drift-old-prod",
			issue_id: "i-drift",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_labels: JSON.stringify(["Product"]),
			last_activity_at: "2026-01-01 10:00:00",
		});
		store.upsertSession({
			execution_id: "drift-new-ops",
			issue_id: "i-drift",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_labels: JSON.stringify(["Operations"]),
			last_activity_at: "2026-01-02 10:00:00",
		});

		// Product-lead should get the older in-scope session
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i-drift&action=approve&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("drift-old-prod");
	});
});
