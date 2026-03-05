/**
 * Typed error hierarchy — introduces typed errors alongside existing string errors.
 * Migration of existing string error paths deferred to Step 2c/Step 3.
 * From Maestro sealed exception pattern (external-repo-survey.md §3.3).
 * Distinguishes startup vs runtime vs decision errors for retry policy.
 */
export type FlywheelError =
	| { type: "runner_timeout"; sessionId?: string; elapsed: number }
	| { type: "runner_startup_failure"; reason: string }
	| { type: "git_conflict"; worktree: string; files: string[] }
	| { type: "git_infra_error"; command: string; reason: string }
	| { type: "hook_callback_timeout"; token: string }
	| { type: "worktree_create_failure"; reason: string }
	| { type: "decision_escalation"; reason: string }
	| { type: "terminal_error"; reason: string };

/** Whether an error is retryable */
export function isRetryable(err: FlywheelError): boolean {
	return (
		err.type === "runner_timeout" ||
		err.type === "runner_startup_failure" ||
		err.type === "hook_callback_timeout"
	);
}

/**
 * Retry policy — from Conductor retry pattern (external-repo-survey.md §1.2).
 * Claude sessions are expensive, so defaults are conservative.
 * NOTE: Step 2b defines types only. Actual retry loop is Step 3 (DagDispatcher).
 */
export interface RetryPolicy {
	maxRetries: number;
	delaySeconds: number;
	backoff: "fixed" | "linear" | "exponential";
	backoffRate?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: 1,
	delaySeconds: 30,
	backoff: "fixed",
};

/** Calculate delay in ms for a given attempt (1-based) */
export function retryDelay(policy: RetryPolicy, attempt: number): number {
	const base = policy.delaySeconds * 1000;
	switch (policy.backoff) {
		case "fixed":
			return base;
		case "linear":
			return base * attempt * (policy.backoffRate ?? 1);
		case "exponential":
			return base * (policy.backoffRate ?? 2) ** (attempt - 1);
	}
}
