import { describe, expect, it } from "vitest";
import type {
	LandOperationRow,
	Session,
	StateStore,
} from "../../StateStore.js";
import { resolveLandFinalizationContext } from "../land-source-session.js";

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
		lease_expires_at: "2026-09-16T05:10:00.000Z",
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

function session(executionId: string): Session {
	return {
		execution_id: executionId,
		issue_id: "issue-1",
		issue_identifier: "FLY-2616",
		project_name: "flywheel",
		pr_number: 1216,
		pr_head_sha: HEAD,
		status: "completed",
	} as Session;
}

function storeFixture(input: {
	ownerExecutionId?: string;
	sessions?: Session[];
	mergeStep?: boolean;
}): StateStore {
	const sessions = input.sessions ?? [];
	return {
		getWorkflowGateEntryPrOwnerExecutionId: () => input.ownerExecutionId,
		getSession: (executionId: string) =>
			sessions.find((candidate) => candidate.execution_id === executionId),
		getSessionsByIssue: () => sessions,
		getSessionByIssue: () => sessions[0],
		listLandOperationSteps: () =>
			input.mergeStep === false
				? []
				: [
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

describe("resolveLandFinalizationContext", () => {
	it("keeps the legacy session path when the exact gate-entry owner row survives", () => {
		const owner = session("implement-1");
		expect(
			resolveLandFinalizationContext(
				storeFixture({
					ownerExecutionId: owner.execution_id,
					sessions: [owner],
				}),
				operation(),
			),
		).toEqual({ kind: "session", session: owner });
	});

	it("uses the durable gate-entry execution identity after its session row is gone", () => {
		const sibling = session("qa-sibling");
		expect(
			resolveLandFinalizationContext(
				storeFixture({
					ownerExecutionId: "implement-deleted",
					sessions: [sibling],
				}),
				operation(),
			),
		).toMatchObject({
			kind: "operation",
			operationId: "land:operation-1",
			runId: "run-1",
			issueUuid: "issue-1",
			project: "flywheel",
			sourceExecutionId: "implement-deleted",
			mergeReceiptId: "land:operation-1:merge_confirmed",
		});
	});

	it("does not substitute an unrelated surviving sibling for the missing exact owner", () => {
		const result = resolveLandFinalizationContext(
			storeFixture({
				ownerExecutionId: "implement-deleted",
				sessions: [session("qa-sibling")],
			}),
			operation(),
		);

		expect(result.kind).toBe("operation");
		if (result.kind === "operation") {
			expect(result.sourceExecutionId).toBe("implement-deleted");
		}
	});

	it("fails closed when the immutable merge step is unavailable", () => {
		expect(
			resolveLandFinalizationContext(
				storeFixture({
					ownerExecutionId: "implement-deleted",
					mergeStep: false,
				}),
				operation(),
			),
		).toEqual({ kind: "unresolved", reason: "merge_receipt_unavailable" });
	});
});
