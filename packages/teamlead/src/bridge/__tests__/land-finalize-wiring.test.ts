import { describe, expect, it } from "vitest";
import type {
	LandOperationRow,
	Session,
	StateStore,
} from "../../StateStore.js";
import { prepareLandFinalization } from "../land-finalization-context.js";

const HEAD = "a".repeat(40);

function operation(
	overrides: Partial<LandOperationRow> = {},
): LandOperationRow {
	return {
		operation_id: "land:operation-1",
		run_id: "run-1",
		issue_id: "issue-1",
		project_name: "flywheel",
		pr_number: 1216,
		approved_head: HEAD,
		state: "running",
		owner_id: "land-owner",
		lease_expires_at: "2099-09-16T05:10:00.000Z",
		generation: 1,
		ship_attempt: 1,
		resume_generation: 0,
		current_step: "merge_confirmed",
		merge_confirmed_at: "2026-09-16T05:00:00.000Z",
		finalization_completed_at: null,
		retry_count: 0,
		retry_epoch_key: null,
		next_attempt_at: null,
		carryover_receipt_id: null,
		superseded_at: null,
		superseded_by_operation_id: null,
		linear_done_disposition: null,
		linear_done_deferred_at: null,
		linear_done_settled_at: null,
		linear_done_last_reason: null,
		linear_done_retry_count: 0,
		linear_done_next_attempt_at: null,
		linear_done_last_attempt_at: null,
		last_error: null,
		created_at: "2026-09-16T04:50:00.000Z",
		updated_at: "2026-09-16T05:00:00.000Z",
		...overrides,
	};
}

function storeFixture(input: {
	ownerExecutionId?: string;
	sessions?: Session[];
}): StateStore {
	const sessions = input.sessions ?? [];
	return {
		getWorkflowGateEntryPrOwnerExecutionId: () => input.ownerExecutionId,
		getSession: (executionId: string) =>
			sessions.find((candidate) => candidate.execution_id === executionId),
		getSessionsByIssue: () => sessions,
		getSessionByIssue: () => sessions[0],
		listLandOperationSteps: () => [
			{
				operation_id: "land:operation-1",
				step: "merge_confirmed",
				receipt: { prNumber: 1216, headSha: HEAD },
				generation: 1,
				completed_at: "2026-09-16T05:00:00.000Z",
			},
		],
	} as unknown as StateStore;
}

describe("land finalization plugin wiring", () => {
	it("passes only a trusted operation-scoped merged-worktree proof into cleanup", () => {
		const store = storeFixture({ ownerExecutionId: "implement-deleted" });
		store.listLandOperationSteps = (() => [
			{
				operation_id: "land:operation-1",
				step: "merge_confirmed",
				receipt: { prNumber: 1216, headSha: HEAD },
				generation: 1,
				completed_at: "2026-09-16T05:00:00.000Z",
			},
			{
				operation_id: "land:operation-1",
				step: "aux:merged_worktree_proof",
				receipt: {
					state: "MERGED",
					prNumber: 1216,
					headSha: HEAD,
					mergeSha: "b".repeat(40),
					baseRefName: "main",
					repoIdentity: "xrliAnnie/flywheel",
				},
				generation: 1,
				completed_at: "2026-09-16T05:01:00.000Z",
			},
		]) as StateStore["listLandOperationSteps"];

		const prepared = prepareLandFinalization(
			store,
			operation(),
			{},
			{
				projectName: "flywheel",
				projectRoot: "/repo/flywheel",
				projectRepo: "xrliAnnie/flywheel",
			},
		);

		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.opts.mergedWorktreeProof).toMatchObject({
			operationId: "land:operation-1",
			operationGeneration: 1,
			repoIdentity: "xrliAnnie/flywheel",
			projectRoot: "/repo/flywheel",
			prNumber: 1216,
			baseRefName: "main",
			mergedPrHead: HEAD,
			mergeSha: "b".repeat(40),
			mergeReceiptId: "land:operation-1:aux:merged_worktree_proof",
		});
	});

	it("enters operation-scoped finalization after the exact source session row is gone", () => {
		const prepared = prepareLandFinalization(
			storeFixture({ ownerExecutionId: "implement-deleted" }),
			operation(),
		);

		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.context).toMatchObject({
			kind: "operation",
			sourceExecutionId: "implement-deleted",
		});
		expect(prepared.opts).toMatchObject({
			issueId: "issue-1",
			projectName: "flywheel",
			operationContext: {
				operationId: "land:operation-1",
				ownerId: "land-owner",
				generation: 1,
				sourceExecutionId: "implement-deleted",
			},
		});
		expect("executionId" in prepared.opts).toBe(false);
		expect("sessionStatus" in prepared.opts).toBe(false);
	});

	it("keeps a null source identity instead of borrowing a surviving sibling", () => {
		const sibling = {
			execution_id: "qa-sibling",
			issue_id: "different-issue",
			project_name: "flywheel",
			status: "completed",
		} as Session;
		const prepared = prepareLandFinalization(
			storeFixture({ sessions: [sibling] }),
			operation({ run_id: null }),
		);

		expect(prepared.ok).toBe(true);
		if (!prepared.ok || prepared.context.kind !== "operation") return;
		expect(prepared.context.sourceExecutionId).toBeNull();
		expect(prepared.opts.operationContext?.sourceExecutionId).toBeNull();
		expect("executionId" in prepared.opts).toBe(false);
	});
});
