import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-1329 (A3): re-adopt must cover EVERY role's parked status.
 *
 * The FLY-1319 restart re-adopted the QA session and missed the implement one.
 * That is not a coincidence — it is the query. Boot re-adopt filters
 * `status === "running"`, but under keep-alive each role parks at a DIFFERENT
 * status (phase-orchestrator HANDOFF_STATUS):
 *
 *   - design  parks at `design_done`   — not in getActiveSessions() at all
 *   - implement parks at `awaiting_review`
 *   - qa      runs at `running`        — the only one the old filter matched
 *
 * So the roles that park are exactly the roles re-adopt could not see. A parked
 * implement surviving a restart was structurally impossible.
 */
describe("FLY-1329 A3: getReadoptCandidateSessions covers every parked role", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());

	function seed(execId: string, status: string): void {
		store.upsertSession({
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			status,
		});
	}

	it("includes design_done — a parked design (invisible to getActiveSessions)", () => {
		seed("design-parked", "design_done");
		const ids = store.getReadoptCandidateSessions().map((s) => s.execution_id);
		expect(ids).toContain("design-parked");
		// Proof this is a real gap, not a restatement: the old source query misses it.
		expect(store.getActiveSessions().map((s) => s.execution_id)).not.toContain(
			"design-parked",
		);
	});

	it("includes awaiting_review — the parked implement FLY-1319 lost", () => {
		seed("implement-parked", "awaiting_review");
		expect(
			store.getReadoptCandidateSessions().map((s) => s.execution_id),
		).toContain("implement-parked");
	});

	it("includes running — the QA shape the old filter already covered", () => {
		seed("qa-live", "running");
		expect(
			store.getReadoptCandidateSessions().map((s) => s.execution_id),
		).toContain("qa-live");
	});

	it("includes approved_to_ship — parked awaiting the ship flow", () => {
		seed("ship-pending", "approved_to_ship");
		expect(
			store.getReadoptCandidateSessions().map((s) => s.execution_id),
		).toContain("ship-pending");
	});

	/** Terminal rows must never be re-adopted — that would resurrect the dead. */
	it("EXCLUDES terminal statuses (completed / failed / blocked)", () => {
		seed("done", "completed");
		seed("dead", "failed");
		seed("stuck", "blocked");
		const ids = store.getReadoptCandidateSessions().map((s) => s.execution_id);
		expect(ids).not.toContain("done");
		expect(ids).not.toContain("dead");
		expect(ids).not.toContain("stuck");
	});

	it("returns all four candidate statuses together", () => {
		seed("a", "running");
		seed("b", "awaiting_review");
		seed("c", "design_done");
		seed("d", "approved_to_ship");
		seed("e", "completed");
		expect(store.getReadoptCandidateSessions()).toHaveLength(4);
	});

	/** The existing query must keep its exact semantics — other callers rely on it. */
	it("does NOT change getActiveSessions (its own callers depend on that set)", () => {
		seed("a", "running");
		seed("c", "design_done");
		const active = store.getActiveSessions().map((s) => s.execution_id);
		expect(active).toEqual(["a"]);
	});
});
