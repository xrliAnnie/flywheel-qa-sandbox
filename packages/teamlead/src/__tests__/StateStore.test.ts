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

// ── FLY-369: chat_threads archived_at — archive-once mark + lead_id readback ──
describe("StateStore — FLY-369 chat thread archival", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("getChatThreadByIssue returns lead_id + null archived_at for a fresh thread", () => {
		store.upsertChatThread("t-1", "ch-1", "FLY-100", "lead-a");
		expect(store.getChatThreadByIssue("FLY-100", "ch-1")).toEqual({
			thread_id: "t-1",
			channel_id: "ch-1",
			lead_id: "lead-a",
			archived_at: null,
		});
	});

	it("markChatThreadArchived sets archived_at (archive-once record)", () => {
		store.upsertChatThread("t-1", "ch-1", "FLY-100", "lead-a");
		expect(
			store.getChatThreadByIssue("FLY-100", "ch-1")?.archived_at,
		).toBeNull();

		store.markChatThreadArchived("t-1");
		expect(
			store.getChatThreadByIssue("FLY-100", "ch-1")?.archived_at,
		).toBeTruthy();
	});

	it("archived_at column survives a legacy DB without it (migration)", async () => {
		const path = "/tmp/fly369-legacy-chat-threads.sqlite";
		try {
			const fs = await import("node:fs");
			const initSqlJs = (await import("sql.js")).default;
			const SQL = await initSqlJs();
			const seed = new SQL.Database();
			// Legacy chat_threads WITHOUT archived_at (pre-FLY-369 schema)
			seed.run(`CREATE TABLE chat_threads (
				thread_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				issue_id TEXT,
				lead_id TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				discord_missing_at TEXT
			)`);
			seed.run(
				"INSERT INTO chat_threads (thread_id, channel_id, issue_id, lead_id) VALUES (?, ?, ?, ?)",
				["legacy-1", "ch-1", "FLY-99", "lead-a"],
			);
			fs.writeFileSync(path, Buffer.from(seed.export()));
			seed.close();

			const migrated = await StateStore.create(path);
			// archived_at column now exists; legacy row reads back with null archived_at
			expect(
				migrated.getChatThreadByIssue("FLY-99", "ch-1")?.archived_at,
			).toBeNull();
			// and mark works on the migrated DB
			migrated.markChatThreadArchived("legacy-1");
			expect(
				migrated.getChatThreadByIssue("FLY-99", "ch-1")?.archived_at,
			).toBeTruthy();
		} finally {
			try {
				const fs = await import("node:fs");
				fs.unlinkSync(path);
			} catch {}
		}
	});
});

// ── FLY-195: stuck-episode disposition receipts (plan §3.4) ──
describe("StateStore — stuck dispositions (FLY-195)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("returns undefined when no disposition exists", () => {
		expect(
			store.getStuckDisposition("exec-1", "aaaaaaaaaaaaaaaa"),
		).toBeUndefined();
	});

	it("writes and reads back a disposition", () => {
		store.setStuckDisposition({
			execution_id: "exec-1",
			episode_fingerprint: "aaaaaaaaaaaaaaaa",
			disposition: "false_positive",
			noted_by: "product-lead",
			note: "runner was mid long build",
		});
		const row = store.getStuckDisposition("exec-1", "aaaaaaaaaaaaaaaa");
		expect(row).toBeDefined();
		expect(row!.disposition).toBe("false_positive");
		expect(row!.noted_by).toBe("product-lead");
		expect(row!.snooze_until_ms).toBeNull();
	});

	it("is keyed per (execution, fingerprint) — other episodes unaffected", () => {
		store.setStuckDisposition({
			execution_id: "exec-1",
			episode_fingerprint: "aaaaaaaaaaaaaaaa",
			disposition: "legitimate_wait",
		});
		expect(
			store.getStuckDisposition("exec-1", "bbbbbbbbbbbbbbbb"),
		).toBeUndefined();
		expect(
			store.getStuckDisposition("exec-2", "aaaaaaaaaaaaaaaa"),
		).toBeUndefined();
	});

	it("upserts: a later write replaces the disposition (snooze → false_positive)", () => {
		store.setStuckDisposition({
			execution_id: "exec-1",
			episode_fingerprint: "aaaaaaaaaaaaaaaa",
			disposition: "snooze",
			snooze_until_ms: 1_000_000,
		});
		expect(
			store.getStuckDisposition("exec-1", "aaaaaaaaaaaaaaaa")!.snooze_until_ms,
		).toBe(1_000_000);
		store.setStuckDisposition({
			execution_id: "exec-1",
			episode_fingerprint: "aaaaaaaaaaaaaaaa",
			disposition: "false_positive",
		});
		const row = store.getStuckDisposition("exec-1", "aaaaaaaaaaaaaaaa");
		expect(row!.disposition).toBe("false_positive");
		expect(row!.snooze_until_ms).toBeNull();
	});

	it("rejects an invalid disposition value", () => {
		expect(() =>
			store.setStuckDisposition({
				execution_id: "exec-1",
				episode_fingerprint: "aaaaaaaaaaaaaaaa",
				// @ts-expect-error invalid on purpose
				disposition: "approve_everything",
			}),
		).toThrow(/Invalid stuck disposition/);
	});

	it("survives a save/reload cycle (durable for Q7 re-read)", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join: joinPath } = await import("node:path");
		const dir = mkdtempSync(joinPath(tmpdir(), "fly195-"));
		const dbPath = joinPath(dir, "state.db");
		const s1 = await StateStore.create(dbPath);
		s1.setStuckDisposition({
			execution_id: "exec-9",
			episode_fingerprint: "cccccccccccccccc",
			disposition: "needs_founder",
			noted_by: "ops-lead",
		});
		s1.close();
		const s2 = await StateStore.create(dbPath);
		const row = s2.getStuckDisposition("exec-9", "cccccccccccccccc");
		expect(row?.disposition).toBe("needs_founder");
		s2.close();
	});
});

// ── FLY-253: execution-scoped latch storage ('*' sentinel rows) ──
describe("StateStore — FLY-253 stuck disposition rows / latch / consume", () => {
	let store: StateStore;
	const FP = "aaaaaaaaaaaaaaaa";
	const NOW = 1_000_000_000_000;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	const writeExact = (over: Record<string, unknown> = {}) =>
		store.setStuckDisposition({
			execution_id: "exec-1",
			episode_fingerprint: FP,
			disposition: "false_positive",
			...over,
		});
	const writeSentinel = (over: Record<string, unknown> = {}) =>
		store.setStuckDisposition({
			execution_id: "exec-1",
			episode_fingerprint: "*",
			disposition: "legitimate_wait",
			...over,
		});

	describe("getStuckDispositionRows", () => {
		it("returns empty when nothing exists", () => {
			const rows = store.getStuckDispositionRows("exec-1", FP);
			expect(rows.exact).toBeUndefined();
			expect(rows.sentinel).toBeUndefined();
		});

		it("returns the exact row only", () => {
			writeExact();
			const rows = store.getStuckDispositionRows("exec-1", FP);
			expect(rows.exact?.disposition).toBe("false_positive");
			expect(rows.sentinel).toBeUndefined();
		});

		it("returns the sentinel row only", () => {
			writeSentinel();
			const rows = store.getStuckDispositionRows("exec-1", FP);
			expect(rows.exact).toBeUndefined();
			expect(rows.sentinel?.disposition).toBe("legitimate_wait");
			expect(rows.sentinel?.episode_fingerprint).toBe("*");
		});

		it("returns both when both exist; other executions unaffected", () => {
			writeExact();
			writeSentinel();
			const rows = store.getStuckDispositionRows("exec-1", FP);
			expect(rows.exact?.disposition).toBe("false_positive");
			expect(rows.sentinel?.disposition).toBe("legitimate_wait");
			const other = store.getStuckDispositionRows("exec-2", FP);
			expect(other.exact).toBeUndefined();
			expect(other.sentinel).toBeUndefined();
		});

		it("sentinel applies to ANY fingerprint of the execution", () => {
			writeSentinel();
			const rows = store.getStuckDispositionRows("exec-1", "bbbbbbbbbbbbbbbb");
			expect(rows.sentinel?.disposition).toBe("legitimate_wait");
		});
	});

	describe("clearExecutionStuckReceipts (re_arm)", () => {
		it("deletes the sentinel AND episode rows (Codex code R1 HIGH-1: a residual effective exact row must not survive re_arm)", () => {
			writeExact();
			writeSentinel();
			store.clearExecutionStuckReceipts("exec-1");
			const rows = store.getStuckDispositionRows("exec-1", FP);
			expect(rows.sentinel).toBeUndefined();
			expect(rows.exact).toBeUndefined();
		});

		it("is a no-op when nothing exists, and scoped to the execution", () => {
			store.setStuckDisposition({
				execution_id: "exec-2",
				episode_fingerprint: FP,
				disposition: "false_positive",
			});
			expect(() => store.clearExecutionStuckReceipts("exec-1")).not.toThrow();
			expect(store.getStuckDispositionRows("exec-2", FP).exact).toBeDefined();
		});
	});

	describe("consumeExpiredStuckDispositions (one-shot reminder token)", () => {
		it("deletes expired exact AND expired sentinel together", () => {
			writeExact({ disposition: "snooze", snooze_until_ms: NOW - 1 });
			writeSentinel({
				disposition: "legitimate_wait",
				snooze_until_ms: NOW - 5,
			});
			store.consumeExpiredStuckDispositions("exec-1", FP, NOW);
			const rows = store.getStuckDispositionRows("exec-1", FP);
			expect(rows.exact).toBeUndefined();
			expect(rows.sentinel).toBeUndefined();
		});

		it("keeps future-dated rows (concurrent Lead refresh survives)", () => {
			writeSentinel({ disposition: "snooze", snooze_until_ms: NOW + 60_000 });
			store.consumeExpiredStuckDispositions("exec-1", FP, NOW);
			expect(
				store.getStuckDispositionRows("exec-1", FP).sentinel,
			).toBeDefined();
		});

		it("keeps untimed rows (NULL snooze_until_ms is a terminal receipt, never consumed)", () => {
			writeExact(); // false_positive, NULL
			writeSentinel(); // legitimate_wait permanent (TTL=0)
			store.consumeExpiredStuckDispositions("exec-1", FP, NOW);
			const rows = store.getStuckDispositionRows("exec-1", FP);
			expect(rows.exact).toBeDefined();
			expect(rows.sentinel).toBeDefined();
		});

		it("boundary: snooze_until_ms == now is expired (<=) and consumed", () => {
			writeSentinel({ disposition: "snooze", snooze_until_ms: NOW });
			store.consumeExpiredStuckDispositions("exec-1", FP, NOW);
			expect(
				store.getStuckDispositionRows("exec-1", FP).sentinel,
			).toBeUndefined();
		});

		it("does not touch other fingerprints or executions", () => {
			store.setStuckDisposition({
				execution_id: "exec-1",
				episode_fingerprint: "bbbbbbbbbbbbbbbb",
				disposition: "snooze",
				snooze_until_ms: NOW - 1,
			});
			store.setStuckDisposition({
				execution_id: "exec-2",
				episode_fingerprint: FP,
				disposition: "snooze",
				snooze_until_ms: NOW - 1,
			});
			store.consumeExpiredStuckDispositions("exec-1", FP, NOW);
			expect(
				store.getStuckDispositionRows("exec-1", "bbbbbbbbbbbbbbbb").exact,
			).toBeDefined();
			expect(store.getStuckDispositionRows("exec-2", FP).exact).toBeDefined();
		});
	});
});

// FLY-205 — doc_tier + issue_url persistence: BOTH write paths must round-trip
// (Codex design R3 #2: a column reachable from the type but missing from a
// handwritten SQL list would silently not persist).
describe("FLY-205 — doc_tier / issue_url persistence", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("upsertSession write path round-trips doc_tier + issue_url", () => {
		store.upsertSession({
			execution_id: "e-205-a",
			issue_id: "LEARN-21",
			project_name: "sub",
			status: "running",
			doc_tier: "plan_only",
			issue_url: "https://linear.app/x/issue/LEARN-21",
		});
		const s = store.getSession("e-205-a");
		expect(s?.doc_tier).toBe("plan_only");
		expect(s?.issue_url).toBe("https://linear.app/x/issue/LEARN-21");
	});

	it("patchSessionMetadata write path round-trips doc_tier + issue_url", () => {
		store.upsertSession({
			execution_id: "e-205-b",
			issue_id: "LEARN-22",
			project_name: "sub",
			status: "running",
		});
		store.patchSessionMetadata("e-205-b", {
			doc_tier: "none",
			issue_url: "https://linear.app/x/issue/LEARN-22",
		});
		const s = store.getSession("e-205-b");
		expect(s?.doc_tier).toBe("none");
		expect(s?.issue_url).toBe("https://linear.app/x/issue/LEARN-22");
	});

	it("persistTransition write path round-trips doc_tier + issue_url", () => {
		store.persistTransition("e-205-c", "running", {
			issue_id: "LEARN-23",
			project_name: "sub",
			doc_tier: "full",
			issue_url: "https://linear.app/x/issue/LEARN-23",
		});
		const s = store.getSession("e-205-c");
		expect(s?.doc_tier).toBe("full");
		expect(s?.issue_url).toBe("https://linear.app/x/issue/LEARN-23");
	});

	it("values survive file-backed close/reopen (migration column is real)", async () => {
		const dbPath = `/tmp/fly205-statestore-test-${Date.now()}.db`;
		const s1 = await StateStore.create(dbPath);
		s1.upsertSession({
			execution_id: "e-205-d",
			issue_id: "LEARN-24",
			project_name: "sub",
			status: "running",
			doc_tier: "plan_only",
			issue_url: "https://linear.app/x/issue/LEARN-24",
		});
		s1.close();
		const s2 = await StateStore.create(dbPath);
		const s = s2.getSession("e-205-d");
		expect(s?.doc_tier).toBe("plan_only");
		expect(s?.issue_url).toBe("https://linear.app/x/issue/LEARN-24");
		s2.close();
	});

	it("COALESCE semantics: later upsert without tier does not clobber stored tier", () => {
		store.upsertSession({
			execution_id: "e-205-e",
			issue_id: "LEARN-25",
			project_name: "sub",
			status: "running",
			doc_tier: "none",
		});
		// e.g. a heartbeat-ish upsert that doesn't carry doc_tier
		store.upsertSession({
			execution_id: "e-205-e",
			issue_id: "LEARN-25",
			project_name: "sub",
			status: "running",
		});
		expect(store.getSession("e-205-e")?.doc_tier).toBe("none");
	});
});

describe("StateStore — FLY-245 D-a lifecycle_revision (monotonic freshness)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("a new session starts at revision 0", () => {
		store.upsertSession(makeSession({ status: "running" }));
		expect(store.getLifecycleRevision("exec-1")).toBe(0);
		expect(store.getSession("exec-1")?.lifecycle_revision).toBe(0);
	});

	it("upsertSession bumps the revision on a genuine status CHANGE", () => {
		store.upsertSession(makeSession({ status: "running" }));
		store.upsertSession(makeSession({ status: "awaiting_review" }));
		expect(store.getLifecycleRevision("exec-1")).toBe(1);
		store.upsertSession(makeSession({ status: "blocked" }));
		expect(store.getLifecycleRevision("exec-1")).toBe(2);
	});

	it("a same-status re-upsert does NOT inflate the revision", () => {
		store.upsertSession(makeSession({ status: "running" }));
		store.upsertSession(makeSession({ status: "running", summary: "x" }));
		store.upsertSession(makeSession({ status: "running", summary: "y" }));
		expect(store.getLifecycleRevision("exec-1")).toBe(0);
	});

	it("persistTransition (FSM path) bumps on a transition", () => {
		store.upsertSession(makeSession({ status: "running" }));
		store.persistTransition("exec-1", "awaiting_review", {
			issue_id: "GEO-95",
			project_name: "geoforge3d",
		});
		expect(store.getLifecycleRevision("exec-1")).toBe(1);
	});

	it("forceStatus (legacy path) is NOT a hole — it bumps too", () => {
		store.upsertSession(makeSession({ status: "running" }));
		store.forceStatus("exec-1", "blocked", new Date(0).toISOString());
		expect(store.getLifecycleRevision("exec-1")).toBe(1);
	});

	it("status leaving and RETURNING to the same value keeps climbing (the freshness point)", () => {
		// running → blocked → running: status returns to 'running' but revision is
		// now 2, so a confirmation snapshotted at revision 0 is stale.
		const f = { issue_id: "GEO-95", project_name: "geoforge3d" };
		store.upsertSession(makeSession({ status: "running" }));
		store.persistTransition("exec-1", "blocked", f);
		store.persistTransition("exec-1", "running", f);
		expect(store.getLifecycleRevision("exec-1")).toBe(2);
	});

	it("getLifecycleRevision is 0 for an absent session", () => {
		expect(store.getLifecycleRevision("nope")).toBe(0);
	});
});
