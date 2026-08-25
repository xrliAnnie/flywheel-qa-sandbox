import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-887: StateStore queries backing the DAG workflow keep-alive orchestrator —
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
		workflow_node_id?: string;
	},
): void {
	store.upsertSession({
		execution_id: over.execution_id,
		issue_id: over.issue_id,
		project_name: "flywheel",
		status: over.status ?? "running",
		session_role: over.session_role,
		chat_thread_role: over.chat_thread_role,
		workflow_node_id: over.workflow_node_id,
	});
}

describe("getWorkflowManagedSessionsForIssue (FLY-2027)", () => {
	it("adds workflow-bound main actors without changing the phase query", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "phase",
			issue_id: "FLY-1",
			chat_thread_role: "implement",
		});
		seedSession(store, {
			execution_id: "generic",
			issue_id: "FLY-1",
			chat_thread_role: "main",
			workflow_node_id: "execute",
		});
		seedSession(store, {
			execution_id: "review",
			issue_id: "FLY-1",
			chat_thread_role: "main",
			workflow_node_id: "review",
		});
		seedSession(store, {
			execution_id: "ordinary-main",
			issue_id: "FLY-1",
			chat_thread_role: "main",
		});

		expect(
			store
				.getWorkflowManagedSessionsForIssue("FLY-1")
				.map((row) => row.execution_id)
				.sort(),
		).toEqual(["generic", "phase", "review"]);
		expect(
			store.getPhaseSessionsForIssue("FLY-1").map((row) => row.execution_id),
		).toEqual(["phase"]);
	});
});

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

	// FLY-939 (Codex design R1 #2): rows sharing an identical last_activity_at
	// (rapid-fire inserts within the same tick — the exact shape the G-C ghost
	// guard probes) must still resolve to a deterministic newest-first order via
	// the added `rowid DESC` tiebreak, not DB-implementation-defined order.
	it("FLY-939: rowid DESC tiebreak orders same-timestamp rows newest-inserted-first", async () => {
		const store = await freshStore();
		for (const id of ["r1", "r2", "r3", "r4"]) {
			seedSession(store, {
				execution_id: id,
				issue_id: "FLY-1",
				chat_thread_role: "qa",
				status: "completed",
			});
		}
		const rows = store.getPhaseSessionsForIssue("FLY-1");
		expect(rows.map((r) => r.execution_id)).toEqual(["r4", "r3", "r2", "r1"]);
	});
});

describe("getParkedPhaseCandidates (FLY-1204)", () => {
	it("returns phase rows in the reclaimable status set only", async () => {
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
			execution_id: "q1",
			issue_id: "FLY-1",
			chat_thread_role: "qa",
			status: "completed",
		});
		// running qa is a candidate too — a FAIL fix-loop parks with status still
		// running; the HeartbeatService verdict layer distinguishes parked-running
		// from actively-working-running via CommDB declared_state.
		seedSession(store, {
			execution_id: "q2",
			issue_id: "FLY-2",
			chat_thread_role: "qa",
			status: "running",
		});
		seedSession(store, {
			execution_id: "a",
			issue_id: "FLY-3",
			chat_thread_role: "implement",
			status: "approved_to_ship",
		});
		const ids = store
			.getParkedPhaseCandidates()
			.map((s) => s.execution_id)
			.sort();
		expect(ids).toEqual(["a", "d", "i", "q1", "q2"]);
	});

	it("excludes non-phase (main) rows and non-candidate statuses", async () => {
		const store = await freshStore();
		// main role — never a phase candidate even in a candidate status
		seedSession(store, {
			execution_id: "main-1",
			issue_id: "FLY-1",
			chat_thread_role: "main",
			status: "completed",
		});
		// a crashed/terminal phase (failed) is NOT in the candidate set
		seedSession(store, {
			execution_id: "f",
			issue_id: "FLY-1",
			chat_thread_role: "design",
			status: "failed",
		});
		// terminated is likewise excluded
		seedSession(store, {
			execution_id: "t",
			issue_id: "FLY-1",
			chat_thread_role: "qa",
			status: "terminated",
		});
		expect(store.getParkedPhaseCandidates()).toEqual([]);
	});

	it("exposes only workflow-bound main actors on the additive managed patrol query", async () => {
		const store = await freshStore();
		seedSession(store, {
			execution_id: "generic-parked",
			issue_id: "FLY-1",
			chat_thread_role: "main",
			workflow_node_id: "execute",
			status: "ship_parked",
		});
		seedSession(store, {
			execution_id: "generic-failed",
			issue_id: "FLY-1",
			chat_thread_role: "main",
			workflow_node_id: "execute",
			status: "failed",
		});
		seedSession(store, {
			execution_id: "ordinary-main",
			issue_id: "FLY-1",
			chat_thread_role: "main",
			status: "ship_parked",
		});

		expect(
			store.getWorkflowManagedParkedCandidates().map((row) => row.execution_id),
		).toEqual(["generic-parked"]);
		expect(store.getParkedPhaseCandidates()).toEqual([]);
	});
});
