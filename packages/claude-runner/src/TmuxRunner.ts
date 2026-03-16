/**
 * @deprecated Use TmuxAdapter instead (GEO-157).
 * This file provides backward-compatible TmuxRunner for scripts that call runner.run().
 * Will be removed in a future version.
 */
import type { FlywheelRunRequest, FlywheelRunResult, IFlywheelRunner, IHookCallbackServer } from "flywheel-core";
import { TmuxAdapter, type ExecFileFn } from "./TmuxAdapter.js";

export type { ExecFileFn } from "./TmuxAdapter.js";

/**
 * @deprecated Use TmuxAdapter instead.
 * Compat wrapper that bridges IFlywheelRunner.run() to IAdapter.execute().
 */
export class TmuxRunner implements IFlywheelRunner {
	readonly name: string;
	private adapter: TmuxAdapter;

	constructor(
		sessionName?: string,
		execFileFn?: ExecFileFn,
		pollIntervalMs?: number,
		defaultTimeoutMs?: number,
		hookServer?: IHookCallbackServer,
	) {
		this.adapter = new TmuxAdapter(sessionName, execFileFn, pollIntervalMs, defaultTimeoutMs, hookServer);
		this.name = this.adapter.type;
	}

	async run(request: FlywheelRunRequest): Promise<FlywheelRunResult> {
		const result = await this.adapter.execute({
			executionId: request.sessionId ?? `compat-${Date.now()}`,
			issueId: request.issueId ?? "unknown",
			prompt: request.prompt,
			cwd: request.cwd,
			allowedTools: request.allowedTools,
			maxTurns: request.maxTurns,
			label: request.label,
			timeoutMs: request.timeoutMs,
			model: request.model,
			permissionMode: request.permissionMode,
			appendSystemPrompt: request.appendSystemPrompt,
			sessionDisplayName: request.sessionDisplayName,
			sentinelPath: request.sentinelPath,
		});

		return {
			success: result.success,
			costUsd: result.costUsd,
			sessionId: result.sessionId,
			tmuxWindow: result.tmuxWindow,
			durationMs: result.durationMs,
			numTurns: result.numTurns,
			resultText: result.resultText,
			timedOut: result.timedOut,
		};
	}

	/** Expose sanitizeWindowName for compat (used by some scripts) */
	sanitizeWindowName(name: string): string {
		return this.adapter.sanitizeWindowName(name);
	}
}
