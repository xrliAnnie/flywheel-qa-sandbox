/** Dependency-light workflow state constants shared by ledgers and renderers. */
export const WORKFLOW_RUN_NODE_STATES = [
	"pending",
	"admitted",
	"running",
	"review",
	"done",
	"failed",
	"completed",
	"superseded",
] as const;
export type WorkflowRunNodeState = (typeof WORKFLOW_RUN_NODE_STATES)[number];

export const ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES = [
	"completed",
	"failed",
	"terminated",
	"blocked",
	"rejected",
	"deferred",
	"shelved",
] as const;
