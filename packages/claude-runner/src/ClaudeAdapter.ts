import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	AdapterSession,
	ClaudeAdapterConfig,
	IAdapter,
} from "flywheel-core";
import { ClaudeRunner } from "./ClaudeRunner.js";
import { ClaudeAdapterSession } from "./ClaudeAdapterSession.js";
import type { ClaudeRunnerConfig } from "./types.js";

/**
 * ClaudeAdapter — Claude SDK adapter for both fire-and-forget and interactive streaming.
 *
 * Implements IAdapter (supportsStreaming: true). Wraps ClaudeRunner internally.
 *
 * - `execute()`: Creates a ClaudeRunner, starts with string prompt, waits for
 *   completion, returns messages. Used by Edge Worker non-streaming path.
 * - `startSession()`: Creates a ClaudeRunner in streaming mode, returns an
 *   AdapterSession handle. Used by Edge Worker streaming path.
 */
export class ClaudeAdapter implements IAdapter {
	readonly type = "claude-sdk";
	readonly supportsStreaming = true;

	constructor(private config: ClaudeAdapterConfig) {}

	async checkEnvironment(): Promise<AdapterHealthCheck> {
		// Claude SDK doesn't require a CLI check — it uses the SDK directly.
		// We could check for API key availability, but that's handled at runtime.
		return {
			healthy: true,
			message: "Claude SDK adapter ready",
		};
	}

	async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
		const runnerConfig = this.buildRunnerConfig(ctx);
		const runner = new ClaudeRunner(runnerConfig);
		const start = Date.now();

		try {
			const sessionInfo = await runner.start(ctx.prompt);
			const messages = runner.getMessages();

			return {
				success: true,
				sessionId: sessionInfo.sessionId ?? "",
				durationMs: Date.now() - start,
				messages,
				sessionParams: sessionInfo.sessionId
					? { sessionId: sessionInfo.sessionId }
					: undefined,
			};
		} catch (error) {
			return {
				success: false,
				sessionId: "",
				durationMs: Date.now() - start,
				messages: runner.getMessages(),
			};
		}
	}

	async startSession(ctx: AdapterExecutionContext): Promise<AdapterSession> {
		const runnerConfig = this.buildRunnerConfig(ctx);
		const runner = new ClaudeRunner(runnerConfig);

		// Start streaming mode (non-blocking — runner processes messages asynchronously)
		await runner.startStreaming(ctx.prompt || undefined);

		return new ClaudeAdapterSession(runner);
	}

	/**
	 * Build a ClaudeRunnerConfig from the adapter config + execution context.
	 */
	private buildRunnerConfig(ctx: AdapterExecutionContext): ClaudeRunnerConfig {
		const resumeId = ctx.previousSession?.sessionId as string | undefined;

		return {
			workingDirectory: ctx.cwd,
			allowedTools: ctx.allowedTools ?? this.config.allowedTools,
			disallowedTools: this.config.disallowedTools,
			allowedDirectories: ctx.allowedDirectories ?? this.config.allowedDirectories,
			resumeSessionId: resumeId ?? this.config.resumeSessionId,
			workspaceName: ctx.workspaceName ?? this.config.workspaceName,
			appendSystemPrompt: ctx.appendSystemPrompt ?? this.config.appendSystemPrompt,
			mcpConfigPath: ctx.mcpConfigPath as string | string[] | undefined ?? this.config.mcpConfigPath,
			mcpConfig: ctx.mcpConfig as ClaudeRunnerConfig["mcpConfig"] ?? this.config.mcpConfig,
			model: ctx.model ?? this.config.model,
			fallbackModel: this.config.fallbackModel,
			maxTurns: ctx.maxTurns ?? this.config.maxTurns,
			tools: this.config.tools,
			flywheelHome: ctx.flywheelHome ?? this.config.flywheelHome,
			logger: this.config.logger,
			promptVersions: this.config.promptVersions,
			hooks: ctx.hooks as ClaudeRunnerConfig["hooks"] ?? this.config.hooks,
			outputFormat: this.config.outputFormat,
			extraArgs: this.config.extraArgs,
			systemPrompt: this.config.systemPrompt,
			onAskUserQuestion: ctx.onAskUserQuestion ?? this.config.onAskUserQuestion,
			onMessage: ctx.onMessage,
			onError: ctx.onError,
			onComplete: ctx.onComplete,
		};
	}
}
