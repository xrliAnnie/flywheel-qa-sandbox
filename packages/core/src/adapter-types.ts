/**
 * Unified Adapter Protocol — GEO-157
 *
 * Replaces three runner interfaces (IFlywheelRunner, IAgentRunner, ISimpleAgentRunner)
 * with a single IAdapter interface that supports both fire-and-forget execution
 * (DAG path) and interactive streaming sessions (Edge Worker path).
 *
 * @see doc/engineer/plan/archive/v1.2.0-GEO-157-adapter-protocol-heartbeat.md
 */

import type {
	HookCallbackMatcher,
	HookEvent,
	McpServerConfig,
	OutputFormat,
} from "@anthropic-ai/claude-agent-sdk";

import type {
	AgentMessage,
	IMessageFormatter,
	OnAskUserQuestion,
} from "./agent-runner-types.js";

import type { ILogger } from "./logging/index.js";

// Re-export types that AdapterSession depends on (consumers shouldn't need
// to import from agent-runner-types directly for these)
export type { AgentMessage, IMessageFormatter, OnAskUserQuestion };

// ---------------------------------------------------------------------------
// IAdapter — Core interface
// ---------------------------------------------------------------------------

/**
 * Unified adapter interface for Flywheel agent execution.
 *
 * Supports two execution modes:
 * - **Fire-and-forget** (`execute`): Used by Blueprint for autonomous
 *   task execution. All adapters must implement this.
 * - **Interactive streaming** (`startSession`): Used by EdgeWorker for Linear agent
 *   sessions with real-time message exchange. Only adapters with
 *   `supportsStreaming: true` implement this.
 *
 * @example
 * ```typescript
 * // DAG path — fire-and-forget
 * const adapter = registry.get("claude-cli");
 * const result = await adapter.execute(ctx);
 *
 * // Edge Worker path — interactive streaming
 * if (adapter.supportsStreaming) {
 *   const session = await adapter.startSession!(ctx);
 *   session.addMessage("Additional context from user");
 * }
 * ```
 */
export interface IAdapter {
	/** Adapter type identifier (e.g., "claude-cli", "claude-sdk", "codex-cli") */
	readonly type: string;

	/** Whether this adapter supports interactive streaming sessions */
	readonly supportsStreaming: boolean;

	/** Environment pre-check (e.g., verify CLI is installed, API key valid) */
	checkEnvironment(): Promise<AdapterHealthCheck>;

	/** Fire-and-forget execution (DAG path) */
	execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;

	/** Post-execution cleanup (e.g., release tmux window) */
	cleanup?(ctx: AdapterExecutionContext): Promise<void>;

	/**
	 * Start an interactive streaming session (Edge Worker path).
	 * Only available when `supportsStreaming` is true.
	 */
	startSession?(ctx: AdapterExecutionContext): Promise<AdapterSession>;
}

// ---------------------------------------------------------------------------
// AdapterSession — Interactive session handle
// ---------------------------------------------------------------------------

/**
 * Handle to a running interactive agent session.
 *
 * Wraps the streaming lifecycle methods previously on IAgentRunner.
 * Returned by `IAdapter.startSession()`.
 */
export interface AdapterSession {
	/** Agent session ID (null until provider assigns one) */
	readonly sessionId: string | null;

	/** When the session started */
	readonly startedAt: Date;

	/** Adapter/provider type (e.g., "claude-sdk") — used by AgentSessionManager
	 *  to decide which session ID field to populate (claudeSessionId, etc.) */
	readonly adapterType: string;

	/** Inject a message into the running session */
	addMessage(content: string): void;

	/** Signal that no more messages will be added */
	completeStream(): void;

	/** Whether the session is in streaming mode and accepting messages */
	isStreaming(): boolean;

	/** Stop the session */
	stop(): void;

	/** Whether the session is currently running */
	isRunning(): boolean;

	/** Get all messages from the session */
	getMessages(): AgentMessage[];

	/** Get the message formatter for this adapter */
	getFormatter(): IMessageFormatter;
}

// ---------------------------------------------------------------------------
// AdapterExecutionContext — Execution parameters
// ---------------------------------------------------------------------------

/**
 * Context passed to `IAdapter.execute()` and `IAdapter.startSession()`.
 *
 * Unifies fields from FlywheelRunRequest (DAG path) and AgentRunnerConfig
 * (Edge Worker path) into a single structure.
 */
export interface AdapterExecutionContext {
	// -- Identity --

	/** Execution ID — matches the existing DAG/Blueprint/StateStore executionId */
	executionId: string;
	/** Issue identifier (e.g., "GEO-95") */
	issueId: string;

	// -- Execution parameters --

	/** The prompt to send to the agent */
	prompt: string;
	/** Working directory for the agent session */
	cwd: string;
	/** FLY-1961: seed this real worktree in the selected vendor trust store. */
	pretrustWorkspace?: boolean;
	/** AI model to use (e.g., "opus", "sonnet") */
	model?: string;
	/**
	 * FLY-671: reasoning-effort level (`low|medium|high|xhigh|max`). Consumed by
	 * the claude-tmux runner as CLI `--effort`, and (FLY-1224) by the codex-tmux
	 * runner as a daemon spawn override `-c model_reasoning_effort="<effort>"`.
	 * Absent ⇒ no flag / no override (account or CODEX_HOME config default).
	 */
	effort?: string;
	/** Permission mode (e.g., "bypassPermissions", "plan") */
	permissionMode?: string;
	/** Additional text to append to the system prompt */
	appendSystemPrompt?: string;
	/** Allowed tool patterns (e.g., ["Read(**)", "Edit(**)", "Bash"]) */
	allowedTools?: string[];
	/**
	 * FLY-615: enable the ponytail (code-minimalism) behavior for this run.
	 * Resolved by Blueprint from the three-layer ladder + readiness. The
	 * backend decides HOW: Claude (TmuxAdapter) adds `--settings enabledPlugins`
	 * to load the real plugin; Codex (CodexTmuxAdapter) injects the portable
	 * ponytail ruleset into the instruction layer. Absent/false = no change
	 * (byte-compatible spawn).
	 */
	enablePonytail?: boolean;
	/** FLY-1395: resolved prompt/skill arm for a Codex runner. */
	skillFrameworkMode?: "superpowers" | "matt" | "bare";
	/** Fully-qualified machine-global Codex skill names disabled for this run. */
	codexSkillDisableNames?: string[];
	/** Verified vendored matt-skills source copied into this run's CODEX_HOME. */
	codexMattSkillsSourceDir?: string;
	/**
	 * FLY-751: per-runner MCP slimming. Marketplace-qualified plugin keys to
	 * disable for THIS launch (merged into the same `--settings enabledPlugins`
	 * map ponytail uses, as `false` entries). Resolved by the dispatcher via
	 * `resolveRunnerMcpProfile` (flywheel-config) — claude-tmux only. Absent or
	 * empty = no change (byte-compatible spawn).
	 */
	disabledPlugins?: string[];
	/**
	 * FLY-751: when true the launch gets `--no-chrome` (Claude-in-Chrome
	 * integration off). QA runners keep the browser (the profile resolver
	 * exempts them). Absent/false = no change (byte-compatible spawn).
	 */
	disableChrome?: boolean;
	/**
	 * FLY-1185 §2.7: marketplace-qualified plugin keys to POSITIVELY enable
	 * (`true` entries in the per-launch `--settings enabledPlugins` merge,
	 * applied AFTER disabledPlugins so an explicit opt-in wins). The playwright
	 * opt-in channel that overrides the machine-level default-off (QA role /
	 * `playwright` label / `full-mcp` label). Absent/empty = no change.
	 */
	enabledPluginsExtra?: string[];
	/** Maximum number of agentic turns */
	maxTurns?: number;
	/** Process-level timeout in milliseconds */
	timeoutMs?: number;
	/**
	 * FLY-1269: explicit DAG workflow Codex phase lifetime. Present only for a
	 * share-parent Design/Implement/QA execution while the keep-alive flag is on.
	 * Adapters must not infer this identity from environment variables or labels.
	 */
	phaseKeepAlive?: { role: "design" | "implement" | "qa" };

	// -- Session persistence --

	/**
	 * State from a previous execution for session resume.
	 *
	 * NOTE: TmuxAdapter ignores this (tmux interactive mode doesn't support resume).
	 * ClaudeCodeAdapter uses `previousSession.sessionId` with `--resume` flag.
	 * ClaudeAdapter (SDK) uses `previousSession.sessionId` with `resumeSessionId`.
	 */
	previousSession?: Record<string, unknown>;

	// -- DAG path specific --

	/** Human-readable label for UI display (e.g., "GEO-101-Fix the bug") */
	label?: string;
	/** Path to sentinel file for land-status detection (TmuxAdapter only) */
	sentinelPath?: string;
	/** Display name for the Claude session (passed as --name to CLI) */
	sessionDisplayName?: string;

	// -- Edge Worker path specific --

	/** Workspace name for logging and organization */
	workspaceName?: string;
	/** Directories the agent can read from */
	allowedDirectories?: string[];
	/** Flywheel home directory */
	flywheelHome?: string;
	/** Path(s) to MCP configuration file(s) */
	mcpConfigPath?: string | string[];
	/** MCP server configurations (inline) */
	mcpConfig?: Record<string, unknown>;
	/** Event hooks for customizing agent behavior */
	hooks?: Record<string, unknown>;
	/** Callback for AskUserQuestion tool invocations */
	onAskUserQuestion?: OnAskUserQuestion;

	// -- GEO-206: Lead ↔ Runner communication --

	/** SQLite DB path for flywheel-comm CLI */
	commDbPath?: string;
	/** Timeout when waiting for Lead response (ms). Default: 176_400_000 (49h, FLY-159 — 48h gate timeout + 1h buffer; was 12h pre-FLY-159, raised through 25h before settling at 49h) */
	waitingTimeoutMs?: number;
	/** Lead agent ID (for session registration) */
	leadId?: string;
	/** Project name (for session registration) */
	projectName?: string;
	/**
	 * FLY-2147: per-launch role-memory disposition. `disabled` asks the Claude
	 * adapter to pass autoMemoryEnabled:false (fail-closed); for a
	 * policy_conflict the effective state remains unknown because managed
	 * settings can outrank the launch settings. Undefined is reserved for
	 * backends whose spawn contract is untouched.
	 */
	runnerMemory?:
		| {
				status: "mounted";
				dir: string;
				/** FLY-2148: bounded spawn-time MEMORY.md measurement for closeout comparison. */
				snapshot?: {
					lines: number;
					linesExact: boolean;
					bytes: number;
					sha16: string;
					topicFiles: number;
				};
		  }
		| { status: "disabled"; reason: string };

	// -- FLY-142 Phase 0 PR 1.2: Agent Team transport identity --
	//
	// These fields drive the vendor-neutral `IAgentTeamTransport` adapter
	// (packages/agent-team-transport). When set, TmuxAdapter calls
	// `transport.buildRunnerSpawnConfig(ctx)` to merge vendor-specific env +
	// CLI flags into the spawn invocation. When absent (current production),
	// transport wiring is skipped and Runner spawns the same as before.
	//
	// Default vendor is `claude-code` (selected by `FLYWHEEL_AGENT_BACKEND`
	// env at AgentTeamTransportFactory.fromEnv() call site).

	/** Agent name within the team (e.g. "runner-FLY-142-abc1") */
	agentName?: string;
	/** Lead's team this Runner joins (typically equals leadId) */
	teamName?: string;
	/**
	 * Lead's claude session UUID — passed as `--parent-session-id` so the
	 * Runner appears as a child of the Lead session in claude-code's UI.
	 */
	leadSessionId?: string;
	/** UI color hint passed as `--agent-color` (e.g. "cyan", "red") */
	agentColor?: string;
	/**
	 * Vendor backend selector. When set, signals Blueprint/TmuxAdapter to
	 * activate transport wiring. When absent, no transport wiring (backward-
	 * compat default = production today).
	 */
	vendor?: "claude-code" | "codex";

	// -- GEO-292: Bridge connection for stage reporting --

	/** Bridge URL for stage reporting (e.g., http://localhost:4100) */
	bridgeUrl?: string;
	/** Optional ingest token for Bridge authentication */
	bridgeIngestToken?: string;
	/**
	 * FLY-1244: short-lived credential bound to this exact enrolled workflow
	 * execution. Used only by the dedicated workflow verdict endpoint; unlike the
	 * fleet-wide ingest bearer, a leak is scoped to one execution + TTL.
	 */
	workflowSubmissionCredential?: string;
	/** FLY-1425: engine-owned runners must never fall back to legacy /events. */
	workflowSubmissionExpected?: boolean;
	/** FLY-1281: one-shot credential for a generalized generic node output. */
	workflowOutputCredential?: string;
	/** Sealed product-node capability; enables the founder_review CLI/prompt contract. */
	founderReviewRequired?: boolean;
	/**
	 * FLY-191 Phase 2: the Bridge's StateStore path, propagated to the Runner
	 * env as FLYWHEEL_STATE_DB_PATH so `flywheel-comm verify-approval` reads
	 * the SAME StateStore the Bridge writes. Without it both sides only agree
	 * by the ~/.flywheel/teamlead.db default-path coincidence — any deployment
	 * with a custom TEAMLEAD_DB_PATH (test slots, future multi-Bridge) would
	 * leave the Runner verifying against the wrong DB and fail-closed forever.
	 */
	stateDbPath?: string;

	/**
	 * FLY-795: the resolved `progress.md` path, propagated to the Runner env as
	 * FLYWHEEL_PROGRESS_PATH so a RESUMED runner writes its cursor back to the
	 * exact same branch-committed file the prior runner used (via
	 * `flywheel-comm progress --file $FLYWHEEL_PROGRESS_PATH`). Set only for a
	 * restart-resume; a fresh runner derives progress.md inside its own doc folder.
	 */
	progressPath?: string;

	// -- Callbacks --

	/** Log output callback (stdout/stderr from CLI process) */
	onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
	/** Message callback (each agent message as it arrives) */
	onMessage?: (message: AgentMessage) => void | Promise<void>;
	/** Error callback */
	onError?: (error: Error) => void | Promise<void>;
	/** Completion callback (all messages when session ends) */
	onComplete?: (messages: AgentMessage[]) => void | Promise<void>;

	/**
	 * Heartbeat callback — cross-package transport.
	 *
	 * Injected by Blueprint. TmuxAdapter calls this during its poll loop
	 * and immediately on start. Blueprint routes it through
	 * ExecutionEventEmitter → TeamLead /events/heartbeat route.
	 *
	 * The adapter (claude-runner) never directly depends on StateStore (teamlead).
	 */
	onHeartbeat?: (executionId: string) => void;

	/**
	 * FLY-116: fired by TmuxAdapter immediately after `tmux new-window` returns
	 * a windowId, BEFORE waiting for runner completion. Used to spawn a per-runner
	 * macOS Terminal.app viewer with a unique custom title (status-dominant close
	 * later by closeRunner / postMergeTmuxCleanup / actions cleanup).
	 *
	 * Best-effort — adapter wraps in try/catch; failures non-fatal.
	 */
	onTmuxWindowCreated?: (info: {
		baseSessionName: string;
		windowId: string;
	}) => void;
	/**
	 * FLY-245 R2 HIGH-3 — fired SYNCHRONOUSLY the instant `tmux new-window`
	 * returns a windowId, BEFORE CommDB registration (which is non-fatal) and
	 * before the agent is usable. The gateway-retry dispatcher binds this to its
	 * durable launch claim so a post-crash replay can discover the live Runner by
	 * execId and adopt it rather than re-driving (which would orphan it). Distinct
	 * from `onTmuxWindowCreated` (viewer spawn, fired later). For claude-tmux this
	 * is a required launch fence: the callback must durably persist and re-read
	 * the tmux generation tuple before the gated runner is released.
	 */
	onTmuxWindowOpened?: (info: {
		baseSessionName: string;
		windowId: string;
		socketPath: string;
		serverStartTime: string;
		executionId: string;
		launchGeneration?: number;
		launchFingerprint?: string;
	}) => void;
	/**
	 * FLY-245 R5 HIGH — the DURABLE "this Runner is committed to start" record.
	 * Set ONLY on the gateway-retry path. The adapter GATES the Runner on this
	 * path (Claude/Codex cannot start until the adapter writes this file) and
	 * writes it at the single commit point. The dispatcher's post-crash adopt
	 * decision is `claim exists + this file exists → adopt; else re-drive`, so a
	 * window recorded but NEVER committed (crash between window-open and commit)
	 * is re-driven, never adopted as a started Runner. Deterministic path keyed by
	 * executionId so a replay (new Bridge process) computes the same path.
	 */
	launchCommitPath?: string;
	/** FLY-1281: deterministic fenced token for the generalized launch gate. */
	launchGateToken?: string;
	launchGeneration?: number;
	launchFingerprint?: string;
	workflowTmuxWindowAuthority?: (candidate: {
		windowId: string;
		windowName: string;
		executionId?: string;
		launchGeneration?: number;
		launchFingerprint?: string;
	}) => "prune" | "keep";
	/** Bridge-owned marker-first commit; adapters must not write the marker directly. */
	commitWorkflowLaunch?: () => { ok: boolean; reason?: string };
}

// ---------------------------------------------------------------------------
// AdapterExecutionResult — Execution output
// ---------------------------------------------------------------------------

/**
 * A machine-readable terminal failure that must survive adapter, orchestration,
 * and Bridge boundaries. Unknown failures deliberately remain on the legacy
 * untyped `failed` path.
 */
export type TerminalFailureKind =
	| "goal_blocked"
	| "worktree_takeover_failed"
	| "reown_exhausted";

export interface TerminalFailureInfo {
	failureKind: TerminalFailureKind;
	failureReason: string;
	failureClass?: "environment";
	failureCode?: string;
}

/** FLY-1638: machine-readable failure before the workflow launch fence commits. */
export type LaunchPrecommitFailure =
	| {
			code: "LAUNCH_COMMAND_OVERSIZE";
			reason: "tmux_command_budget" | "prompt_size_budget";
			physicalEvidence: "absent";
	  }
	| {
			code: "LAUNCH_TMUX_SESSION_HELD";
			reason:
				| "saturated"
				| "split_brain"
				| "ambiguous"
				| "unknown"
				| "rescue_failed"
				| "lock_unavailable";
			physicalEvidence: "absent";
	  }
	| {
			code: "LAUNCH_WINDOW_IDENTITY_FAILED";
			reason: "identity_publish_failed" | "generation_record_failed";
			physicalEvidence: "cleaned" | "unknown";
	  }
	| {
			code: "LAUNCH_PRECOMMIT_TIMEOUT";
			reason: "deadline_exhausted";
			physicalEvidence: "unknown";
	  }
	| {
			code: "LAUNCH_PRECOMMIT_FAILED";
			reason: string;
			physicalEvidence: "cleaned" | "unknown";
	  };

export type LaunchPrecommitOutcome =
	| { status: "committed" }
	| { status: "precommit_failed"; failure: LaunchPrecommitFailure };

/**
 * Result returned by `IAdapter.execute()`.
 *
 * Unifies FlywheelRunResult (DAG path) fields with additional session
 * persistence and message history support.
 */
export interface AdapterExecutionResult {
	/** Whether the agent completed successfully */
	success: boolean;
	/** Agent session ID */
	sessionId: string;
	/** Total duration in milliseconds */
	durationMs?: number;
	/** True if terminated by timeout */
	timedOut?: boolean;
	/** Total API cost in USD (if available) */
	costUsd?: number;
	/** Number of agentic turns used */
	numTurns?: number;
	/** The agent's text result */
	resultText?: string;
	/** Typed terminal cause for failures whose semantics must not be flattened. */
	failure?: TerminalFailureInfo;

	// -- Session persistence --

	/**
	 * State to persist for next execution (session resume).
	 * Written to StateStore via ExecutionEventEmitter → /events/session_params.
	 */
	sessionParams?: Record<string, unknown>;

	// -- DAG path specific --

	/** tmux target — format "session:@window_id" (TmuxAdapter only) */
	tmuxWindow?: string;

	// -- Usage tracking --

	/** Token usage (if available) */
	usage?: { inputTokens: number; outputTokens: number };

	/**
	 * Message history from the session.
	 * Used by Edge Worker non-streaming path (GitHub reply) where
	 * execute() is called instead of startSession().
	 */
	messages?: AgentMessage[];
}

// ---------------------------------------------------------------------------
// AdapterHealthCheck — Environment check result
// ---------------------------------------------------------------------------

/**
 * Result of `IAdapter.checkEnvironment()`.
 */
export interface AdapterHealthCheck {
	/** Whether the adapter is ready to execute */
	healthy: boolean;
	/** Human-readable status message */
	message: string;
	/** Optional metadata (e.g., CLI version, API endpoint) */
	details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AdapterConfig — Configuration for adapter construction
// ---------------------------------------------------------------------------

/**
 * Generic adapter configuration.
 *
 * Replaces AgentRunnerConfig. Provider-specific configs (ClaudeAdapterConfig)
 * extend this with additional fields.
 */
export interface AdapterConfig {
	/** Working directory for the agent session */
	workingDirectory?: string;
	/** List of allowed tool patterns */
	allowedTools?: string[];
	/** List of disallowed tool patterns */
	disallowedTools?: string[];
	/** Directories the agent can read from */
	allowedDirectories?: string[];
	/** Session ID to resume from a previous session */
	resumeSessionId?: string;
	/** Workspace name for logging and organization */
	workspaceName?: string;
	/** Additional text to append to default system prompt */
	appendSystemPrompt?: string;
	/** Path(s) to MCP configuration file(s) */
	mcpConfigPath?: string | string[];
	/** MCP server configurations (inline) */
	mcpConfig?: Record<string, McpServerConfig>;
	/** AI model to use (e.g., "opus", "sonnet", "haiku") */
	model?: string;
	/** Fallback model if primary is unavailable */
	fallbackModel?: string;
	/** Maximum number of turns before completing session */
	maxTurns?: number;
	/** Built-in tools available in model context */
	tools?: string[];
	/** Flywheel home directory (required) */
	flywheelHome: string;
	/** Prompt template version information */
	promptVersions?: {
		userPromptVersion?: string;
		systemPromptVersion?: string;
	};
	/** Event hooks for customizing agent behavior */
	hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
	/** Callback for AskUserQuestion tool invocations */
	onAskUserQuestion?: OnAskUserQuestion;
	/** Callback for each message received */
	onMessage?: (message: AgentMessage) => void | Promise<void>;
	/** Callback for errors */
	onError?: (error: Error) => void | Promise<void>;
	/** Callback when session completes */
	onComplete?: (messages: AgentMessage[]) => void | Promise<void>;
}

/**
 * Claude SDK adapter configuration.
 *
 * Extends AdapterConfig with Claude-specific fields from ClaudeRunnerConfig.
 */
export interface ClaudeAdapterConfig extends AdapterConfig {
	/** Logger instance (ClaudeRunner internal use) */
	logger?: ILogger;
	/** Extra CLI arguments (key-value or key-null pairs for SDK query options) */
	extraArgs?: Record<string, string | null>;
	/** Output format configuration (maps to Claude SDK OutputFormat) */
	outputFormat?: OutputFormat;
	/** System prompt (used by ClaudeRunner, some test-scripts depend on this) */
	systemPrompt?: string;
}
