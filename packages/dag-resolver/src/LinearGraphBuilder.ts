import type { DagNode, LinearIssueData } from "./types.js";

/**
 * Linear state.type values that indicate an issue is terminal (done/canceled).
 * Uses the stable SDK enum, not the user-customizable state.name.
 */
const TERMINAL_TYPES = new Set(["completed", "canceled"]);

/** Relation type indicating relatedIssue blocks this issue */
const BLOCKED_BY_TYPE = "blocks";

/**
 * Converts pre-resolved Linear issues into DagNodes for dependency resolution.
 *
 * Filters out terminal-state issues (completed, canceled by default)
 * and extracts blocking relationships from issue relations.
 *
 * Caller is responsible for pre-resolving async Linear SDK fields
 * (issue.state, issue.relations()) before passing to build().
 */
export class LinearGraphBuilder {
	constructor(private terminalTypes: Set<string> = TERMINAL_TYPES) {}

	build(issues: LinearIssueData[]): DagNode[] {
		const active = issues.filter(
			(i) => !this.terminalTypes.has(i.state?.type ?? ""),
		);
		const activeIds = new Set(active.map((i) => i.id));

		return active.map((issue) => ({
			id: issue.id,
			blockedBy: (issue.relations?.nodes ?? [])
				.filter(
					(r) => r.type === BLOCKED_BY_TYPE && activeIds.has(r.relatedIssue.id),
				)
				.map((r) => r.relatedIssue.id),
		}));
	}
}
