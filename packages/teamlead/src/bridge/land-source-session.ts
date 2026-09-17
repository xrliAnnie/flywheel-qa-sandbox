import type { LandOperationRow, Session, StateStore } from "../StateStore.js";

export interface LandSourceSessionInput {
	runId?: string | null;
	issueId: string;
	projectName: string;
	prNumber: number;
	approvedHead: string;
}

export type LandFinalizationContext =
	| { kind: "session"; session: Session }
	| {
			kind: "operation";
			operationId: string;
			runId: string | null;
			issueUuid: string;
			project: string;
			sourceExecutionId: string | null;
			issueIdentifier?: string;
			mergeReceiptId: string;
	  }
	| {
			kind: "unresolved";
			reason: "merge_receipt_unavailable" | "operation_identity_invalid";
	  };

export function resolveLandSourceSession(
	store: StateStore,
	input: LandSourceSessionInput,
): Session | undefined {
	const gateEntryOwnerExecutionId = input.runId
		? store.getWorkflowGateEntryPrOwnerExecutionId({
				runId: input.runId,
				prNumber: input.prNumber,
				headSha: input.approvedHead,
			})
		: undefined;
	if (gateEntryOwnerExecutionId) {
		const owner = store.getSession(gateEntryOwnerExecutionId);
		return owner?.issue_id === input.issueId &&
			owner.project_name === input.projectName &&
			owner.pr_number === input.prNumber
			? owner
			: undefined;
	}

	return (
		store
			.getSessionsByIssue(input.issueId)
			.find(
				(candidate) =>
					candidate.project_name === input.projectName &&
					candidate.pr_number === input.prNumber &&
					candidate.pr_head_sha?.toLowerCase() === input.approvedHead,
			) ?? store.getSessionByIssue(input.issueId)
	);
}

/**
 * Resolve the post-merge closeout identity without requiring a surviving
 * session row. The gate-entry producer remains the source execution identity;
 * a sibling session is never substituted when that exact row was retired.
 */
export function resolveLandFinalizationContext(
	store: StateStore,
	operation: LandOperationRow,
): LandFinalizationContext {
	if (
		!operation.operation_id ||
		!operation.issue_id ||
		!operation.project_name ||
		!Number.isSafeInteger(operation.pr_number) ||
		operation.pr_number < 1 ||
		!/^[0-9a-f]{40}$/i.test(operation.approved_head)
	) {
		return { kind: "unresolved", reason: "operation_identity_invalid" };
	}

	const mergeStep = store
		.listLandOperationSteps(operation.operation_id)
		.find((step) => step.step === "merge_confirmed");
	if (
		!mergeStep ||
		String(mergeStep.receipt.headSha ?? "").toLowerCase() !==
			operation.approved_head.toLowerCase()
	) {
		return { kind: "unresolved", reason: "merge_receipt_unavailable" };
	}

	const sourceExecutionId = operation.run_id
		? (store.getWorkflowGateEntryPrOwnerExecutionId({
				runId: operation.run_id,
				prNumber: operation.pr_number,
				headSha: operation.approved_head,
			}) ?? null)
		: null;
	if (sourceExecutionId) {
		const source = store.getSession(sourceExecutionId);
		if (
			source?.issue_id === operation.issue_id &&
			source.project_name === operation.project_name &&
			source.pr_number === operation.pr_number
		) {
			return { kind: "session", session: source };
		}
		return {
			kind: "operation",
			operationId: operation.operation_id,
			runId: operation.run_id,
			issueUuid: operation.issue_id,
			project: operation.project_name,
			sourceExecutionId,
			mergeReceiptId: `${operation.operation_id}:merge_confirmed`,
		};
	}

	const legacySession = resolveLandSourceSession(store, {
		runId: operation.run_id,
		issueId: operation.issue_id,
		projectName: operation.project_name,
		prNumber: operation.pr_number,
		approvedHead: operation.approved_head,
	});
	if (legacySession) return { kind: "session", session: legacySession };

	return {
		kind: "operation",
		operationId: operation.operation_id,
		runId: operation.run_id,
		issueUuid: operation.issue_id,
		project: operation.project_name,
		sourceExecutionId: null,
		mergeReceiptId: `${operation.operation_id}:merge_confirmed`,
	};
}
