import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { CommDB } from "flywheel-comm/db";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
} from "flywheel-core";
import { createLogger, type ILogger } from "flywheel-core";
import {
	type ExecFileLike,
	runWaitAwareExec,
	WaitAwareExecTimeoutError,
} from "./wait-aware-exec.js";

// Standalone/future direct fallback only. Production Blueprint currently passes
// 24h explicitly and does not register this dormant direct adapter.
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_WAITING_TIMEOUT_MS = 176_400_000;
const DEFAULT_WAIT_RETRY_MS = 5 * 60_000;

export interface ClaudeCodeAdapterOptions {
	execFile?: ExecFileLike;
	waitRetryMs?: number;
	now?: () => number;
	resolveCommCli?: () => string | undefined;
}

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
	private readonly execFile: ExecFileLike;
	private readonly waitRetryMs: number;
	private readonly now: () => number;
	private readonly resolveCommCli: () => string | undefined;

	constructor(logger?: ILogger, options: ClaudeCodeAdapterOptions = {}) {
		this.logger = logger ?? createLogger({ component: "ClaudeCodeAdapter" });
		this.execFile = options.execFile ?? (execFile as unknown as ExecFileLike);
		this.waitRetryMs = options.waitRetryMs ?? DEFAULT_WAIT_RETRY_MS;
		this.now = options.now ?? Date.now;
		this.resolveCommCli = options.resolveCommCli ?? defaultResolveCommCli;
	}

	async checkEnvironment(): Promise<AdapterHealthCheck> {
		try {
			const version = await this.execClaude({
				args: ["--version"],
				cwd: ".",
				activeTimeoutMs: 10_000,
				waitingTimeoutMs: DEFAULT_WAITING_TIMEOUT_MS,
				isWaiting: () => false,
				env: this.buildEnv(undefined, DEFAULT_WAITING_TIMEOUT_MS),
			});
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
		const waitingTimeout = ctx.waitingTimeoutMs ?? DEFAULT_WAITING_TIMEOUT_MS;

		this.logger.info(
			`Spawning claude CLI in ${ctx.cwd} (timeout: ${timeout}ms)`,
		);
		this.logger.debug(`CLI args: claude ${args.join(" ")}`);

		try {
			const stdout = await this.execClaude({
				args,
				cwd: ctx.cwd,
				activeTimeoutMs: timeout,
				waitingTimeoutMs: waitingTimeout,
				isWaiting: () => hasPendingBlockingGate(ctx),
				env: this.buildEnv(ctx, waitingTimeout),
			});
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
				...(error instanceof WaitAwareExecTimeoutError
					? { timedOut: true }
					: {}),
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

	private async execClaude(input: {
		args: string[];
		cwd: string;
		activeTimeoutMs: number;
		waitingTimeoutMs: number;
		isWaiting: () => boolean;
		env: NodeJS.ProcessEnv;
	}): Promise<string> {
		const result = await runWaitAwareExec({
			file: "claude",
			argv: input.args,
			options: {
				cwd: input.cwd,
				maxBuffer: 50 * 1024 * 1024,
				env: input.env,
			},
			activeTimeoutMs: input.activeTimeoutMs,
			waitingTimeoutMs: input.waitingTimeoutMs,
			waitRetryMs: this.waitRetryMs,
			isWaiting: input.isWaiting,
			execFile: this.execFile,
			now: this.now,
			onProbeError: (error) => {
				this.logger.warn(
					"Could not inspect blocking gate state; retaining active timeout semantics:",
					error,
				);
			},
		});
		return result.stdout;
	}

	private buildEnv(
		ctx: AdapterExecutionContext | undefined,
		waitingTimeoutMs: number,
	): NodeJS.ProcessEnv {
		const env = { ...process.env };
		delete env.CLAUDECODE;

		if (ctx) {
			env.FLYWHEEL_EXEC_ID = ctx.executionId;
			env.FLYWHEEL_ISSUE_ID = ctx.issueId;
			if (ctx.commDbPath) env.FLYWHEEL_COMM_DB = ctx.commDbPath;
			if (ctx.projectName) env.FLYWHEEL_PROJECT_NAME = ctx.projectName;
			if (ctx.sentinelPath) {
				env.FLYWHEEL_LAND_STATUS_PATH = ctx.sentinelPath;
			}
		}

		const commCli = this.resolveCommCli();
		if (commCli) env.FLYWHEEL_COMM_CLI = commCli;
		env.BASH_MAX_TIMEOUT_MS = String(waitingTimeoutMs);
		return env;
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

function hasPendingBlockingGate(ctx: AdapterExecutionContext): boolean {
	if (!ctx.commDbPath) return false;
	const db = CommDB.openReadonly(ctx.commDbPath);
	try {
		return db.hasPendingBlockingGateFrom(ctx.executionId);
	} finally {
		db.close();
	}
}

function defaultResolveCommCli(): string | undefined {
	try {
		return createRequire(import.meta.url).resolve("flywheel-comm");
	} catch {
		return undefined;
	}
}
