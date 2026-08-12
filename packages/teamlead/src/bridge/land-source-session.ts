import type { Session, StateStore } from "../StateStore.js";

export interface LandSourceSessionInput {
	runId?: string | null;
	issueId: string;
	projectName: string;
	prNumber: number;
	approvedHead: string;
}

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
