/** GEO-168: IRetryDispatcher interface — retry creates a new execution. */

export interface RetryRequest {
	oldExecutionId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	projectName: string;
	reason?: string;
	previousError?: string;
	previousDecisionRoute?: string;
	previousReasoning?: string;
	runAttempt: number;
	// GEO-206: Lead ID for bidirectional communication
	leadId?: string;
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
	/** FLY-137 v1.27.2: Lead override agent name (bypasses label match) */
	agentName?: string;
	/** FLY-137 v1.27.2: pre-normalized lowercased Linear labels */
	issueLabels?: string[];
	/** FLY-137 v1.27.2: owning dept (or "multiple"/undefined per DepartmentRegistry resolution) */
	owningDept?: string | "multiple";
	/**
	 * FLY-137 Phase 5: codex-skip label snapshot. On retry, runs-route /
	 * actions.ts re-fetches Linear labels when LINEAR_API_KEY is set; falls
	 * back to the stored session value otherwise.
	 */
	codexSkip?: boolean;
	/**
	 * FLY-205: doc tier carried over from the predecessor session row
	 * (`session.doc_tier`). Retry must REUSE the original tier — a missing
	 * value (pre-FLY-205 session) falls back to "full" downstream. Never let
	 * a retry silently upgrade a plan_only/none run back to full docs.
	 */
	docTier?: "full" | "plan_only" | "none";
	/**
	 * FLY-205: Linear issue URL from the predecessor session row
	 * (`session.issue_url`) — keeps the DOC-FLOW header identical between
	 * start and retry prompts.
	 */
	issueUrl?: string;
	/**
	 * FLY-245 D2 (plan §5.2.1): gateway pre-bound successor execution id.
	 * When present the dispatcher MUST use it instead of generating a fresh
	 * randomUUID, so crash recovery can reconcile / idempotently re-drive by a
	 * key that was durably bound BEFORE dispatch. Absent → legacy behavior
	 * (fresh UUID), byte-compatible.
	 */
	successorExecutionId?: string;
}

export interface RetryResult {
	newExecutionId: string;
	oldExecutionId: string;
}

export interface IRetryDispatcher {
	dispatch(req: RetryRequest): Promise<RetryResult>;
	getInflightIssues(): Set<string>;
	/** FLY-59: Check if a specific issue+role combo is currently inflight */
	hasInflightForRole(issueId: string, role: string): boolean;
	stopAccepting(): void;
	drain(): Promise<void>;
	teardownRuntimes(): Promise<void>;
}

/** GEO-267: Start a new Runner execution (no predecessor session) */
export interface StartRequest {
	issueId: string;
	projectName: string;
	leadId?: string;
	/** FLY-24: Pre-fetched issue title from runs-route Linear pre-flight */
	issueTitle?: string;
	/** FLY-24: Pre-fetched issue identifier (e.g. "GEO-304") from runs-route Linear pre-flight */
	issueIdentifier?: string;
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
	/** FLY-137 v1.27.2: explicit Lead override (bypasses label match in AgentDispatcher) */
	agentName?: string;
	/**
	 * FLY-137 v1.27.2: pre-normalized lowercased Linear labels. runs-route.ts
	 * normalizes once at the boundary; downstream code never re-lowercases.
	 */
	issueLabels?: string[];
	/**
	 * FLY-137 v1.27.2: owning dept of the issue, resolved via
	 * `DepartmentRegistry.getDepartmentForIssue`. AgentDispatcher's dept-aware
	 * step 2 uses this to scope label match.
	 *   - string: exactly one Lead matched
	 *   - "multiple": 2+ Leads matched (FLY-127 ambiguous case)
	 *   - undefined: no Lead matched
	 */
	owningDept?: string | "multiple";
	/**
	 * FLY-137 Phase 5: codex-skip label snapshot at run start. Persisted on
	 * the session row so the event-route stage_changed handler can read
	 * without re-hitting Linear at every transition.
	 */
	codexSkip?: boolean;
	/**
	 * FLY-205: Lead-judged doc tier (validated at the runs-route boundary via
	 * `parseDocTier`). Undefined → effective "full" downstream. Persisted on
	 * the session row (effective value) so retry reuses it.
	 */
	docTier?: "full" | "plan_only" | "none";
	/** FLY-205: Linear issue URL from runs-route preflight (DOC-FLOW header). */
	issueUrl?: string;
}

export interface StartResult {
	executionId: string;
	issueId: string;
}

export interface IStartDispatcher {
	start(req: StartRequest): Promise<StartResult>;
	/** Current count of inflight (dispatched but not yet completed) executions */
	getInflightCount(): number;
	/**
	 * FLY-137 v1.27.2 (Codex Track A #2): synchronous validation of a Lead-provided
	 * `agentName` before `start()` is called. Returns `{ ok: true }` on valid name
	 * (project's agents map OR the reserved "generic"). Returns `{ ok: false, ... }`
	 * with the `available` list when the name is unknown, so runs-route can map to
	 * a FLY-127-shaped 400 INVALID_AGENT_NAME response before kicking off async work.
	 *
	 * Returns `{ ok: false, reason: "project_unknown" }` when the project isn't
	 * registered. Returns `{ ok: true }` when `agentName` is undefined/null (no
	 * override) — caller decides whether to invoke this method.
	 */
	validateAgentName(
		projectName: string,
		agentName: string | undefined,
	):
		| { ok: true }
		| { ok: false; reason: "unknown_agent"; available: string[] }
		| { ok: false; reason: "project_unknown" };
}
