/**
 * FLY-799 Part C — fan-out finalization node collection.
 *
 * 甲 (Annie 2026-07-02): one issue, three internal stages, NO independent
 * sub-issues → the finalization relationship graph is just feature ↔ QA
 * (auto_qa_record), NOT a Linear sub-issue tree. When the shipped runner
 * self-ships, the fan-out cleans the shipped runner + its QA runner(s).
 *
 * This module holds the pure traversal (`collectRelatedNodes`) and the
 * safe-to-finalize policy (`isQaSafeToFinalize`). Only an already-PASS QA is
 * finalized on the parent's approval — a running/awaiting_retest/failed/stuck QA
 * has no verdict yet, and the root approval does not authorize closing it
 * (Codex R1 #7). cleanupNode (closeRunner + worktree + LinearIssueFinalizer) and
 * the per-node retry store are wired in the integration step.
 */

import type { StateStore } from "../StateStore.js";

export interface RelatedNode {
	/** Present for nodes that have a runner. */
	executionId?: string;
	issueId: string;
	role: "shipped" | "qa";
	/** auto_qa_record.status for a QA node. */
	qaStatus?: string;
}

/**
 * Only a PASSED QA is finalized when the parent ships. Everything else
 * (running / awaiting_retest / failed / stuck / superseded) is left alone —
 * it has no positive verdict and the parent's ship approval does not authorize
 * closing it.
 */
export function isQaSafeToFinalize(qaStatus: string): boolean {
	return qaStatus === "passed";
}

export function collectRelatedNodes(
	store: StateStore,
	args: { rootExecutionId: string; rootIssueId: string },
): RelatedNode[] {
	const nodes: RelatedNode[] = [
		{
			executionId: args.rootExecutionId,
			issueId: args.rootIssueId,
			role: "shipped",
		},
	];

	for (const rec of store.listAutoQaRecordsByParent(args.rootExecutionId)) {
		// A QA node needs something to clean: a runner (qa_execution_id) and/or a
		// separate QA issue (qa_issue_id). Skip records with neither.
		if (!rec.qa_execution_id && !rec.qa_issue_id) continue;
		nodes.push({
			executionId: rec.qa_execution_id,
			issueId: rec.qa_issue_id ?? rec.issue_id,
			role: "qa",
			qaStatus: rec.status,
		});
	}

	return nodes;
}
