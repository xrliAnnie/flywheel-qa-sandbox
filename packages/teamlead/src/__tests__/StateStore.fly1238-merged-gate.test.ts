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

	it("reopens a resolved guard row as a fresh bounded-failure episode", () => {
		store.ensureMergedGateGuardFailure({
			questionId: "q-reopen",
			source: "text",
			executionId: "exec-1",
			issueId: "FLY-1238",
			projectName: "flywheel",
			nowMs: 1_000,
		});
		store.recordMergedGateGuardUnknown({
			questionId: "q-reopen",
			source: "text",
			nowMs: 1_001,
			nextRetryMs: 31_001,
			error: "temporary outage",
			terminal: false,
		});
		store.resolveMergedGateGuardFailure("q-reopen", "text");

		const reopened = store.ensureMergedGateGuardFailure({
			questionId: "q-reopen",
			source: "text",
			executionId: "exec-1",
			issueId: "FLY-1238",
			projectName: "flywheel",
			nowMs: 50_000,
		});

		expect(reopened).toMatchObject({
			attempts: 0,
			first_seen_ms: 50_000,
			next_retry_ms: 0,
			terminal: false,
			alerted: false,
		});
		expect(reopened.resolved_at).toBeUndefined();
	});

	it("records CommDB finalizer failures, alerts after three attempts, and marks receipt exactly once", () => {
		for (let attempt = 1; attempt <= 3; attempt++) {
			store.recordCommDbFinalizeOutcome({
				executionId: "exec-finalize",
				issueId: "FLY-1238",
				projectName: "flywheel",
				ok: false,
				error: `sqlite busy ${attempt}`,
				nowMs: 1_000 + attempt,
			});
		}
		const failure = store.getCommDbFinalizeFailure("exec-finalize");
		expect(failure).toMatchObject({
			attempts: 3,
			first_failure_ms: 1_001,
			last_failure_ms: 1_003,
			last_error: "sqlite busy 3",
			alerted: false,
		});
		const alerts = store
			.listPendingFounderActions()
			.filter(
				(row) => row.action_key === "commdb-finalize-stuck-exec-finalize",
			);
		expect(alerts).toHaveLength(1);

		store.markFounderActionDelivered("commdb-finalize-stuck-exec-finalize");
		expect(store.getCommDbFinalizeFailure("exec-finalize")?.alerted).toBe(true);

		store.recordCommDbFinalizeOutcome({
			executionId: "exec-finalize",
			issueId: "FLY-1238",
			projectName: "flywheel",
			ok: false,
			error: "still stuck",
			nowMs: 2_000,
		});
		expect(
			store
				.listPendingFounderActions()
				.filter(
					(row) => row.action_key === "commdb-finalize-stuck-exec-finalize",
				),
		).toHaveLength(0);

		store.recordCommDbFinalizeOutcome({
			executionId: "exec-finalize",
			issueId: "FLY-1238",
			projectName: "flywheel",
			ok: true,
			nowMs: 3_000,
		});
		expect(
			store.getCommDbFinalizeFailure("exec-finalize")?.resolved_at,
		).toBeTruthy();
	});

	it("queues the same durable finalizer alert after fifteen minutes", () => {
		store.recordCommDbFinalizeOutcome({
			executionId: "exec-aged",
			issueId: "FLY-1238",
			projectName: "flywheel",
			ok: false,
			error: "first",
			nowMs: 10,
		});
		store.recordCommDbFinalizeOutcome({
			executionId: "exec-aged",
			issueId: "FLY-1238",
			projectName: "flywheel",
			ok: false,
			error: "aged",
			nowMs: 15 * 60_000 + 10,
		});
		expect(
			store
				.listPendingFounderActions()
				.some((row) => row.action_key === "commdb-finalize-stuck-exec-aged"),
		).toBe(true);
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
