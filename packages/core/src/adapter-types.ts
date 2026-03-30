/**
 * Unified Adapter Protocol — GEO-157
 *
 * Replaces three runner interfaces (IFlywheelRunner, IAgentRunner, ISimpleAgentRunner)
 * with a single IAdapter interface that supports both fire-and-forget execution
 * (DAG path) and interactive streaming sessions (Edge Worker path).
 *
 * @see doc/plan/new/v1.2.0-GEO-157-adapter-protocol-heartbeat.md
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
 * - **Fire-and-forget** (`execute`): Used by Blueprint/DagDispatcher for autonomous
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
	/** AI model to use (e.g., "opus", "sonnet") */
	model?: string;
	/** Permission mode (e.g., "bypassPermissions", "plan") */
	permissionMode?: string;
	/** Additional text to append to the system prompt */
	appendSystemPrompt?: string;
	/** Allowed tool patterns (e.g., ["Read(**)", "Edit(**)", "Bash"]) */
	allowedTools?: string[];
	/** Maximum number of agentic turns */
	maxTurns?: number;
	/** Process-level timeout in milliseconds */
	timeoutMs?: number;

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
	/** Absolute path to flywheel-comm CLI (dist/index.js) for progress reporting */
	commCliPath?: string;
	/** Timeout when waiting for Lead response (ms). Default: 14_400_000 (4h) */
	waitingTimeoutMs?: number;
	/** Lead agent ID (for session registration) */
	leadId?: string;
	/** Project name (for session registration) */
	projectName?: string;

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
}

// ---------------------------------------------------------------------------
// AdapterExecutionResult — Execution output
// ---------------------------------------------------------------------------

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
