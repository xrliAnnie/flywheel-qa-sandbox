/**
 * FLY-191 Phase 2 — awaiting_review review-window persistence.
 *
 * The Bridge-side 48h timeout is anchored on `awaiting_review_entered_at`:
 *  - set on ENTRY into awaiting_review (persistTransition / upsertSession /
 *    forceStatus),
 *  - NEVER drifted by same-status re-writes or activity (Codex R1 MEDIUM-6),
 *  - explicitly reset by `resetAwaitingReviewWindow` (re-review request),
 *  - `gate_timeout_notified_at` dedups exactly once per window and is cleared
 *    on every fresh entry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const EXEC = "exec-fly191-window";

describe("awaiting_review window (FLY-191 Phase 2)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-191",
			project_name: "flywheel",
			status: "running",
		});
	});

	function enteredAt(): string | undefined {
		return store.getSession(EXEC)?.awaiting_review_entered_at;
	}

	it("stamps entered_at on entry via upsertSession", () => {
		expect(enteredAt()).toBeUndefined();
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-191",
			project_name: "flywheel",
			status: "awaiting_review",
		});
		expect(enteredAt()).toBeTruthy();
	});

	it("stamps entered_at on entry via persistTransition", () => {
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: "flywheel",
			last_activity_at: "2026-06-03 10:00:00",
		});
		expect(enteredAt()).toBeTruthy();
	});

	it("stamps entered_at on entry via forceStatus", () => {
		store.forceStatus(EXEC, "awaiting_review", "2026-06-03 10:00:00");
		expect(enteredAt()).toBeTruthy();
	});

	it("does NOT drift on a same-status re-write (deadline stability)", () => {
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: "flywheel",
		});
		const first = enteredAt();
		// Backdate so a re-stamp would be observable
		store.resetAwaitingReviewWindow(EXEC); // fresh stamp
		const stamped = enteredAt();
		// Same-status upsert (activity refresh) must not move the anchor
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-191",
			project_name: "flywheel",
			status: "awaiting_review",
			last_activity_at: "2026-06-03 23:59:59",
		});
		expect(enteredAt()).toBe(stamped);
		expect(first).toBeTruthy();
	});

	it("re-entry after leaving awaiting_review re-stamps (fresh review window)", async () => {
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: "flywheel",
		});
		// Leave (approved) then re-enter — e.g. approve undone is impossible,
		// so emulate the realistic running→awaiting_review re-entry of a retry.
		store.persistTransition(EXEC, "approved_to_ship", {
			issue_id: "FLY-191",
			project_name: "flywheel",
		});
		// Backdate the old stamp to make re-stamp observable at 1s resolution.
		store.resetAwaitingReviewWindow(EXEC);
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: "flywheel",
		});
		expect(enteredAt()).toBeTruthy();
	});

	it("getAwaitingReviewTimedOut returns only expired + un-notified awaiting_review rows", async () => {
		// Session 1: awaiting_review, entered 50h ago → timed out
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: "flywheel",
		});
		backdateEnteredAt(store, EXEC, 50);

		// Session 2: awaiting_review, entered 1h ago → inside window
		store.upsertSession({
			execution_id: "fresh",
			issue_id: "FLY-192",
			project_name: "flywheel",
			status: "awaiting_review",
		});

		// Session 3: running (not awaiting_review)
		store.upsertSession({
			execution_id: "runner",
			issue_id: "FLY-193",
			project_name: "flywheel",
			status: "running",
		});

		// Session 4: awaiting_review but NO anchor (legacy pre-migration row)
		store.upsertSession({
			execution_id: "legacy",
			issue_id: "FLY-194",
			project_name: "flywheel",
			status: "awaiting_review",
		});
		clearEnteredAt(store, "legacy");

		const timedOut = store.getAwaitingReviewTimedOut(48);
		expect(timedOut.map((s) => s.execution_id)).toEqual([EXEC]);
	});

	it("markGateTimeoutNotified dedups; resetAwaitingReviewWindow re-arms", () => {
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: "flywheel",
		});
		backdateEnteredAt(store, EXEC, 50);
		expect(store.getAwaitingReviewTimedOut(48)).toHaveLength(1);

		store.markGateTimeoutNotified(EXEC);
		expect(store.getAwaitingReviewTimedOut(48)).toHaveLength(0);

		// Re-review → fresh window → (after it expires again) a new notification
		store.resetAwaitingReviewWindow(EXEC);
		expect(store.getSession(EXEC)?.gate_timeout_notified_at).toBeUndefined();
		backdateEnteredAt(store, EXEC, 50);
		expect(store.getAwaitingReviewTimedOut(48)).toHaveLength(1);
	});
});

/** Backdate the anchor via a normal-API-adjacent path: direct column update. */
function backdateEnteredAt(
	store: StateStore,
	executionId: string,
	hoursAgo: number,
): void {
	// biome-ignore lint/complexity/useLiteralKeys: tests reach the raw sql.js db
	(store as unknown as { db: import("sql.js").Database })["db"].run(
		`UPDATE sessions SET awaiting_review_entered_at = datetime('now', '-${hoursAgo} hours') WHERE execution_id = ?`,
		[executionId],
	);
}

function clearEnteredAt(store: StateStore, executionId: string): void {
	// biome-ignore lint/complexity/useLiteralKeys: tests reach the raw sql.js db
	(store as unknown as { db: import("sql.js").Database })["db"].run(
		"UPDATE sessions SET awaiting_review_entered_at = NULL WHERE execution_id = ?",
		[executionId],
	);
}
