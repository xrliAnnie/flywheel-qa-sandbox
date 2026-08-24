export const WORKFLOW_REPLACEMENT_RETRY_DELAYS_MS = [
	60_000,
	5 * 60_000,
	15 * 60_000,
] as const;

export type WorkflowReplacementNextCheckDisposition =
	| "replacement_candidate"
	| "environment_hold_candidate"
	| "retry_limit_hold_candidate";
