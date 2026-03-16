import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { StateStore } from "../StateStore.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type http from "node:http";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

function toSqlite(d: Date): string {
	return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
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
		store.upsertSession({ execution_id: "e1", issue_id: "i1", project_name: "p", status: "running", issue_identifier: "GEO-1" });
		store.upsertSession({ execution_id: "e2", issue_id: "i2", project_name: "p", status: "awaiting_review", issue_identifier: "GEO-2" });
		store.upsertSession({ execution_id: "e3", issue_id: "i3", project_name: "p", status: "failed", issue_identifier: "GEO-3" });

		const res = await fetch(`${baseUrl}/api/sessions`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(2);
		expect(body.sessions.map((s: any) => s.execution_id).sort()).toEqual(["e1", "e2"]);
	});

	it("GET /api/sessions?mode=recent returns most recent N sessions", async () => {
		store.upsertSession({ execution_id: "e1", issue_id: "i1", project_name: "p", status: "completed", last_activity_at: toSqlite(new Date(2026, 0, 1)) });
		store.upsertSession({ execution_id: "e2", issue_id: "i2", project_name: "p", status: "running", last_activity_at: toSqlite(new Date(2026, 0, 3)) });
		store.upsertSession({ execution_id: "e3", issue_id: "i3", project_name: "p", status: "failed", last_activity_at: toSqlite(new Date(2026, 0, 2)) });

		const res = await fetch(`${baseUrl}/api/sessions?mode=recent&limit=2`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(2);
		expect(body.sessions[0].execution_id).toBe("e2");
	});

	it("GET /api/sessions?mode=stuck returns stuck sessions", async () => {
		store.upsertSession({
			execution_id: "stuck-1", issue_id: "i1", project_name: "p", status: "running",
			last_activity_at: toSqlite(new Date(Date.now() - 30 * 60_000)),
		});
		store.upsertSession({
			execution_id: "recent-1", issue_id: "i2", project_name: "p", status: "running",
			last_activity_at: toSqlite(new Date()),
		});

		const res = await fetch(`${baseUrl}/api/sessions?mode=stuck&stuck_threshold=15`);
		const body = await res.json();
		expect(body.sessions.map((s: any) => s.execution_id)).toContain("stuck-1");
		expect(body.sessions.map((s: any) => s.execution_id)).not.toContain("recent-1");
	});

	it("GET /api/sessions?mode=by_identifier returns matching session", async () => {
		store.upsertSession({ execution_id: "e1", issue_id: "i1", project_name: "p", status: "running", issue_identifier: "GEO-95" });

		const res = await fetch(`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-95`);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].identifier).toBe("GEO-95");
	});

	it("GET /api/sessions/:id returns session by execution_id", async () => {
		store.upsertSession({ execution_id: "exec-uuid", issue_id: "i1", project_name: "p", status: "running", issue_identifier: "GEO-95" });

		const res = await fetch(`${baseUrl}/api/sessions/exec-uuid`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.execution_id).toBe("exec-uuid");
		expect(body.identifier).toBe("GEO-95");
	});

	it("GET /api/sessions/GEO-95 returns session by identifier (fallback)", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "running", issue_identifier: "GEO-95" });

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
		store.upsertSession({ execution_id: "e1", issue_id: "i1", project_name: "p", status: "completed", issue_identifier: "GEO-95", started_at: toSqlite(new Date(2026, 0, 1)) });
		store.upsertSession({ execution_id: "e2", issue_id: "i1", project_name: "p", status: "running", issue_identifier: "GEO-95", started_at: toSqlite(new Date(2026, 0, 2)) });

		const res = await fetch(`${baseUrl}/api/sessions/GEO-95/history`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.identifier).toBe("GEO-95");
		expect(body.count).toBe(2);
		expect(body.history[0].execution_id).toBe("e1");
	});

	it("Response format omits issue_id, uses identifier field", async () => {
		store.upsertSession({ execution_id: "e1", issue_id: "internal-uuid", project_name: "p", status: "running", issue_identifier: "GEO-95" });

		const res = await fetch(`${baseUrl}/api/sessions/e1`);
		const body = await res.json();
		expect(body.issue_id).toBeUndefined();
		expect(body.identifier).toBe("GEO-95");
	});

	it("GET /api/sessions/:id includes thread fallback when thread_id is empty", async () => {
		store.upsertSession({ execution_id: "e1", issue_id: "i1", project_name: "p", status: "running" });
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/sessions/e1`);
		const body = await res.json();
		expect(body.thread_id).toBe("1234.5678");
	});

	it("GET /api/sessions/:id uses session thread_id when present", async () => {
		store.upsertSession({ execution_id: "e1", issue_id: "i1", project_name: "p", status: "running", thread_id: "direct.9999" });
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
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "running" });
		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ thread_id: "1234.5678", channel: "C07XXX", issue_id: "i1", execution_id: "exec-1" }),
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
			body: JSON.stringify({ thread_id: "1234.5678", channel: "C07XXX", issue_id: "i1", execution_id: "nonexistent" }),
		});
		expect(res.status).toBe(404);
	});

	it("POST /api/threads/upsert returns 400 for mismatched issue_id", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "running" });
		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ thread_id: "1234.5678", channel: "C07XXX", issue_id: "WRONG", execution_id: "exec-1" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("mismatch");
	});

	it("POST /api/threads/upsert returns 409 for thread bound to different issue", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "running" });
		store.upsertThread("1234.5678", "C07XXX", "OTHER-ISSUE");

		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ thread_id: "1234.5678", channel: "C07XXX", issue_id: "i1", execution_id: "exec-1" }),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toContain("already bound");
	});

	it("POST /api/threads/upsert idempotent for same thread + same issue", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "running" });
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/threads/upsert`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ thread_id: "1234.5678", channel: "C07XXX", issue_id: "i1", execution_id: "exec-1" }),
		});
		expect(res.status).toBe(200);
	});

	// --- GET /api/thread/:thread_id ---

	it("GET /api/thread/:thread_id returns issue info for known thread", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "awaiting_review", issue_identifier: "GEO-42" });
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
		store.upsertSession({ execution_id: "e1", issue_id: "i1", project_name: "p", status: "failed", last_activity_at: "2024-01-01 10:00:00" });
		store.upsertSession({ execution_id: "e2", issue_id: "i1", project_name: "p", status: "running", last_activity_at: "2024-01-01 12:00:00" });
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/thread/1234.5678`);
		const body = await res.json();
		expect(body.latest_execution.execution_id).toBe("e2");
	});

	// --- GET /api/resolve-action ---

	it("GET /api/resolve-action returns can_execute:true for valid action", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "awaiting_review", last_activity_at: "2024-01-01 10:00:00" });

		const res = await fetch(`${baseUrl}/api/resolve-action?issue_id=i1&action=approve`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("exec-1");
		expect(body.status).toBe("awaiting_review");
	});

	it("GET /api/resolve-action returns can_execute:false when no matching session", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "running" });

		const res = await fetch(`${baseUrl}/api/resolve-action?issue_id=i1&action=approve`);
		const body = await res.json();
		expect(body.can_execute).toBe(false);
		expect(body.reason).toContain("No session found");
	});

	it("GET /api/resolve-action returns 400 for unknown action", async () => {
		const res = await fetch(`${baseUrl}/api/resolve-action?issue_id=i1&action=nuke`);
		expect(res.status).toBe(400);
	});

	it("GET /api/resolve-action returns 400 for missing params", async () => {
		const res = await fetch(`${baseUrl}/api/resolve-action`);
		expect(res.status).toBe(400);
	});

	it("GET /api/resolve-action works with multi-status actions (shelve)", async () => {
		store.upsertSession({ execution_id: "exec-1", issue_id: "i1", project_name: "p", status: "failed", last_activity_at: "2024-01-01 10:00:00" });

		const res = await fetch(`${baseUrl}/api/resolve-action?issue_id=i1&action=shelve`);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("exec-1");
	});
});
