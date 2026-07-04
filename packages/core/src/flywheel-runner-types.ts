/**
 * Flywheel Runner Types
 *
 * Simplified, CLI-spawn-oriented runner interface for Flywheel orchestration.
 * Unlike the legacy IAgentRunner (SDK-coupled, streaming, event-based),
 * IFlywheelRunner is a simple request/response contract: run(request) → result.
 *
 * Used by Blueprint Dispatcher (Task 6) to invoke agent runners.
 */

/**
 * Request to run an agent session.
 */
export interface FlywheelRunRequest {
	/** The prompt to send to the agent */
	prompt: string;
	/** Working directory for the agent session */
	cwd: string;
	/** Allowed tool patterns (e.g., ["Read(**)", "Edit(**)", "Bash"]) */
	allowedTools?: string[];
	/** Maximum number of agentic turns */
	maxTurns?: number;
	/** Maximum dollar amount to spend on API calls */
	maxCostUsd?: number;
	/** Session ID for resuming a previous session (headless mode only) */
	sessionId?: string;
	/** Human-readable label for UI display (e.g., "GEO-101-Fix the bug") */
	label?: string;
	/** Issue ID for callback env var (URL-safe, e.g., "GEO-95") */
	issueId?: string;
	/** Process-level timeout in milliseconds (default: 30 minutes) */
	timeoutMs?: number;
	/** Model to use (e.g., "opus", "sonnet") */
	model?: string;
	/** Permission mode (e.g., "bypassPermissions", "plan") */
	permissionMode?: string;
	/** Additional system prompt to append */
	appendSystemPrompt?: string;
	/** Display name for the Claude session (passed as --name to CLI) */
	sessionDisplayName?: string;
	/** Path to sentinel file for land-status detection (TmuxRunner only) */
	sentinelPath?: string;
}

/**
 * Result of an agent run.
 */
export interface FlywheelRunResult {
	/** Whether the agent completed successfully */
	success: boolean;
	/** Total API cost in USD (unavailable in interactive mode) */
	costUsd?: number;
	/** Claude session ID — for resume in headless mode, UUID in interactive mode */
	sessionId: string;
	/** tmux target — format "session:@window_id" e.g. "flywheel:@42" (only set by TmuxRunner) */
	tmuxWindow?: string;
	/** Total duration in milliseconds */
	durationMs?: number;
	/** Number of agentic turns used */
	numTurns?: number;
	/** The agent's text result (may be empty for tool-only sessions) */
	resultText?: string;
	/** True if the session was terminated by timeout (TmuxRunner only) */
	timedOut?: boolean;
}

/**
 * Simplified runner interface for Flywheel orchestration.
 *
 * Each runner implementation wraps a specific CLI tool (claude, codex, gemini)
 * and exposes a uniform run() contract. Blueprint Dispatcher uses this
 * to invoke agents without knowing CLI-specific details.
 */
export interface IFlywheelRunner {
	/** Runner identifier (e.g., "claude", "codex", "gemini") */
	readonly name: string;
	/** Run an agent session and return the result */
	run(request: FlywheelRunRequest): Promise<FlywheelRunResult>;
}
