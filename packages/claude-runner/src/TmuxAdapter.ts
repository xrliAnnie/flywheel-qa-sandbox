import { execFileSync } from "node:child_process";
import { watch, readFileSync } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
	IHookCallbackServer,
} from "flywheel-core";
import { FLYWHEEL_MARKER_DIR } from "flywheel-core";

export type ExecFileFn = (
	cmd: string,
	args: string[],
) => { stdout: string };

/**
 * TmuxAdapter — launches Claude Code in an interactive tmux window.
 *
 * Implements IAdapter (supportsStreaming: false). Replaces TmuxRunner (GEO-157).
 *
 * Two completion modes:
 * - v0.2 mode (hookServer present): HTTP callback (primary) + pane_dead poller (fallback)
 * - v0.1.1 mode (hookServer absent): marker file watcher + pane_dead poller
 *
 * Heartbeat: calls ctx.onHeartbeat(executionId) immediately on start and
 * during each poll cycle, so HeartbeatService can detect orphaned sessions.
 */
export class TmuxAdapter implements IAdapter {
	readonly type = "claude-tmux";
	readonly supportsStreaming = false;
	private preflightDone = false;

	constructor(
		private sessionName: string = "flywheel",
		private execFileFn: ExecFileFn = defaultExecFile,
		private pollIntervalMs: number = 5000,
		private defaultTimeoutMs: number = 2_700_000, // 45 min
		private hookServer?: IHookCallbackServer,
	) {}

	async checkEnvironment(): Promise<AdapterHealthCheck> {
		try {
			const tmuxResult = this.execFileFn("tmux", ["-V"]);
			const claudeResult = this.execFileFn("claude", ["--version"]);
			return {
				healthy: true,
				message: "tmux and claude CLI available",
				details: {
					tmux: tmuxResult.stdout.trim(),
					claude: claudeResult.stdout.trim(),
				},
			};
		} catch (err) {
			return {
				healthy: false,
				message: `Environment check failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
		// Lazy preflight: check tmux AND claude on first run
		if (!this.preflightDone) {
			this.execFileFn("tmux", ["-V"]);
			this.execFileFn("claude", ["--version"]);
			this.preflightDone = true;
		}

		const windowName = this.sanitizeWindowName(
			ctx.label ?? `issue-${Date.now()}`,
		);
		const claudeSessionId = randomUUID();
		const start = Date.now();
		const effectiveTimeoutMs = ctx.timeoutMs ?? this.defaultTimeoutMs;

		// Generate per-run callback token if hookServer available
		const callbackToken = this.hookServer ? randomUUID() : undefined;

		// Ensure session exists (idempotent)
		this.ensureSession();

		if (this.hookServer) {
			// v0.2 mode: no marker dir needed
		} else {
			// v0.1.1 mode: inject FLYWHEEL_MARKER_DIR into tmux session environment
			this.execFileFn("tmux", [
				"set-environment",
				"-t",
				`=${this.sessionName}`,
				"FLYWHEEL_MARKER_DIR",
				FLYWHEEL_MARKER_DIR,
			]);
		}

		// Unset CLAUDECODE to prevent nested Claude hang/refuse
		this.execFileFn("tmux", [
			"set-environment",
			"-t",
			`=${this.sessionName}`,
			"-u",
			"CLAUDECODE",
		]);

		// Enable remain-on-exit so dead panes stay visible.
		this.execFileFn("tmux", [
			"set-option",
			"-t",
			`=${this.sessionName}:`,
			"remain-on-exit",
			"on",
		]);

		// Prevent Claude CLI from overwriting the pane title via escape sequences.
		this.execFileFn("tmux", [
			"set-option",
			"-t",
			`=${this.sessionName}:`,
			"allow-rename",
			"off",
		]);

		// Build claude args (interactive mode — NO --print, NO --output-format)
		const claudeArgs = this.buildClaudeArgs(ctx, claudeSessionId);

		// Build per-window env args for v0.2 HTTP callback
		const envArgs =
			this.hookServer && callbackToken
				? [
						"-e",
						`FLYWHEEL_CALLBACK_PORT=${this.hookServer.getPort()}`,
						"-e",
						`FLYWHEEL_CALLBACK_TOKEN=${callbackToken}`,
						"-e",
						`FLYWHEEL_ISSUE_ID=${ctx.issueId ?? "unknown"}`,
					]
				: [];

		// Launch Claude in a new tmux window WITH cwd
		const launchResult = this.execFileFn("tmux", [
			"new-window",
			"-P",
			"-F",
			"#{window_id}",
			"-t",
			`=${this.sessionName}`,
			...envArgs,
			"-n",
			windowName,
			"-c",
			ctx.cwd,
			"claude",
			...claudeArgs,
		]);
		const windowId = launchResult.stdout.trim();

		// Send immediate first heartbeat (before first poll cycle)
		ctx.onHeartbeat?.(ctx.executionId);

		// Wait for completion: mode depends on hookServer presence
		const timedOut = await this.waitForCompletion(
			ctx,
			claudeSessionId,
			windowId,
			effectiveTimeoutMs,
			callbackToken,
			ctx.sentinelPath,
		);

		return {
			success: true, // runner-level: process completed. Task-level success via GitResultChecker
			sessionId: claudeSessionId,
			tmuxWindow: `${this.sessionName}:${windowId}`,
			durationMs: Date.now() - start,
			timedOut,
		};
	}

	private buildClaudeArgs(
		ctx: AdapterExecutionContext,
		sessionId: string,
	): string[] {
		// CLI syntax: claude [options] [prompt] — options MUST come before prompt
		const args: string[] = [];
		args.push("--session-id", sessionId);
		if (ctx.permissionMode)
			args.push("--permission-mode", ctx.permissionMode);
		if (ctx.appendSystemPrompt)
			args.push("--append-system-prompt", ctx.appendSystemPrompt);
		if (ctx.model) args.push("--model", ctx.model);
		if (ctx.allowedTools?.length)
			args.push("--allowed-tools", ...ctx.allowedTools);
		// NOTE: --max-turns does NOT exist in Claude CLI v2.1.63
		// NOTE: previousSession intentionally ignored — no resume in interactive tmux mode
		// Prompt as last CLI arg — Claude starts processing immediately on launch
		args.push(ctx.prompt);
		return args;
	}

	/**
	 * Wait for session completion via dual-path detection.
	 * Returns true if the wait was terminated by timeout (not normal completion).
	 *
	 * During the poll loop, calls ctx.onHeartbeat to report liveness.
	 */
	private async waitForCompletion(
		ctx: AdapterExecutionContext,
		claudeSessionId: string,
		windowId: string,
		timeoutMs: number,
		callbackToken?: string,
		sentinelPath?: string,
	): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let watcher: ReturnType<typeof watch> | null = null;
			let poller: ReturnType<typeof setInterval> | null = null;
			let gracePollerRef: ReturnType<typeof setInterval> | null = null;

			const settle = (timedOut: boolean) => {
				if (settled) return;
				settled = true;
				watcher?.close();
				if (poller) clearInterval(poller);
				if (gracePollerRef) clearInterval(gracePollerRef);
				clearTimeout(timer);
				if (this.hookServer && callbackToken) {
					this.hookServer.cancelWait(callbackToken);
				}
				resolve(timedOut);
			};

			// Timeout
			const timer = setTimeout(() => {
				console.warn(
					`[TmuxAdapter] Session ${claudeSessionId} timed out after ${timeoutMs}ms. Window ${windowId} preserved for inspection.`,
				);
				settle(true);
			}, timeoutMs);

			if (this.hookServer && callbackToken) {
				// ── v0.2 mode: HTTP callback (primary) + pane_dead poller + sentinel (fallback) ──

				// Path 1: HTTP callback
				this.hookServer
					.waitForCompletion(callbackToken, timeoutMs)
					.then((event) => {
						if (event) settle(false);
					});

				// Path 2: pane_dead poller + sentinel check (fallback — races with callback)
				poller = setInterval(() => {
					if (settled) return;

					// Heartbeat: report liveness each poll cycle
					ctx.onHeartbeat?.(ctx.executionId);

					// Sentinel check: land-status.json terminal state
					if (sentinelPath) {
						try {
							if (existsSync(sentinelPath)) {
								const raw = readFileSync(sentinelPath, "utf-8");
								const signal = JSON.parse(raw);
								if (signal.status === "merged" || signal.status === "failed" || signal.status === "ready_to_merge") {
									clearTimeout(timer);
									let graceChecks = 0;
									gracePollerRef = setInterval(() => {
										graceChecks++;
										// Continue heartbeats during grace period
										ctx.onHeartbeat?.(ctx.executionId);
										try {
											const result = this.execFileFn("tmux", [
												"list-panes", "-t", windowId, "-F", "#{pane_dead}",
											]);
											if (result.stdout.trim() === "1") {
												settle(false);
											}
										} catch {
											settle(false);
										}
										if (graceChecks >= 6) {
											settle(false);
										}
									}, this.pollIntervalMs);
									if (poller) clearInterval(poller);
									poller = null;
									return;
								}
							}
						} catch (err) {
							console.warn(
								`[TmuxAdapter] Sentinel check failed for ${sentinelPath}: ${err instanceof Error ? err.message : String(err)}. Falling back to pane_dead detection.`,
							);
						}
					}

					try {
						const result = this.execFileFn("tmux", [
							"list-panes",
							"-t",
							windowId,
							"-F",
							"#{pane_dead}",
						]);
						if (result.stdout.trim() === "1") settle(false);
					} catch {
						settle(false);
					}
				}, this.pollIntervalMs);
			} else {
				// ── v0.1.1 mode: marker file watcher + pane_dead poller ──

				// Path 1: Watch for any hook-written .done marker file
				watcher = existsSync(FLYWHEEL_MARKER_DIR)
					? watch(FLYWHEEL_MARKER_DIR, (_, filename) => {
							if (!settled && filename?.endsWith(".done")) {
								settle(false);
							}
						})
					: null;

				// Path 2: Poll pane_dead as fallback
				poller = setInterval(() => {
					if (settled) return;

					// Heartbeat: report liveness each poll cycle
					ctx.onHeartbeat?.(ctx.executionId);

					// Also check if any marker appeared (in case fs.watch missed it)
					try {
						const files = readdirSync(FLYWHEEL_MARKER_DIR);
						if (files.some((f: string) => f.endsWith(".done"))) {
							settle(false);
							return;
						}
					} catch {
						/* marker dir may not exist */
					}
					try {
						const result = this.execFileFn("tmux", [
							"list-panes",
							"-t",
							windowId,
							"-F",
							"#{pane_dead}",
						]);
						if (result.stdout.trim() === "1") {
							settle(false);
						}
					} catch (err) {
						const msg =
							err instanceof Error ? err.message : String(err);
						console.warn(
							`[TmuxAdapter] tmux list-panes failed for ${windowId}: ${msg}. Treating as session ended.`,
						);
						settle(false);
					}
				}, this.pollIntervalMs);
			}
		});
	}

	private ensureSession(): void {
		try {
			this.execFileFn("tmux", [
				"has-session",
				"-t",
				`=${this.sessionName}`,
			]);
		} catch {
			this.execFileFn("tmux", [
				"new-session",
				"-d",
				"-s",
				this.sessionName,
			]);
		}
	}

	sanitizeWindowName(name: string): string {
		return name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 50);
	}
}

function defaultExecFile(
	cmd: string,
	args: string[],
): { stdout: string } {
	const result = execFileSync(cmd, args, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	return { stdout: result };
}
