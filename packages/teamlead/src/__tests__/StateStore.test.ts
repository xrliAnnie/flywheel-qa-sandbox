import { describe, expect, it, beforeEach } from "vitest";
import { StateStore } from "../StateStore.js";
import type { SessionEvent, SessionUpsert } from "../StateStore.js";

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
		store2["migrate"]();
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
		store.upsertSession(makeSession({ status: "awaiting_review", decision_route: "needs_review" }));
		const s = store.getSession("exec-1");
		expect(s!.status).toBe("awaiting_review");
		expect(s!.decision_route).toBe("needs_review");
	});

	it("getActiveSessions returns only running/awaiting_review", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		store.upsertSession(makeSession({ execution_id: "e2", status: "awaiting_review" }));
		store.upsertSession(makeSession({ execution_id: "e3", status: "failed" }));
		store.upsertSession(makeSession({ execution_id: "e4", status: "completed" }));

		const active = store.getActiveSessions();
		expect(active).toHaveLength(2);
		const ids = active.map(s => s.execution_id).sort();
		expect(ids).toEqual(["e1", "e2"]);
	});

	it("getStuckSessions returns sessions with old last_activity_at", () => {
		// Use SQLite datetime format (YYYY-MM-DD HH:MM:SS) — no T/Z
		const toSqlite = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

		// Insert a session with activity 30 min ago
		store.upsertSession(makeSession({
			execution_id: "stuck-1",
			status: "running",
			last_activity_at: toSqlite(new Date(Date.now() - 30 * 60 * 1000)),
		}));
		// Insert a session with recent activity
		store.upsertSession(makeSession({
			execution_id: "recent-1",
			status: "running",
			last_activity_at: toSqlite(new Date()),
		}));

		const stuck = store.getStuckSessions(15);
		const stuckIds = stuck.map(s => s.execution_id);
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

	// --- v1.0 Phase 1: slack_thread_ts ---

	it("upsertSession stores and retrieves slack_thread_ts", () => {
		store.upsertSession(makeSession({ slack_thread_ts: "1234.5678" }));
		const s = store.getSession("exec-1");
		expect(s!.slack_thread_ts).toBe("1234.5678");
	});

	it("upsertSession preserves slack_thread_ts via COALESCE on update", () => {
		store.upsertSession(makeSession({ slack_thread_ts: "1234.5678" }));
		// Update without slack_thread_ts — should preserve existing value
		store.upsertSession(makeSession({ status: "awaiting_review" }));
		const s = store.getSession("exec-1");
		expect(s!.slack_thread_ts).toBe("1234.5678");
		expect(s!.status).toBe("awaiting_review");
	});

	it("setSessionThreadTs updates only the thread field", () => {
		store.upsertSession(makeSession());
		store.setSessionThreadTs("exec-1", "9999.1111");
		const s = store.getSession("exec-1");
		expect(s!.slack_thread_ts).toBe("9999.1111");
		expect(s!.status).toBe("running"); // unchanged
	});

	it("setSessionThreadTs is no-op if session does not exist", () => {
		// Should not throw
		store.setSessionThreadTs("nonexistent", "1234.5678");
	});

	// --- v1.0 Phase 1: getThreadByIssue ---

	it("getThreadByIssue returns thread for known issue", () => {
		store.upsertThread("1234.5678", "C07XXX", "GEO-42");
		const thread = store.getThreadByIssue("GEO-42");
		expect(thread).toBeDefined();
		expect(thread!.thread_ts).toBe("1234.5678");
		expect(thread!.channel).toBe("C07XXX");
	});

	it("getThreadByIssue returns undefined for unknown issue", () => {
		expect(store.getThreadByIssue("UNKNOWN-1")).toBeUndefined();
	});

	it("getThreadByIssue returns updated thread after re-upsert", () => {
		store.upsertThread("old.1111", "C07XXX", "GEO-42");
		store.upsertThread("new.2222", "C07YYY", "GEO-42");
		const thread = store.getThreadByIssue("GEO-42");
		expect(thread!.thread_ts).toBe("new.2222");
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

	it("upsertThread handles same thread_ts + same issue (idempotent)", () => {
		store.upsertThread("1234.5678", "C07XXX", "GEO-42");
		store.upsertThread("1234.5678", "C07XXX", "GEO-42");
		expect(store.getThreadIssue("1234.5678")).toBe("GEO-42");
	});

	// --- v1.0 Phase 1: migration cleans duplicate threads ---

	it("migrate cleans up duplicate issue_id entries in conversation_threads", async () => {
		// Manually insert duplicate records bypassing upsertThread
		store["db"].run(
			"INSERT INTO conversation_threads (thread_ts, channel, issue_id) VALUES ('ts1', 'C1', 'GEO-99')",
		);
		// Temporarily drop the unique index so we can insert a duplicate
		store["db"].run("DROP INDEX IF EXISTS idx_threads_issue");
		store["db"].run(
			"INSERT INTO conversation_threads (thread_ts, channel, issue_id) VALUES ('ts2', 'C1', 'GEO-99')",
		);
		// Re-run migrate — should clean up and recreate index
		store.migrate();
		// Should have exactly one record for GEO-99 (the one with higher rowid = ts2)
		const thread = store.getThreadByIssue("GEO-99");
		expect(thread).toBeDefined();
		expect(thread!.thread_ts).toBe("ts2");
		// Old one should be gone
		expect(store.getThreadIssue("ts1")).toBeUndefined();
	});

	// --- v1.0 Phase 1: getLatestSessionByIssueAndStatuses ---

	it("getLatestSessionByIssueAndStatuses returns matching session", () => {
		store.upsertSession(makeSession({
			execution_id: "e1", status: "awaiting_review",
			last_activity_at: "2024-01-01 10:00:00",
		}));
		store.upsertSession(makeSession({
			execution_id: "e2", status: "failed",
			last_activity_at: "2024-01-01 11:00:00",
		}));
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", ["awaiting_review"]);
		expect(s).toBeDefined();
		expect(s!.execution_id).toBe("e1");
	});

	it("getLatestSessionByIssueAndStatuses returns latest when multiple match", () => {
		store.upsertSession(makeSession({
			execution_id: "e1", status: "awaiting_review",
			last_activity_at: "2024-01-01 10:00:00",
		}));
		store.upsertSession(makeSession({
			execution_id: "e2", status: "awaiting_review",
			last_activity_at: "2024-01-01 12:00:00",
		}));
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", ["awaiting_review"]);
		expect(s!.execution_id).toBe("e2");
	});

	it("getLatestSessionByIssueAndStatuses returns undefined for no match", () => {
		store.upsertSession(makeSession({ execution_id: "e1", status: "running" }));
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", ["awaiting_review", "blocked"]);
		expect(s).toBeUndefined();
	});

	it("getLatestSessionByIssueAndStatuses with empty statuses returns undefined", () => {
		store.upsertSession(makeSession());
		expect(store.getLatestSessionByIssueAndStatuses("GEO-95", [])).toBeUndefined();
	});

	it("getLatestSessionByIssueAndStatuses matches multiple statuses", () => {
		store.upsertSession(makeSession({
			execution_id: "e1", status: "blocked",
			last_activity_at: "2024-01-01 10:00:00",
		}));
		const s = store.getLatestSessionByIssueAndStatuses("GEO-95", ["awaiting_review", "blocked"]);
		expect(s).toBeDefined();
		expect(s!.execution_id).toBe("e1");
	});
});
