import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-887: StateStore queries backing the three-stage keep-alive orchestrator —
 * (1) `getPhaseSessionsForIssue` returns ALL phase sessions (design/implement/qa
 * by `chat_thread_role`) for an issue so the ship-time finalizer can close the
 * parked design + implement sessions; (2) `countEventsByIssueAndType` is the
 * durable, replay-idempotent fix-round ledger (a fix round no longer spawns a
 * new implement session, so the old session-count no longer grows).
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function seedSession(
	store: StateStore,
	over: {
		execution_id: string;
		issue_id: string;
		status?: string;
		session_role?: string;
		chat_thread_role?: string;
	},
): void {
	store.upsertSession({
		execution_id: over.execution_id,
		issue_id: over.issue_id,
		project_name: "flywheel",
		status: over.status ?? "running",
		session_role: over.session_role,
		chat_thread_role: over.chat_thread_role,
	});
}

describe("getPhaseSessionsForIssue (FLY-887)", () => {
	it("returns design/implement/qa phase sessions for the issue", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "d",
			issue_id: "FLY-1",
			chat_thread_role: "design",
			status: "design_done",
		});
		seedSession(store, {
			execution_id: "i",
			issue_id: "FLY-1",
			chat_thread_role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, {
			execution_id: "q",
			issue_id: "FLY-1",
			chat_thread_role: "qa",
			status: "running",
		});
		const rows = store.getPhaseSessionsForIssue("FLY-1");
		expect(rows.map((r) => r.execution_id).sort()).toEqual(["d", "i", "q"]);
	});

	it("excludes single-session / auto-QA rows (chat_thread_role='main')", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "main-1",
			issue_id: "FLY-1",
			chat_thread_role: "main",
		});
		// an auto-QA session carries session_role='qa' but chat_thread_role='main'
		seedSession(store, {
			execution_id: "autoqa-1",
			issue_id: "FLY-1",
			session_role: "qa",
			chat_thread_role: "main",
		});
		expect(store.getPhaseSessionsForIssue("FLY-1")).toEqual([]);
	});

	it("does not leak across issues", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "d1",
			issue_id: "FLY-1",
			chat_thread_role: "design",
		});
		seedSession(store, {
			execution_id: "d2",
			issue_id: "FLY-2",
			chat_thread_role: "design",
		});
		const rows = store.getPhaseSessionsForIssue("FLY-1");
		expect(rows.map((r) => r.execution_id)).toEqual(["d1"]);
	});

	it("includes terminal phase sessions too (caller filters by status)", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "d",
			issue_id: "FLY-1",
			chat_thread_role: "design",
			status: "completed",
		});
		expect(
			store.getPhaseSessionsForIssue("FLY-1").map((r) => r.status),
		).toEqual(["completed"]);
	});
});

describe("countEventsByIssueAndType (FLY-887 fix-round ledger)", () => {
	it("counts only events of the requested type for the issue", async () => {
		const store = await freshStore();
		store.insertEvent({
			event_id: "fr-1",
			execution_id: "q",
			issue_id: "FLY-1",
			project_name: "flywheel",
			event_type: "three_stage_fix_round",
			source: "test",
		});
		store.insertEvent({
			event_id: "fr-2",
			execution_id: "q",
			issue_id: "FLY-1",
			project_name: "flywheel",
			event_type: "three_stage_fix_round",
			source: "test",
		});
		// a different event type must not be counted
		store.insertEvent({
			event_id: "qa-1",
			execution_id: "q",
			issue_id: "FLY-1",
			project_name: "flywheel",
			event_type: "qa_result",
			source: "test",
		});
		expect(
			store.countEventsByIssueAndType("FLY-1", "three_stage_fix_round"),
		).toBe(2);
		expect(store.countEventsByIssueAndType("FLY-1", "qa_result")).toBe(1);
	});

	it("is replay-idempotent — a duplicate event_id is not double-counted", async () => {
		const store = await freshStore();
		expect(
			store.insertEvent({
				event_id: "fr-1",
				execution_id: "q",
				issue_id: "FLY-1",
				project_name: "flywheel",
				event_type: "three_stage_fix_round",
				source: "test",
			}),
		).toBe(true);
		// same event_id replayed → UNIQUE constraint → false, no new row
		expect(
			store.insertEvent({
				event_id: "fr-1",
				execution_id: "q",
				issue_id: "FLY-1",
				project_name: "flywheel",
				event_type: "three_stage_fix_round",
				source: "test",
			}),
		).toBe(false);
		expect(
			store.countEventsByIssueAndType("FLY-1", "three_stage_fix_round"),
		).toBe(1);
	});

	it("returns 0 for an issue with no such events", async () => {
		const store = await freshStore();
		expect(
			store.countEventsByIssueAndType("FLY-404", "three_stage_fix_round"),
		).toBe(0);
	});
});
