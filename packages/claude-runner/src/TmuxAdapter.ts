import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
	IHookCallbackServer,
} from "flywheel-core";
import { FLYWHEEL_MARKER_DIR, sanitizeTmuxName } from "flywheel-core";

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
/**
 * Minimal IAgentTeamTransport-shaped surface needed by TmuxAdapter.
 *
 * We don't import `IAgentTeamTransport` directly to avoid creating a
 * dependency from claude-runner → agent-team-transport (which would couple
 * a generic runner package to a vendor-specific transport). Callers pass an
 * adapter instance produced by `AgentTeamTransportFactory.fromEnv()`.
 *
 * FLY-142 Phase 0 PR 1.2.
 */
export interface RunnerSpawnTransport {
	buildRunnerSpawnConfig(ctx: {
		leadName: string;
		runnerName: string;
		teamName: string;
		parentSessionId?: string;
		color?: string;
		sessionId?: string;
		permissionMode?: string;
		[key: string]: unknown;
	}): { args: string[]; env: Record<string, string> };
}

export class TmuxAdapter implements IAdapter {
	readonly type = "claude-tmux";
	readonly supportsStreaming = false;
	private preflightDone = false;

	constructor(
		private sessionName: string = "flywheel",
		private execFileFn: ExecFileFn = defaultExecFile,
		private pollIntervalMs: number = 5000,
		private defaultTimeoutMs: number = 86_400_000, // 24h safety net (FLY-97; idle detection via FLY-92 watchdog)
		private hookServer?: IHookCallbackServer,
		/**
		 * FLY-142 PR 1.2: optional vendor-neutral transport adapter. When
		 * provided AND `ctx.agentName + ctx.teamName + ctx.vendor` are all
		 * set, TmuxAdapter calls `transport.buildRunnerSpawnConfig(ctx)` and
		 * merges the resulting CLI args + env into the spawn invocation.
		 *
		 * When undefined OR ctx is missing fields, no transport wiring →
		 * backward-compatible with all existing call sites.
		 */
		private transport?: RunnerSpawnTransport,
	) {}

	/**
	 * FLY-159 Codex r1 R1 HIGH (test-visible): determine whether the current
	 * waiting period has exceeded the per-wait hard cap. Pure function — no
	 * Date.now, no DB, easy to unit test. See `checkDynamicTimeout` for the
	 * wait-period vs session-total rationale.
	 */
	static _isWaitingPeriodExpired(
		lastWaitStart: number | null,
		now: number,
		hardCap: number,
	): boolean {
		if (lastWaitStart === null) return false;
		return now - lastWaitStart > hardCap;
	}

	/**
	 * FLY-159 Codex r2+r3 (test-visible): outer `setTimeout` ultra-safety
	 * net duration. The inner per-wait + per-active budgets are enforced
	 * by `checkDynamicTimeout`'s polling loop; this outer timer is a
	 * last-resort kill switch ONLY if the inner polling stalls (DB closed,
	 * etc.).
	 *
	 * It must be generous enough that the inner cap always fires first
	 * across any plausible session — otherwise the outer timer preempts
	 * `resolveGate(0)` + `gate_timed_out` and silently bypasses Annie's
	 * approval. Per Codex r3 MEDIUM, a fixed `* 3` multiplier breaks for
	 * Runners with 4+ sequential gates (brainstorm + N questions +
	 * approve_to_ship).
	 *
	 * Formula: `max(timeoutMs, waitingBudget * 7)` ≈ 7 sequential 49h
	 * waits ≈ 14.3 days. Well beyond any plausible Runner session while
	 * still finite enough to function as a stall-detection safety net.
	 * (setTimeout max delay is 2^31-1 ms ≈ 24.85 days, so 14.3 days fits.
	 * Multiplier bumped down from 14 → 7 because waitingBudget doubled
	 * 25h → 49h with the 24h → 48h gate timeout shift; product remains
	 * ≈ 14 days.)
	 */
	static _computeOuterHardTimeoutMs(
		timeoutMs: number,
		waitingBudgetMs: number,
	): number {
		return Math.max(timeoutMs, waitingBudgetMs * 7);
	}

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

		// FLY-142 PR 1.2: vendor-neutral Agent Team transport spawn config.
		// Computed once and reused for both env injection (envArgs below) and
		// CLI args (prepended to claudeArgs). Returns null when transport
		// isn't wired OR ctx lacks agentName/teamName/vendor → backward-
		// compatible spawn (skipped wiring).
		const transportSpawnConfig = this.tryBuildTransportSpawnConfig(ctx);

		// Build claude args (interactive mode — NO --print, NO --output-format)
		const claudeArgs = this.buildClaudeArgs(ctx, claudeSessionId);

		// Prepend transport-supplied identity flags BEFORE standard claudeArgs
		// so the prompt (last positional) stays last.
		if (transportSpawnConfig) {
			claudeArgs.unshift(...transportSpawnConfig.args);
		}

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

		// FLY-142 PR 1.4: Mailbox sentinel — when present, ~/.flywheel/hooks/inbox-check.sh
		// short-circuits to a no-op. Lead → Runner delivery uses claude-code's
		// stock useInboxPoller (vendor-neutral mailbox), bypassing the buggy
		// CommDB hook filter (only reads type='instruction', drops 'response').
		//
		// Codex r1 PR 1.4 HIGH: sentinel must be GATED on the backend selector
		// — if FLYWHEEL_COMM_BACKEND=commdb (rollback), do NOT write the
		// sentinel AND propagate FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 to the
		// Runner env so even a stale on-disk sentinel from a prior mailbox-mode
		// session is ignored. Without this gate, rollback is broken: every new
		// Runner spawn re-creates the sentinel, hook keeps no-op'ing, legacy
		// CommDB Lead → Runner messages are never injected.
		//
		// Default (env unset / "mailbox"): write sentinel + don't disable.
		// Rollback ("commdb"): skip sentinel write + force disable in Runner env.
		const backendRaw = (
			process.env.FLYWHEEL_COMM_BACKEND ?? "mailbox"
		).toLowerCase();
		const backend: "mailbox" | "commdb" =
			backendRaw === "commdb" ? "commdb" : "mailbox";

		if (backend === "mailbox") {
			try {
				const sentinelDir = join(
					homedir(),
					".flywheel",
					"runner-state",
					ctx.executionId,
				);
				mkdirSync(sentinelDir, { recursive: true });
				const sentinelPath = join(sentinelDir, "mailbox-active");
				writeFileSync(
					sentinelPath,
					JSON.stringify(
						{
							execution_id: ctx.executionId,
							created_at: new Date().toISOString(),
							note: "FLY-142 PR 1.4 — mailbox cutover sentinel; presence tells inbox-check.sh hook to noop.",
						},
						null,
						2,
					),
					"utf-8",
				);
				envArgs.push("-e", `FLYWHEEL_RUNNER_STATE_DIR=${sentinelDir}`);
			} catch (err) {
				// Non-fatal: hook will fall back to old behavior (and thus the wake
				// bug). Log loudly so this gets caught in QA.
				console.error(
					`[TmuxAdapter] FLY-142 sentinel write FAILED for ${ctx.executionId}: ${(err as Error).message}. Runner will be subject to FLY-142 wake bug if Lead writes via flywheel-comm respond.`,
				);
			}
		} else {
			// Rollback: defense-in-depth — even if a stale sentinel exists from a
			// previous mailbox-mode spawn, force the hook to ignore it via env.
			envArgs.push("-e", "FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1");
			console.warn(
				`[TmuxAdapter] FLY-142 PR 1.4 — FLYWHEEL_COMM_BACKEND=commdb (rollback): skipping mailbox sentinel for ${ctx.executionId} + forcing FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 in Runner env. Hook will run legacy CommDB polling path.`,
			);
		}

		// GEO-292: Bridge connection for stage reporting
		if (ctx.bridgeUrl) {
			envArgs.push("-e", `FLYWHEEL_BRIDGE_URL=${ctx.bridgeUrl}`);
		}
		if (ctx.bridgeIngestToken) {
			envArgs.push("-e", `FLYWHEEL_INGEST_TOKEN=${ctx.bridgeIngestToken}`);
		}
		if (ctx.projectName) {
			envArgs.push("-e", `FLYWHEEL_PROJECT_NAME=${ctx.projectName}`);
		}

		// FLY-80: Inject Lead ID + comm CLI path so Runner's /spin approve gate works.
		// Without these, the gate's `if [ -n "$FLYWHEEL_COMM_CLI" ]` check fails
		// and the Runner completes without waiting for Annie's approval.
		if (ctx.leadId) {
			envArgs.push("-e", `FLYWHEEL_LEAD_ID=${ctx.leadId}`);
		}
		if (ctx.commDbPath) {
			try {
				const req = createRequire(import.meta.url);
				const commCliPath = req.resolve("flywheel-comm");
				envArgs.push("-e", `FLYWHEEL_COMM_CLI=${commCliPath}`);
			} catch {
				// flywheel-comm not resolvable — gate will fall back to manual mode
			}
		}

		// FLY-60 W2: inject the landing-signal sentinel path so the
		// `flywheel-comm stage set completed` CLI can read landing-status.json
		// and attach the parsed `landing_status` object to its stage_changed
		// event payload. Bridge's event-route uses that payload to fire
		// `runPostShipFinalization` on the post-merge re-finalize path
		// (codex-approved §12.3 of the FLY-60 plan). Other code paths that
		// don't pass `sentinelPath` are unaffected (env var simply absent).
		if (ctx.sentinelPath) {
			envArgs.push("-e", `FLYWHEEL_LAND_STATUS_PATH=${ctx.sentinelPath}`);
		}

		// FLY-102 / FLY-159: Override Claude Code's Bash tool max timeout.
		// Default is 600,000ms (10 min) which kills gate commands that wait for
		// human decisions. Set to 49h = 48h gate timeout + 1h buffer so the
		// gate CLI can fire its own fail-close path and emit gate_timed_out
		// before the Bash tool kills it.
		envArgs.push("-e", "BASH_MAX_TIMEOUT_MS=176400000");

		// FLY-142 PR 1.2: merge transport-supplied env vars into envArgs.
		// (`transportSpawnConfig` was computed earlier — reused here.)
		if (transportSpawnConfig) {
			for (const [key, value] of Object.entries(transportSpawnConfig.env)) {
				envArgs.push("-e", `${key}=${value}`);
			}
		}

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

		// FLY-116: fire onTmuxWindowCreated callback BEFORE waitForCompletion,
		// so the macOS Terminal viewer opens while the runner is still running.
		if (ctx.onTmuxWindowCreated) {
			try {
				ctx.onTmuxWindowCreated({
					baseSessionName: this.sessionName,
					windowId,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(
					`[TmuxAdapter] onTmuxWindowCreated callback failed: ${msg}`,
				);
			}
		}

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
			// FLY-86: Kill zombie tmux window after timeout
			if (sessionStatus === "timeout") {
				try {
					this.execFileFn("tmux", ["kill-window", "-t", windowId]);
				} catch {
					// Window may already be gone — non-fatal
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

	/**
	 * FLY-142 PR 1.2: build vendor-neutral Agent Team spawn config for this
	 * Runner. Returns null if transport isn't wired OR ctx lacks the required
	 * identity fields — preserves backward compat with all pre-FLY-142
	 * spawn flows that don't yet pass agentName/teamName/vendor.
	 */
	private tryBuildTransportSpawnConfig(
		ctx: AdapterExecutionContext,
	): { args: string[]; env: Record<string, string> } | null {
		if (!this.transport) return null;
		if (!ctx.agentName || !ctx.teamName || !ctx.vendor) return null;

		try {
			return this.transport.buildRunnerSpawnConfig({
				leadName: ctx.leadId ?? ctx.teamName,
				runnerName: ctx.agentName,
				teamName: ctx.teamName,
				...(ctx.leadSessionId !== undefined && {
					parentSessionId: ctx.leadSessionId,
				}),
				...(ctx.agentColor !== undefined && { color: ctx.agentColor }),
				...(ctx.permissionMode !== undefined && {
					permissionMode: ctx.permissionMode,
				}),
				// Pass executionId-derived sessionId so claude-code's
				// `--session-id` flag (also added by buildClaudeArgs) and
				// transport's flag refer to the same session.
				// (Transport's --session-id is purely informational here;
				// buildClaudeArgs appends the canonical --session-id.)
			});
		} catch {
			// Transport spawn-config failure is non-fatal — Runner spawns
			// without Agent Team identity flags (degrades to pre-FLY-142
			// behavior rather than blocking the spawn).
			return null;
		}
	}

	private buildClaudeArgs(
		ctx: AdapterExecutionContext,
		sessionId: string,
	): string[] {
		// CLI syntax: claude [options] [prompt] — options MUST come before prompt
		const args: string[] = [];
		args.push("--session-id", sessionId);
		if (ctx.permissionMode) args.push("--permission-mode", ctx.permissionMode);
		if (ctx.appendSystemPrompt) {
			// FLY-154 hotfix: tmux `new-window` parser has an internal command
			// buffer that rejects very long argv lists with `command too long`
			// (qa-fly-372 hybrid swap test caught this — designer/agent prompts
			// are 6KB+ and combined with --append-system-prompt + issue body
			// + env -e args the parser overflows). claude supports the file
			// variant `--append-system-prompt-file <path>`, which keeps the
			// argv small. Write to a deterministic per-execution path under
			// the system tmpdir so /Users/.flywheel/runs/<id>/ cleanup also
			// works without colliding across runs.
			const promptDir = join(
				tmpdir(),
				"flywheel-runner-prompts",
				ctx.executionId,
			);
			// Codex R3 LOW: shared tmpdir → restrict perms so other local users
			// can't read the prompt contents (designer / issue-body text). 0o700
			// on the dir prevents listing the per-execution subdir, 0o600 on
			// the file prevents reading by anyone but the Runner owner.
			mkdirSync(promptDir, { recursive: true, mode: 0o700 });
			const promptPath = join(promptDir, "append-system-prompt.md");
			writeFileSync(promptPath, ctx.appendSystemPrompt, {
				encoding: "utf-8",
				mode: 0o600,
			});
			args.push("--append-system-prompt-file", promptPath);
		}
		if (ctx.model) args.push("--model", ctx.model);
		if (ctx.allowedTools?.length)
			args.push("--allowed-tools", ...ctx.allowedTools);
		if (ctx.sessionDisplayName) args.push("--name", ctx.sessionDisplayName);
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
	 * count against the normal active-work timeout. This prevents the scenario
	 * where Lead responds after a long delay but Runner immediately times out.
	 *
	 * We track `totalWaitingMs` — accumulated time spent in waiting state.
	 * Normal timeout checks: (elapsed - totalWaitingMs) > normalTimeoutMs
	 * Waiting hard cap: per-wait-period budget (NOT session-total) —
	 *   (now - lastWaitStart) > waitingTimeoutMs (49h, FLY-159 = 48h gate +
	 *   1h buffer). Codex r1 R1 HIGH: a session-total cap would let active
	 *   work eat the wait budget, killing a gate before its own 48h timer
	 *   fires and skipping resolveGate(0) + gate_timed_out notification.
	 *   Each wait period gets its own 49h budget; entering a new wait resets
	 *   the clock.
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
			const hardCap = ctx.waitingTimeoutMs ?? 176_400_000; // 49h
			return {
				shouldTimeout: TmuxAdapter._isWaitingPeriodExpired(
					waitState.lastWaitStart,
					now,
					hardCap,
				),
				isWaiting,
			};
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

			// FLY-159 Codex r2 HIGH: when ctx.waitingTimeoutMs is set (production
			// usage with dynamic gate timeout via CommDB), the outer ultra-safety
			// net must be generous enough that the inner per-wait cap
			// (checkDynamicTimeout) always fires first — otherwise a long active
			// phase + 48h gate would be killed by this timer at 49h
			// session-total, skipping `resolveGate(0)` + `gate_timed_out`.
			// When unset (tests / non-waiting usage), there's no gate semantics
			// so the outer timer keeps its legacy meaning of "absolute active
			// budget."
			const hardTimeoutMs = ctx.waitingTimeoutMs
				? TmuxAdapter._computeOuterHardTimeoutMs(
						timeoutMs,
						ctx.waitingTimeoutMs,
					)
				: timeoutMs;
			const timer = setTimeout(() => {
				console.warn(
					`[TmuxAdapter] Session ${claudeSessionId} hard timeout after ${hardTimeoutMs}ms. Window ${windowId} will be cleaned up.`,
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
								`[TmuxAdapter] Dynamic timeout for ${claudeSessionId}. Window ${windowId} will be cleaned up.`,
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
							"#{pane_dead}|#{pane_dead_status}",
						]);
						const [dead, exitStatus] = result.stdout.trim().split("|");
						if (dead === "1") {
							// FLY-102: Log exit code for crash diagnostics
							const elapsed = Date.now() - start;
							console.log(
								`[TmuxAdapter] Runner pane died: window=${windowId} exit=${exitStatus} elapsed=${Math.round(elapsed / 1000)}s session=${claudeSessionId}`,
							);
							settle(false);
						}
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
								`[TmuxAdapter] Dynamic timeout for ${claudeSessionId}. Window ${windowId} will be cleaned up.`,
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
							"#{pane_dead}|#{pane_dead_status}",
						]);
						const [dead, exitStatus] = result.stdout.trim().split("|");
						if (dead === "1") {
							// FLY-102: Log exit code for crash diagnostics
							const elapsed = Date.now() - start;
							console.log(
								`[TmuxAdapter] Runner pane died: window=${windowId} exit=${exitStatus} elapsed=${Math.round(elapsed / 1000)}s session=${claudeSessionId}`,
							);
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

/**
 * FLY-154 hotfix: exported for direct unit testing of the stderr-capture
 * wrapping. Production callers should still use the default constructor
 * which wires this in automatically.
 */
export function defaultExecFile(
	cmd: string,
	args: string[],
): { stdout: string } {
	try {
		const result = execFileSync(cmd, args, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout: result };
	} catch (err) {
		// FLY-154 hotfix: execFileSync's default error.message is just
		// `Command failed: <cmd>` — it does NOT include stderr, even though
		// `error.stderr` is populated. qa-fly-372 spent a full Bridge restart
		// cycle guessing the cause of a "tmux command too long" failure
		// because Bridge logs only saw the truncated cmd line. Wrap to surface
		// stderr (+ stdout if non-empty) in the thrown message so future
		// failures are observable without re-running. Preserves all other
		// fields (.stderr, .stdout, .status, .signal) for callers that read
		// them programmatically.
		if (err instanceof Error) {
			const e = err as Error & {
				stderr?: string | Buffer;
				stdout?: string | Buffer;
				status?: number;
				signal?: string | null;
			};
			const stderrStr = e.stderr
				? Buffer.isBuffer(e.stderr)
					? e.stderr.toString("utf-8")
					: String(e.stderr)
				: "";
			const stdoutStr = e.stdout
				? Buffer.isBuffer(e.stdout)
					? e.stdout.toString("utf-8")
					: String(e.stdout)
				: "";
			const detail = [
				stderrStr.trim() ? `stderr: ${stderrStr.trim()}` : "",
				stdoutStr.trim() ? `stdout: ${stdoutStr.trim()}` : "",
				e.status != null ? `status: ${e.status}` : "",
				e.signal ? `signal: ${e.signal}` : "",
			]
				.filter(Boolean)
				.join(" | ");
			if (detail) {
				e.message = `${e.message} (${detail})`;
			}
		}
		throw err;
	}
}
