import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { CaptureSessionFn } from "../bridge/tools.js";
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

	it("GET /api/sessions?mode=by_identifier&statuses=... filters to closable states (FLY-102 Codex Round 1)", async () => {
		// Same identifier, two sessions: one running (not closable), one completed.
		store.upsertSession({
			execution_id: "exec-running",
			issue_id: "i1",
			project_name: "p",
			status: "running",
			issue_identifier: "FLY-500",
		});
		store.upsertSession({
			execution_id: "exec-completed",
			issue_id: "i1",
			project_name: "p",
			status: "completed",
			issue_identifier: "FLY-500",
		});

		const closable =
			"blocked,completed,deferred,failed,rejected,shelved,terminated";
		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=FLY-500&statuses=${encodeURIComponent(closable)}`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].execution_id).toBe("exec-completed");
	});

	it("statuses filter returns >1 when multiple closable sessions (caller disambiguates)", async () => {
		store.upsertSession({
			execution_id: "exec-failed",
			issue_id: "i1",
			project_name: "p",
			status: "failed",
			issue_identifier: "FLY-501",
		});
		store.upsertSession({
			execution_id: "exec-completed",
			issue_id: "i1",
			project_name: "p",
			status: "completed",
			issue_identifier: "FLY-501",
		});

		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=FLY-501&statuses=${encodeURIComponent("completed,failed")}`,
		);
		const body = await res.json();
		expect(body.count).toBe(2);
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

	it("GET /api/sessions/:id does NOT fallback to conversation_threads (FLY-80)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "p",
			status: "running",
		});
		store.upsertThread("1234.5678", "C07XXX", "i1");

		const res = await fetch(`${baseUrl}/api/sessions/e1`);
		const body = await res.json();
		// FLY-80: No stale thread fallback — thread_id comes only from session
		expect(body.thread_id).toBeUndefined();
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

describe("Session capture endpoint", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	const mockCapture: CaptureSessionFn = async (execId, _project, lines) => ({
		output: `mock terminal output for ${execId}\n`,
		tmux_target: "flywheel:@42",
		lines,
		captured_at: new Date().toISOString(),
	});

	const mockCaptureError: CaptureSessionFn = async () => ({
		error: "tmux window not found: flywheel:@99",
		status: 502,
	});

	function startServerWithCapture(s: StateStore, captureFn?: CaptureSessionFn) {
		const app = createBridgeApp(
			s,
			[],
			makeConfig(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			captureFn,
		);
		return app.listen(0, "127.0.0.1");
	}

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
		if (store) {
			store.close();
		}
	});

	it("GET /api/sessions/:id/capture returns 200 with capture output", async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "test-project",
			status: "running",
			issue_identifier: "GEO-262",
		});
		server = startServerWithCapture(store, mockCapture);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		const res = await fetch(`${baseUrl}/api/sessions/exec-1/capture?lines=50`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.execution_id).toBe("exec-1");
		expect(body.output).toContain("mock terminal output");
		expect(body.tmux_target).toBe("flywheel:@42");
		expect(body.lines).toBe(50);
		expect(body.captured_at).toBeTruthy();
	});

	it("GET /api/sessions/:id/capture returns 404 for unknown session", async () => {
		store = await StateStore.create(":memory:");
		server = startServerWithCapture(store, mockCapture);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		const res = await fetch(`${baseUrl}/api/sessions/nonexistent/capture`);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Session not found");
	});

	it("GET /api/sessions/:id/capture forwards capture error status", async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "test-project",
			status: "running",
		});
		server = startServerWithCapture(store, mockCaptureError);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		const res = await fetch(`${baseUrl}/api/sessions/exec-1/capture`);
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toContain("tmux window not found");
	});

	it("GET /api/sessions/:id/capture clamps lines parameter", async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "test-project",
			status: "running",
		});

		let capturedLines: number | undefined;
		const lineCapture: CaptureSessionFn = async (_execId, _project, lines) => {
			capturedLines = lines;
			return {
				output: "output\n",
				tmux_target: "flywheel:@42",
				lines,
				captured_at: new Date().toISOString(),
			};
		};

		server = startServerWithCapture(store, lineCapture);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		// lines=9999 should clamp to 500
		let res = await fetch(`${baseUrl}/api/sessions/exec-1/capture?lines=9999`);
		let body = await res.json();
		expect(body.lines).toBe(500);
		expect(capturedLines).toBe(500);

		// lines=0 should clamp to 1
		res = await fetch(`${baseUrl}/api/sessions/exec-1/capture?lines=0`);
		body = await res.json();
		expect(body.lines).toBe(1);
		expect(capturedLines).toBe(1);

		// lines=NaN should default to 100
		res = await fetch(`${baseUrl}/api/sessions/exec-1/capture?lines=abc`);
		body = await res.json();
		expect(body.lines).toBe(100);
		expect(capturedLines).toBe(100);
	});

	it("GET /api/sessions/:id/capture resolves session by identifier fallback", async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "test-project",
			status: "running",
			issue_identifier: "GEO-262",
		});
		server = startServerWithCapture(store, mockCapture);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		const res = await fetch(`${baseUrl}/api/sessions/GEO-262/capture`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.execution_id).toBe("exec-1");
		expect(body.output).toContain("exec-1");
	});

	it("GET /api/sessions/:id/capture returns 501 when captureSessionFn not configured", async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "test-project",
			status: "running",
		});
		// No capture function passed
		server = startServerWithCapture(store);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		const res = await fetch(`${baseUrl}/api/sessions/exec-1/capture`);
		expect(res.status).toBe(501);
		const body = await res.json();
		expect(body.error).toContain("Capture not configured");
	});

	it("GET /api/sessions/:id/capture defaults lines to 100 when not specified", async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "i1",
			project_name: "test-project",
			status: "running",
		});
		server = startServerWithCapture(store, mockCapture);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		const res = await fetch(`${baseUrl}/api/sessions/exec-1/capture`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.lines).toBe(100);
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

	it("GET /api/sessions without leadId returns all sessions", async () => {
		const res = await fetch(`${baseUrl}/api/sessions`);
		const body = await res.json();
		expect(body.count).toBe(3);
	});

	it("GET /api/sessions?leadId=product-lead returns only product sessions", async () => {
		const res = await fetch(`${baseUrl}/api/sessions?leadId=product-lead`);
		const body = await res.json();
		expect(body.count).toBe(2);
		const ids = body.sessions.map((s: any) => s.execution_id).sort();
		expect(ids).toEqual(["prod-1", "prod-2"]);
	});

	it("GET /api/sessions?leadId=ops-lead returns only ops sessions", async () => {
		const res = await fetch(`${baseUrl}/api/sessions?leadId=ops-lead`);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].execution_id).toBe("ops-1");
	});

	it("GET /api/sessions?leadId=unknown-lead returns empty", async () => {
		const res = await fetch(`${baseUrl}/api/sessions?leadId=unknown-lead`);
		const body = await res.json();
		expect(body.count).toBe(0);
	});

	it("mode=by_identifier ignores leadId", async () => {
		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-102&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].execution_id).toBe("ops-1");
	});

	it("GET /api/sessions/:id/history?leadId filters history", async () => {
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

	it("resolve-action without leadId uses existing behavior", async () => {
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i3&action=terminate`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
	});

	it("resolve-action?leadId=product-lead in scope returns true", async () => {
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i2&action=approve&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
	});

	it("resolve-action?leadId=product-lead out of scope returns false", async () => {
		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i3&action=terminate&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(false);
	});

	it("resolve-action scope-aware selects in-scope candidate (label drift)", async () => {
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

		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=i-drift&action=approve&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("drift-old-prod");
	});

	// --- GEO-200: by_identifier thread fallback ---

	it("GET /api/sessions?mode=by_identifier does NOT fallback to conversation_threads (FLY-80)", async () => {
		store.upsertSession({
			execution_id: "e-fallback",
			issue_id: "i-fallback",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-200",
		});
		// Session has no thread_id — conversation_threads is NOT consulted (FLY-80)
		store.upsertThread("thread-fb-200", "forum-ch", "i-fallback");

		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-200`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].thread_id).toBeUndefined();
	});

	it("GET /api/sessions?mode=by_identifier skips discord_missing thread in fallback", async () => {
		store.upsertSession({
			execution_id: "e-missing",
			issue_id: "i-missing",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-201",
		});
		store.upsertThread("thread-miss", "forum-ch", "i-missing");
		store.markDiscordMissing("thread-miss");

		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-201`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		// thread_id should not be present (discord_missing_at filters it)
		expect(body.sessions[0].thread_id).toBeUndefined();
	});

	it("GET /api/sessions/:id skips discord_missing thread in fallback", async () => {
		store.upsertSession({
			execution_id: "e-miss-id",
			issue_id: "i-miss-id",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-202",
		});
		store.upsertThread("thread-miss-id", "forum-ch", "i-miss-id");
		store.markDiscordMissing("thread-miss-id");

		const res = await fetch(`${baseUrl}/api/sessions/e-miss-id`);
		const body = await res.json();
		// thread_id should not be present
		expect(body.thread_id).toBeUndefined();
	});

	it("session thread_id cleared after markDiscordMissing", async () => {
		store.upsertSession({
			execution_id: "e-stale",
			issue_id: "i-stale",
			project_name: "p",
			status: "running",
			issue_identifier: "GEO-203",
		});
		store.upsertThread("thread-stale", "forum-ch", "i-stale");
		store.setSessionThreadId("e-stale", "thread-stale");

		// Verify session has thread_id before cleanup
		let res = await fetch(`${baseUrl}/api/sessions/e-stale`);
		let body = await res.json();
		expect(body.thread_id).toBe("thread-stale");

		// Mark as missing — clears sessions.thread_id
		store.markDiscordMissing("thread-stale");

		res = await fetch(`${baseUrl}/api/sessions/e-stale`);
		body = await res.json();
		expect(body.thread_id).toBeUndefined();
	});
});
