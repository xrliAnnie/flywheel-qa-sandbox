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

	it("upsertThread + getThreadIssue round-trip", () => {
		store.upsertThread("1234.5678", "C07XXX", "GEO-95");
		const issueId = store.getThreadIssue("1234.5678");
		expect(issueId).toBe("GEO-95");
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

	// --- v1.0 Phase 1: thread_id ---

	it("upsertSession stores and retrieves thread_id", () => {
		store.upsertSession(makeSession({ thread_id: "1234.5678" }));
		const s = store.getSession("exec-1");
		expect(s!.thread_id).toBe("1234.5678");
	});

	it("upsertSession preserves thread_id via COALESCE on update", () => {
		store.upsertSession(makeSession({ thread_id: "1234.5678" }));
		// Update without thread_id — should preserve existing value
		store.upsertSession(makeSession({ status: "awaiting_review" }));
		const s = store.getSession("exec-1");
		expect(s!.thread_id).toBe("1234.5678");
		expect(s!.status).toBe("awaiting_review");
	});

	it("setSessionThreadId updates only the thread field", () => {
		store.upsertSession(makeSession());
		store.setSessionThreadId("exec-1", "9999.1111");
		const s = store.getSession("exec-1");
		expect(s!.thread_id).toBe("9999.1111");
		expect(s!.status).toBe("running"); // unchanged
	});

	it("setSessionThreadId is no-op if session does not exist", () => {
		// Should not throw
		store.setSessionThreadId("nonexistent", "1234.5678");
	});

	// --- v1.0 Phase 1: getThreadByIssue ---

	it("getThreadByIssue returns thread for known issue", () => {
		store.upsertThread("1234.5678", "C07XXX", "GEO-42");
		const thread = store.getThreadByIssue("GEO-42");
		expect(thread).toBeDefined();
		expect(thread!.thread_id).toBe("1234.5678");
		expect(thread!.channel).toBe("C07XXX");
	});

	it("getThreadByIssue returns undefined for unknown issue", () => {
		expect(store.getThreadByIssue("UNKNOWN-1")).toBeUndefined();
	});

	it("getThreadByIssue returns updated thread after re-upsert", () => {
		store.upsertThread("old.1111", "C07XXX", "GEO-42");
		store.upsertThread("new.2222", "C07YYY", "GEO-42");
		const thread = store.getThreadByIssue("GEO-42");
		expect(thread!.thread_id).toBe("new.2222");
		expect(thread!.channel).toBe("C07YYY");
	});

	// --- v1.0 Phase 1: upsertThread one-issue-one-thread ---

	it("upsertThread replaces old thread for same issue", () => {
		store.upsertThread("old.1111", "C07XXX", "GEO-42");
		store.upsertThread("new.2222", "C07XXX", "GEO-42");
		// Old thread should be gone
		expect(store.getThreadIssue("old.1111")).toBeUndefined();
		// New thread maps to the issue
		expect(store.getThreadIssue("new.2222")).toBe("GEO-42");
	});

	it("upsertThread handles same thread_id + same issue (idempotent)", () => {
		store.upsertThread("1234.5678", "C07XXX", "GEO-42");
		store.upsertThread("1234.5678", "C07XXX", "GEO-42");
		expect(store.getThreadIssue("1234.5678")).toBe("GEO-42");
	});

	// --- v1.0 Phase 1: migration cleans duplicate threads ---

	it("migrate cleans up duplicate issue_id entries in conversation_threads", async () => {
		// Manually insert duplicate records bypassing upsertThread
		store.db.run(
			"INSERT INTO conversation_threads (thread_id, channel, issue_id) VALUES ('ts1', 'C1', 'GEO-99')",
		);
		// Temporarily drop the unique index so we can insert a duplicate
		store.db.run("DROP INDEX IF EXISTS idx_threads_issue");
		store.db.run(
			"INSERT INTO conversation_threads (thread_id, channel, issue_id) VALUES ('ts2', 'C1', 'GEO-99')",
		);
		// Re-run migrate — should clean up and recreate index
		store.migrate();
		// Should have exactly one record for GEO-99 (the one with higher rowid = ts2)
		const thread = store.getThreadByIssue("GEO-99");
		expect(thread).toBeDefined();
		expect(thread!.thread_id).toBe("ts2");
		// Old one should be gone
		expect(store.getThreadIssue("ts1")).toBeUndefined();
	});

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

	it("fresh DB creates thread_id column directly (case a)", async () => {
		// Fresh DB — DDL has thread_id, no migration needed
		const fresh = await StateStore.create(":memory:");
		fresh.upsertSession(makeSession({ thread_id: "fresh-thread-123" }));
		const s = fresh.getSession("exec-1");
		expect(s!.thread_id).toBe("fresh-thread-123");

		// conversation_threads also uses thread_id
		fresh.upsertThread("ct-fresh-123", "C07XXX", "GEO-95");
		const thread = fresh.getThreadByIssue("GEO-95");
		expect(thread!.thread_id).toBe("ct-fresh-123");
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

		// Verify columns were renamed and data cleared (user_version < 2)
		const s = store2.getSession("e1");
		expect(s).toBeDefined();
		// thread_id should be NULL after cutover cleanup
		expect(s!.thread_id).toBeUndefined();

		// conversation_threads should be empty after cutover cleanup
		const thread = store2.getThreadByIssue("i1");
		expect(thread).toBeUndefined();

		// Can insert new data with thread_id
		store2.setSessionThreadId("e1", "new-discord-id");
		expect(store2.getSession("e1")!.thread_id).toBe("new-discord-id");

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

		// Run migration — should ADD thread_id column
		store2.migrate();

		// Verify thread_id column exists and works
		store2.setSessionThreadId("e1", "added-thread-id");
		expect(store2.getSession("e1")!.thread_id).toBe("added-thread-id");

		store2.close();
	});

	const toSqlite3 = (d: Date) =>
		d
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");
	it("getEligibleForCleanup returns completed beyond threshold", () => {
		const past = toSqlite3(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				issue_id: "GEO-100",
				status: "completed",
				started_at: past,
				last_activity_at: past,
			}),
		);
		store.upsertThread("thread-100", "CH1", "GEO-100");
		expect(store.getEligibleForCleanup(1440)).toHaveLength(1);
	});
	it("getEligibleForCleanup excludes failed", () => {
		const past = toSqlite3(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				issue_id: "GEO-100",
				status: "failed",
				started_at: past,
				last_activity_at: past,
			}),
		);
		store.upsertThread("thread-100", "CH1", "GEO-100");
		expect(store.getEligibleForCleanup(1440)).toHaveLength(0);
	});
	it("getEligibleForCleanup excludes archived", () => {
		const past = toSqlite3(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				issue_id: "GEO-100",
				status: "completed",
				started_at: past,
				last_activity_at: past,
			}),
		);
		store.upsertThread("thread-100", "CH1", "GEO-100");
		store.markArchived("thread-100");
		expect(store.getEligibleForCleanup(1440)).toHaveLength(0);
	});
	it("markArchived + clearArchived cycle", () => {
		const past = toSqlite3(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession(
			makeSession({
				execution_id: "e1",
				issue_id: "GEO-100",
				status: "completed",
				started_at: past,
				last_activity_at: past,
			}),
		);
		store.upsertThread("thread-100", "CH1", "GEO-100");
		store.markArchived("thread-100");
		expect(store.getEligibleForCleanup(1440)).toHaveLength(0);
		store.clearArchived("thread-100");
		expect(store.getEligibleForCleanup(1440)).toHaveLength(1);
	});
});
