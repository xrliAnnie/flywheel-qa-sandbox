/** GEO-168: IRetryDispatcher interface — retry creates a new execution. */

// FLY-579: QaContext is defined in edge-worker (Blueprint owns the prompt
// rendering); teamlead depends on edge-worker, so we import the type here for
// StartRequest. Defining it in teamlead would invert the dependency.
import type { PonytailInput } from "flywheel-config";
import type { QaContext } from "flywheel-edge-worker/dist/Blueprint.js";

export type { QaContext };

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
	 * FLY-728 Part C: the difficulty-sorter's dispatch model. On retry it is
	 * the predecessor's persisted `dispatch_model` (actions.ts reads the
	 * session row) — NEVER `runner_model`, which is display/audit output and
	 * would smuggle stale label/project/account choices back in (FLY-751
	 * Codex R1 #2). The label layer re-resolves a manual label first, so this
	 * only re-applies a genuinely dispatch-chosen model. Absent → no dispatch
	 * override.
	 */
	dispatchModel?: string;
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
	/**
	 * FLY-728 Part C: the per-run `/api/runs/start` `model` param — the
	 * difficulty-sorter's output, normalized to a canonical tier id + whitelisted
	 * at the runs-route boundary (`normalizeDispatchModel`). Applied below a
	 * manual model/vendor label and above the project default. Absent → no
	 * dispatch override (byte-compatible).
	 */
	dispatchModel?: string;
	/**
	 * FLY-579: explicit git start point for the worktree (a commit SHA / ref).
	 * Threaded to `WorktreeManager.create({ startPoint })`. The Auto-QA
	 * coordinator passes the parent main session's `pr_head_sha` so the QA
	 * worktree is pinned to the exact reviewed commit (NOT `origin/main`).
	 * Absent → existing behavior (`FLYWHEEL_RUNNER_START_POINT` / `origin/main`).
	 */
	startPoint?: string;
	/**
	 * FLY-579: QA-runner context. Present ONLY for `sessionRole === "qa"`
	 * Auto-QA spawns. Blueprint renders it into a QA-mode prompt (independent
	 * verification of `parentExecutionId`'s PR at `prHeadSha`) and the QA runner
	 * reports its verdict back via `flywheel-comm qa-result --target-exec
	 * <parentExecutionId>`.
	 */
	qaContext?: QaContext;
	/**
	 * FLY-643: when true, the runner's executor backend is resolved WITHOUT the
	 * issue's vendor labels (project roles config > env > built-in claude-tmux).
	 * `issueLabels` is still carried on the BlueprintContext for Lead/thread
	 * routing — only the backend-selection label layer is bypassed.
	 *
	 * Auto-QA sets this so a QA runner spawned on a separate QA·FLY-XX issue (or
	 * mirroring the parent's labels) cannot inherit the parent task's vendor
	 * backend (e.g. `agy`/`kimi` → no-transport) and must run on the normal
	 * transported Claude lane (Claude-in-Chrome E2E). Absent → existing
	 * label-driven backend resolution (byte-compatible).
	 */
	ignoreRunnerLabelSelection?: boolean;
	/**
	 * FLY-752: require a MAILBOX-CAPABLE executor backend. Auto-QA sets this so the
	 * QA runner can always receive a `retest_wake` across the fix loop. If backend
	 * resolution would pick a no-transport lane (antigravity/kimi → transport:none,
	 * even after `ignoreRunnerLabelSelection` because project roles / env default
	 * still apply), it is FORCED to `claude-tmux` (and the no-transport role/env
	 * runner model is dropped to the Claude account default, since it may be
	 * Claude-incompatible). Absent → no forcing (byte-compatible).
	 */
	requireMailboxTransport?: boolean;
	/**
	 * FLY-615: per-run + per-issue ponytail signal (run-param override + issue
	 * labels + read status), built by runs-route. Resolved against project
	 * config in Blueprint. Absent → Blueprint falls back to hydrated labels.
	 */
	ponytailInput?: PonytailInput;
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
