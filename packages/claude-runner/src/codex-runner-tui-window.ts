/**
 * FLY-1188 M4c-3 — the founder-facing cmux/tmux window for a resident codex
 * RUNNER: a real interactive `codex resume --remote` TUI attached to the SAME
 * thread the runner's daemon is driving, so the founder can WATCH the /goal run
 * live in cmux (Annie's core acceptance: "cmux 能看它跑"). A second human
 * client on the same thread — the machine client (M4a) drives it; this pane
 * observes + can intervene.
 *
 * Shape mirrors the verified lead-side precedent
 * (teamlead/src/lead-backends/codex/tui-window.ts), adapted for the runner:
 *   - the remote socket is the runner daemon's SHORT SUN_LEN-safe socketPath
 *     (M4c-1), NOT one derived from CODEX_HOME (the lead convention);
 *   - the founder TUI shares the runner thread's `workspace-write` sandbox
 *     (not the lead's read-only), so it matches the daemon/machine client;
 *   - the window name is the runner-scoped label (a Linear identifier, per
 *     FLY-272) so the founder can find it.
 *
 * Fail-open: a window failure costs VISIBILITY, never the run (the machine
 * client keeps driving the goal). All side effects are injected for tests.
 */

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withSyncOpMarker } from "./sync-op-marker.js";

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/; // absolute paths, no quotes/spaces/metachars
const SAFE_ID = /^[A-Za-z0-9-]+$/; // thread ids are UUID-shaped
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/; // tmux session/window names
const SAFE_WINDOW_ID = /^@[0-9]+$/; // immutable tmux window ids

/** A value interpolated into the tmux shell command must be system-derived
 * config, not user input — but validate at the boundary anyway (a value that
 * could break its quoting is a config error → throw, fail-loud). */
function assertShellSafe(name: string, value: string, re: RegExp): string {
	if (!re.test(value)) {
		throw new Error(
			`runner-tui-window: ${name} contains characters unsafe for the tmux shell command: ${JSON.stringify(value)}`,
		);
	}
	return value;
}

/**
 * FLY-1239: the outcome of one `ensureRunnerTuiWindow` attempt. The reason
 * discriminates so the caller can retry ONLY the case worth retrying — a TUI
 * that spawned but died during settle (the rollout-landing race) — while a
 * headless box (`tmux-absent`) or a tmux-level failure (`create-failed`) stops
 * after one attempt.
 */
export type RunnerTuiAbortCause = "run-ended" | "caller-cancel" | "deadline";

export type RunnerTuiWindowFailureCategory =
	| "retryable-hold"
	| "retryable-transient-ipc"
	| "permanent"
	| "cancellation";

export interface RunnerTuiWindowFailureEvidence {
	category: RunnerTuiWindowFailureCategory;
	reason:
		| "hold_lock_unavailable"
		| "stale_window_unproven"
		| "new_window_failed"
		| "window_id_unproven"
		| "window_died"
		| "tmux_absent"
		| "config_invalid"
		| "ipc_exception"
		| "aborted";
	abortCause?: RunnerTuiAbortCause;
	detail?: string;
}

export type RunnerTuiWindowOutcome =
	| { created: true; windowId: string }
	| ({ created: false } & RunnerTuiWindowFailureEvidence);

export interface RunnerTuiWindowSpec {
	/** cmux/tmux session the runner's windows live in. */
	tmuxSession: string;
	/** Window name — the runner-scoped label (a Linear identifier, FLY-272). */
	windowName: string;
	/** The runner's isolated CODEX_HOME (auth/config). */
	codexHome: string;
	/** The daemon's SHORT control-socket path (M4c-1 — NOT under CODEX_HOME). */
	socketPath: string;
	/** Working directory for the TUI (`-C` — kills the resume cwd menu). */
	cwd: string;
	/** Thread the TUI must resume (the one the runner's daemon is driving). */
	threadId: string;
	/** Execution identity inherited by generalized-room stub binaries. */
	executionId?: string;
	/** Slot StateStore path used to derive the execution's durable exit fence. */
	stateDbPath?: string;
	/** codex binary (default "codex"). */
	codexBin?: string;
}

/**
 * Build the exact `codex resume --remote` command line (pure — unit-testable;
 * quoted for the shell tmux spawns). The founder TUI shares the runner thread's
 * workspace-write sandbox and never prompts for approval (the daemon enforces
 * the sandbox for every client of the thread).
 */
export function buildRunnerTuiCommand(spec: RunnerTuiWindowSpec): string {
	assertShellSafe("codexHome", spec.codexHome, SAFE_PATH);
	assertShellSafe("socketPath", spec.socketPath, SAFE_PATH);
	assertShellSafe("cwd", spec.cwd, SAFE_PATH);
	assertShellSafe("threadId", spec.threadId, SAFE_ID);
	if (spec.executionId)
		assertShellSafe("executionId", spec.executionId, SAFE_ID);
	if (spec.stateDbPath)
		assertShellSafe("stateDbPath", spec.stateDbPath, SAFE_PATH);
	if (spec.codexBin) assertShellSafe("codexBin", spec.codexBin, SAFE_PATH);
	const bin = spec.codexBin ?? "codex";
	return [
		`CODEX_HOME="${spec.codexHome}"`,
		...(spec.executionId ? [`FLYWHEEL_EXEC_ID="${spec.executionId}"`] : []),
		...(spec.stateDbPath
			? [`FLYWHEEL_STATE_DB_PATH="${spec.stateDbPath}"`]
			: []),
		bin,
		"resume",
		`--remote "unix://${spec.socketPath}"`,
		`-C "${spec.cwd}"`,
		"-s workspace-write", // the founder pane matches the thread's sandbox
		`-c 'approval_policy="never"'`,
		spec.threadId,
	].join(" ");
}

export interface RunnerTuiWindowDeps {
	exec?: (cmd: string, args: string[]) => { ok: boolean };
	execOut?: (cmd: string, args: string[]) => string | undefined;
	/** Guarded shared-session ensure. Production uses tmux-server-rescue. */
	ensureSession?: (tmuxSession: string) => boolean;
	log?: (m: string) => void;
	/** Block for `ms` (default: a real synchronous sleep). Injected in tests. */
	sleep?: (ms: number) => void;
	/**
	 * How long to let the TUI settle before proving it is still there (default
	 * 800ms). `tmux new-window` returns success the moment it forks the shell —
	 * a command that dies 200ms later still "succeeded" — so the liveness proof
	 * has to happen AFTER the window has had a chance to die.
	 */
	settleMs?: number;
	/** Async production seams. When absent, legacy sync seams above are adapted
	 * only for compatibility tests; the real Bridge path always uses these. */
	execAsync?: (
		cmd: string,
		args: string[],
		options?: { timeoutMs?: number; signal?: AbortSignal },
	) => Promise<{ ok: boolean; stdout?: string }>;
	execOutAsync?: (
		cmd: string,
		args: string[],
		options?: { timeoutMs?: number; signal?: AbortSignal },
	) => Promise<string | undefined>;
	ensureSessionAsync?: (
		tmuxSession: string,
		signal?: AbortSignal,
	) => Promise<boolean>;
	sleepAsync?: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
}

function tmuxSocketPath(): string {
	const override = process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE?.trim();
	if (override?.startsWith("/")) return resolve(override);
	let tmp = "/tmp";
	try {
		tmp = realpathSync("/tmp");
	} catch {
		// tmux itself defaults to /tmp when the symlink cannot be resolved.
	}
	const uid = process.getuid?.();
	if (!Number.isSafeInteger(uid) || (uid ?? -1) < 0) {
		throw new Error("runner-tui-window: cannot determine tmux socket uid");
	}
	return join(tmp, `tmux-${uid}`, "default");
}

type EnsureSessionSpawnResult = {
	status: number | null;
	stdout?: string | Buffer;
};

export interface EnsureSessionWithRetryOptions {
	spawn: (
		cmd: string,
		args: string[],
		options: {
			stdio: ["ignore", "pipe", "ignore"];
			encoding: "utf8";
			timeout: number;
		},
	) => EnsureSessionSpawnResult;
	sleep: (ms: number) => void;
	now: () => number;
	log?: (message: string) => void;
	deadlineMs: number;
	attemptCapMs: number;
	cliPath: string;
	socket: string;
	session: string;
}

export interface EnsureSessionWithRetryAsyncOptions
	extends Omit<EnsureSessionWithRetryOptions, "spawn" | "sleep"> {
	spawn: (
		cmd: string,
		args: string[],
		options: {
			stdio: ["ignore", "pipe", "ignore"];
			encoding: "utf8";
			timeout: number;
			signal?: AbortSignal;
		},
	) => Promise<EnsureSessionSpawnResult>;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
}

/**
 * Legacy synchronous compatibility seam for isolated callers and tests.
 * Production Bridge code must use `ensureSessionWithRetryAsync` so a tmux
 * rescue cannot occupy the Bridge event loop for the shared retry deadline.
 */
export function ensureSessionWithRetry(
	options: EnsureSessionWithRetryOptions,
): boolean {
	const startedAt = options.now();
	const args = [
		"ensure",
		options.socket,
		"--verify",
		"tmux",
		"-S",
		options.socket,
		"has-session",
		"-t",
		`=${options.session}`,
		"--create",
		"tmux",
		"-S",
		options.socket,
		"new-session",
		"-Ad",
		"-s",
		options.session,
	];
	let attempt = 0;
	while (true) {
		const remaining = options.deadlineMs - (options.now() - startedAt);
		if (remaining <= 0) return false;
		attempt += 1;
		try {
			const result = options.spawn(options.cliPath, args, {
				stdio: ["ignore", "pipe", "ignore"],
				encoding: "utf8",
				timeout: Math.min(options.attemptCapMs, remaining),
			});
			if (result.status === 0) return true;
			const stdout = result.stdout?.toString().trim() ?? "";
			const tail = stdout.length > 500 ? stdout.slice(-500) : stdout;
			safeLog(
				options.log,
				`runner-tui-window: guarded session ensure attempt ${attempt} held (status=${result.status ?? "null"})${tail ? `: ${tail}` : ""}`,
			);
		} catch (error) {
			safeLog(
				options.log,
				`runner-tui-window: guarded session ensure attempt ${attempt} failed: ${errMessage(error)}`,
			);
		}
		const afterAttemptRemaining =
			options.deadlineMs - (options.now() - startedAt);
		if (afterAttemptRemaining <= 0) return false;
		options.sleep(Math.min(1_000, afterAttemptRemaining));
	}
}

/** Async parity for the Bridge production path. It deliberately preserves the
 * guarded-rescue argv, retry classification, shared deadline and log text from
 * the synchronous compatibility helper above while yielding between attempts. */
export async function ensureSessionWithRetryAsync(
	options: EnsureSessionWithRetryAsyncOptions,
): Promise<boolean> {
	const startedAt = options.now();
	const args = [
		"ensure",
		options.socket,
		"--verify",
		"tmux",
		"-S",
		options.socket,
		"has-session",
		"-t",
		`=${options.session}`,
		"--create",
		"tmux",
		"-S",
		options.socket,
		"new-session",
		"-Ad",
		"-s",
		options.session,
	];
	let attempt = 0;
	while (!options.signal?.aborted) {
		const remaining = options.deadlineMs - (options.now() - startedAt);
		if (remaining <= 0) return false;
		attempt += 1;
		try {
			const result = await options.spawn(options.cliPath, args, {
				stdio: ["ignore", "pipe", "ignore"],
				encoding: "utf8",
				timeout: Math.min(options.attemptCapMs, remaining),
				...(options.signal ? { signal: options.signal } : {}),
			});
			if (result.status === 0) return true;
			const stdout = result.stdout?.toString().trim() ?? "";
			const tail = stdout.length > 500 ? stdout.slice(-500) : stdout;
			safeLog(
				options.log,
				`runner-tui-window: guarded session ensure attempt ${attempt} held (status=${result.status ?? "null"})${tail ? `: ${tail}` : ""}`,
			);
		} catch (error) {
			if (options.signal?.aborted) return false;
			safeLog(
				options.log,
				`runner-tui-window: guarded session ensure attempt ${attempt} failed: ${errMessage(error)}`,
			);
		}
		const afterAttemptRemaining =
			options.deadlineMs - (options.now() - startedAt);
		if (afterAttemptRemaining <= 0 || options.signal?.aborted) return false;
		await options.sleep(Math.min(1_000, afterAttemptRemaining), options.signal);
	}
	return false;
}

function positiveInt(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

type AsyncSpawnOptions = {
	stdio: ["ignore", "pipe", "ignore"];
	encoding: "utf8";
	timeout: number;
	signal?: AbortSignal;
};

/** Promise-based child wrapper used by the Bridge path. `error` and `close`
 * race through one settled latch. Timeout/abort send SIGTERM, then a bounded
 * SIGKILL if needed, and settle only after child close so teardown continuations
 * have a real happens-after edge over the command's possible side effects. */
export function spawnCommandAsync(
	cmd: string,
	args: string[],
	options: AsyncSpawnOptions,
): Promise<EnsureSessionSpawnResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		if (options.signal?.aborted) {
			resolvePromise({ status: null, stdout: "" });
			return;
		}
		let settled = false;
		let terminationRequested = false;
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		let forceKillTimer: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const settle = (
			kind: "resolve" | "reject",
			value: EnsureSessionSpawnResult | unknown,
		): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (kind === "resolve") resolvePromise(value as EnsureSessionSpawnResult);
			else rejectPromise(value);
		};
		const terminate = (): void => {
			if (terminationRequested) return;
			terminationRequested = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* process already gone */
			}
			forceKillTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* process already gone */
				}
			}, 1_000);
			(forceKillTimer as { unref?: () => void }).unref?.();
		};
		const onAbort = (): void => terminate();
		const timer = setTimeout(terminate, options.timeout);
		(timer as { unref?: () => void }).unref?.();
		try {
			child = spawn(cmd, args, {
				stdio: options.stdio,
			});
		} catch (error) {
			settle("reject", error);
			return;
		}
		child.stdout?.setEncoding(options.encoding);
		child.stdout?.on("data", (chunk: string | Buffer) => {
			stdout += chunk.toString();
		});
		child.once("error", (error) => {
			// A kill-related error does not prove the child has stopped; keep waiting
			// for `close` so teardown never races a still-live command. Spawn errors
			// happen before termination is requested and are safe to reject directly.
			if (!terminationRequested) settle("reject", error);
		});
		child.once("close", (status) =>
			settle("resolve", {
				status: terminationRequested ? null : status,
				stdout,
			}),
		);
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function defaultSleepAsync(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolvePromise) => {
		const done = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolvePromise();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

function defaultEnsureSessionAsync(
	tmuxSession: string,
	log?: (message: string) => void,
	signal?: AbortSignal,
): Promise<boolean> {
	const socket = tmuxSocketPath();
	const cli = join(homedir(), ".flywheel", "bin", "tmux-server-rescue");
	return ensureSessionWithRetryAsync({
		spawn: spawnCommandAsync,
		sleep: defaultSleepAsync,
		now: Date.now,
		log,
		deadlineMs: positiveInt(
			process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS,
			210_000,
		),
		attemptCapMs: positiveInt(
			process.env.FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS,
			90_000,
		),
		cliPath: cli,
		socket,
		session: tmuxSession,
		...(signal ? { signal } : {}),
	});
}

async function defaultExecAsync(
	cmd: string,
	args: string[],
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; stdout?: string }> {
	try {
		const effectiveArgs =
			cmd === "tmux" && process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE
				? ["-S", tmuxSocketPath(), ...args]
				: args;
		const result = await spawnCommandAsync(cmd, effectiveArgs, {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			timeout: options.timeoutMs ?? 10_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
		return {
			ok: result.status === 0,
			...(result.status === 0
				? { stdout: result.stdout?.toString().trim() }
				: {}),
		};
	} catch {
		return { ok: false };
	}
}

async function defaultExecOutAsync(
	cmd: string,
	args: string[],
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | undefined> {
	try {
		const effectiveArgs =
			cmd === "tmux" && process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE
				? ["-S", tmuxSocketPath(), ...args]
				: args;
		const result = await spawnCommandAsync(cmd, effectiveArgs, {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			timeout: options.timeoutMs ?? 5_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
		return result.status === 0 ? result.stdout?.toString().trim() : undefined;
	} catch {
		return undefined;
	}
}

function defaultExec(cmd: string, args: string[]): { ok: boolean } {
	try {
		const effectiveArgs =
			cmd === "tmux" && process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE
				? ["-S", tmuxSocketPath(), ...args]
				: args;
		const r = withSyncOpMarker("codex-tui:tmux-exec", () =>
			spawnSync(cmd, effectiveArgs, {
				stdio: "ignore",
				timeout: 10_000,
			}),
		);
		return { ok: r.status === 0 };
	} catch {
		return { ok: false };
	}
}

function defaultExecOut(cmd: string, args: string[]): string | undefined {
	try {
		const effectiveArgs =
			cmd === "tmux" && process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE
				? ["-S", tmuxSocketPath(), ...args]
				: args;
		const r = withSyncOpMarker("codex-tui:tmux-read", () =>
			spawnSync(cmd, effectiveArgs, {
				encoding: "utf8",
				timeout: 5_000,
			}),
		);
		return r.status === 0 ? r.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Log without letting a throwing injected logger break the fail-open contract. */
function safeLog(log: ((m: string) => void) | undefined, m: string): void {
	if (!log) return;
	try {
		log(m);
	} catch {
		/* a broken logger must not break the lifecycle */
	}
}

/** Stringify a caught value without itself throwing — JS allows `throw null`
 * and a hostile error (a Proxy whose getPrototypeOf trap or `message` getter
 * throws), so EVERYTHING (the instanceof check + the message read + String())
 * is inside the try, or it would break the fail-open catch. Exported (FLY-1239)
 * so the adapter's async no-throw retry boundary reuses the same safe formatter. */
export function errMessage(err: unknown): string {
	try {
		if (err instanceof Error) return err.message;
		return String(err);
	} catch {
		return "unknown error";
	}
}

type AsyncWindowExecDeps = {
	exec: (
		cmd: string,
		args: string[],
		options?: { timeoutMs?: number; signal?: AbortSignal },
	) => Promise<{ ok: boolean; stdout?: string }>;
	execOut: (
		cmd: string,
		args: string[],
		options?: { timeoutMs?: number; signal?: AbortSignal },
	) => Promise<string | undefined>;
	signal?: AbortSignal;
};

function parseWindowList(out: string): Array<{ id: string; name: string }> {
	if (out === "") return [];
	return out.split("\n").map((line) => {
		const sp = line.indexOf(" ");
		return sp < 0
			? { id: line, name: "" }
			: { id: line.slice(0, sp), name: line.slice(sp + 1) };
	});
}

function abortCause(signal: AbortSignal | undefined): RunnerTuiAbortCause {
	const reason = signal?.reason;
	return reason === "deadline" || reason === "run-ended"
		? reason
		: "caller-cancel";
}

function tuiFailure(
	category: RunnerTuiWindowFailureCategory,
	reason: RunnerTuiWindowFailureEvidence["reason"],
	options: Pick<RunnerTuiWindowFailureEvidence, "abortCause" | "detail"> = {},
): RunnerTuiWindowOutcome {
	return { created: false, category, reason, ...options };
}

/** Terminal-only cleanup. Unlike the creation-time purge it never ensures a
 * session and never creates a scaffold, so it is safe after daemon teardown and
 * as a happens-after cleanup for a late in-flight `new-window`. */
export async function scanAndKillSameNameWindows(
	spec: Pick<RunnerTuiWindowSpec, "tmuxSession" | "windowName">,
	deps: AsyncWindowExecDeps = {
		exec: defaultExecAsync,
		execOut: defaultExecOutAsync,
	},
): Promise<void> {
	if (deps.signal?.aborted) return;
	const out = await deps.execOut(
		"tmux",
		[
			"list-windows",
			"-t",
			`=${spec.tmuxSession}`,
			"-F",
			"#{window_id} #{window_name}",
		],
		{ timeoutMs: 5_000, ...(deps.signal ? { signal: deps.signal } : {}) },
	);
	if (out === undefined) return;
	for (const window of parseWindowList(out)) {
		if (
			window.name !== spec.windowName ||
			!SAFE_WINDOW_ID.test(window.id) ||
			deps.signal?.aborted
		)
			continue;
		await deps.exec("tmux", ["kill-window", "-t", window.id], {
			timeoutMs: 10_000,
			...(deps.signal ? { signal: deps.signal } : {}),
		});
	}
}

async function purgeSameNameWindowsAsync(
	spec: Pick<RunnerTuiWindowSpec, "tmuxSession" | "windowName">,
	deps: AsyncWindowExecDeps & {
		ensureSession: (session: string, signal?: AbortSignal) => Promise<boolean>;
	},
): Promise<boolean> {
	const listWindows = async (): Promise<
		Array<{ id: string; name: string }> | undefined
	> => {
		const out = await deps.execOut(
			"tmux",
			[
				"list-windows",
				"-t",
				`=${spec.tmuxSession}`,
				"-F",
				"#{window_id} #{window_name}",
			],
			{ timeoutMs: 5_000, ...(deps.signal ? { signal: deps.signal } : {}) },
		);
		return out === undefined ? undefined : parseWindowList(out);
	};

	const before = await listWindows();
	if (before === undefined || deps.signal?.aborted) return false;
	for (const window of before) {
		if (window.name !== spec.windowName || !SAFE_WINDOW_ID.test(window.id))
			continue;
		await deps.exec("tmux", ["kill-window", "-t", window.id], {
			timeoutMs: 10_000,
			...(deps.signal ? { signal: deps.signal } : {}),
		});
		if (deps.signal?.aborted) return false;
	}
	if (!(await deps.ensureSession(spec.tmuxSession, deps.signal))) return false;
	const after = await listWindows();
	return (
		after !== undefined &&
		!deps.signal?.aborted &&
		!after.some((window) => window.name === spec.windowName)
	);
}

/**
 * Ensure the founder-facing TUI window. Steps (each fail-open):
 *   1. `tmux -V` probe — absent → `{ created:false, reason:"tmux-absent" }`
 *      (headless box: the run continues, only the terminal view is missing).
 *   2. ensure the runner's session (idempotent attach-or-create).
 *   3. FLY-1239 PROVABLE purge: kill every same-named window by immutable id,
 *      re-ensure the session, and verify none remain — else `create-failed`
 *      (never create over a stale/ambiguous same-named window → ≤1 window).
 *   4. create the window running the real `codex resume --remote` TUI.
 *   5. settle + liveness probe: a pane gone after settle → `{ reason:"died" }`
 *      (the rollout-race the caller retries).
 */
export function ensureRunnerTuiWindow(
	spec: RunnerTuiWindowSpec,
	deps: RunnerTuiWindowDeps = {},
): Promise<RunnerTuiWindowOutcome> {
	assertShellSafe("tmuxSession", spec.tmuxSession, SAFE_NAME);
	assertShellSafe("windowName", spec.windowName, SAFE_NAME);
	return ensureRunnerTuiWindowAsync(spec, deps);
}

async function ensureRunnerTuiWindowAsync(
	spec: RunnerTuiWindowSpec,
	deps: RunnerTuiWindowDeps,
): Promise<RunnerTuiWindowOutcome> {
	const exec: AsyncWindowExecDeps["exec"] =
		deps.execAsync ??
		(deps.exec
			? async (cmd: string, args: string[]) => deps.exec!(cmd, args)
			: defaultExecAsync);
	const execOut =
		deps.execOutAsync ??
		(deps.execOut
			? async (cmd: string, args: string[]) => deps.execOut!(cmd, args)
			: defaultExecOutAsync);
	const ensureSession =
		deps.ensureSessionAsync ??
		(deps.ensureSession
			? async (session: string) => deps.ensureSession!(session)
			: deps.exec
				? async (session: string, signal?: AbortSignal) =>
						(
							await exec("tmux", ["new-session", "-Ad", "-s", session], {
								timeoutMs: 10_000,
								...(signal ? { signal } : {}),
							})
						).ok
				: (session: string, signal?: AbortSignal) =>
						defaultEnsureSessionAsync(session, deps.log, signal));
	const signal = deps.signal;
	try {
		if (signal?.aborted) {
			return tuiFailure("cancellation", "aborted", {
				abortCause: abortCause(signal),
			});
		}
		if (
			!(
				await exec("tmux", ["-V"], {
					timeoutMs: 10_000,
					...(signal ? { signal } : {}),
				})
			).ok
		) {
			safeLog(
				deps.log,
				`runner-tui-window: tmux unavailable — skipping (${spec.windowName})`,
			);
			return tuiFailure("permanent", "tmux_absent");
		}
		if (!(await ensureSession(spec.tmuxSession, signal))) {
			safeLog(
				deps.log,
				`runner-tui-window: guarded tmux session ensure held — skipping (${spec.windowName})`,
			);
			if (signal?.aborted) {
				return tuiFailure("cancellation", "aborted", {
					abortCause: abortCause(signal),
				});
			}
			return tuiFailure("retryable-hold", "hold_lock_unavailable");
		}
		// FLY-1239: prove no stale/duplicate same-named window remains before create.
		if (
			!(await purgeSameNameWindowsAsync(spec, {
				exec,
				execOut,
				ensureSession,
				...(signal ? { signal } : {}),
			}))
		) {
			safeLog(
				deps.log,
				`runner-tui-window: could not prove the session is free of stale '${spec.windowName}' windows — skipping create this attempt (non-fatal, run unaffected)`,
			);
			if (signal?.aborted) {
				return tuiFailure("cancellation", "aborted", {
					abortCause: abortCause(signal),
				});
			}
			return tuiFailure("retryable-transient-ipc", "stale_window_unproven");
		}
		if (signal?.aborted) {
			return tuiFailure("cancellation", "aborted", {
				abortCause: abortCause(signal),
			});
		}
		const created = await exec(
			"tmux",
			[
				"new-window",
				"-d",
				"-t",
				`=${spec.tmuxSession}`,
				"-P",
				"-F",
				"#{window_id}",
				"-n",
				spec.windowName,
				buildRunnerTuiCommand(spec),
			],
			{
				timeoutMs: 10_000,
				...(signal ? { signal } : {}),
			},
		);
		if (!created.ok) {
			safeLog(
				deps.log,
				`runner-tui-window: create failed (non-fatal, run unaffected): ${spec.windowName}`,
			);
			return tuiFailure("retryable-transient-ipc", "new_window_failed");
		}
		const windowId = created.stdout?.trim();
		if (!windowId || !SAFE_WINDOW_ID.test(windowId)) {
			safeLog(
				deps.log,
				`runner-tui-window: create returned no immutable window id (${spec.windowName})`,
			);
			return tuiFailure("retryable-transient-ipc", "window_id_unproven");
		}
		// QA · FLY-1188 — PROVE it. `tmux new-window` reports success as soon as it
		// forks the shell, so it says "ok" even for a command that dies 200ms later
		// (the shipped TUI died instantly on `stdout is not a terminal`). Claiming
		// "founder TUI up" on that is how an EMPTY cmux tab — the founder's original
		// symptom — stayed invisible to the mocks AND to the operator. Let it settle,
		// then ask tmux whether the pane is actually still there.
		await (
			deps.sleepAsync ??
			(deps.sleep ? async (ms: number) => deps.sleep!(ms) : defaultSleepAsync)
		)(deps.settleMs ?? 800, signal);
		if (
			signal?.aborted ||
			(await execOut(
				"tmux",
				[
					"display-message",
					"-p",
					"-t",
					`=${spec.tmuxSession}:${windowId}`,
					"#{window_id} #{window_name} #{pane_dead}",
				],
				{
					timeoutMs: 5_000,
					...(signal ? { signal } : {}),
				},
			)) !== `${windowId} ${spec.windowName} 0`
		) {
			safeLog(
				deps.log,
				`runner-tui-window: founder TUI DIED immediately (${spec.windowName}) — the pane is gone right after tmux reported success (most likely the FLY-1239 rollout-landing race: 'no rollout found'). The run continues (the machine client drives the goal) but the founder CANNOT WATCH it. Inspect by hand: ${buildRunnerTuiCommand(spec)}`,
			);
			if (signal?.aborted) {
				return tuiFailure("cancellation", "aborted", {
					abortCause: abortCause(signal),
				});
			}
			return tuiFailure("retryable-transient-ipc", "window_died");
		}
		safeLog(
			deps.log,
			`runner-tui-window: founder TUI up (${spec.windowName}, thread ${spec.threadId})`,
		);
		return { created: true, windowId };
	} catch (err) {
		safeLog(
			deps.log,
			`runner-tui-window: ensure failed (non-fatal): ${errMessage(err)}`,
		);
		if (signal?.aborted) {
			return tuiFailure("cancellation", "aborted", {
				abortCause: abortCause(signal),
			});
		}
		const detail = errMessage(err).slice(0, 500);
		return tuiFailure(
			detail.startsWith("runner-tui-window:")
				? "permanent"
				: "retryable-transient-ipc",
			detail.startsWith("runner-tui-window:")
				? "config_invalid"
				: "ipc_exception",
			{ detail },
		);
	}
}

/** ID-scoped liveness probe (identity-echo defends against tmux resolving a
 * missing target to the session's current window). */
export function isRunnerTuiWindowAlive(
	spec: Pick<RunnerTuiWindowSpec, "tmuxSession" | "windowName">,
	deps: Pick<RunnerTuiWindowDeps, "execOut"> = {},
): boolean {
	const execOut = deps.execOut ?? defaultExecOut;
	let out: string | undefined;
	try {
		out = execOut("tmux", [
			"display-message",
			"-p",
			"-t",
			`=${spec.tmuxSession}:=${spec.windowName}`,
			"#{window_name} #{pane_dead}",
		]);
	} catch {
		return false; // fail-open: a probe that throws is "not alive", never a throw
	}
	return out === `${spec.windowName} 0`;
}

/** Explicitly tear down the founder TUI window (on run completion / shutdown —
 * leaving it alive orphans a TUI pointing at a dead daemon socket). Fail-open. */
export function killRunnerTuiWindow(
	spec: Pick<RunnerTuiWindowSpec, "tmuxSession" | "windowName"> & {
		/** Immutable tmux identity captured after creation. Survives pane rename. */
		windowId?: string;
	},
	deps: RunnerTuiWindowDeps = {},
): void {
	const exec = deps.exec ?? defaultExec;
	try {
		assertShellSafe("tmuxSession", spec.tmuxSession, SAFE_NAME);
		assertShellSafe("windowName", spec.windowName, SAFE_NAME);
		if (spec.windowId)
			assertShellSafe("windowId", spec.windowId, SAFE_WINDOW_ID);
		const target = spec.windowId
			? `=${spec.tmuxSession}:${spec.windowId}`
			: `=${spec.tmuxSession}:=${spec.windowName}`;
		const r = exec("tmux", ["kill-window", "-t", target]);
		safeLog(
			deps.log,
			r.ok
				? `runner-tui-window: killed (${spec.windowName})`
				: `runner-tui-window: kill returned non-ok (non-fatal): ${spec.windowName}`,
		);
	} catch (err) {
		safeLog(
			deps.log,
			`runner-tui-window: kill threw (non-fatal): ${errMessage(err)}`,
		);
	}
}
