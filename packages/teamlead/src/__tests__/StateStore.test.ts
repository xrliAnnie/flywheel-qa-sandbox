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
});
