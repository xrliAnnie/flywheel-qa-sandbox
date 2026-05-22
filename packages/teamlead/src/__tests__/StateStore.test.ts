import { beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent, SessionUpsert } from "../StateStore.js";
import { StateStore } from "../StateStore.js";

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		event_id: `evt-${Math.random().toString(36).slice(2)}`,
		execution_id: "exec-1",
		issue_id: "GEO-95",
		project_name: "geoforge3d",
		event_type: "session_started",
		source: "orchestrator",
		...overrides,
	};
}

function makeSession(overrides: Partial<SessionUpsert> = {}): SessionUpsert {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-95",
		project_name: "geoforge3d",
		status: "running",
		...overrides,
	};
}

describe("StateStore", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("migrate() is idempotent (call twice)", async () => {
		const store2 = await StateStore.create(":memory:");
		// Second migrate is called inside create, call again explicitly
		store2.migrate();
		store2.close();
	});

	it("insertEvent stores and retrieves event", () => {
		const event = makeEvent();
		const ok = store.insertEvent(event);
		expect(ok).toBe(true);

		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(1);
		expect(events[0]!.event_id).toBe(event.event_id);
		expect(events[0]!.issue_id).toBe("GEO-95");
	});

	it("insertEvent with duplicate event_id returns false", () => {
		const event = makeEvent({ event_id: "dup-id" });
		expect(store.insertEvent(event)).toBe(true);
		expect(store.insertEvent(event)).toBe(false);
	});

	it("upsertSession creates new session", () => {
		store.upsertSession(makeSession());
		const s = store.getSession("exec-1");
		expect(s).toBeDefined();
		expect(s!.status).toBe("running");
		expect(s!.issue_id).toBe("GEO-95");
	});

	it("upsertSession updates existing session", () => {
		store.upsertSession(makeSession());
		store.upsertSession(
			makeSession({
				status: "awaiting_review",
				decision_route: "needs_review",
			}),
		);
		const s = store.getSession("exec-1");
		expect(s!.status).toBe("awaiting_review");
		expect(s!.decision_route).toBe("needs_review");
	});

	it("getActiveSessions returns only running/awaiting_review", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		store.upsertSession(
			makeSession({ execution_id: "e2", status: "awaiting_review" }),
		);
		store.upsertSession(makeSession({ execution_id: "e3", status: "failed" }));
		store.upsertSession(
			makeSession({ execution_id: "e4", status: "completed" }),
		);

		const active = store.getActiveSessions();
		expect(active).toHaveLength(2);
		const ids = active.map((s) => s.execution_id).sort();
		expect(ids).toEqual(["e1", "e2"]);
	});

	it("getStuckSessions returns sessions with old last_activity_at", () => {
		// Use SQLite datetime format (YYYY-MM-DD HH:MM:SS) — no T/Z
		const toSqlite = (d: Date) =>
			d
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d+Z$/, "");

		// Insert a session with activity 30 min ago
		store.upsertSession(
			makeSession({
				execution_id: "stuck-1",
				status: "running",
				last_activity_at: toSqlite(new Date(Date.now() - 30 * 60 * 1000)),
			}),
		);
		// Insert a session with recent activity
		store.upsertSession(
			makeSession({
				execution_id: "recent-1",
				status: "running",
				last_activity_at: toSqlite(new Date()),
			}),
		);

		const stuck = store.getStuckSessions(15);
		const stuckIds = stuck.map((s) => s.execution_id);
		expect(stuckIds).toContain("stuck-1");
		expect(stuckIds).not.toContain("recent-1");
	});

	it("upsertSession ignores running after terminal (failed→running no-op)", () => {
		store.upsertSession(makeSession({ status: "failed", last_error: "oops" }));
		expect(store.getSession("exec-1")!.status).toBe("failed");

		// Try to go back to running
		store.upsertSession(makeSession({ status: "running" }));
		expect(store.getSession("exec-1")!.status).toBe("failed");
	});

	it("upsertSession ignores running after terminal (completed→running no-op)", () => {
		store.upsertSession(makeSession({ status: "completed" }));
		expect(store.getSession("exec-1")!.status).toBe("completed");

		// Try to go back to running
		store.upsertSession(makeSession({ status: "running" }));
		expect(store.getSession("exec-1")!.status).toBe("completed");
	});

	// FLY-163: forum thread CRUD tests (upsertThread, getThreadByIssue,
	// getThreadIssue, setSessionThreadId, conversation_threads migration
	// cleanup) removed — conversation_threads table dropped.

	// --- v1.0 Phase 1: getLatestSessionByIssueAndStatuses ---

	it("getLatestSessionByIssueAndStatuses returns matching session", () => {
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				status: "awaiting_review",
				last_activity_at: "2024-01-01 10:00:00",
			}),
		);
		store.upsertSession(
			makeSession({
				execution_id: "e2",
				status: "failed",
				last_activity_at: "2024-01-01 11:00:00",
			}),
		);
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", [
			"awaiting_review",
		]);
		expect(s).toBeDefined();
		expect(s!.execution_id).toBe("e1");
	});

	it("getLatestSessionByIssueAndStatuses returns latest when multiple match", () => {
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				status: "awaiting_review",
				last_activity_at: "2024-01-01 10:00:00",
			}),
		);
		store.upsertSession(
			makeSession({
				execution_id: "e2",
				status: "awaiting_review",
				last_activity_at: "2024-01-01 12:00:00",
			}),
		);
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", [
			"awaiting_review",
		]);
		expect(s!.execution_id).toBe("e2");
	});

	it("getLatestSessionByIssueAndStatuses returns undefined for no match", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", [
			"awaiting_review",
			"blocked",
		]);
		expect(s).toBeUndefined();
	});

	it("getLatestSessionByIssueAndStatuses with empty statuses returns undefined", () => {
		store.upsertSession(makeSession());
		expect(
			store.getLatestSessionByIssueAndStatuses("GEO-95", []),
		).toBeUndefined();
	});

	it("getLatestSessionByIssueAndStatuses matches multiple statuses", () => {
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				status: "blocked",
				last_activity_at: "2024-01-01 10:00:00",
			}),
		);
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", [
			"awaiting_review",
			"blocked",
		]);
		expect(s).toBeDefined();
		expect(s!.execution_id).toBe("e1");
	});

	// --- GEO-157: heartbeat + adapter columns ---

	it("upsertSession stores and retrieves heartbeat_at", () => {
		store.upsertSession(makeSession({ heartbeat_at: "2026-03-15 10:00:00" }));
		const s = store.getSession("exec-1");
		expect(s!.heartbeat_at).toBe("2026-03-15 10:00:00");
	});

	it("upsertSession stores and retrieves adapter_type", () => {
		store.upsertSession(makeSession({ adapter_type: "claude-cli" }));
		const s = store.getSession("exec-1");
		expect(s!.adapter_type).toBe("claude-cli");
	});

	it("upsertSession stores and retrieves session_params", () => {
		store.upsertSession(makeSession({ session_params: '{"sessionId":"abc"}' }));
		const s = store.getSession("exec-1");
		expect(s!.session_params).toBe('{"sessionId":"abc"}');
	});

	it("upsertSession stores and retrieves run_attempt", () => {
		store.upsertSession(makeSession({ run_attempt: 3 }));
		const s = store.getSession("exec-1");
		expect(s!.run_attempt).toBe(3);
	});

	it("upsertSession preserves heartbeat_at via COALESCE on update", () => {
		store.upsertSession(makeSession({ heartbeat_at: "2026-03-15 10:00:00" }));
		store.upsertSession(makeSession({ status: "awaiting_review" }));
		const s = store.getSession("exec-1");
		expect(s!.heartbeat_at).toBe("2026-03-15 10:00:00");
		expect(s!.status).toBe("awaiting_review");
	});

	// --- GEO-157: updateHeartbeat ---

	it("updateHeartbeat sets heartbeat_at to now", () => {
		store.upsertSession(makeSession());
		store.updateHeartbeat("exec-1");
		const s = store.getSession("exec-1");
		expect(s!.heartbeat_at).toBeDefined();
		// Should be a recent timestamp (within the last minute)
		const hb = new Date(`${s!.heartbeat_at!.replace(" ", "T")}Z`);
		expect(Date.now() - hb.getTime()).toBeLessThan(60_000);
	});

	it("updateHeartbeat is no-op for nonexistent session", () => {
		// Should not throw
		store.updateHeartbeat("nonexistent");
	});

	// --- GEO-157: getOrphanSessions ---

	it("getOrphanSessions returns sessions with stale heartbeat", () => {
		const toSqlite = (d: Date) =>
			d
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d+Z$/, "");

		// Orphan: heartbeat 90 min ago
		store.upsertSession(
			makeSession({
				execution_id: "orphan-1",
				status: "running",
				heartbeat_at: toSqlite(new Date(Date.now() - 90 * 60 * 1000)),
			}),
		);
		// Recent heartbeat
		store.upsertSession(
			makeSession({
				execution_id: "alive-1",
				status: "running",
				heartbeat_at: toSqlite(new Date()),
			}),
		);
		// No heartbeat (should NOT be returned — heartbeat_at IS NULL)
		store.upsertSession(
			makeSession({
				execution_id: "no-hb-1",
				status: "running",
			}),
		);
		// Stale heartbeat but not running (should NOT be returned)
		store.upsertSession(
			makeSession({
				execution_id: "done-1",
				status: "completed",
				heartbeat_at: toSqlite(new Date(Date.now() - 90 * 60 * 1000)),
			}),
		);

		const orphans = store.getOrphanSessions(60);
		const ids = orphans.map((s) => s.execution_id);
		expect(ids).toContain("orphan-1");
		expect(ids).not.toContain("alive-1");
		expect(ids).not.toContain("no-hb-1");
		expect(ids).not.toContain("done-1");
	});

	// --- GEO-157: getSessionParams / setSessionParams ---

	it("setSessionParams + getSessionParams round-trip", () => {
		store.upsertSession(makeSession());
		store.setSessionParams("exec-1", {
			sessionId: "claude-123",
			lastPromptHash: "abc",
		});
		const params = store.getSessionParams("exec-1");
		expect(params).toEqual({ sessionId: "claude-123", lastPromptHash: "abc" });
	});

	it("getSessionParams returns undefined when no params set", () => {
		store.upsertSession(makeSession());
		const params = store.getSessionParams("exec-1");
		expect(params).toBeUndefined();
	});

	it("getSessionParams returns undefined for nonexistent session", () => {
		expect(store.getSessionParams("nonexistent")).toBeUndefined();
	});

	// --- GEO-157: getLatestSessionParams ---

	it("getLatestSessionParams returns most recent session with params", () => {
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				issue_id: "GEO-95",
				last_activity_at: "2024-01-01 10:00:00",
			}),
		);
		store.setSessionParams("e1", { sessionId: "old-session" });
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				issue_id: "GEO-95",
				run_attempt: 1,
			}),
		);

		store.upsertSession(
			makeSession({
				execution_id: "e2",
				issue_id: "GEO-95",
				last_activity_at: "2024-01-01 12:00:00",
				run_attempt: 2,
			}),
		);
		store.setSessionParams("e2", { sessionId: "new-session" });

		const result = store.getLatestSessionParams("GEO-95");
		expect(result).toBeDefined();
		expect(result!.sessionParams).toEqual({ sessionId: "new-session" });
		expect(result!.runAttempt).toBe(2);
	});

	it("getLatestSessionParams returns undefined when no params exist", () => {
		store.upsertSession(makeSession());
		expect(store.getLatestSessionParams("GEO-95")).toBeUndefined();
	});

	it("getLatestSessionParams returns undefined for unknown issue", () => {
		expect(store.getLatestSessionParams("UNKNOWN-1")).toBeUndefined();
	});

	// --- GEO-163: migration tests ---

	it("fresh DB has sessions.thread_id physical column (deprecated, FLY-163)", async () => {
		// Fresh DB — DDL keeps the thread_id column as deprecated. TS layer
		// no longer reads/writes it; this is a schema-survival check.
		const fresh = await StateStore.create(":memory:");
		const stmt = fresh.db.prepare(
			"SELECT 1 FROM pragma_table_info('sessions') WHERE name='thread_id'",
		);
		const hasCol = stmt.step();
		stmt.free();
		expect(hasCol).toBe(true);
		fresh.close();
	});

	it("legacy DB renames slack_thread_ts → thread_id (case b)", async () => {
		// Simulate a pre-migration DB: create table with slack_thread_ts column
		const initSqlJs = (await import("sql.js")).default;
		const SQL = await initSqlJs();
		const db = new SQL.Database();
		// Create old-style sessions table with slack_thread_ts
		db.run(`CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			issue_identifier TEXT,
			issue_title TEXT,
			project_name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			started_at TEXT,
			last_activity_at TEXT,
			tmux_session TEXT,
			worktree_path TEXT,
			branch TEXT,
			last_error TEXT,
			decision_route TEXT,
			decision_reasoning TEXT,
			cost_usd REAL DEFAULT 0,
			commit_count INTEGER DEFAULT 0,
			files_changed INTEGER DEFAULT 0,
			lines_added INTEGER DEFAULT 0,
			lines_removed INTEGER DEFAULT 0,
			summary TEXT,
			diff_summary TEXT,
			commit_messages TEXT,
			changed_file_paths TEXT,
			slack_thread_ts TEXT
		)`);
		// Create old-style conversation_threads with thread_ts
		db.run(`CREATE TABLE conversation_threads (
			thread_ts TEXT PRIMARY KEY,
			channel TEXT NOT NULL,
			issue_id TEXT,
			summary TEXT,
			last_updated TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		// Insert test data with old column names
		db.run(
			"INSERT INTO sessions (execution_id, issue_id, project_name, status, slack_thread_ts) VALUES ('e1', 'i1', 'p', 'running', 'old-slack-ts')",
		);
		db.run(
			"INSERT INTO conversation_threads (thread_ts, channel, issue_id) VALUES ('old-ct-ts', 'C123', 'i1')",
		);
		db.close();

		// Re-create StateStore from that DB data — migration should rename columns
		// We use :memory: and manually inject the old schema
		const store2 = await StateStore.create(":memory:");
		// Manually inject old schema by accessing internal db
		const internalDb = store2.db;
		// Drop the fresh tables and recreate with old schema
		internalDb.run("DROP TABLE IF EXISTS session_events");
		internalDb.run("DROP TABLE IF EXISTS sessions");
		internalDb.run("DROP TABLE IF EXISTS conversation_threads");
		internalDb.run("DROP INDEX IF EXISTS idx_threads_issue");
		internalDb.run("DROP INDEX IF EXISTS idx_events_execution");
		internalDb.run("DROP INDEX IF EXISTS idx_events_issue");
		internalDb.run("DROP INDEX IF EXISTS idx_sessions_status");
		// Create old-style tables
		internalDb.run(`CREATE TABLE session_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT UNIQUE NOT NULL,
			ts TEXT NOT NULL DEFAULT (datetime('now')),
			execution_id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			project_name TEXT NOT NULL,
			event_type TEXT NOT NULL,
			severity TEXT NOT NULL DEFAULT 'info',
			payload JSON,
			source TEXT NOT NULL
		)`);
		internalDb.run(`CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			issue_identifier TEXT,
			issue_title TEXT,
			project_name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			started_at TEXT,
			last_activity_at TEXT,
			tmux_session TEXT,
			worktree_path TEXT,
			branch TEXT,
			last_error TEXT,
			decision_route TEXT,
			decision_reasoning TEXT,
			cost_usd REAL DEFAULT 0,
			commit_count INTEGER DEFAULT 0,
			files_changed INTEGER DEFAULT 0,
			lines_added INTEGER DEFAULT 0,
			lines_removed INTEGER DEFAULT 0,
			summary TEXT,
			diff_summary TEXT,
			commit_messages TEXT,
			changed_file_paths TEXT,
			slack_thread_ts TEXT
		)`);
		internalDb.run(`CREATE TABLE conversation_threads (
			thread_ts TEXT PRIMARY KEY,
			channel TEXT NOT NULL,
			issue_id TEXT,
			summary TEXT,
			last_updated TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		internalDb.run(
			"INSERT INTO sessions (execution_id, issue_id, project_name, status, slack_thread_ts) VALUES ('e1', 'i1', 'p', 'running', 'old-slack-ts')",
		);
		internalDb.run(
			"INSERT INTO conversation_threads (thread_ts, channel, issue_id) VALUES ('old-ct-ts', 'C123', 'i1')",
		);
		// Reset user_version so cutover cleanup runs
		internalDb.run("PRAGMA user_version = 0");

		// Run migration
		store2.migrate();

		// Verify sessions.slack_thread_ts column was renamed to thread_id
		// (physical column kept as deprecated under FLY-163)
		const probe = store2.db.prepare(
			"SELECT 1 FROM pragma_table_info('sessions') WHERE name='thread_id'",
		);
		const hasNewCol = probe.step();
		probe.free();
		expect(hasNewCol).toBe(true);
		// conversation_threads should have been dropped by FLY-163 migration
		const tableProbe = store2.db.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_threads'",
		);
		const tableExists = tableProbe.step();
		tableProbe.free();
		expect(tableExists).toBe(false);

		store2.close();
	});

	it("very-legacy DB adds thread_id column (case c)", async () => {
		const store2 = await StateStore.create(":memory:");
		const internalDb = store2.db;
		// Drop and recreate tables WITHOUT thread column at all
		internalDb.run("DROP TABLE IF EXISTS session_events");
		internalDb.run("DROP TABLE IF EXISTS sessions");
		internalDb.run("DROP TABLE IF EXISTS conversation_threads");
		internalDb.run("DROP INDEX IF EXISTS idx_threads_issue");
		internalDb.run("DROP INDEX IF EXISTS idx_events_execution");
		internalDb.run("DROP INDEX IF EXISTS idx_events_issue");
		internalDb.run("DROP INDEX IF EXISTS idx_sessions_status");
		internalDb.run(`CREATE TABLE session_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT UNIQUE NOT NULL,
			ts TEXT NOT NULL DEFAULT (datetime('now')),
			execution_id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			project_name TEXT NOT NULL,
			event_type TEXT NOT NULL,
			severity TEXT NOT NULL DEFAULT 'info',
			payload JSON,
			source TEXT NOT NULL
		)`);
		internalDb.run(`CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			issue_identifier TEXT,
			issue_title TEXT,
			project_name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			started_at TEXT,
			last_activity_at TEXT,
			tmux_session TEXT,
			worktree_path TEXT,
			branch TEXT,
			last_error TEXT,
			decision_route TEXT,
			decision_reasoning TEXT,
			cost_usd REAL DEFAULT 0,
			commit_count INTEGER DEFAULT 0,
			files_changed INTEGER DEFAULT 0,
			lines_added INTEGER DEFAULT 0,
			lines_removed INTEGER DEFAULT 0,
			summary TEXT,
			diff_summary TEXT,
			commit_messages TEXT,
			changed_file_paths TEXT
		)`);
		internalDb.run(`CREATE TABLE conversation_threads (
			channel TEXT NOT NULL,
			issue_id TEXT,
			summary TEXT,
			last_updated TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		internalDb.run(
			"INSERT INTO sessions (execution_id, issue_id, project_name, status) VALUES ('e1', 'i1', 'p', 'running')",
		);

		// Run migration — should ADD thread_id column (kept as deprecated)
		store2.migrate();

		// Verify thread_id column exists (FLY-163: physical column kept)
		const probe = store2.db.prepare(
			"SELECT 1 FROM pragma_table_info('sessions') WHERE name='thread_id'",
		);
		const hasCol = probe.step();
		probe.free();
		expect(hasCol).toBe(true);

		store2.close();
	});

	// FLY-163: getEligibleForCleanup / markArchived / clearArchived /
	// markDiscordMissing / getThreadIssue tests removed — forum thread cleanup
	// path (CleanupService + conversation_threads.discord_missing_at) deleted.
	// The `toSqlite3` helper used only by those tests is removed with them.

	it("FLY-163 migration drops conversation_threads from a legacy DB", async () => {
		// Create a legacy DB with the conversation_threads table + a few rows +
		// archived columns. Re-open through StateStore.create() and confirm the
		// migration drops the table, leaves sessions intact (with thread_id
		// physical column preserved as deprecated).
		const path = "/tmp/fly163-legacy.sqlite";
		try {
			const fs = await import("node:fs");
			const initSqlJs = (await import("sql.js")).default;
			const SQL = await initSqlJs();
			const seed = new SQL.Database();
			seed.run(`CREATE TABLE conversation_threads (
				thread_id TEXT PRIMARY KEY,
				channel TEXT NOT NULL,
				issue_id TEXT,
				summary TEXT,
				last_updated TEXT NOT NULL DEFAULT (datetime('now')),
				archived_at TEXT,
				cleanup_notified_at TEXT,
				discord_missing_at TEXT
			)`);
			seed.run(
				"INSERT INTO conversation_threads (thread_id, channel, issue_id) VALUES (?, ?, ?)",
				["legacy-1", "CH1", "GEO-LEG-1"],
			);
			fs.writeFileSync(path, Buffer.from(seed.export()));
			seed.close();

			const migrated = await StateStore.create(path);
			const stmt = migrated.db.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_threads'",
			);
			const dropped = !stmt.step();
			stmt.free();
			expect(dropped).toBe(true);
			// chat_threads operations still work
			migrated.upsertChatThread(
				"thread-abc",
				"channel-xyz",
				"issue-1",
				"lead-1",
			);
			expect(
				migrated.getChatThreadByIssue("issue-1", "channel-xyz"),
			).toBeDefined();
		} finally {
			try {
				const fs = await import("node:fs");
				fs.unlinkSync(path);
			} catch {}
		}
	});

	// --- GEO-292: pr_number, session_stage, stage_updated_at ---

	it("migration creates pr_number, session_stage, stage_updated_at columns", async () => {
		const store2 = await StateStore.create(":memory:");
		const internalDb = store2.db;

		// Verify columns exist by querying PRAGMA
		const cols = internalDb.exec("PRAGMA table_info(sessions)");
		const colNames = cols[0]!.values.map((row) => row[1] as string);
		expect(colNames).toContain("pr_number");
		expect(colNames).toContain("session_stage");
		expect(colNames).toContain("stage_updated_at");

		store2.close();
	});

	it("upsertSession writes and reads pr_number", () => {
		store.upsertSession(makeSession({ pr_number: 42 }));
		const s = store.getSession("exec-1");
		expect(s!.pr_number).toBe(42);
	});

	it("upsertSession writes and reads session_stage + stage_updated_at", () => {
		store.upsertSession(
			makeSession({
				session_stage: "implement",
				stage_updated_at: "2026-03-30 12:00:00",
			}),
		);
		const s = store.getSession("exec-1");
		expect(s!.session_stage).toBe("implement");
		expect(s!.stage_updated_at).toBe("2026-03-30 12:00:00");
	});

	it("upsertSession preserves pr_number via COALESCE on update", () => {
		store.upsertSession(makeSession({ pr_number: 99 }));
		store.upsertSession(makeSession({ status: "awaiting_review" }));
		const s = store.getSession("exec-1");
		expect(s!.pr_number).toBe(99);
		expect(s!.status).toBe("awaiting_review");
	});

	it("upsertSession preserves session_stage via COALESCE on update", () => {
		store.upsertSession(makeSession({ session_stage: "research" }));
		store.upsertSession(makeSession({ status: "awaiting_review" }));
		const s = store.getSession("exec-1");
		expect(s!.session_stage).toBe("research");
	});

	it("persistTransition writes pr_number, session_stage, stage_updated_at", () => {
		// Create session first
		store.upsertSession(makeSession());
		store.persistTransition("exec-1", "awaiting_review", {
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			pr_number: 77,
			session_stage: "pr_created",
			stage_updated_at: "2026-03-30 14:00:00",
			last_activity_at: "2026-03-30 14:00:00",
		});
		const s = store.getSession("exec-1");
		expect(s!.pr_number).toBe(77);
		expect(s!.session_stage).toBe("pr_created");
		expect(s!.stage_updated_at).toBe("2026-03-30 14:00:00");
		expect(s!.status).toBe("awaiting_review");
	});

	it("patchSessionMetadata writes pr_number, session_stage, stage_updated_at", () => {
		store.upsertSession(makeSession());
		store.patchSessionMetadata("exec-1", {
			pr_number: 55,
			session_stage: "code_review",
			stage_updated_at: "2026-03-30 15:00:00",
		});
		const s = store.getSession("exec-1");
		expect(s!.pr_number).toBe(55);
		expect(s!.session_stage).toBe("code_review");
		expect(s!.stage_updated_at).toBe("2026-03-30 15:00:00");
	});

	it("patchSessionMetadata does not overwrite unmentioned fields", () => {
		store.upsertSession(
			makeSession({
				pr_number: 10,
				session_stage: "implement",
				stage_updated_at: "2026-03-30 10:00:00",
			}),
		);
		// Patch only session_stage
		store.patchSessionMetadata("exec-1", { session_stage: "test" });
		const s = store.getSession("exec-1");
		expect(s!.pr_number).toBe(10);
		expect(s!.session_stage).toBe("test");
		// stage_updated_at was not in the patch, should be unchanged
		expect(s!.stage_updated_at).toBe("2026-03-30 10:00:00");
	});

	it("rowToSession returns pr_number, session_stage, stage_updated_at", () => {
		store.upsertSession(
			makeSession({
				pr_number: 123,
				session_stage: "ship",
				stage_updated_at: "2026-03-30 16:00:00",
			}),
		);
		const s = store.getSession("exec-1");
		expect(s).toBeDefined();
		expect(s!.pr_number).toBe(123);
		expect(s!.session_stage).toBe("ship");
		expect(s!.stage_updated_at).toBe("2026-03-30 16:00:00");
	});

	it("rowToSession returns undefined for null pr_number/session_stage/stage_updated_at", () => {
		store.upsertSession(makeSession());
		const s = store.getSession("exec-1");
		expect(s!.pr_number).toBeUndefined();
		expect(s!.session_stage).toBeUndefined();
		expect(s!.stage_updated_at).toBeUndefined();
	});
});
