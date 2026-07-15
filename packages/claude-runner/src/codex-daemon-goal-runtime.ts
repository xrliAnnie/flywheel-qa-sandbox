/**
 * FLY-1188 M4c-2 — the runner-side resident-/goal runtime: composes the daemon
 * spawn primitive (M4c-1), the ws transport (M4b), and the daemon client + goal
 * loop (M4a) into one "drive a goal to terminal on a resident daemon" call, and
 * survives a daemon death mid-run by restarting the daemon (optionally on the
 * NEXT account, for 429/usage-limit rotation) and RESUMING the same thread —
 * the goal state is persisted with the thread (V2-verified), so a restart
 * continues where it left off rather than starting over.
 *
 * All heavy collaborators (spawn, connect, client, goal loop) are injected so
 * the lifecycle + restart/resume logic is unit-testable without a live daemon.
 */

import {
	CodexDaemonClient,
	CodexDaemonError,
	type CodexDaemonEvents,
	type DaemonTransport,
	type GoalPhaseLifecycle,
	GoalRunError,
	type GoalRunResult,
	type GoalStatus,
	runGoalToTerminal,
} from "./codex-daemon-client.js";
import {
	type DaemonHandle,
	resolveDaemonSocketPath,
	type SpawnCodexDaemonOptions,
	spawnCodexDaemon,
} from "./codex-daemon-runtime.js";
import {
	type ConnectDaemonTransportOptions,
	connectDaemonTransport,
} from "./codex-daemon-transport.js";

export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy =
	| "never"
	| "on-request"
	| "on-failure"
	| "unless-trusted";

/** One connected daemon session: the live daemon + the client speaking to it. */
interface DaemonSession {
	handle: DaemonHandle;
	client: CodexDaemonClient;
	/** Which account (CODEX_HOME) this daemon is running under. */
	codexHome: string;
	/** Resolves when the daemon process actually EXITS (armed at spawn — Node
	 * keeps exitCode null on a signal kill, so we key on the `exit` event). */
	exited: Promise<void>;
}

/** A dead-but-maybe-not-yet-exited daemon the restart path must wait on. */
interface DyingDaemon {
	handle: DaemonHandle;
	exited: Promise<void>;
}

export interface CodexDaemonGoalRuntimeOptions {
	executionId: string;
	codexBin: string;
	/**
	 * Account rotation pool of CODEX_HOMEs. The first is used initially; a
	 * daemon death restarts on the NEXT (429/usage-limit rotation). At least one
	 * is required.
	 */
	codexHomes: string[];
	/** Worktree the daemon's thread runs in. */
	cwd: string;
	sandbox?: Sandbox;
	approvalPolicy?: ApprovalPolicy;
	model?: string;
	/**
	 * FLY-1224: reasoning effort delivered as a DAEMON-level config override
	 * (`-c model_reasoning_effort="<effort>"` on the app-server spawn — the
	 * thread/start API has no effort field). Replayed on every rotation restart.
	 * Absent → the CODEX_HOME config default.
	 */
	effort?: string;
	baseInstructions?: string;
	/**
	 * FLY-1188 M4d: extra sandbox writable roots for the daemon's workspace-write
	 * threads (the realpath'd worktree + its linked-worktree git metadata dirs),
	 * delivered to the daemon spawn as `-c sandbox_workspace_write.writable_roots`.
	 * Without these a linked-worktree `git commit` dies in the Seatbelt sandbox.
	 */
	sandboxWritableRoots?: string[];
	/** FLY-1188 M4d: grant the daemon's threads network access (Bridge POST / git
	 * push / gh) — `-c sandbox_workspace_write.network_access=true`. */
	networkAccess?: boolean;
	/** Override the control-socket path (default: derived from executionId). */
	socketPath?: string;
	/** Base env for the daemon (default process.env; secrets are stripped in spawn). */
	env?: NodeJS.ProcessEnv;
	/** Max daemon restarts during a single goal run (default 5). */
	maxRestarts?: number;
	/** Bounded wait for a dying daemon to exit before a restart (default 5s). */
	exitWaitMs?: number;
	logger?: (m: string) => void;

	// ── injected collaborators (default to the real ones) ────────────────
	spawnDaemon?: (opts: SpawnCodexDaemonOptions) => Promise<DaemonHandle>;
	connectTransport?: (
		opts: ConnectDaemonTransportOptions,
	) => Promise<DaemonTransport>;
	makeClient?: (transport: DaemonTransport) => CodexDaemonClient;
	/** Injected goal loop (default runGoalToTerminal) — for tests. */
	runGoalFn?: typeof runGoalToTerminal;
	sleep?: (ms: number) => Promise<void>;
}

export interface RunGoalInput {
	objective: string;
	kickText?: string;
	tokenBudget?: number;
	/** Resume an existing thread instead of starting a fresh one. */
	resumeThreadId?: string;
	/** The ACTIVE ceiling (cap when NOT waiting on a gate). */
	overallTimeoutMs?: number;
	/** FLY-1188 MED-7: the EXTENDED ceiling used only while a gate is open. */
	waitingTimeoutMs?: number;
	/** FLY-1188 MED-7: is this run currently blocked on an OPEN gate? */
	isWaiting?: () => boolean;
	/** FLY-1269 explicit resident three-stage phase controller. */
	phaseLifecycle?: GoalPhaseLifecycle;
	phaseControlPollIntervalMs?: number;
	phaseControlRpcTimeoutMs?: number;
	/**
	 * FLY-1188 M4d: fired the moment OUR thread is confirmed ready (right after
	 * `ensureThread` resolves the authoritative own-thread id) — NOT a raw
	 * notification, which a daemon can emit for a foreign thread. Fires again on
	 * each restart/resume with the same thread id (`restarts` increments), so
	 * handlers must be idempotent. A throwing handler is swallowed (it must never
	 * break the run). The caller uses this as the single trustworthy hook for
	 * opening the founder window / writing the FLY-245 launch commit / persisting
	 * the resume handle.
	 */
	onThreadReady?: (threadId: string, restarts: number) => void;
	/**
	 * FLY-1188 M4d: fired the INSTANT the goal is confirmed SET (after `setGoal`
	 * resolves, inside the goal loop) — the safe FLY-245 launch-commit point. Fires
	 * again on each restart/resume; a throwing handler is swallowed.
	 */
	onGoalActive?: () => void;
	/**
	 * FLY-1188 HIGH-3: pid of THIS execution's prior daemon (persisted across a
	 * Bridge restart). Used ONLY for the first spawn of this run — if that prior
	 * daemon was orphaned by a Bridge crash and is still listening on our socket,
	 * it is reaped so the resuming redrive isn't blocked. See
	 * SpawnCodexDaemonOptions.reapOrphanPid.
	 */
	reapOrphanPid?: number;
	/**
	 * FLY-1188 HIGH-3: fired with the LIVE daemon's pid right after each spawn
	 * (and on every account-rotation restart). The caller persists it so a later
	 * resuming redrive can reap this daemon if the Bridge dies without killing it.
	 * `undefined` when the spawn seam did not surface a pid. A throwing handler is
	 * swallowed (it must never break the run).
	 */
	onDaemonPid?: (pid: number | undefined) => void;
}

export interface RunGoalOutcome {
	threadId: string;
	result: GoalRunResult;
	/** How many daemon restarts (account rotations) the run survived. */
	restarts: number;
}

/** A daemon death recoverable by restart+resume: either the goal loop's
 * transport_closed or a raw client "closed" error from a setup RPC. */
function isTransportDeath(err: unknown): boolean {
	return (
		(err instanceof GoalRunError && err.kind === "transport_closed") ||
		(err instanceof CodexDaemonError && err.kind === "closed")
	);
}

/**
 * A resident-/goal runtime bound to one runner execution. `runGoal` drives a
 * goal to a terminal status on a resident daemon, transparently restarting +
 * resuming across a daemon death. `stop()` tears the daemon down. Not
 * re-entrant — a second concurrent `runGoal` is rejected.
 */
export class CodexDaemonGoalRuntime {
	private readonly opts: CodexDaemonGoalRuntimeOptions;
	private readonly log: (m: string) => void;
	private readonly socketPath: string;
	private readonly spawnDaemon: NonNullable<
		CodexDaemonGoalRuntimeOptions["spawnDaemon"]
	>;
	private readonly connectTransport: NonNullable<
		CodexDaemonGoalRuntimeOptions["connectTransport"]
	>;
	private readonly makeClient: NonNullable<
		CodexDaemonGoalRuntimeOptions["makeClient"]
	>;
	private readonly runGoalFn: typeof runGoalToTerminal;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly exitWaitMs: number;
	private accountCursor = 0;
	private session: DaemonSession | null = null;
	private stopped = false;
	private running = false;
	/** The teardown started by stop() — always RESOLVES (a failure is recorded
	 * in teardownError + logged), so in-flight runGoal can await it without an
	 * unhandled rejection; drained() re-throws the recorded failure. */
	private teardownDone: Promise<void> = Promise.resolve();
	private teardownError: Error | null = null;
	/** The in-flight runGoal's completion marker (resolves, never rejects, once
	 * the run has fully settled + done its own daemon cleanup); null when idle. */
	private inflight: Promise<void> | null = null;
	/** HIGH-3: per-run callback fired with each spawned daemon's pid so the
	 * caller can persist it for post-crash orphan reaping. Set in runGoal,
	 * cleared in its finally. */
	private onDaemonPidCb?: (pid: number | undefined) => void;

	constructor(opts: CodexDaemonGoalRuntimeOptions) {
		if (opts.codexHomes.length === 0) {
			throw new Error("CodexDaemonGoalRuntime requires at least one codexHome");
		}
		this.opts = opts;
		this.log = opts.logger ?? (() => {});
		this.socketPath =
			opts.socketPath ?? resolveDaemonSocketPath(opts.executionId);
		this.spawnDaemon = opts.spawnDaemon ?? spawnCodexDaemon;
		this.connectTransport = opts.connectTransport ?? connectDaemonTransport;
		this.makeClient =
			opts.makeClient ??
			((transport) => new CodexDaemonClient({ transport, logger: this.log }));
		this.runGoalFn = opts.runGoalFn ?? runGoalToTerminal;
		this.sleep =
			opts.sleep ??
			((ms: number) =>
				new Promise<void>((r) => {
					const t = setTimeout(r, ms);
					(t as { unref?: () => void }).unref?.(); // a losing timeout race must not keep the process alive
				}));
		this.exitWaitMs = opts.exitWaitMs ?? 5_000;
	}

	/** The account (CODEX_HOME) the NEXT daemon start will use, then advance. */
	private nextCodexHome(): string {
		const homes = this.opts.codexHomes;
		const home = homes[this.accountCursor % homes.length];
		this.accountCursor += 1;
		if (home === undefined) {
			throw new Error("codexHomes unexpectedly empty"); // guarded in ctor
		}
		return home;
	}

	/** An exit promise armed at spawn — resolves when the daemon process EXITS.
	 * Node keeps exitCode null on a signal kill, so consult signalCode + the
	 * `exit` event, not exitCode polling (R2 HIGH-1). */
	private makeExitPromise(handle: DaemonHandle): Promise<void> {
		return new Promise<void>((resolve) => {
			const c = handle.child;
			if (c.exitCode !== null || c.signalCode != null) {
				resolve();
				return;
			}
			c.once("exit", () => resolve());
		});
	}

	/**
	 * Spawn a daemon on the next account, connect, initialize; store the session.
	 * Every partial-failure path closes the resources it created AND drains the
	 * daemon to exit before throwing — so a subsequent restart never races a
	 * still-dying daemon on the same socket, and a stop() that raced startup
	 * leaves no live daemon.
	 */
	private async startSession(reapOrphanPid?: number): Promise<DaemonSession> {
		const codexHome = this.nextCodexHome();
		const handle = await this.spawnDaemon({
			codexBin: this.opts.codexBin,
			codexHome,
			socketPath: this.socketPath,
			// FLY-1188 M4d: the daemon's workspace-write threads inherit these
			// sandbox roots + network grant (the runner's worktree git metadata +
			// flywheel roots) — the daemon form of the exec-cycle sandbox fix.
			sandboxWritableRoots: this.opts.sandboxWritableRoots,
			sandboxNetworkAccess: this.opts.networkAccess,
			// FLY-1224: per-phase reasoning effort rides the daemon spawn argv.
			effort: this.opts.effort,
			env: this.opts.env,
			// HIGH-3: reap a prior orphaned daemon of THIS execution (if any) so
			// the resuming redrive can reclaim the socket instead of blocking.
			...(reapOrphanPid !== undefined ? { reapOrphanPid } : {}),
			logger: this.log,
		});
		// HIGH-3: surface the live daemon pid so the caller can persist it — a
		// later resuming redrive uses it to reap this daemon if the Bridge dies
		// without killing it. Swallow a throwing handler (must never break spawn).
		try {
			this.onDaemonPidCb?.(handle.child.pid ?? undefined);
		} catch (err) {
			this.safeLog(
				`onDaemonPid handler threw (ignored): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const exited = this.makeExitPromise(handle);
		const dying: DyingDaemon = { handle, exited };
		// Close the given resources, then SIGTERM the daemon and WAIT for it to
		// exit before surfacing the error.
		const failClose = async (
			err: unknown,
			...closables: Array<{ close(): void } | undefined>
		): Promise<never> => {
			for (const c of closables) safeClose(c);
			safeStop(handle);
			await this.drainExit(dying);
			throw err;
		};

		if (this.stopped) {
			return failClose(new Error("runtime stopped during daemon spawn"));
		}

		let transport: DaemonTransport;
		try {
			// Connect to the EXPLICIT socket path (the daemon listens on a short
			// SUN_LEN-safe path, NOT one derived from CODEX_HOME).
			transport = await this.connectTransport({ socketPath: this.socketPath });
		} catch (err) {
			return failClose(err);
		}
		if (this.stopped) {
			return failClose(
				new Error("runtime stopped during daemon connect"),
				transport,
			);
		}

		let client: CodexDaemonClient | undefined;
		try {
			client = this.makeClient(transport);
			await client.initialize();
		} catch (err) {
			// close each resource best-effort (a throw in one must not skip the
			// others), then drain the daemon.
			return failClose(err, client, transport);
		}
		if (this.stopped) {
			return failClose(
				new Error("runtime stopped during daemon initialize"),
				client,
			);
		}

		const session: DaemonSession = { handle, client, codexHome, exited };
		this.session = session;
		return session;
	}

	private async ensureThread(
		session: DaemonSession,
		existingThreadId: string | undefined,
	): Promise<string> {
		if (existingThreadId) {
			return session.client.resumeThread(existingThreadId);
		}
		return session.client.startThread({
			cwd: this.opts.cwd,
			sandbox: this.opts.sandbox ?? "workspace-write",
			approvalPolicy: this.opts.approvalPolicy ?? "never",
			model: this.opts.model,
			baseInstructions: this.opts.baseInstructions,
		});
	}

	/** Signal the current session dead + drop it; returns the dying daemon so
	 * the restart path can WAIT for the daemon to actually exit. */
	private killSession(): DyingDaemon | null {
		const s = this.session;
		if (!s) return null;
		this.session = null;
		safeClose(s.client);
		safeStop(s.handle);
		return { handle: s.handle, exited: s.exited };
	}

	/** True if the daemon EXITED within `ms`; false on timeout. A losing timeout
	 * race leaves an unref'd timer (default sleep) so it can't keep the process
	 * alive. */
	private raceExit(exited: Promise<void>, ms: number): Promise<boolean> {
		return Promise.race([
			exited.then(() => true),
			this.sleep(ms).then(() => false),
		]);
	}

	/** Wait (bounded) for a killed daemon to actually EXIT, SIGKILL-escalating if
	 * it lingers; if it STILL won't die, fail loud — the caller must NOT restart
	 * on a socket a possibly-live daemon still owns. */
	private async drainExit(dying: DyingDaemon): Promise<void> {
		if (!(await this.raceExit(dying.exited, this.exitWaitMs))) {
			safeStop(dying.handle, "SIGKILL");
			if (!(await this.raceExit(dying.exited, this.exitWaitMs))) {
				throw new Error(
					`codex daemon did not exit after SIGKILL — refusing to restart on socket ${dying.handle.socketPath}`,
				);
			}
		}
		// QA · FLY-1188 HIGH-2: the promise above tracks the process we SPAWNED —
		// the rotation shim. The `codex app-server` the shim forked is a different
		// process and outlives it happily, still holding the socket (that is the
		// ~178MB orphan the real-machine QA found alive 5 minutes after teardown).
		// So "the shim exited" is NOT "the daemon is dead". Ask the socket.
		if (!(await ensureDaemonDead(dying.handle))) {
			throw new Error(
				`codex daemon still listening on ${dying.handle.socketPath} after teardown — refusing to leave an unmonitored orphan`,
			);
		}
	}

	/**
	 * Drive a goal to a terminal status on the resident daemon. A daemon death
	 * mid-run — the goal loop's transport_closed OR a raw client "closed" from a
	 * setup RPC (both inside the recovery boundary) — tears the dead session
	 * down, waits for it to exit, restarts on the NEXT account and RESUMES the
	 * same thread; up to maxRestarts. A terminal status (incl.
	 * blocked/usageLimited/budgetLimited) resolves for the caller to act on. A
	 * timeout / setup_failed / goal_replaced propagates. Not re-entrant.
	 */
	async runGoal(
		input: RunGoalInput,
		events?: CodexDaemonEvents,
	): Promise<RunGoalOutcome> {
		if (this.stopped) throw new Error("runtime already stopped");
		if (this.running) {
			throw new Error("runGoal is already in progress (not re-entrant)");
		}
		this.running = true;
		// A completion marker for THIS run (resolves — never rejects — when the
		// run has fully settled AND its stop-teardown wait is done), so drained()
		// can wait for an in-flight run's own cleanup (e.g. a stop() that raced
		// startSession, whose partial daemon is drained inside this call).
		let settle: () => void = () => {};
		this.inflight = new Promise<void>((r) => {
			settle = r;
		});
		try {
			const maxRestarts = this.opts.maxRestarts ?? 5;
			let threadId = input.resumeThreadId;
			let restarts = 0;
			// HIGH-3: persist the live daemon pid on every spawn; reap a prior
			// orphan only on the FIRST spawn of this run (a within-run restart
			// tears down its own session first, so there is no orphan to reap).
			this.onDaemonPidCb = input.onDaemonPid;
			let reapPid = input.reapOrphanPid;
			// MED-7 R2 (Codex full-PR review): arm the RUN's start ONCE. Every
			// restart's runGoalToTerminal gets this SAME anchor, so the active +
			// waiting ceilings are absolute for the run — an account-rotation
			// restart can no longer re-arm a full fresh budget (which let N
			// restarts multiply the cap).
			const runStartedAt = Date.now();
			// MED-7 R3 (Codex full-PR review): carry the monotonic gate-wait deadline
			// extension across restarts, so a runner that extended its deadline while
			// waiting on a gate is not cut off by a transport restart after the gate
			// closes. Each runGoalToTerminal reports its max deadline; the next call
			// gets it as a floor.
			let carriedDeadlineMs = 0;
			let carriedHardDeadlineMs = 0;

			while (true) {
				try {
					const session = this.session ?? (await this.startSession(reapPid));
					reapPid = undefined; // reap applies only to the first spawn
					threadId = await this.ensureThread(session, threadId);
					// AUTHORITATIVE own-thread signal (FLY-1188 M4d): the thread is
					// confirmed ours here (not a raw notification, which can be
					// foreign). Fires on each restart/resume too; a throwing handler
					// must never break the run.
					if (input.onThreadReady) {
						try {
							input.onThreadReady(threadId, restarts);
						} catch (err) {
							this.safeLog(
								`onThreadReady handler threw (ignored): ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}
					const result = await this.runGoalFn(
						session.client,
						{
							threadId,
							objective: input.objective,
							kickText: input.kickText,
							tokenBudget: input.tokenBudget,
							overallTimeoutMs: input.overallTimeoutMs,
							// MED-7 R2: the RUN's start — shared by every restart so the
							// ceilings never re-arm.
							startedAt: runStartedAt,
							// MED-7 R3: floor from a prior call's gate extension + feedback.
							minDeadlineMs: carriedDeadlineMs,
							minHardDeadlineMs: carriedHardDeadlineMs,
							onDeadlineExtended: (ms) => {
								if (ms > carriedDeadlineMs) carriedDeadlineMs = ms;
							},
							onBudgetRestored: ({ deadlineMs, hardDeadlineMs }) => {
								if (deadlineMs > carriedDeadlineMs)
									carriedDeadlineMs = deadlineMs;
								if (hardDeadlineMs > carriedHardDeadlineMs) {
									carriedHardDeadlineMs = hardDeadlineMs;
								}
							},
							...(input.phaseLifecycle
								? { phaseLifecycle: input.phaseLifecycle }
								: {}),
							...(input.phaseControlPollIntervalMs !== undefined
								? {
										phaseControlPollIntervalMs:
											input.phaseControlPollIntervalMs,
									}
								: {}),
							...(input.phaseControlRpcTimeoutMs !== undefined
								? { phaseControlRpcTimeoutMs: input.phaseControlRpcTimeoutMs }
								: {}),
							// MED-7: forward the extended-ceiling + gate-open predicate so
							// the goal loop caps at the active budget unless a gate is open.
							...(input.waitingTimeoutMs !== undefined
								? { waitingTimeoutMs: input.waitingTimeoutMs }
								: {}),
							...(input.isWaiting ? { isWaiting: input.isWaiting } : {}),
							...(input.onGoalActive
								? { onGoalActive: input.onGoalActive }
								: {}),
						},
						events,
					);
					return { threadId, result, restarts };
				} catch (err) {
					// ANY failure tears the (possibly dead) session down first and
					// WAITS for the daemon to exit — so we never leak a daemon and a
					// restart never races the dying one on the same socket. (A
					// startSession failure already drained its own handle, so
					// killSession returns null there.)
					const dead = this.killSession();
					if (dead) {
						await this.drainExit(dead);
					} else if (this.stopped) {
						// stop() concurrently took the session — wait for ITS teardown
						// so this run doesn't complete before the daemon is confirmed
						// gone (the teardown failure, if any, is surfaced via drained()
						// / the log, not this run's error).
						await this.teardownDone;
					}

					if (
						isTransportDeath(err) &&
						restarts < maxRestarts &&
						!this.stopped
					) {
						restarts += 1;
						this.safeLog(
							`daemon died mid-goal — restart ${restarts}/${maxRestarts} (rotating account) + resume thread ${threadId}`,
						);
						continue; // resume the SAME threadId on a new daemon/account
					}
					throw err;
				}
			}
		} finally {
			this.running = false;
			this.onDaemonPidCb = undefined;
			// SUCCESS OR FAILURE: if stop() ran during this call, wait for its
			// session-drain so this run never returns/throws ahead of the daemon's
			// exit (M4a's terminal-before-close can let runGoalFn succeed after a
			// concurrent stop).
			if (this.stopped) await this.teardownDone;
			settle();
			this.inflight = null;
		}
	}

	/**
	 * Tear down the daemon + client. Idempotent + sync (SIGTERM is sent now).
	 * The exit drain (SIGKILL escalation + confirmation) runs in the background
	 * as an AWAITABLE `teardownDone` — call `drained()` to wait for it and
	 * observe a SIGKILL-unconfirmed failure. A failure is also logged; it is
	 * recorded (not thrown) so a concurrent runGoal can await teardownDone
	 * without an unhandled rejection.
	 */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		const dead = this.killSession();
		if (dead) {
			this.teardownDone = this.drainExit(dead).catch((e) => {
				this.teardownError = e instanceof Error ? e : new Error(String(e));
				// safeLog so a throwing injected logger cannot re-reject this
				// promise (it must ALWAYS resolve — awaiters rely on that).
				this.safeLog(
					`daemon teardown after stop failed: ${this.teardownError.message}`,
				);
			});
		}
	}

	/**
	 * Await the full teardown: stop()'s session-drain AND any in-flight runGoal's
	 * own cleanup (a stop() that raced startSession drains its partial daemon
	 * inside that call, not via teardownDone). Re-throws if a daemon could not be
	 * confirmed dead (SIGKILL-unconfirmed).
	 */
	async drained(): Promise<void> {
		await this.teardownDone;
		const inflight = this.inflight;
		if (inflight) await inflight; // resolves (never rejects) when the run settles
		if (this.teardownError) throw this.teardownError;
	}

	/** Log without letting a throwing injected logger break teardown. */
	private safeLog(m: string): void {
		try {
			this.log(m);
		} catch {
			/* a broken logger must not break the lifecycle */
		}
	}
}

// ── best-effort resource closers (a throw in one must not skip the rest) ──

function safeClose(closable: { close(): void } | undefined): void {
	if (!closable) return;
	try {
		closable.close();
	} catch {
		/* already closed */
	}
}

/** QA · FLY-1188 HIGH-2 — socket-verified death (escalates to a group SIGKILL
 * and unlinks the socket). A handle that cannot answer, or throws, is treated as
 * NOT confirmed dead: the caller must never assume a teardown it cannot prove. */
async function ensureDaemonDead(handle: DaemonHandle): Promise<boolean> {
	if (typeof handle.ensureDead !== "function") return false;
	try {
		return await handle.ensureDead();
	} catch {
		return false;
	}
}

function safeStop(handle: DaemonHandle, signal?: NodeJS.Signals): void {
	try {
		handle.stop(signal);
	} catch {
		/* already gone */
	}
}

export type { GoalRunResult, GoalStatus };
