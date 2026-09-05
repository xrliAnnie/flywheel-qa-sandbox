/** GEO-168: IRetryDispatcher interface — retry creates a new execution. */

import type {
	DesignBackend,
	PonytailInput,
	PonytailRetryInput,
	RoleEffort,
	SkillFrameworkMode,
	WorkflowDispatchVendor,
} from "flywheel-config";
import type { LaunchPrecommitOutcome } from "flywheel-core";
import type {
	WorkflowIssueDeliveryInput,
	WorkflowResumeContext,
} from "flywheel-edge-worker/dist/Blueprint.js";

export type { WorkflowResumeContext };

export interface GeneralizedExecutionDispatch {
	/** True only for a typed run whose transitions are owned by the DAG engine. */
	engineOwned?: boolean;
	executionId: string;
	/** Exact StateStore admission bound before dispatch. Required when engineOwned. */
	activationId?: string;
	runId: string;
	nodeId: string;
	attempt: number;
	snapshotDigest: string;
	gateCarrierEpoch: 0 | 1;
	dispatch: {
		vendor: "claude" | "codex";
		model: string;
		effort?: RoleEffort;
	};
	capabilities: Record<string, boolean | string>;
	agentContent: string;
	outputCredential?: string;
	submissionCredential?: string;
	idempotencyKey: string;
	launchGateToken?: string;
	commitWorkflowLaunch?: () => { ok: boolean; reason?: string };
	prepareWorkflowIssueDelivery?: (input: WorkflowIssueDeliveryInput) => void;
	/** Persist CommDB's granted TURN epoch into the activation ledger before launch. */
	projectTurn?: (input: {
		activationId: string;
		issueId: string;
		executionId: string;
		epoch: number;
		sourceEventId: string;
		grantedAt: string;
	}) => { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
	/** Current launch-owner generation, used to bind physical tmux identity. */
	launchGeneration?: number;
}

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
	 * FLY-1224: per-phase vendor (phase table output; Bridge-INTERNAL, never on
	 * the HTTP body). Only transported vendors — a no-transport backend can
	 * never enter phase dispatch. actions.ts re-derives it from the phase table
	 * for PHASE rows; undefined for every non-phase retry (byte-compatible).
	 */
	dispatchVendor?: WorkflowDispatchVendor;
	/** FLY-1224: per-phase reasoning effort (phase table output). */
	dispatchEffort?: RoleEffort;
	/** FLY-1259: effective design backend locked at DAG workflow admission. */
	designBackend?: DesignBackend;
	/**
	 * FLY-1356: per-dispatch skill-framework arm continuation. Set ONLY when the
	 * predecessor session was itself explicitly overridden (via === "override")
	 * — a 529 forced arm stays forced for the whole retry/successor pipeline.
	 * The resolver ignores it outside `split` (kill total-semantics, R1#1).
	 */
	skillFrameworkMode?: SkillFrameworkMode;
	/** FLY-1609: frozen predecessor intent plus this retry's fresh selector. */
	ponytailRetry?: PonytailRetryInput;
	/**
	 * FLY-245 D2 (plan §5.2.1): gateway pre-bound successor execution id.
	 * When present the dispatcher MUST use it instead of generating a fresh
	 * randomUUID, so crash recovery can reconcile / idempotently re-drive by a
	 * key that was durably bound BEFORE dispatch. Absent → legacy behavior
	 * (fresh UUID), byte-compatible.
	 */
	successorExecutionId?: string;
	/**
	 * FLY-793: DAG workflow shares the parent issue's single branch B.
	 * Bridge-INTERNAL; carried on the retry path so a retried phase keeps the
	 * shared-branch behavior. Absent → role-aware worktree key (byte-compatible).
	 */
	shareParentBranch?: boolean;
	/** Bridge-derived pinned-graph identity; never accepted from public HTTP. */
	loopTarget?: { nodeId: string };
	/**
	 * FLY-887 R2 (Codex R1 #2): carried on the retry path for PHASE rows
	 * (`chat_thread_role` ∈ design/implement/qa) so a refreshed Linear label
	 * cannot bypass the phase table on retry — previously the retry path
	 * hardcoded this to undefined, re-opening the label layer that the original
	 * phase dispatch had bypassed. actions.ts sets it from the predecessor row's
	 * phase marker; absent → existing label-driven resolution (byte-compatible
	 * for `chat_thread_role='main'` rows, incl. auto-QA).
	 */
	ignoreRunnerLabelSelection?: boolean;
	/** FLY-1281: Bridge-internal, pre-bound generalized retry execution. */
	generalizedExecution?: GeneralizedExecutionDispatch;
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
	/**
	 * FLY-1279 B2: durable recovery successor id. The coordinator persists this
	 * before dispatch so a crash can adopt/re-drive the same physical launch.
	 * Absent keeps the fresh-start random UUID behavior.
	 */
	successorExecutionId?: string;
	leadId?: string;
	/** FLY-24: Pre-fetched issue title from runs-route Linear pre-flight */
	issueTitle?: string;
	/** FLY-24: Pre-fetched issue identifier (e.g. "GEO-304") from runs-route Linear pre-flight */
	issueIdentifier?: string;
	/** Bridge-derived founder-visible route line; never accepted from HTTP input. */
	routeSummary?: string;
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
	 * FLY-1224: per-phase vendor (phase table output; Bridge-INTERNAL — set only
	 * by the workflow engine / the server-side DAG workflow entry, never from
	 * the public `/api/runs/start` body). Only transported vendors. Absent →
	 * the resolver's FLY-728 claude-tmux behavior (byte-compatible).
	 */
	dispatchVendor?: WorkflowDispatchVendor;
	/** FLY-1224: per-phase reasoning effort (phase table output). */
	dispatchEffort?: RoleEffort;
	/** FLY-1259: effective design backend locked at DAG workflow admission. */
	designBackend?: DesignBackend;
	/**
	 * FLY-1356: explicit per-dispatch skill-framework arm (529 eval forced-arm).
	 * Validated at the runs-route boundary (∈ three modes AND flag === split).
	 * Sticky for the whole pipeline via the session-row via="override" record.
	 */
	skillFrameworkMode?: SkillFrameworkMode;
	/**
	 * Explicit git start point for the worktree (a commit SHA / ref), threaded to
	 * `WorktreeManager.create({ startPoint })` for internal resume/dispatch flows.
	 * Absent → existing behavior (`FLYWHEEL_RUNNER_START_POINT` / `origin/main`).
	 */
	startPoint?: string;
	/** FLY-1707: Bridge-internal resume admission; never accepted from HTTP. */
	workflowResume?: WorkflowResumeContext;
	/**
	 * FLY-1718 P1: authenticated human override that deliberately starts from
	 * main even when the managed origin branch exists. Only runs-route may mint
	 * this object; engine/reconcile/retry callers leave it absent.
	 */
	freshStart?: {
		authority: "authenticated_runs_route";
		actor: string;
		reason: string;
	};
	/**
	 * FLY-643: when true, the runner's executor backend is resolved WITHOUT the
	 * issue's vendor labels (project roles config > env > built-in claude-tmux).
	 * `issueLabels` is still carried on the BlueprintContext for Lead/thread
	 * routing — only the backend-selection label layer is bypassed.
	 *
	 * Generalized DAG dispatches use this so the phase table, not issue vendor
	 * labels, selects the execution backend.
	 */
	ignoreRunnerLabelSelection?: boolean;
	/**
	 * FLY-615: per-run + per-issue ponytail signal (run-param override + issue
	 * labels + read status), built by runs-route. Resolved against project
	 * config in Blueprint. Absent → Blueprint falls back to hydrated labels.
	 */
	ponytailInput?: PonytailInput;
	/**
	 * FLY-793: DAG workflow shares the parent issue's single branch B.
	 * Bridge-INTERNAL — set ONLY by the workflow engine when dispatching a
	 * Design/Implement/QA phase-session; MUST NEVER be populated from the public
	 * `/api/runs/start` body or a runner payload (runs-route does not read it).
	 * Threaded to `BlueprintContext.shareParentBranch`. Absent → role-aware
	 * worktree key (byte-compatible).
	 */
	shareParentBranch?: boolean;
	/** Bridge-derived pinned-graph identity; never accepted from public HTTP. */
	loopTarget?: { nodeId: string };
	/**
	 * FLY-859: fix-round context for an Implement-fix dispatch after a
	 * DAG workflow QA FAIL. Bridge-INTERNAL — set ONLY by the workflow engine;
	 * MUST NEVER be populated from the public `/api/runs/start` body or a
	 * runner payload (runs-route does not read it). Threaded to
	 * `BlueprintContext.phaseFixContext`. Absent → plain implement prompt
	 * (byte-compatible).
	 */
	phaseFixContext?: { round: number; qaSummary: string };
	/**
	 * FLY-1232 module ②: SEMANTIC shadow context for the T2/T7 spawn moments
	 * (node / attempt / preceding edge — NEVER an ordinal, which only the
	 * writer allocates in-transaction). Bridge-INTERNAL — set ONLY by the
	 * workflow engine; runs-route does not read it. Absent → the pre-launch
	 * seam synthesizes the T1 default ({node: role, attempt: 1}) when a shadow
	 * writer is present, and is entirely inert when it is not.
	 */
	/** FLY-1281: Bridge-internal, pre-bound generalized node execution. */
	generalizedExecution?: GeneralizedExecutionDispatch;
}

export interface StartResult {
	executionId: string;
	issueId: string;
	/** Resolves at launch commit or a proven pre-commit failure; never rejects. */
	launchOutcome?: Promise<LaunchPrecommitOutcome>;
}

export interface IStartDispatcher {
	start(req: StartRequest): Promise<StartResult>;
	/** FLY-1279: fail-closed recovery gate; production RunDispatcher implements it. */
	hasInflightForRole?(issueId: string, role: string): boolean;
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
