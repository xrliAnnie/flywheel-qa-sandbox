import { execFile } from "node:child_process";
import type {
	FlywheelRunRequest,
	FlywheelRunResult,
	IFlywheelRunner,
} from "flywheel-core";
import { createLogger, type ILogger } from "flywheel-core";

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
 * ClaudeCodeRunner — spawns `claude` CLI in non-interactive (--print) mode.
 *
 * This is the Phase 1 IFlywheelRunner implementation. It does NOT use the
 * Claude Agent SDK — it spawns the CLI binary as a child process and parses
 * the JSON output. This follows the CEO's direction: "不 reinvent the wheel,
 * 直接 spawn 现有 CLI 工具".
 */
export class ClaudeCodeRunner implements IFlywheelRunner {
	readonly name = "claude";
	private logger: ILogger;

	constructor(logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "ClaudeCodeRunner" });
	}

	async run(request: FlywheelRunRequest): Promise<FlywheelRunResult> {
		const args = this.buildArgs(request);
		const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		this.logger.info(
			`Spawning claude CLI in ${request.cwd} (timeout: ${timeout}ms)`,
		);
		this.logger.debug(`CLI args: claude ${args.join(" ")}`);

		try {
			const stdout = await this.execClaude(args, request.cwd, timeout);
			return this.parseResult(stdout);
		} catch (error) {
			this.logger.error("Claude CLI failed:", error);
			return {
				success: false,
				costUsd: 0,
				sessionId: "",
			};
		}
	}

	/**
	 * Build CLI arguments from the run request.
	 */
	private buildArgs(request: FlywheelRunRequest): string[] {
		const args: string[] = ["--print", "--output-format", "json"];

		if (request.maxTurns !== undefined) {
			args.push("--max-turns", String(request.maxTurns));
		}

		if (request.maxCostUsd !== undefined) {
			args.push("--max-budget-usd", String(request.maxCostUsd));
		}

		if (request.sessionId) {
			args.push("--resume", request.sessionId);
		}

		if (request.allowedTools && request.allowedTools.length > 0) {
			args.push("--allowedTools", ...request.allowedTools);
		}

		if (request.model) {
			args.push("--model", request.model);
		}

		if (request.permissionMode) {
			args.push("--permission-mode", request.permissionMode);
		}

		if (request.appendSystemPrompt) {
			args.push("--append-system-prompt", request.appendSystemPrompt);
		}

		// Prompt comes last, after "--" separator
		args.push("--", request.prompt);

		return args;
	}

	/**
	 * Execute claude CLI and return stdout.
	 */
	private execClaude(
		args: string[],
		cwd: string,
		timeout: number,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			// Build env: inherit process.env but remove CLAUDECODE to allow nested execution
			const env = { ...process.env };
			delete env.CLAUDECODE;

			execFile(
				"claude",
				args,
				{
					cwd,
					timeout,
					maxBuffer: 50 * 1024 * 1024, // 50MB — agent output can be large
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

	/**
	 * Parse JSON output from claude CLI.
	 */
	private parseResult(stdout: string): FlywheelRunResult {
		if (!stdout || !stdout.trim()) {
			this.logger.error("Claude CLI returned empty output");
			return { success: false, costUsd: 0, sessionId: "" };
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
			return { success: false, costUsd: 0, sessionId: "" };
		}
	}
}
