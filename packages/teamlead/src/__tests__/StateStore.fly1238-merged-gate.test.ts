import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore FLY-1238 merged gate cleanup", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("invalidates the active deferral and only pending notices for the exact question", () => {
		store.deferFounderApproval({
			questionId: "q-1",
			msgId: "m-1",
			executionId: "exec-1",
			issueId: "FLY-1238",
			projectName: "flywheel",
			prHeadSha: "abc",
			threadId: "thread-1",
			decision: "approve",
			content: "批准",
			authorUserId: "founder",
			founderIdAtCapture: "founder",
			ttlSeconds: 600,
			heldReplyAction: action("held-q1", "held_reply", "q-1"),
		});
		store.insertFounderAction(action("drift-q1", "head_drift_notice", "q-1"));
		store.insertFounderAction(action("rebound-q1", "rebound_notice", "q-1"));
		store.insertFounderAction(action("other-q2", "held_reply", "q-2"));
		store.insertFounderAction(action("delivered-q1", "held_reply", "q-1"));
		store.markFounderActionDelivered("delivered-q1");

		const result = store.invalidateMergedGateArtifacts({
			executionId: "exec-1",
			issueId: "FLY-1238",
			projectName: "flywheel",
			questionId: "q-1",
			prNumber: 588,
			source: "text",
			observedMergeCommitOid: "deadbeef",
		});

		expect(result).toEqual({
			invalidatedDeferredCount: 1,
			supersededActionCount: 3,
		});
		expect(store.getDeferredApproval("q-1", "m-1")?.invalidated_reason).toBe(
			"pr_merged",
		);
		for (const key of ["held-q1", "drift-q1", "rebound-q1"]) {
			expect(store.getFounderAction(key)?.status).toBe("superseded");
		}
		expect(store.getFounderAction("other-q2")?.status).toBe("pending");
		expect(store.getFounderAction("delivered-q1")?.status).toBe("delivered");
		expect(
			store
				.getEventsByExecution("exec-1")
				.filter((event) => event.event_type === "merged_gate_suppressed"),
		).toHaveLength(1);

		store.invalidateMergedGateArtifacts({
			executionId: "exec-1",
			issueId: "FLY-1238",
			projectName: "flywheel",
			questionId: "q-1",
			prNumber: 588,
			source: "text",
		});
		expect(
			store
				.getEventsByExecution("exec-1")
				.filter((event) => event.event_type === "merged_gate_suppressed"),
		).toHaveLength(1);
	});

	it("persists first_seen before probes and queues one stable terminal alert", () => {
		const first = store.ensureMergedGateGuardFailure({
			questionId: "q-1",
			source: "action_drain",
			executionId: "exec-1",
			issueId: "FLY-1238",
			projectName: "flywheel",
			nowMs: 1_000,
		});
		expect(first.first_seen_ms).toBe(1_000);
		expect(first.attempts).toBe(0);

		for (let attempt = 1; attempt <= 5; attempt++) {
			store.recordMergedGateGuardUnknown({
				questionId: "q-1",
				source: "action_drain",
				nowMs: 1_000 + attempt,
				nextRetryMs: 2_000 + attempt,
				error: "gh unavailable",
				terminal: attempt === 5,
			});
		}
		const row = store.getMergedGateGuardFailure("q-1", "action_drain");
		expect(row?.attempts).toBe(5);
		expect(row?.terminal).toBe(true);
		expect(
			store
				.listPendingFounderActions()
				.filter((actionRow) => actionRow.kind === "emit_alert"),
		).toHaveLength(1);

		store.recordMergedGateGuardUnknown({
			questionId: "q-1",
			source: "action_drain",
			nowMs: 3_000,
			nextRetryMs: 4_000,
			error: "still unavailable",
			terminal: true,
		});
		expect(
			store
				.listPendingFounderActions()
				.filter((actionRow) => actionRow.kind === "emit_alert"),
		).toHaveLength(1);

		store.resolveMergedGateGuardFailure("q-1", "action_drain");
		expect(
			store.getMergedGateGuardFailure("q-1", "action_drain")?.resolved_at,
		).toBeTruthy();
	});
});

function action(
	actionKey: string,
	kind: "held_reply" | "head_drift_notice" | "rebound_notice",
	questionId: string,
) {
	return {
		actionKey,
		kind,
		executionId: "exec-1",
		issueId: "FLY-1238",
		projectName: "flywheel",
		threadId: "thread-1",
		payload: { questionId, text: "notice" },
	} as const;
}
