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
	/** Session ID for resuming a previous session */
	sessionId?: string;
	/** Process-level timeout in milliseconds (default: 30 minutes) */
	timeoutMs?: number;
	/** Model to use (e.g., "opus", "sonnet") */
	model?: string;
	/** Permission mode (e.g., "bypassPermissions", "plan") */
	permissionMode?: string;
	/** Additional system prompt to append */
	appendSystemPrompt?: string;
}

/**
 * Result of an agent run.
 */
export interface FlywheelRunResult {
	/** Whether the agent completed successfully */
	success: boolean;
	/** Total API cost in USD */
	costUsd: number;
	/** Session ID (for resuming later) */
	sessionId: string;
	/** Total duration in milliseconds */
	durationMs?: number;
	/** Number of agentic turns used */
	numTurns?: number;
	/** The agent's text result (may be empty for tool-only sessions) */
	resultText?: string;
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
