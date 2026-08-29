/**
 * CodexTmuxAdapter — FLY-1188 M4: launches a Codex runner as a RESIDENT
 * `/goal`-driven daemon (`codex app-server --remote-control`), NOT an
 * exec-per-cycle. `execute()` composes the M4 stack:
 *
 *   provision (FLY-793 sandbox scope / FLY-209 gh cred / FLY-123 CODEX_HOME)
 *     → CodexDaemonGoalRuntime.runGoal(objective)         [M4c-2]
 *         spawn daemon → connect → set the `/goal` → drive it across turns
 *         to a terminal ThreadGoalStatus, transparently restarting+resuming
 *         the SAME thread across a daemon death (429/usage-limit rotation);
 *     → founder cmux window (`codex resume --remote`) opened on the first
 *         threadId in the goal stream so Annie can WATCH it run live [M4c-3];
 *     → terminal reclaim: kill the window, stop the daemon, CONFIRM exit.
 *
 * The blocking gate LOOP is gone — the daemon's `/goal` registers gates
 * `--no-block` and POLLS `check` across its own turns (Blueprint's codex branch
 * teaches this; the runner has no exec-cycle resume + no mailbox wake). A
 * CONCURRENT adapter-side gate-deadline watcher restores FLY-159 (it expires an
 * over-deadline marker + emits `gate_timed_out`), since the resident daemon has
 * no blocking loop to own the timeout. Blueprint still awaits one `execute()`
 * exactly like the Claude path.
 *
 * The runtime + the founder window are INJECTED (CodexDaemonAdapterDeps,
 * default = the real ones) so the wiring is unit-testable without a real
 * `codex app-server`; real-daemon behavior is the V5 (529) real-machine
 * acceptance.
 */

import { randomUUID } from "node:crypto";
import {
	accessSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	defaultGateMarkerDir,
	type GateMarker,
	listGateMarkersForExecution,
	removeGateMarker,
} from "flywheel-comm/gate-marker";
import { PONYTAIL_RULESET } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
	IHookCallbackServer,
} from "flywheel-core";
import { sanitizeTmuxName } from "flywheel-core";
import {
	buildDaemonSandboxWritableRoots,
	buildGoalKickText,
	buildGoalObjective,
	classifyGoalOutcome,
	enforceObjectiveLimit,
} from "./codex-daemon-adapter-helpers.js";
import type { CodexDaemonEvents } from "./codex-daemon-client.js";
import {
	GOAL_OBJECTIVE_MAX_CHARS,
	GoalRunError,
} from "./codex-daemon-client.js";
import type {
	CodexDaemonGoalRuntimeOptions,
	RunGoalInput,
	RunGoalOutcome,
} from "./codex-daemon-goal-runtime.js";
import { CodexDaemonGoalRuntime } from "./codex-daemon-goal-runtime.js";
import {
	assertSocketPathFitsSunLen,
	resolveDaemonSocketPath,
} from "./codex-daemon-runtime.js";
import {
	flywheelCodexBin,
	provisionCodexHome,
	rawCodexBin,
	removeCodexHome,
	scrubCodexHomeCredential,
	stripInheritedSecretEnv,
} from "./codex-home.js";
import {
	atomicMergeCodexSessionState,
	type CodexPhaseLifecycle,
	CodexPhaseLifecycleController,
	type CodexPhaseLifecycleControllerOptions,
	type CodexWakeWatcher,
} from "./codex-phase-lifecycle.js";
import {
	ensureRunnerTuiWindow,
	isRunnerTuiWindowAlive,
	killRunnerTuiWindow,
	errMessage as safeErr,
} from "./codex-runner-tui-window.js";

/**
 * FLY-1239: bounded, NON-BLOCKING retry for the founder TUI window. The founder
 * window opens on `onThreadReady`, which fires right after `thread/start` and
 * BEFORE the first turn — so the thread's rollout may not be persisted yet and
 * `codex resume --remote` dies with `-32600 no rollout found`. We reopen (each
 * attempt provably purges its own stale pane first, so ≤1 window ever) on a
 * scheduler that yields the event loop between attempts, letting the goal loop
 * send `setGoal` (which lands the rollout) concurrently. Bounded + fail-loud:
 * after the cap we log once and the run continues without a visible pane.
 */
export const TUI_OPEN_MAX_ATTEMPTS = 8; // per open-chain (includes the first attempt)
export const TUI_OPEN_RETRY_GAP_MS = 900;

import type { ExecFileFn } from "./TmuxAdapter.js";
import { defaultExecFile } from "./TmuxAdapter.js";

/**
 * Structural surface of the codex transport this executor needs. Kept
 * structural (no agent-team-transport import) for the same reason as
 * TmuxAdapter's RunnerSpawnTransport — claude-runner must not couple to a
 * vendor transport package.
 */
export interface CodexRunnerTransport {
	buildRunnerSpawnConfig(ctx: {
		leadName: string;
		runnerName: string;
		teamName: string;
		[key: string]: unknown;
	}): { args: string[]; env: Record<string, string> };
	createReceiver(ctx: {
		leadName: string;
		runnerName: string;
		teamName: string;
		[key: string]: unknown;
	}): CodexWakeWatcher | null;
}

export type { CodexWakeWatcher } from "./codex-phase-lifecycle.js";

/**
 * FLY-1188 M4d: the resident-/goal runtime surface execute() drives — injected
 * (default = a real CodexDaemonGoalRuntime) so the adapter's daemon-mode
 * lifecycle is unit-testable without spawning a real `codex app-server`.
 */
export interface CodexDaemonGoalRuntimeLike {
	runGoal(
		input: RunGoalInput,
		events?: CodexDaemonEvents,
	): Promise<RunGoalOutcome>;
	stop(): void;
	drained(): Promise<void>;
}

/** Injected collaborators for daemon-mode execute() (default to the real ones). */
export interface CodexDaemonAdapterDeps {
	/** Build the resident-/goal runtime for one execution. */
	runtimeFactory?: (
		opts: CodexDaemonGoalRuntimeOptions,
	) => CodexDaemonGoalRuntimeLike;
	/** Open the founder-facing cmux TUI window (fail-open). */
	ensureWindow?: typeof ensureRunnerTuiWindow;
	/** Tear the founder window down on terminal (fail-open). */
	killWindow?: typeof killRunnerTuiWindow;
	/** Is the founder window's pane still alive? (restart-reopen probe.) */
	windowAlive?: (windowName: string) => boolean;
	/** FLY-1239: schedule a founder-window reopen attempt (the rollout-race
	 * retry). Returns a cancel handle. Default: an unref'd `setTimeout`. Injected
	 * in tests to drive the retry chain deterministically. */
	scheduleReopen?: (fn: () => void, ms: number) => () => void;
	/** Build the adapter-owned three-stage phase lifecycle controller. */
	phaseLifecycleFactory?: (
		options: CodexPhaseLifecycleControllerOptions,
	) => CodexPhaseLifecycle;
	/** FLY-1269: heartbeat lifetime seam. Controlled phase shutdown keeps this
	 * running through drain/TUI cleanup/ack; tests pin the stop boundary. */
	startHeartbeat?: (heartbeat: () => void, intervalMs: number) => () => void;
	/** FLY-1269: credential retirement seam used to prove scrub precedes the
	 * request-bound success acknowledgement. */
	scrubCredential?: (executionId: string) => void;
}

export function codexSessionStateDir(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const base =
		env.FLYWHEEL_CODEX_SESSION_DIR?.trim() ||
		join(homedir(), ".flywheel", "state", "codex-sessions");
	return join(base, executionId);
}

export class CodexTmuxAdapter implements IAdapter {
	readonly type = "codex-tmux";
	readonly supportsStreaming = false;
	private preflightDone = false;
	private readonly runtimeFactory: NonNullable<
		CodexDaemonAdapterDeps["runtimeFactory"]
	>;
	private readonly ensureWindow: typeof ensureRunnerTuiWindow;
	private readonly killWindow: typeof killRunnerTuiWindow;
	private readonly windowAliveFn: (windowName: string) => boolean;
	private readonly scheduleReopen: (fn: () => void, ms: number) => () => void;
	private readonly phaseLifecycleFactory: NonNullable<
		CodexDaemonAdapterDeps["phaseLifecycleFactory"]
	>;
	private readonly startHeartbeat: NonNullable<
		CodexDaemonAdapterDeps["startHeartbeat"]
	>;
	private readonly scrubCredential: NonNullable<
		CodexDaemonAdapterDeps["scrubCredential"]
	>;

	constructor(
		private sessionName: string = "flywheel",
		private execFileFn: ExecFileFn = defaultExecFile,
		// The concurrent gate-deadline watcher's poll interval (FLY-159 resident
		// replacement). Same positional slot as TmuxAdapter's factory shape.
		private pollIntervalMs: number = 5000,
		private defaultTimeoutMs: number = 86_400_000, // 24h active budget (mirrors TmuxAdapter)
		// hookServer accepted for constructor-position parity with TmuxAdapter
		// (run-infra registers both via the same factory shape) — unused: the
		// daemon /goal drives its own turns, not via HTTP callbacks.
		_hookServer?: IHookCallbackServer,
		private transport?: CodexRunnerTransport,
		deps: CodexDaemonAdapterDeps = {},
	) {
		this.runtimeFactory =
			deps.runtimeFactory ?? ((opts) => new CodexDaemonGoalRuntime(opts));
		this.ensureWindow = deps.ensureWindow ?? ensureRunnerTuiWindow;
		this.killWindow = deps.killWindow ?? killRunnerTuiWindow;
		this.windowAliveFn =
			deps.windowAlive ??
			((windowName) =>
				isRunnerTuiWindowAlive({
					tmuxSession: this.sessionName,
					windowName,
				}));
		this.scheduleReopen =
			deps.scheduleReopen ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				(t as { unref?: () => void }).unref?.();
				return () => clearTimeout(t);
			});
		this.phaseLifecycleFactory =
			deps.phaseLifecycleFactory ??
			((options) => new CodexPhaseLifecycleController(options));
		this.startHeartbeat =
			deps.startHeartbeat ??
			((heartbeat, intervalMs) => {
				const timer = setInterval(heartbeat, intervalMs);
				(timer as { unref?: () => void }).unref?.();
				return () => clearInterval(timer);
			});
		this.scrubCredential = deps.scrubCredential ?? scrubCodexHomeCredential;
	}

	async checkEnvironment(): Promise<AdapterHealthCheck> {
		// PRECONDITION (QA Finding 2): `codex exec` hard-refuses a non-git cwd
		// ("Not inside a trusted directory") unless --skip-git-repo-check is
		// passed — which we deliberately do NOT pass. Production always runs
		// in a git worktree (WorktreeManager) or the project root (git repo),
		// so this holds; any future non-git execution path must address it.
		try {
			const tmux = this.execFileFn("tmux", ["-V"]).stdout.trim();
			const codex = this.execFileFn("codex", ["--version"]).stdout.trim();
			// FLY-123 WS-B (R1 LOW #6): runners use the repo-owned, CODEX_HOME-
			// aware rotation shim (via FLYWHEEL_CODEX_BIN), NOT Annie's global
			// codex-with-fallback. Health-check the actual shim is executable —
			// a clean host without the global wrapper must still be healthy.
			const shim = flywheelCodexBin();
			accessSync(shim, fsConstants.X_OK);
			return {
				healthy: true,
				message: "tmux, codex CLI and repo rotation shim available",
				details: { tmux, codex, shim },
			};
		} catch (err) {
			return {
				healthy: false,
				message: `Environment check failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/**
	 * FLY-209: extract the host gh token + wire the worktree to use gh's git
	 * credential helper. Returns the token (for the per-cycle GH_TOKEN env
	 * injection) or undefined if gh isn't authenticated — in which case the
	 * runner simply can't push (it will fail closed at the push step, same as
	 * the pre-FLY-209 behavior), which is non-fatal to the rest of the run.
	 *
	 * Token validation: gh tokens are `[A-Za-z0-9_-]`; reject anything else so
	 * a corrupted value never reaches the codex `-c` TOML string (the helper
	 * re-validates with the same charset, defense in depth).
	 */
	private provisionGitHubCredential(
		ctx: AdapterExecutionContext,
	): string | undefined {
		let token: string;
		try {
			token = this.execFileFn("gh", ["auth", "token"]).stdout.trim();
		} catch {
			console.warn(
				`[CodexTmuxAdapter] gh auth token unavailable for ${ctx.executionId} — Codex runner will not be able to push/open PRs (fail-closed at push).`,
			);
			return undefined;
		}
		if (!/^[A-Za-z0-9_-]{1,255}$/.test(token)) {
			console.warn(
				`[CodexTmuxAdapter] gh auth token has unexpected format for ${ctx.executionId} — skipping credential injection.`,
			);
			return undefined;
		}
		// Configure the worktree's git: (1) resolve https pushes via gh (reads
		// GH_TOKEN from the per-cycle sandbox env); (2) rewrite ssh→https for
		// github so the push uses the token path even if the project's origin
		// is an ssh remote — the ssh agent socket is sandbox-blocked, so ssh
		// can never work for a Codex runner. Scoped to github.com; best-effort.
		try {
			this.execFileFn("git", [
				"-C",
				ctx.cwd,
				"config",
				"credential.https://github.com.helper",
				"!gh auth git-credential",
			]);
			this.execFileFn("git", [
				"-C",
				ctx.cwd,
				"config",
				"url.https://github.com/.insteadOf",
				"git@github.com:",
			]);
		} catch (err) {
			console.warn(
				`[CodexTmuxAdapter] failed to set git credential config for ${ctx.executionId}: ${(err as Error).message}`,
			);
		}
		return token;
	}

	async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
		if (!this.preflightDone) {
			this.execFileFn("tmux", ["-V"]);
			this.execFileFn("codex", ["--version"]);
			this.preflightDone = true;
		}

		const start = Date.now();

		// FLY-1188 (sandbox scope): realpath the worktree + resolve its git
		// metadata dirs FIRST (fail-loud — a runner that cannot commit is
		// crippled; see resolveGitWritableDirs for the FLY-793 detail).
		const sandboxCwd = realpathSync(ctx.cwd);
		const gitWritableDirs = this.resolveGitWritableDirs(sandboxCwd);

		// FLY-209 (credentials): host gh token + worktree git credential helper.
		const ghToken = this.provisionGitHubCredential(ctx);

		// FLY-123 (isolation): per-runner CODEX_HOME. From this point the home
		// holds a LIVE GH_TOKEN, so EVERY exit must scrub it (P5) — the whole rest
		// of execute() runs inside the try/finally below (Codex M4d HIGH-5: a
		// throw between here and runGoal must not leak the token).
		const codexHome = provisionCodexHome({
			executionId: ctx.executionId,
			ghToken,
		});

		// Founder cmux window name (a Linear identifier, FLY-272).
		const windowName = sanitizeTmuxName(
			ctx.label ?? `codex-${ctx.executionId.slice(0, 8)}`,
		);
		let tmuxWindow = `${this.sessionName}:${windowName}`;

		let runtime: CodexDaemonGoalRuntimeLike | undefined;
		let phaseLifecycle: CodexPhaseLifecycle | undefined;
		let registeredSession = false;
		let stopGateWatcher: () => void = () => {};
		let stopHeartbeat: () => void = () => {};
		let tuiOpened = false;
		// FLY-1239 founder-window retry state (all scoped to this execution).
		let tuiOpening = false; // a bounded reopen chain is in flight (single-flight)
		let threadReadySeen = false; // did the authoritative onThreadReady hook ever fire?
		let runEnded = false; // set in `finally` — stops any pending reopen from spawning
		let cancelReopen: (() => void) | undefined; // cancel the latest scheduled reopen
		let outcome: RunGoalOutcome | undefined;
		let caughtError: unknown;
		let teardownError: unknown;
		let controlledShutdownRequestId: string | undefined;
		const controlledShutdownSucceeded = (): boolean => {
			if (!controlledShutdownRequestId || teardownError) return false;
			if (classifyGoalOutcome({ outcome, caughtError }).success) return true;
			return (
				caughtError instanceof GoalRunError &&
				caughtError.kind === "transport_closed"
			);
		};

		try {
			// M4c-1: SHORT SUN_LEN-safe control socket (fail loud on over-length).
			const socketPath = resolveDaemonSocketPath(ctx.executionId);
			assertSocketPathFitsSunLen(socketPath);

			// CommDB session registration (vendor=codex → send routing).
			registeredSession = this.registerCommDbSession(ctx, windowName);
			ctx.onHeartbeat?.(ctx.executionId);

			const gateMarkerDir = defaultGateMarkerDir();
			const writableRoots = buildDaemonSandboxWritableRoots({
				flywheelRoot: join(homedir(), ".flywheel"),
				gateMarkerDir,
				commDbDir: ctx.commDbPath ? dirname(ctx.commDbPath) : undefined,
				sandboxCwd,
				gitWritableDirs,
			});

			const systemLayer = ctx.enablePonytail
				? ctx.appendSystemPrompt
					? `${PONYTAIL_RULESET}\n\n---\n\n${ctx.appendSystemPrompt}`
					: PONYTAIL_RULESET
				: ctx.appendSystemPrompt;
			// FLY-1236: the durable /goal objective is a bounded phase-neutral
			// north-star (issueId+label); the FULL working instructions ride the
			// kick turn (turn/start, not subject to the goal's 4000-char cap). This
			// removes the setup_failed the old "fold everything into the objective"
			// form hit at real implement scale. The kick is reconstructed from ctx
			// on every execute(), so a fresh thread (crash → new execId) is kicked
			// with the full body again, never left goal-only.
			const kickText = buildGoalKickText({ systemLayer, prompt: ctx.prompt });
			const { objective, degraded } = enforceObjectiveLimit(
				buildGoalObjective({ issueId: ctx.issueId, label: ctx.label }),
				ctx.issueId,
			);
			if (degraded) {
				this.log(
					`[CodexTmuxAdapter] goal objective exceeded ${GOAL_OBJECTIVE_MAX_CHARS} chars — degraded to minimal pointer; full instructions ride the kick turn (issue=${ctx.issueId})`,
				);
			}

			runtime = this.runtimeFactory({
				executionId: ctx.executionId,
				codexBin: flywheelCodexBin(),
				codexHomes: [codexHome],
				cwd: sandboxCwd,
				socketPath,
				sandbox: "workspace-write",
				approvalPolicy: "never",
				...(ctx.model ? { model: ctx.model } : {}),
				// FLY-1224: per-phase reasoning effort → daemon spawn config override
				// (-c model_reasoning_effort=). Absent → CODEX_HOME config default.
				...(ctx.effort ? { effort: ctx.effort } : {}),
				env: this.buildDaemonEnv(ctx, gateMarkerDir),
				sandboxWritableRoots: writableRoots,
				networkAccess: true,
				logger: (m) => this.log(m),
			});

			if (ctx.phaseKeepAlive) {
				if (!ctx.commDbPath) {
					throw new Error(
						`phase keep-alive requires commDbPath for ${ctx.executionId}`,
					);
				}
				const watcher =
					this.transport && ctx.agentName && ctx.teamName
						? this.transport.createReceiver({
								leadName: ctx.leadId ?? ctx.teamName,
								runnerName: ctx.agentName,
								teamName: ctx.teamName,
							})
						: null;
				phaseLifecycle = this.phaseLifecycleFactory({
					executionId: ctx.executionId,
					role: ctx.phaseKeepAlive.role,
					commDbPath: ctx.commDbPath,
					sessionStatePath: join(
						codexSessionStateDir(ctx.executionId),
						"session.json",
					),
					...(ctx.agentName ? { mailboxAgentName: ctx.agentName } : {}),
					watcher,
				});
				await phaseLifecycle.start();
			}

			const buildSpec = (threadId: string) => ({
				tmuxSession: this.sessionName,
				windowName,
				codexHome,
				socketPath,
				cwd: sandboxCwd,
				threadId,
				// QA · FLY-1188: the TUI gets the RAW codex binary, NOT the
				// rotation shim. The shim pipes stdout through `tee` to sniff
				// 429s, and `codex resume --remote` refuses to render without a
				// TTY ("stdout is not a terminal", exit 1) — which is why the
				// founder's cmux tab came up empty. The daemon above keeps the
				// shim: `app-server` needs no TTY and does want the rotation.
				codexBin: rawCodexBin(),
			});

			// Latch the founder window ON SUCCESS (MEDIUM-1: only on success) +
			// publish the window id.
			const wireCreated = (): void => {
				tuiOpened = true;
				const windowId = this.resolveWindowId(windowName);
				if (windowId) tmuxWindow = `${this.sessionName}:${windowId}`;
				if (ctx.onTmuxWindowCreated) {
					try {
						ctx.onTmuxWindowCreated({
							baseSessionName: this.sessionName,
							windowId: windowId ?? windowName,
						});
					} catch (err) {
						console.warn(
							`[CodexTmuxAdapter] onTmuxWindowCreated failed: ${(err as Error).message}`,
						);
					}
				}
			};

			// FLY-1239: one bounded reopen attempt. ONLY a `died` outcome (a TUI that
			// spawned but exited during settle — the rollout-landing race) is retried;
			// `tmux-absent` / `create-failed` stop after one attempt. Retries are
			// scheduled (never awaited synchronously) so the goal loop keeps advancing
			// and lands the rollout between attempts. Wrapped in a no-throw boundary:
			// an async retry callback that threw would be an uncaught exception and
			// could crash the process — window failure must never break the run.
			const attemptOpen = (threadId: string, n: number): void => {
				try {
					if (runEnded || tuiOpened) {
						tuiOpening = false;
						return;
					}
					const result = this.ensureWindow(buildSpec(threadId), {
						log: (m) => this.log(m),
					});
					if (result.created) {
						wireCreated();
						tuiOpening = false;
						return;
					}
					if (
						result.reason === "died" &&
						n < TUI_OPEN_MAX_ATTEMPTS &&
						!runEnded
					) {
						cancelReopen = this.scheduleReopen(
							() => attemptOpen(threadId, n + 1),
							TUI_OPEN_RETRY_GAP_MS,
						);
						return; // still opening — chain continues on the next tick
					}
					if (result.reason === "died") {
						// fail-loud (bounded, not silent, not infinite). `died` proves an
						// immediate exit, NOT specifically "no rollout found", so keep the
						// cause soft and point at the detailed per-attempt log above.
						this.log(
							`runner-tui-window: founder TUI exited immediately on every attempt (${n}) — most likely the FLY-1239 rollout-landing race, but could be an auth/binary/TTY bootstrap failure; see the preceding runner-tui-window log for the exact command. The run continues (the machine client drives the goal); the founder cannot watch the pane.`,
						);
					}
					// died-exhausted / tmux-absent / create-failed → stop this chain.
					tuiOpening = false;
				} catch (err) {
					this.log(
						`runner-tui-window: reopen attempt threw (non-fatal, fail-open): ${safeErr(err)}`,
					);
					tuiOpening = false; // stop this chain; window failure never breaks the run
				}
			};

			// Start a single-flight reopen chain. The FIRST attempt is scheduled too
			// (0 ms) so `onThreadReady` returns and `setGoal` is sent BEFORE any TUI
			// settle blocks the event loop (Codex R1 MED-2).
			const startOpenChain = (threadId: string): void => {
				if (tuiOpened || tuiOpening || runEnded) return;
				tuiOpening = true;
				try {
					cancelReopen = this.scheduleReopen(() => attemptOpen(threadId, 1), 0);
				} catch (err) {
					tuiOpening = false;
					this.log(
						`runner-tui-window: reopen schedule threw (non-fatal): ${safeErr(err)}`,
					);
				}
			};

			// HIGH-2 (FLY-159 resident replacement): a CONCURRENT gate-deadline
			// watcher. The exec-cycle owned gate timeouts inside its blocking
			// loop, which the resident daemon no longer has — so an unanswered
			// `gate --no-block` marker would otherwise hang until the overall goal
			// budget. This expires the CommDB question at the marker's configured
			// deadline + emits gate_timed_out for fail-close (FLY-159 parity).
			stopGateWatcher = this.startGateDeadlineWatcher(ctx, gateMarkerDir);

			// Periodic heartbeat (Codex R2 HIGH): the exec-cycle beat every poll;
			// the resident daemon has no such loop, so without this a long task or
			// a 48h gate wait reads as stale and the monitor may reap a LIVE
			// daemon. Beat on every goal notification (frequent while working) AND
			// on a periodic timer (covers quiet gate-waits).
			const heartbeat = (): void => {
				try {
					ctx.onHeartbeat?.(ctx.executionId);
				} catch {
					/* heartbeat is best-effort — never break the run */
				}
			};
			stopHeartbeat = this.startHeartbeat(heartbeat, this.pollIntervalMs);

			// AUTHORITATIVE own-thread hook (MEDIUM-2): NOT a raw notification (a
			// daemon can emit foreign-thread traffic). On OUR thread becoming ready:
			// persist the resume handle (HIGH-4) + (re)open the founder window. On a
			// daemon RESTART (restarts > 0) the old remote TUI may have exited when
			// its socket closed — re-open if the pane is dead (Codex R2 MEDIUM).
			// HIGH-3: track the live daemon pid (updated on every spawn/restart via
			// onDaemonPid) so persistSessionState records the CURRENT daemon — a
			// resuming redrive reaps it if a Bridge crash orphaned it.
			let latestDaemonPid: number | undefined;
			const onThreadReady = (threadId: string, restarts: number): void => {
				threadReadySeen = true; // authoritative hook fired → the fallback is not needed
				this.persistSessionState(ctx, threadId, windowName, latestDaemonPid);
				if (restarts > 0 && tuiOpened && !this.isWindowAlive(windowName)) {
					tuiOpened = false; // pane died with the old socket — reopen below
				}
				startOpenChain(threadId);
			};

			// FLY-245 launch commit written the INSTANT the goal is actually SET
			// (Codex R2 HIGH: onThreadReady fires BEFORE setGoal — writing the
			// commit there could make a retry ADOPT a goal-less thread). Only latch
			// `committed` on a SUCCESSFUL write, so a restart retries it (a swallowed
			// failure that still set committed would let a replay collide).
			let committed = false;
			const onGoalActive = (): void => {
				if (committed || !ctx.launchCommitPath) return;
				if (this.writeLaunchCommit(ctx.launchCommitPath)) committed = true;
			};

			// HIGH-4 (Codex R2): resume the prior thread across a Bridge/adapter
			// crash. HIGH-3 (Codex full-PR review) CORRECTS the earlier premise: the
			// codex daemon is a child of the Bridge, but `detached:false` does NOT
			// kill it when the Bridge dies on Unix — it is reparented to init and
			// keeps running (orphaned). Resume still needs the persisted thread id;
			// prefer an explicit ctx.previousSession.threadId (if the dispatcher ever
			// provides one), else the session.json this adapter persisted (keyed by
			// executionId), so a re-execute of the SAME execution resumes the same
			// thread with NO Bridge-side wiring. The persisted daemon PID lets the
			// resuming spawn REAP a prior orphan still holding our socket (see
			// reapOrphanPid) instead of blocking on it forever.
			const resumeThreadId =
				(typeof ctx.previousSession?.threadId === "string"
					? (ctx.previousSession.threadId as string)
					: undefined) ?? this.readPersistedThreadId(ctx.executionId);
			const reapOrphanPid = this.readPersistedDaemonPid(ctx.executionId);

			const goalPromise = runtime.runGoal(
				{
					objective,
					// FLY-1236: the full working instructions ride the kick turn
					// (turn/start), not the length-capped /goal objective.
					kickText,
					// MED-7 (Codex full-PR review): the ACTIVE cap applies normally; the
					// larger gate-wait cap extends the deadline ONLY while a gate is
					// actually open (isWaiting). The old `max(active, waiting)` gave
					// EVERY run the 49h ceiling — a task that never opens a gate lost
					// the 24h active-cap invariant and could run ~49h.
					overallTimeoutMs: ctx.timeoutMs ?? this.defaultTimeoutMs,
					waitingTimeoutMs: ctx.waitingTimeoutMs ?? 176_400_000,
					isWaiting: () => {
						try {
							// An unanswered `gate --no-block` marker for this execution =
							// a gate the runner is (possibly) blocked on. Best-effort: a
							// read error must never extend the budget.
							return listGateMarkersForExecution(
								gateMarkerDir,
								ctx.executionId,
							).some((m) => !m.answeredAt);
						} catch {
							return false;
						}
					},
					...(resumeThreadId ? { resumeThreadId } : {}),
					...(reapOrphanPid !== undefined ? { reapOrphanPid } : {}),
					onThreadReady,
					// HIGH-3: capture each spawned daemon's pid so onThreadReady
					// persists the CURRENT daemon for post-crash orphan reaping.
					onDaemonPid: (pid) => {
						latestDaemonPid = pid;
					},
					onGoalActive,
					...(phaseLifecycle ? { phaseLifecycle } : {}),
				},
				{ onNotification: () => heartbeat() },
			);
			if (phaseLifecycle) {
				type GoalSettled =
					| { kind: "goal"; outcome: RunGoalOutcome }
					| { kind: "error"; error: unknown };
				const settledGoal: Promise<GoalSettled> = goalPromise.then(
					(value) => ({ kind: "goal", outcome: value }),
					(error: unknown) => ({ kind: "error", error }),
				);
				const first = await Promise.race([
					settledGoal,
					phaseLifecycle
						.waitForShutdown()
						.then(
							({ requestId }) => ({ kind: "shutdown", requestId }) as const,
						),
				]);
				if (first.kind === "shutdown") {
					controlledShutdownRequestId = first.requestId;
					runtime.stop();
					const settled = await settledGoal;
					if (settled.kind === "goal") outcome = settled.outcome;
					else caughtError = settled.error;
				} else if (first.kind === "goal") {
					outcome = first.outcome;
				} else {
					throw first.error;
				}
			} else {
				outcome = await goalPromise;
			}
			// Fallback: ONLY when the authoritative onThreadReady hook NEVER fired (a
			// very fast / quiet run) — open from the resolved outcome so the founder
			// still gets the pane. One synchronous shot, no retry (the run has ended,
			// the rollout exists, teardown is imminent). Its OWN no-throw boundary
			// (Codex R2 MED-2): a visibility-only throw here must not reach the outer
			// catch, where classifyGoalOutcome would let it override a successful goal.
			if (!threadReadySeen && !tuiOpened && outcome?.threadId) {
				try {
					const o = this.ensureWindow(buildSpec(outcome.threadId), {
						log: (m) => this.log(m),
					});
					if (o.created) wireCreated();
				} catch (err) {
					this.log(
						`runner-tui-window: fallback open threw (non-fatal, fail-open): ${safeErr(err)}`,
					);
				}
			}
		} catch (err) {
			caughtError = err;
		} finally {
			// FLY-1239: cancel any pending founder-window reopen BEFORE teardown — so a
			// scheduled retry cannot fire during `await runtime.drained()` and spawn a
			// window pointing at a now-dead daemon socket. In its OWN no-throw boundary
			// (Codex code R1 MED-1): a throwing cancel handle must NEVER abort teardown
			// (killWindow / runtime.stop / drained / CommDB closeout / credential scrub)
			// — a visibility-only failure staying fail-open is the whole contract.
			runEnded = true;
			try {
				cancelReopen?.();
			} catch (err) {
				this.log(
					`runner-tui-window: reopen cancel threw (non-fatal, teardown continues): ${safeErr(err)}`,
				);
			}
			stopGateWatcher();
			if (phaseLifecycle) {
				try {
					await phaseLifecycle.stopIntake();
				} catch (err) {
					teardownError ??= err;
					console.warn(
						`[CodexTmuxAdapter] ${ctx.executionId} phase intake teardown failed: ${(err as Error).message}`,
					);
				}
			}
			if (phaseLifecycle && controlledShutdownRequestId) {
				// FLY-1269 request-bound order: keep the heartbeat advancing while
				// daemon drain and required cleanup run. The matching ack is written
				// only after the TUI, registry status, and credential are retired.
				if (runtime) {
					runtime.stop();
					try {
						await runtime.drained();
					} catch (err) {
						teardownError = err;
						console.warn(
							`[CodexTmuxAdapter] ${ctx.executionId} daemon teardown unconfirmed: ${(err as Error).message}`,
						);
					}
				}
				try {
					this.killWindow(
						{ tmuxSession: this.sessionName, windowName },
						{ log: (m) => this.log(m) },
					);
				} catch (err) {
					teardownError ??= err;
				}
				if (registeredSession && ctx.commDbPath) {
					let commDb: CommDB | undefined;
					try {
						commDb = new CommDB(ctx.commDbPath);
						commDb.updateSessionStatus(
							ctx.executionId,
							controlledShutdownSucceeded() ? "completed" : "timeout",
						);
					} catch (err) {
						teardownError ??= err;
					} finally {
						commDb?.close();
					}
				}
				try {
					this.scrubCredential(ctx.executionId);
				} catch (err) {
					teardownError ??= err;
				}
				try {
					phaseLifecycle.ackShutdown(
						controlledShutdownRequestId,
						controlledShutdownSucceeded()
							? { ok: true }
							: {
									ok: false,
									error:
										teardownError instanceof Error
											? teardownError.message
											: caughtError instanceof Error
												? caughtError.message
												: "controlled shutdown did not settle cleanly",
								},
					);
				} catch (err) {
					teardownError ??= err;
				}
				stopHeartbeat();
				try {
					await phaseLifecycle.stop();
				} catch (err) {
					teardownError ??= err;
				}
			} else {
				// Ordinary/non-request-bound Codex retains terminal-window-first order.
				stopHeartbeat();
				this.killWindow(
					{ tmuxSession: this.sessionName, windowName },
					{ log: (m) => this.log(m) },
				);
				if (runtime) {
					runtime.stop();
					try {
						await runtime.drained();
					} catch (err) {
						teardownError = err;
						console.warn(
							`[CodexTmuxAdapter] ${ctx.executionId} daemon teardown unconfirmed: ${(err as Error).message}`,
						);
					}
				}
				if (phaseLifecycle) {
					try {
						await phaseLifecycle.stop();
					} catch (err) {
						teardownError ??= err;
					}
				}
				if (registeredSession && ctx.commDbPath) {
					try {
						const commDb = new CommDB(ctx.commDbPath);
						const c = classifyGoalOutcome({ outcome, caughtError });
						const okComplete =
							(c.success || controlledShutdownSucceeded()) && !teardownError;
						commDb.updateSessionStatus(
							ctx.executionId,
							okComplete ? "completed" : "timeout",
						);
						commDb.close();
					} catch {
						// non-fatal (legacy behavior)
					}
				}
				this.scrubCredential(ctx.executionId);
			}
		}

		const cls = classifyGoalOutcome({ outcome, caughtError });
		// HIGH-6: an unconfirmed daemon teardown fails the run (a live daemon +
		// "completed" would be a lie).
		const success =
			(cls.success || controlledShutdownSucceeded()) && !teardownError;
		const threadId = outcome?.threadId;
		const result: AdapterExecutionResult = {
			success,
			sessionId: threadId ?? ctx.executionId,
			tmuxWindow,
			durationMs: Date.now() - start,
			timedOut: cls.timedOut,
			sessionParams: {
				vendor: "codex",
				...(threadId && { threadId }),
			},
		};
		if (cls.resultText !== undefined) result.resultText = cls.resultText;
		if (!success) {
			const reason =
				cls.failureReason ??
				(teardownError
					? `daemon teardown unconfirmed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`
					: undefined);
			if (reason)
				console.error(
					`[CodexTmuxAdapter] ${ctx.executionId} failed: ${reason}`,
				);
		}
		return result;
	}

	/**
	 * FLY-245: write the durable launch commit the INSTANT the goal is SET on our
	 * thread (the daemon-mode analog of the exec-cycle's pre-send-keys commit) — so
	 * a gateway retry's adopt sees a committed Runner only once codex is actually
	 * driving the goal, and a crash BEFORE the goal is set re-drives instead of
	 * adopting a goal-less thread (Codex R2 HIGH). Returns whether the write
	 * SUCCEEDED so the caller only latches `committed` on success (a swallowed
	 * failure + latched committed would let a replay collide with a live daemon).
	 */
	private writeLaunchCommit(commitPath: string): boolean {
		try {
			mkdirSync(dirname(commitPath), { recursive: true });
			writeFileSync(commitPath, "");
			return true;
		} catch (err) {
			console.warn(
				`[CodexTmuxAdapter] launch-commit write failed (will retry on restart): ${(err as Error).message}`,
			);
			return false;
		}
	}

	/**
	 * Read the thread id this execution persisted (Codex R2 HIGH-4 crash-recovery
	 * READER — the codex adapter owns its own resume handle, so a re-execute of
	 * the same executionId after a Bridge crash resumes the same thread without any
	 * dispatcher-side wiring). Best-effort: absent/unreadable/corrupt → undefined
	 * (a fresh thread is started).
	 */
	private readPersistedThreadId(executionId: string): string | undefined {
		try {
			const p = join(codexSessionStateDir(executionId), "session.json");
			if (!existsSync(p)) return undefined;
			const state = JSON.parse(readFileSync(p, "utf-8")) as {
				threadId?: unknown;
			};
			return typeof state.threadId === "string" && state.threadId
				? state.threadId
				: undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * HIGH-3: read the prior daemon's pid persisted by the previous run of THIS
	 * execution, so a resuming redrive can reap it if it was orphaned by a Bridge
	 * crash (see spawnCodexDaemon.reapOrphanPid). Undefined when absent/malformed
	 * → the spawn keeps its safe refuse-to-clobber behavior.
	 */
	private readPersistedDaemonPid(executionId: string): number | undefined {
		try {
			const p = join(codexSessionStateDir(executionId), "session.json");
			if (!existsSync(p)) return undefined;
			const state = JSON.parse(readFileSync(p, "utf-8")) as {
				daemonPid?: unknown;
			};
			return typeof state.daemonPid === "number" &&
				Number.isInteger(state.daemonPid) &&
				state.daemonPid > 0
				? state.daemonPid
				: undefined;
		} catch {
			return undefined;
		}
	}

	/** Is the founder TUI window's pane still alive? (used to reopen after a
	 * daemon restart closed its old socket). Fail-open: unknown → treat as alive
	 * so we don't churn the window. */
	private isWindowAlive(windowName: string): boolean {
		try {
			return this.windowAliveFn(windowName);
		} catch {
			return true;
		}
	}

	/**
	 * Crash-recovery state (FLY-172 marker pattern, Codex M4d HIGH-4): persist the
	 * discovered thread id AT discovery so a Bridge/adapter crash + retry can
	 * RESUME the same thread (`previousSession.threadId`) instead of starting a
	 * new one. Written on each own-thread-ready (idempotent).
	 */
	private persistSessionState(
		ctx: AdapterExecutionContext,
		threadId: string,
		windowName: string,
		daemonPid: number | undefined,
	): void {
		try {
			const stateDir = codexSessionStateDir(ctx.executionId);
			mkdirSync(stateDir, { recursive: true, mode: 0o700 });
			atomicMergeCodexSessionState(join(stateDir, "session.json"), {
				executionId: ctx.executionId,
				issueId: ctx.issueId,
				tmuxWindow: `${this.sessionName}:${windowName}`,
				cwd: ctx.cwd,
				vendor: "codex",
				threadId,
				// HIGH-3: the live daemon's pid, so a resuming redrive can reap
				// this daemon if a Bridge crash orphaned it (detached:false does
				// NOT kill the child on parent death). Omitted when unknown.
				...(daemonPid !== undefined ? { daemonPid } : {}),
				updatedAt: new Date().toISOString(),
			});
		} catch (err) {
			console.warn(
				`[CodexTmuxAdapter] session state persist failed: ${(err as Error).message}`,
			);
		}
	}

	/**
	 * HIGH-2 (FLY-159 resident replacement): a concurrent watcher that expires an
	 * unanswered `gate --no-block` marker at ITS configured deadline (not the
	 * unrelated overall goal budget), emitting a `gate_timed_out` payload
	 * isomorphic to FLY-159's for fail-close markers (fail-open is silent by
	 * design — the runner's own `check` poll then sees the question resolved and
	 * continues). Returns a stop function (cleared in the execute finally). No-op
	 * without a CommDB. The timer is unref'd so it never keeps the process alive.
	 */
	private startGateDeadlineWatcher(
		ctx: AdapterExecutionContext,
		gateMarkerDir: string,
	): () => void {
		if (!ctx.commDbPath) return () => {};
		const fallbackTimeoutMs = ctx.waitingTimeoutMs ?? 176_400_000;
		const startedAt = Date.now();
		const seen = new Set<string>(); // never re-emit for the same marker
		const removeMarker = (questionId: string): void => {
			try {
				removeGateMarker(gateMarkerDir, questionId);
			} catch {
				// best-effort — TTL reaps eventually
			}
		};
		const tick = (): void => {
			try {
				const markers = listGateMarkersForExecution(
					gateMarkerDir,
					ctx.executionId,
				);
				const now = Date.now();
				for (const m of markers) {
					if (seen.has(m.questionId)) continue;
					// Already answered by the Lead (respond wrote answeredAt) — stop
					// watching; never expire a real answer (Codex R2 HIGH). The marker's
					// routing job is done, so clean it up (Codex R3 LOW: don't leave an
					// answered marker to residue + re-scan on every re-execute).
					if (m.answeredAt) {
						seen.add(m.questionId);
						removeMarker(m.questionId);
						continue;
					}
					const createdAt = Date.parse(m.createdAt);
					const anchor = Number.isFinite(createdAt) ? createdAt : startedAt;
					if (now - anchor <= (m.timeoutMs ?? fallbackTimeoutMs)) continue;
					// Deadline passed — resolve as a timeout, RACE-SAFE.
					const outcome = this.resolveGateOnTimeout(ctx, m, now - anchor);
					if (outcome === "retry") continue; // DB error — retry next tick (no seen)
					// timedOut: we wrote the synthetic timeout response the runner's
					// `check` will read. raced: a real Lead answer landed first. Either
					// way the gate is resolved — stop watching + remove the marker so it
					// doesn't residue (Codex R3 LOW).
					seen.add(m.questionId);
					removeMarker(m.questionId);
				}
			} catch {
				// best-effort — retry next tick
			}
		};
		const timer = setInterval(tick, this.pollIntervalMs);
		(timer as { unref?: () => void }).unref?.();
		return () => clearInterval(timer);
	}

	/**
	 * Resolve an over-deadline gate as a TIMEOUT — RACE-SAFE (Codex R2 HIGH). It
	 * atomically writes a synthetic timeout RESPONSE via `insertResponseIfGateOpen`
	 * IFF the gate is still open (owner + checkpoint match, unresolved, unexpired,
	 * unanswered) — so:
	 *  - the polling runner's `flywheel-comm check` sees the timeout (getResponse
	 *    returns it) and acts per fail-open (continue) / fail-close (stop) — the
	 *    OLD `resolveGate`-only path left `check` returning "pending" forever;
	 *  - a concurrent REAL Lead answer wins the atomic INSERT (we get `false` →
	 *    "raced"), so we never clobber it.
	 * Returns "timedOut" (we wrote it), "raced" (a real answer landed first), or
	 * "retry" (DB error — try next tick).
	 */
	private resolveGateOnTimeout(
		ctx: AdapterExecutionContext,
		marker: GateMarker,
		waitedMs: number,
	): "timedOut" | "raced" | "retry" {
		if (!ctx.commDbPath) return "retry";
		const behavior = marker.timeoutBehavior ?? "fail-close";
		const content =
			behavior === "fail-open"
				? `GATE TIMEOUT (fail-open) on your ${marker.checkpoint} checkpoint — no Lead response arrived within the deadline. Per fail-open semantics, CONTINUE using your best judgment.`
				: `GATE TIMEOUT (fail-close) on your ${marker.checkpoint} checkpoint — no Lead response arrived within the deadline. Per fail-close semantics, STOP: do not proceed; run \`flywheel-comm complete --route blocked\`.`;
		try {
			const db = new CommDB(ctx.commDbPath);
			try {
				// HIGH-2 (Codex full-PR review): the gate deadline ≈ the question's
				// own expires_at, so at timeout the question is ALREADY expired.
				// `insertResponseIfGateOpen` (unexpired guard) would refuse, and a
				// following `resolveGate(_,0)` + the runner's next-open purge would
				// delete the synthetic response before `check` reads it.
				// `insertTimeoutResponse` writes without the unexpired guard AND
				// atomically bumps the question's expires_at to a grace window so the
				// purge cascade can't remove it — while still losing the race to a
				// real Lead answer (NOT EXISTS response) → "raced".
				const wrote = db.insertTimeoutResponse({
					questionId: marker.questionId,
					fromAgent: "codex-tmux-adapter",
					content,
					expectedOwner: ctx.executionId, // gate question from_agent = execId
					expectedCheckpoint: marker.checkpoint,
				});
				if (!wrote) return "raced";
			} finally {
				db.close();
			}
		} catch {
			return "retry"; // DB busy/error — try again next tick
		}
		// FLY-159 escalation is fail-close only (fail-open is silent by design).
		if (behavior === "fail-close")
			void this.emitGateTimedOut(ctx, marker, waitedMs);
		return "timedOut";
	}

	/** FLY-159-isomorphic gate_timed_out payload via the Bridge /events route. */
	private async emitGateTimedOut(
		ctx: AdapterExecutionContext,
		marker: GateMarker,
		waitedMs: number,
	): Promise<void> {
		if (!ctx.bridgeUrl || !ctx.projectName) return;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (ctx.bridgeIngestToken)
			headers.Authorization = `Bearer ${ctx.bridgeIngestToken}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		try {
			await fetch(`${ctx.bridgeUrl}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					event_id: randomUUID(),
					execution_id: ctx.executionId,
					issue_id: ctx.issueId,
					project_name: ctx.projectName,
					event_type: "gate_timed_out",
					source: "codex-tmux-adapter",
					payload: {
						checkpoint: marker.checkpoint,
						exec_id: ctx.executionId,
						lead_id: ctx.leadId ?? "unknown",
						waited_ms: waitedMs,
						original_message: marker.message ?? "(codex no-block gate)",
						timeout_behavior: marker.timeoutBehavior ?? "fail-close",
						timeout_behavior_source: marker.timeoutBehaviorSource ?? "default",
						question_id: marker.questionId,
					},
				}),
				signal: controller.signal,
			});
		} catch {
			// best-effort — the watcher already expired the question
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Build the daemon process env: process.env + the FLYWHEEL_* protocol vars
	 * the runner's shell commands (flywheel-comm gate/stage/complete) need +
	 * transport identity. GitHub-token vars are stripped in spawnCodexDaemon
	 * (stripSecretEnv) so they never reach the codex process env; CODEX_HOME is
	 * layered on there too.
	 */
	private buildDaemonEnv(
		ctx: AdapterExecutionContext,
		gateMarkerDir: string,
	): NodeJS.ProcessEnv {
		// Codex full-PR review HIGH-4: wash the Bridge's third-party creds out of
		// the INHERITED env before layering this runner's own FLYWHEEL_* values —
		// the resident daemon runs model-driven shells and must never inherit
		// Discord/Linear/DB/API secrets. FLYWHEEL_* (incl. the ingest token set
		// below) is preserved by the wash.
		const env: NodeJS.ProcessEnv = stripInheritedSecretEnv(process.env);
		env.FLYWHEEL_GATE_MARKER_DIR = gateMarkerDir;
		env.FLYWHEEL_RUNNER_BACKEND_ID = "codex-tmux";
		env.FLYWHEEL_RUNNER_VENDOR_ID = "codex";
		if (ctx.commDbPath) env.FLYWHEEL_COMM_DB = ctx.commDbPath;
		env.FLYWHEEL_EXEC_ID = ctx.executionId;
		env.FLYWHEEL_ISSUE_ID = ctx.issueId ?? "unknown";
		if (ctx.bridgeUrl) env.FLYWHEEL_BRIDGE_URL = ctx.bridgeUrl;
		if (ctx.bridgeIngestToken)
			env.FLYWHEEL_INGEST_TOKEN = ctx.bridgeIngestToken;
		if (ctx.workflowSubmissionCredential)
			env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL =
				ctx.workflowSubmissionCredential;
		if (ctx.stateDbPath) env.FLYWHEEL_STATE_DB_PATH = ctx.stateDbPath;
		if (ctx.progressPath) env.FLYWHEEL_PROGRESS_PATH = ctx.progressPath; // FLY-795
		if (ctx.projectName) env.FLYWHEEL_PROJECT_NAME = ctx.projectName;
		if (ctx.leadId) env.FLYWHEEL_LEAD_ID = ctx.leadId;
		if (ctx.sentinelPath) env.FLYWHEEL_LAND_STATUS_PATH = ctx.sentinelPath;
		try {
			env.FLYWHEEL_COMM_CLI = this.resolveCommCli();
		} catch {
			// gate instructions fall back to manual mode
		}
		// Transport identity env (agent-team mailbox) — no codex flags; the daemon
		// argv is owned by spawnCodexDaemon.
		if (this.transport && ctx.agentName && ctx.teamName) {
			try {
				const spawnConfig = this.transport.buildRunnerSpawnConfig({
					leadName: ctx.leadId ?? ctx.teamName,
					runnerName: ctx.agentName,
					teamName: ctx.teamName,
				});
				for (const [key, value] of Object.entries(spawnConfig.env)) {
					env[key] = value;
				}
			} catch {
				// degrade to identity-less spawn (mirrors TmuxAdapter)
			}
		}
		return env;
	}

	/**
	 * Register the CommDB session (vendor=codex) for send-routing + tracking. The
	 * tmux target is name-based (the founder window is created lazily on the
	 * first threadId). Best-effort — non-fatal, mirrors TmuxAdapter.
	 */
	private registerCommDbSession(
		ctx: AdapterExecutionContext,
		windowName: string,
	): boolean {
		if (!ctx.commDbPath) return false;
		try {
			const commDb = new CommDB(ctx.commDbPath);
			commDb.registerSession(
				ctx.executionId,
				`${this.sessionName}:${windowName}`,
				ctx.projectName ?? "unknown",
				ctx.issueId,
				ctx.leadId,
				// FLY-1188: vendor routes `flywheel-comm send` wakes to the codex
				// mailbox (the claude-code env default misrouted them).
				"codex",
			);
			commDb.close();
			return true;
		} catch {
			return false; // non-fatal (same as TmuxAdapter)
		}
	}

	/**
	 * Best-effort resolve the founder window's tmux id (for onTmuxWindowCreated +
	 * the reported tmuxWindow). Undefined if the window isn't resolvable.
	 */
	private resolveWindowId(windowName: string): string | undefined {
		try {
			const out = this.execFileFn("tmux", [
				"display-message",
				"-p",
				"-t",
				`=${this.sessionName}:=${windowName}`,
				"#{window_id}",
			]).stdout.trim();
			return out || undefined;
		} catch {
			return undefined;
		}
	}

	/** Adapter log line (the daemon runtime + founder-window fns route here). */
	private log(m: string): void {
		console.log(`[CodexTmuxAdapter] ${m}`);
	}

	/**
	 * FLY-1188: resolve the worktree's git metadata dirs for the sandbox
	 * writable roots. `--git-dir` = the worktree's private metadata (a linked
	 * worktree keeps it under <main>/.git/worktrees/<name> — index/HEAD/locks
	 * live there); `--git-common-dir` = the shared store (<main>/.git —
	 * objects/refs). Both must be writable or `git add/commit/push` inside
	 * the worktree dies in the Seatbelt sandbox. `--path-format=absolute`
	 * because rev-parse otherwise emits cwd-relative paths. Failure THROWS:
	 * a codex runner that cannot commit is crippled — abort the spawn loudly
	 * (mirrors GitService.getGitMetadataDirectories, which the legacy
	 * EdgeWorker path already feeds into allowedDirectories).
	 */
	private resolveGitWritableDirs(cwd: string): string[] {
		let stdout: string;
		try {
			stdout = this.execFileFn("git", [
				"-C",
				cwd,
				"rev-parse",
				"--path-format=absolute",
				"--git-dir",
				"--git-common-dir",
			]).stdout;
		} catch (err) {
			throw new Error(
				`[CodexTmuxAdapter] cannot resolve git metadata dirs for ${cwd} — a codex runner that cannot commit is crippled; refusing to spawn: ${(err as Error).message}`,
			);
		}
		const lines = stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		if (lines.length < 2) {
			throw new Error(
				`[CodexTmuxAdapter] cannot resolve git metadata dirs for ${cwd} — unexpected rev-parse output ${JSON.stringify(stdout)}; refusing to spawn`,
			);
		}
		return [...new Set(lines.map((l) => realpathSync(l)))];
	}

	private resolveCommCli(): string {
		const req = createRequire(import.meta.url);
		return req.resolve("flywheel-comm");
	}
}

// re-exported for tests that need to clean state dirs
export function removeCodexSessionState(executionId: string): void {
	try {
		rmSync(codexSessionStateDir(executionId), { recursive: true, force: true });
	} catch {
		// best-effort
	}
	// FLY-123 P5: full retirement also removes the per-runner CODEX_HOME
	// (auth shell + sessions). Credential was already scrubbed at terminal;
	// this reclaims the whole dir.
	removeCodexHome(executionId);
}
