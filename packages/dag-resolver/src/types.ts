/**
 * A node in the dependency graph.
 * Maps 1:1 to a Linear issue (or any task with dependencies).
 */
export interface DagNode {
	/** Unique identifier (e.g., Linear issue ID) */
	id: string;
	/** IDs of nodes that must complete before this one can start */
	blockedBy: string[];
}

/** Lifecycle status of a node in the resolver */
export type NodeStatus = "pending" | "done" | "shelved";

/** Options for DagResolver behavior */
export interface DagResolverOptions {
	/**
	 * When true, shelving a node releases its downstream dependents.
	 * When false (default), shelved nodes block downstream like pending ones.
	 */
	allowBypassBlockers?: boolean;
}

/** Warning emitted during graph construction */
export interface DagWarning {
	type: "unknown_blocker";
	nodeId: string;
	blockerId: string;
}

/**
 * Pre-resolved Linear issue data for graph building.
 *
 * Caller is responsible for awaiting the async Linear SDK fields
 * (issue.state, issue.relations()) and mapping them to this shape.
 *
 * state.type is a Linear SDK stable enum:
 * "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"
 */
export interface LinearIssueData {
	id: string;
	state: { type: string } | null;
	relations: {
		nodes: Array<{ type: string; relatedIssue: { id: string } }>;
	} | null;
}
