import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { CommDB } from "flywheel-comm/db";
import { sanitizeTmuxName } from "flywheel-core";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
	IHookCallbackServer,
} from "flywheel-core";
import { FLYWHEEL_MARKER_DIR } from "flywheel-core";

export type ExecFileFn = (cmd: string, args: string[]) => { stdout: string };

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

		// GEO-269: allow-rename ON so Claude CLI's --name can set the tmux window title.
		// Previously OFF to prevent random title overwrites, but now we pass a meaningful
		// --name (issueId + title) so Claude's title is exactly what we want to display.

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

		// GEO-206: Inject comm DB path for flywheel-comm CLI
		if (ctx.commDbPath) {
			envArgs.push("-e", `FLYWHEEL_COMM_DB=${ctx.commDbPath}`);
		}

		// GEO-266: Inject execution ID for inbox PostToolUse hook
		envArgs.push("-e", `FLYWHEEL_EXEC_ID=${ctx.executionId}`);

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

		// GEO-206 Phase 2: Register session in comm.db
		// Store full tmux target (session:window) so capture works with any session name
		let registeredSession = false;
		if (ctx.commDbPath) {
			try {
				const commDb = new CommDB(ctx.commDbPath);
				commDb.registerSession(
					ctx.executionId,
					`${this.sessionName}:${windowId}`,
					ctx.projectName ?? "unknown",
					ctx.issueId,
					ctx.leadId,
				);
				commDb.close();
				registeredSession = true;
			} catch {
				// Registration failure is non-fatal
			}
		}

		// Send immediate first heartbeat (before first poll cycle)
		ctx.onHeartbeat?.(ctx.executionId);

		// Wait for completion: mode depends on hookServer presence
		let timedOut: boolean;
		let sessionStatus: "completed" | "timeout" = "completed";
		try {
			timedOut = await this.waitForCompletion(
				ctx,
				claudeSessionId,
				windowId,
				effectiveTimeoutMs,
				callbackToken,
				ctx.sentinelPath,
			);
			sessionStatus = timedOut ? "timeout" : "completed";
		} catch (err) {
			// waitForCompletion failure — session may still exist
			sessionStatus = "timeout";
			throw err;
		} finally {
			// GEO-206 Phase 2: Update session status
			if (registeredSession && ctx.commDbPath) {
				try {
					const commDb = new CommDB(ctx.commDbPath);
					commDb.updateSessionStatus(ctx.executionId, sessionStatus);
					commDb.close();
				} catch {
					// Update failure is non-fatal
				}
			}
		}

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
		if (ctx.permissionMode) args.push("--permission-mode", ctx.permissionMode);
		if (ctx.appendSystemPrompt)
			args.push("--append-system-prompt", ctx.appendSystemPrompt);
		if (ctx.model) args.push("--model", ctx.model);
		if (ctx.allowedTools?.length)
			args.push("--allowed-tools", ...ctx.allowedTools);
		if (ctx.sessionDisplayName)
			args.push("--name", ctx.sessionDisplayName);
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
	/**
	 * GEO-206 Phase 2: Check comm.db for pending questions and manage dynamic timeout.
	 * Returns true if the session should be timed out.
	 */
	/**
	 * GEO-206 Phase 2: Check comm.db for pending questions and manage dynamic timeout.
	 *
	 * Timeout logic: When Runner is waiting for Lead, time spent waiting does NOT
	 * count against the normal 45-min timeout. This prevents the scenario where
	 * Lead responds after 50 minutes but Runner immediately times out because
	 * elapsed (50min) > normalTimeout (45min).
	 *
	 * We track `totalWaitingMs` — accumulated time spent in waiting state.
	 * Normal timeout checks: (elapsed - totalWaitingMs) > normalTimeoutMs
	 * Waiting hard cap: elapsed > waitingTimeoutMs (4h absolute limit)
	 */
	private checkDynamicTimeout(
		ctx: AdapterExecutionContext,
		start: number,
		normalTimeoutMs: number,
		commDbHandle: { db: CommDB | null },
		waitState: { totalWaitingMs: number; lastWaitStart: number | null },
	): { shouldTimeout: boolean; isWaiting: boolean } {
		let isWaiting = false;

		// Lazy open: try to open DB if not yet opened
		if (!commDbHandle.db && ctx.commDbPath && existsSync(ctx.commDbPath)) {
			try {
				commDbHandle.db = CommDB.openReadonly(ctx.commDbPath);
			} catch {
				// DB not ready — will retry next cycle
			}
		}

		// Query pending questions for THIS execution
		if (commDbHandle.db) {
			try {
				isWaiting = commDbHandle.db.hasPendingQuestionsFrom(ctx.executionId);
			} catch {
				// Query failed — fall back to normal timeout
				isWaiting = false;
			}
		}

		const now = Date.now();

		// Track waiting time transitions
		if (isWaiting && waitState.lastWaitStart === null) {
			// Entered waiting state
			waitState.lastWaitStart = now;
		} else if (!isWaiting && waitState.lastWaitStart !== null) {
			// Left waiting state — accumulate time spent waiting
			waitState.totalWaitingMs += now - waitState.lastWaitStart;
			waitState.lastWaitStart = null;
		}

		const elapsed = now - start;
		if (isWaiting) {
			// While waiting: only enforce absolute hard cap
			const hardCap = ctx.waitingTimeoutMs ?? 14_400_000; // 4h
			return { shouldTimeout: elapsed > hardCap, isWaiting };
		}

		// Not waiting: subtract accumulated waiting time from elapsed
		const currentWaiting = waitState.lastWaitStart
			? now - waitState.lastWaitStart
			: 0;
		const activeTime = elapsed - waitState.totalWaitingMs - currentWaiting;
		return { shouldTimeout: activeTime > normalTimeoutMs, isWaiting };
	}

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
			const start = Date.now();

			// GEO-206 Phase 2: Lazy-opened readonly DB handle for dynamic timeout
			const commDbHandle: { db: CommDB | null } = { db: null };
			const waitState = {
				totalWaitingMs: 0,
				lastWaitStart: null as number | null,
			};

			const settle = (timedOut: boolean) => {
				if (settled) return;
				settled = true;
				watcher?.close();
				if (poller) clearInterval(poller);
				if (gracePollerRef) clearInterval(gracePollerRef);
				clearTimeout(timer);
				// GEO-206 Phase 2: Close readonly DB handle
				if (commDbHandle.db) {
					try {
						commDbHandle.db.close();
					} catch {
						/* ignore */
					}
					commDbHandle.db = null;
				}
				if (this.hookServer && callbackToken) {
					this.hookServer.cancelWait(callbackToken);
				}
				resolve(timedOut);
			};

			// Hard upper bound timeout (safety net)
			const hardTimeoutMs = Math.max(
				timeoutMs,
				ctx.waitingTimeoutMs ?? timeoutMs,
			);
			const timer = setTimeout(() => {
				console.warn(
					`[TmuxAdapter] Session ${claudeSessionId} hard timeout after ${hardTimeoutMs}ms. Window ${windowId} preserved for inspection.`,
				);
				settle(true);
			}, hardTimeoutMs);

			if (this.hookServer && callbackToken) {
				// ── v0.2 mode: HTTP callback (primary) + pane_dead poller + sentinel (fallback) ──

				// Path 1: HTTP callback (use hard upper bound to match dynamic timeout)
				this.hookServer
					.waitForCompletion(callbackToken, hardTimeoutMs)
					.then((event) => {
						if (event) settle(false);
					});

				// Path 2: pane_dead poller + sentinel check (fallback — races with callback)
				poller = setInterval(() => {
					if (settled) return;

					// Heartbeat: report liveness each poll cycle
					ctx.onHeartbeat?.(ctx.executionId);

					// GEO-206 Phase 2: Dynamic timeout check (query DB first, then check elapsed)
					if (ctx.commDbPath) {
						const { shouldTimeout } = this.checkDynamicTimeout(
							ctx,
							start,
							timeoutMs,
							commDbHandle,
							waitState,
						);
						if (shouldTimeout) {
							console.warn(
								`[TmuxAdapter] Dynamic timeout for ${claudeSessionId}. Window ${windowId} preserved.`,
							);
							settle(true);
							return;
						}
					}

					// Sentinel check: land-status.json terminal state
					if (sentinelPath) {
						try {
							if (existsSync(sentinelPath)) {
								const raw = readFileSync(sentinelPath, "utf-8");
								const signal = JSON.parse(raw);
								if (
									signal.status === "merged" ||
									signal.status === "failed" ||
									signal.status === "ready_to_merge"
								) {
									clearTimeout(timer);
									let graceChecks = 0;
									gracePollerRef = setInterval(() => {
										graceChecks++;
										// Continue heartbeats during grace period
										ctx.onHeartbeat?.(ctx.executionId);
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

					// GEO-206 Phase 2: Dynamic timeout check (query DB first, then check elapsed)
					if (ctx.commDbPath) {
						const { shouldTimeout } = this.checkDynamicTimeout(
							ctx,
							start,
							timeoutMs,
							commDbHandle,
							waitState,
						);
						if (shouldTimeout) {
							console.warn(
								`[TmuxAdapter] Dynamic timeout for ${claudeSessionId}. Window ${windowId} preserved.`,
							);
							settle(true);
							return;
						}
					}

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
						const msg = err instanceof Error ? err.message : String(err);
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
			this.execFileFn("tmux", ["has-session", "-t", `=${this.sessionName}`]);
		} catch {
			this.execFileFn("tmux", ["new-session", "-d", "-s", this.sessionName]);
		}
	}

	sanitizeWindowName(name: string): string {
		return sanitizeTmuxName(name);
	}
}

function defaultExecFile(cmd: string, args: string[]): { stdout: string } {
	const result = execFileSync(cmd, args, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	return { stdout: result };
}
