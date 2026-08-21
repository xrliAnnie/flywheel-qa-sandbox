import type http from "node:http";
import { WORKFLOW_TRANSITIONS } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { CaptureSessionFn } from "../bridge/tools.js";
import type { BridgeConfig } from "../bridge/types.js";
import {
	CMUX_LIVE_SESSION_STATUSES,
	OPERATIONAL_TERMINAL_STATUSES,
} from "../operational-terminal-status.js";
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

	it("GET /api/sessions?mode=live returns every cmux-visible live status", async () => {
		for (const status of CMUX_LIVE_SESSION_STATUSES) {
			store.upsertSession({
				execution_id: status,
				issue_id: status,
				project_name: "p",
				status,
			});
		}
		store.upsertSession({
			execution_id: "completed",
			issue_id: "completed",
			project_name: "p",
			status: "completed",
		});

		const body = await (
			await fetch(`${baseUrl}/api/sessions?mode=live`)
		).json();
		expect(body.sessions.map((s: any) => s.status).sort()).toEqual(
			[...CMUX_LIVE_SESSION_STATUSES].sort(),
		);
	});

	it("classifies every workflow status as live or terminal for cmux", () => {
		const classified = new Set([
			...CMUX_LIVE_SESSION_STATUSES,
			...OPERATIONAL_TERMINAL_STATUSES,
		]);
		expect(
			Object.keys(WORKFLOW_TRANSITIONS).filter(
				(status) => !classified.has(status),
			),
		).toEqual([]);
	});

	it("GET /api/sessions?mode=recent_terminal returns only recent operational terminals", async () => {
		const hoursAgo = (hours: number) =>
			toSqlite(new Date(Date.now() - hours * 60 * 60_000));
		for (const [execution_id, status, hours] of [
			["completed", "completed", 1],
			["failed", "failed", 47],
			["parked", "approved_to_ship", 1],
			["running", "running", 1],
			["old", "terminated", 49],
		] as const) {
			store.upsertSession({
				execution_id,
				issue_id: execution_id,
				project_name: "p",
				status,
				last_activity_at: hoursAgo(hours),
			});
		}

		const res = await fetch(
			`${baseUrl}/api/sessions?mode=recent_terminal&hours=48`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.sessions.map((s: any) => s.execution_id).sort()).toEqual([
			"completed",
			"failed",
		]);
	});

	it("recent_terminal defaults invalid hours to 48 and caps the window at 168", async () => {
		const hoursAgo = (hours: number) =>
			toSqlite(new Date(Date.now() - hours * 60 * 60_000));
		for (const [execution_id, hours] of [
			["recent", 1],
			["within-cap", 100],
			["beyond-cap", 170],
		] as const) {
			store.upsertSession({
				execution_id,
				issue_id: execution_id,
				project_name: "p",
				status: "completed",
				last_activity_at: hoursAgo(hours),
			});
		}

		const invalid = await (
			await fetch(`${baseUrl}/api/sessions?mode=recent_terminal&hours=nope`)
		).json();
		expect(invalid.sessions.map((s: any) => s.execution_id)).toEqual([
			"recent",
		]);
		const capped = await (
			await fetch(`${baseUrl}/api/sessions?mode=recent_terminal&hours=999`)
		).json();
		expect(capped.sessions.map((s: any) => s.execution_id).sort()).toEqual([
			"recent",
			"within-cap",
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

	// FLY-163: forum thread fallback tests (FLY-80) removed —
	// conversation_threads table dropped, session.thread_id TS field removed.
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

	// FLY-163: /api/threads/upsert + /api/thread/:thread_id endpoint tests
	// removed — forum thread concept gone.

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

	// FLY-228 (Codex R2 MED-3): by_identifier now scopes by leadId WHEN provided
	// (so close_runner --abandon's 0/>1 disambiguation runs on the in-scope set).
	it("mode=by_identifier WITHOUT leadId returns the session (unchanged)", async () => {
		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-102`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].execution_id).toBe("ops-1");
	});

	it("mode=by_identifier WITH leadId filters out an out-of-scope session", async () => {
		// GEO-102 is an Operations issue; product-lead must not see it.
		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-102&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.count).toBe(0);
	});

	it("mode=by_identifier WITH matching leadId returns the in-scope session", async () => {
		const res = await fetch(
			`${baseUrl}/api/sessions?mode=by_identifier&identifier=GEO-101&leadId=product-lead`,
		);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.sessions[0].execution_id).toBe("prod-2");
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

	// FLY-163: GEO-200/FLY-80 conversation_threads fallback + markDiscordMissing
	// tests removed — forum thread concept gone.
});
