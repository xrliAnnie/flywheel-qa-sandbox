import { execFile } from "node:child_process";
import { createLogger, type ILogger } from "flywheel-core";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
} from "flywheel-core";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Claude CLI JSON output structure (--output-format json).
 */
interface CliJsonResult {
	type: string;
	subtype: string;
	total_cost_usd: number;
	is_error: boolean;
	duration_ms?: number;
	duration_api_ms?: number;
	num_turns?: number;
	result?: string;
	session_id: string;
}

/**
 * ClaudeCodeAdapter — spawns `claude` CLI in non-interactive (--print) mode.
 *
 * Implements IAdapter (supportsStreaming: false). Replaces ClaudeCodeRunner (GEO-157).
 *
 * Supports session resume via `previousSession.sessionId` (uses `--resume` flag,
 * NOT `--session-id`).
 */
export class ClaudeCodeAdapter implements IAdapter {
	readonly type = "claude";
	readonly supportsStreaming = false;
	private logger: ILogger;

	constructor(logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "ClaudeCodeAdapter" });
	}

	async checkEnvironment(): Promise<AdapterHealthCheck> {
		try {
			const version = await this.execClaude(["--version"], ".", 10_000);
			return {
				healthy: true,
				message: "claude CLI available",
				details: { version: version.trim() },
			};
		} catch (err) {
			return {
				healthy: false,
				message: `claude CLI not available: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
		const args = this.buildArgs(ctx);
		const timeout = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		this.logger.info(
			`Spawning claude CLI in ${ctx.cwd} (timeout: ${timeout}ms)`,
		);
		this.logger.debug(`CLI args: claude ${args.join(" ")}`);

		try {
			const stdout = await this.execClaude(args, ctx.cwd, timeout);
			const result = this.parseResult(stdout);

			// Persist session params for future resume
			if (result.sessionId) {
				result.sessionParams = { sessionId: result.sessionId };
			}

			return result;
		} catch (error) {
			this.logger.error("Claude CLI failed:", error);
			return {
				success: false,
				sessionId: "",
			};
		}
	}

	private buildArgs(ctx: AdapterExecutionContext): string[] {
		const args: string[] = ["--print", "--output-format", "json"];

		if (ctx.maxTurns !== undefined) {
			args.push("--max-turns", String(ctx.maxTurns));
		}

		// Session resume via --resume (NOT --session-id)
		const resumeId =
			(ctx.previousSession?.sessionId as string | undefined) ?? undefined;
		if (resumeId) {
			args.push("--resume", resumeId);
		}

		if (ctx.allowedTools && ctx.allowedTools.length > 0) {
			args.push("--allowedTools", ...ctx.allowedTools);
		}

		if (ctx.model) {
			args.push("--model", ctx.model);
		}

		if (ctx.permissionMode) {
			args.push("--permission-mode", ctx.permissionMode);
		}

		if (ctx.appendSystemPrompt) {
			args.push("--append-system-prompt", ctx.appendSystemPrompt);
		}

		// Prompt comes last, after "--" separator
		args.push("--", ctx.prompt);

		return args;
	}

	private execClaude(
		args: string[],
		cwd: string,
		timeout: number,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const env = { ...process.env };
			delete env.CLAUDECODE;

			execFile(
				"claude",
				args,
				{
					cwd,
					timeout,
					maxBuffer: 50 * 1024 * 1024,
					env,
				},
				(error, stdout, _stderr) => {
					if (error) {
						reject(error);
					} else {
						resolve(stdout);
					}
				},
			);
		});
	}

	private parseResult(stdout: string): AdapterExecutionResult {
		if (!stdout || !stdout.trim()) {
			this.logger.error("Claude CLI returned empty output");
			return { success: false, sessionId: "" };
		}

		try {
			const json = JSON.parse(stdout.trim()) as CliJsonResult;

			return {
				success: !json.is_error && json.subtype === "success",
				costUsd: json.total_cost_usd ?? 0,
				sessionId: json.session_id ?? "",
				durationMs: json.duration_ms,
				numTurns: json.num_turns,
				resultText: json.result,
			};
		} catch {
			this.logger.error("Failed to parse Claude CLI JSON output");
			return { success: false, sessionId: "" };
		}
	}
}
