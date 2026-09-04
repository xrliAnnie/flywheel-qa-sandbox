/** Founder-facing native Codex TUI for a resident runner. The pane reconnects
 * to the App Server socket and owned thread while the machine client remains
 * the automated goal driver. Visibility failures remain fail-open. */

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { auditedSignal, auditedSignalAsync } from "./kill-ledger.js";
import { withSyncOpMarker } from "./sync-op-marker.js";
import { buildRunnerPaneEnvironmentPrefix } from "./TmuxAdapter.js";
import { parseTmuxEnsureSuccess } from "./tmux-ensure-result.js";
import { buildTmuxServerBirthEnvironment } from "./tmux-server-environment.js";

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/; // absolute paths, no quotes/spaces/metachars
const SAFE_ID = /^[A-Za-z0-9-]+$/; // execution/thread ids
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
 * discriminates so the caller can retry transient tmux failures while a
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
		| "marker_unproven"
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
	/** The runner's isolated CODEX_HOME. */
	codexHome: string;
	/** The daemon's short control socket. */
	socketPath: string;
	/** TUI working directory. */
	cwd: string;
	/** The App Server-owned thread to rejoin. */
	threadId: string;
	executionId: string;
	stateDbPath?: string;
	codexBin?: string;
}

/** Build the native remote TUI command (pure and shell-boundary validated). */
export function buildRunnerTuiCommand(spec: RunnerTuiWindowSpec): string {
	assertShellSafe("codexHome", spec.codexHome, SAFE_PATH);
	assertShellSafe("socketPath", spec.socketPath, SAFE_PATH);
	assertShellSafe("cwd", spec.cwd, SAFE_PATH);
	assertShellSafe("threadId", spec.threadId, SAFE_ID);
	assertShellSafe("executionId", spec.executionId, SAFE_ID);
	if (spec.stateDbPath)
		assertShellSafe("stateDbPath", spec.stateDbPath, SAFE_PATH);
	if (spec.codexBin) assertShellSafe("codexBin", spec.codexBin, SAFE_PATH);
	return [
		`exec ${buildRunnerPaneEnvironmentPrefix()}`,
		`CODEX_HOME="${spec.codexHome}"`,
		`FLYWHEEL_EXEC_ID="${spec.executionId}"`,
		...(spec.stateDbPath
			? [`FLYWHEEL_STATE_DB_PATH="${spec.stateDbPath}"`]
			: []),
		spec.codexBin ?? "codex",
		"resume",
		`--remote "unix://${spec.socketPath}"`,
		`-C "${spec.cwd}"`,
		"-s workspace-write",
		`-c 'approval_policy="never"'`,
		spec.threadId,
	].join(" ");
}

export interface RunnerTuiWindowDeps {
	exec?: (
		cmd: string,
		args: string[],
		options?: { env?: NodeJS.ProcessEnv },
	) => { ok: boolean };
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
		options?: {
			timeoutMs?: number;
			signal?: AbortSignal;
			env?: NodeJS.ProcessEnv;
		},
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
		throw new Error("runner-tail-window: cannot determine tmux socket uid");
	}
	return join(tmp, `tmux-${uid}`, "default");
}

type EnsureSessionSpawnResult = {
	status: number | null;
	stdout?: string | Buffer;
	signal: string | null;
	terminated: "timeout" | "abort" | null;
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
	reverifySession?: (input: {
		socket: string;
		session: string;
		timeoutMs: number;
	}) => boolean;
}

export interface EnsureSessionWithRetryAsyncOptions
	extends Omit<
		EnsureSessionWithRetryOptions,
		"spawn" | "sleep" | "reverifySession"
	> {
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
	reverifySession?: (input: {
		socket: string;
		session: string;
		timeoutMs: number;
		signal?: AbortSignal;
	}) => Promise<boolean>;
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
			const helperSuccess = parseTmuxEnsureSuccess(result.stdout);
			if (helperSuccess && options.reverifySession) {
				const reverifyRemaining =
					options.deadlineMs - (options.now() - startedAt);
				if (
					reverifyRemaining > 0 &&
					options.reverifySession({
						socket: options.socket,
						session: options.session,
						timeoutMs: Math.min(5_000, reverifyRemaining),
					})
				) {
					safeLog(
						options.log,
						`runner-tail-window: guarded session ensure attempt ${attempt} succeeded despite exit anomaly (signal=${result.signal ?? "none"}, termination=${result.terminated ?? "none"}) — helper reported ${helperSuccess.action}, re-verified`,
					);
					return true;
				}
			}
			const stdout = result.stdout?.toString().trim() ?? "";
			const tail = stdout.length > 500 ? stdout.slice(-500) : stdout;
			safeLog(
				options.log,
				`runner-tail-window: guarded session ensure attempt ${attempt} held (status=${result.status ?? "null"}, signal=${result.signal ?? "none"}, termination=${result.terminated ?? "none"})${tail ? `: ${tail}` : ""}`,
			);
		} catch (error) {
			safeLog(
				options.log,
				`runner-tail-window: guarded session ensure attempt ${attempt} failed: ${errMessage(error)}`,
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
			const helperSuccess = parseTmuxEnsureSuccess(result.stdout);
			if (result.terminated === "abort" || options.signal?.aborted) {
				safeLog(
					options.log,
					`runner-tail-window: guarded session ensure attempt ${attempt} cancelled (${abortCause(options.signal)}) after helper output ${helperSuccess?.action ?? "none"}`,
				);
				return false;
			}
			if (helperSuccess && options.reverifySession) {
				const reverifyRemaining =
					options.deadlineMs - (options.now() - startedAt);
				if (reverifyRemaining > 0) {
					let reverified = false;
					try {
						reverified = await options.reverifySession({
							socket: options.socket,
							session: options.session,
							timeoutMs: Math.min(5_000, reverifyRemaining),
							...(options.signal ? { signal: options.signal } : {}),
						});
					} catch {
						// A failed diagnostic re-verification preserves the held path.
					}
					if (reverified && !options.signal?.aborted) {
						safeLog(
							options.log,
							`runner-tail-window: guarded session ensure attempt ${attempt} succeeded despite exit anomaly (signal=${result.signal ?? "none"}, termination=${result.terminated ?? "none"}) — helper reported ${helperSuccess.action}, re-verified`,
						);
						return true;
					}
				}
			}
			const stdout = result.stdout?.toString().trim() ?? "";
			const tail = stdout.length > 500 ? stdout.slice(-500) : stdout;
			safeLog(
				options.log,
				`runner-tail-window: guarded session ensure attempt ${attempt} held (status=${result.status ?? "null"}, signal=${result.signal ?? "none"}, termination=${result.terminated ?? "none"})${tail ? `: ${tail}` : ""}`,
			);
		} catch (error) {
			if (options.signal?.aborted) return false;
			safeLog(
				options.log,
				`runner-tail-window: guarded session ensure attempt ${attempt} failed: ${errMessage(error)}`,
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

/** Shared runtime accessor so tmux rescue and its outer TUI budget cannot drift. */
export function tmuxEnsureDeadlineMs(): number {
	return positiveInt(process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS, 210_000);
}

type AsyncSpawnOptions = {
	stdio: ["ignore", "pipe", "ignore"];
	encoding: "utf8";
	timeout: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
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
			resolvePromise({
				status: null,
				stdout: "",
				signal: null,
				terminated: "abort",
			});
			return;
		}
		let settled = false;
		let terminationRequested = false;
		let terminationKind: "timeout" | "abort" | null = null;
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
		const terminate = (kind: "timeout" | "abort"): void => {
			if (terminationRequested) return;
			terminationRequested = true;
			terminationKind = kind;
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
		const onAbort = (): void => terminate("abort");
		const timer = setTimeout(() => terminate("timeout"), options.timeout);
		(timer as { unref?: () => void }).unref?.();
		try {
			child = spawn(cmd, args, {
				stdio: options.stdio,
				...(options.env ? { env: options.env } : {}),
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
		child.once("close", (status, signal) =>
			settle("resolve", {
				status: terminationRequested ? null : status,
				stdout,
				signal: signal ?? null,
				terminated: terminationKind,
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
		reverifySession: async ({ socket, session, timeoutMs, signal }) => {
			const result = await spawnCommandAsync(
				"tmux",
				["-S", socket, "has-session", "-t", `=${session}`],
				{
					stdio: ["ignore", "pipe", "ignore"],
					encoding: "utf8",
					timeout: timeoutMs,
					...(signal ? { signal } : {}),
				},
			);
			return result.status === 0 && !signal?.aborted;
		},
		sleep: defaultSleepAsync,
		now: Date.now,
		log,
		deadlineMs: tmuxEnsureDeadlineMs(),
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
	options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
	} = {},
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
			...(options.env ? { env: options.env } : {}),
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
		const r = withSyncOpMarker("codex-tail:tmux-exec", () =>
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
		const r = withSyncOpMarker("codex-tail:tmux-read", () =>
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
		options?: {
			timeoutMs?: number;
			signal?: AbortSignal;
			env?: NodeJS.ProcessEnv;
		},
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

function parseProvableWindowList(
	out: string,
): Array<{ id: string; name: string }> | undefined {
	const windows = parseWindowList(out);
	// tmux permits an empty window name. It cannot match this runner's validated
	// non-empty name, so it is unrelated evidence rather than a reason to poison
	// the shared base-session inventory.
	return windows.every((window) => SAFE_WINDOW_ID.test(window.id))
		? windows
		: undefined;
}

function parseExecutionWindowList(
	out: string,
	expectedExecutionId: string,
): Array<{ id: string; executionId: string }> | undefined {
	if (out === "") return [];
	const ids = new Set<string>();
	for (const line of out.split("\n")) {
		const markerEnd = line.indexOf("|");
		if (markerEnd < 0) return undefined;
		const executionId = line.slice(0, markerEnd);
		if (executionId !== expectedExecutionId) continue;
		const fields = line.slice(markerEnd + 1).split("|");
		const [session = "", id = ""] = fields;
		if (
			fields.length !== 2 ||
			session.length === 0 ||
			!SAFE_WINDOW_ID.test(id)
		) {
			return undefined;
		}
		ids.add(id);
	}
	return [...ids].map((id) => ({ id, executionId: expectedExecutionId }));
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

async function auditedAsyncTuiWindowKill(
	exec: NonNullable<AsyncWindowExecDeps["exec"]>,
	target: string,
	reason: string,
	options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
	},
): Promise<{ ok: boolean; stdout?: string }> {
	if (exec !== defaultExecAsync) {
		return exec("tmux", ["kill-window", "-t", target], options);
	}
	let mutationResult: { ok: boolean; stdout?: string } = { ok: false };
	const audited = await auditedSignalAsync(
		{
			source: "codex_runner_tui",
			signal: "kill-window",
			targetKind: "tmux-window",
			target,
			reason,
		},
		{
			mutate: async () => {
				mutationResult = await exec(
					"tmux",
					["kill-window", "-t", target],
					options,
				);
				if (!mutationResult.ok) {
					throw new Error("tmux kill-window returned non-ok");
				}
			},
		},
	);
	if (!audited.ok) {
		throw new Error(
			`audited TUI window kill blocked (${audited.kind}): ${audited.error}`,
		);
	}
	return mutationResult;
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
		await auditedAsyncTuiWindowKill(
			deps.exec,
			window.id,
			"terminal_same_name_cleanup",
			{
				timeoutMs: 10_000,
				...(deps.signal ? { signal: deps.signal } : {}),
			},
		);
	}
}

async function purgeSameNameWindowsAsync(
	spec: Pick<RunnerTuiWindowSpec, "tmuxSession" | "windowName" | "executionId">,
	deps: AsyncWindowExecDeps & {
		ensureSession: (session: string, signal?: AbortSignal) => Promise<boolean>;
	},
): Promise<boolean> {
	const listSameNameAxis = async (): Promise<
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
		return out === undefined ? undefined : parseProvableWindowList(out);
	};
	const listExecutionAxis = async (): Promise<
		Array<{ id: string; executionId: string }> | undefined
	> => {
		const out = await deps.execOut(
			"tmux",
			[
				"list-windows",
				"-a",
				"-F",
				"#{@flywheel_exec_id}|#{session_name}|#{window_id}",
			],
			{ timeoutMs: 5_000, ...(deps.signal ? { signal: deps.signal } : {}) },
		);
		return out === undefined
			? undefined
			: parseExecutionWindowList(out, spec.executionId);
	};

	const beforeNames = await listSameNameAxis();
	const beforeExecutions = await listExecutionAxis();
	if (
		beforeNames === undefined ||
		beforeExecutions === undefined ||
		deps.signal?.aborted
	)
		return false;
	const staleWindowIds = new Set(
		beforeNames
			.filter((window) => window.name === spec.windowName)
			.map((window) => window.id),
	);
	for (const window of beforeExecutions) {
		if (window.executionId === spec.executionId) staleWindowIds.add(window.id);
	}
	for (const windowId of staleWindowIds) {
		await auditedAsyncTuiWindowKill(
			deps.exec,
			windowId,
			"precreate_identity_cleanup",
			{
				timeoutMs: 10_000,
				...(deps.signal ? { signal: deps.signal } : {}),
			},
		);
		if (deps.signal?.aborted) return false;
	}
	if (!(await deps.ensureSession(spec.tmuxSession, deps.signal))) return false;
	const afterNames = await listSameNameAxis();
	const afterExecutions = await listExecutionAxis();
	return (
		afterNames !== undefined &&
		afterExecutions !== undefined &&
		!deps.signal?.aborted &&
		!afterNames.some((window) => window.name === spec.windowName) &&
		!afterExecutions.some((window) => window.executionId === spec.executionId)
	);
}

/**
 * Ensure the founder-facing native TUI. Steps (each fail-open):
 *   1. `tmux -V` probe — absent → `{ created:false, reason:"tmux-absent" }`
 *      (headless box: the run continues, only the terminal view is missing).
 *   2. ensure the runner's session (idempotent attach-or-create).
 *   3. FLY-1239/2170 PROVABLE purge: kill base-session same-name windows
 *      plus global same-execution windows by immutable id, re-ensure the
 *      session, and verify both identity axes are empty.
 *   4. create the window running `codex resume --remote` on the owned thread.
 *   5. settle + liveness probe: a pane gone after settle → `{ reason:"died" }`
 *      (a transient tmux/filesystem failure the caller may retry).
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
			? async (cmd: string, args: string[], options) =>
					deps.exec!(cmd, args, options)
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
								env: buildTmuxServerBirthEnvironment(),
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
				`runner-tail-window: tmux unavailable — skipping (${spec.windowName})`,
			);
			return tuiFailure("permanent", "tmux_absent");
		}
		if (!(await ensureSession(spec.tmuxSession, signal))) {
			safeLog(
				deps.log,
				`runner-tail-window: guarded tmux session ensure held — skipping (${spec.windowName})`,
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
				`runner-tail-window: could not prove the session is free of stale '${spec.windowName}' windows — skipping create this attempt (non-fatal, run unaffected)`,
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
				`runner-tail-window: create failed (non-fatal, run unaffected): ${spec.windowName}`,
			);
			return tuiFailure("retryable-transient-ipc", "new_window_failed");
		}
		const windowId = created.stdout?.trim();
		if (!windowId || !SAFE_WINDOW_ID.test(windowId)) {
			safeLog(
				deps.log,
				`runner-tail-window: create returned no immutable window id (${spec.windowName})`,
			);
			return tuiFailure("retryable-transient-ipc", "window_id_unproven");
		}
		// `tmux new-window` reports success as soon as it
		// forks the shell, so it says "ok" even for a command that dies 200ms later
		// (for example, a missing `tail` binary). Let it settle, then prove the pane
		// still exists before publishing its tmux identity.
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
					windowId,
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
				`runner-tui-window: founder TUI died immediately (${spec.windowName}) — the pane is gone right after tmux reported success. The run continues but the founder cannot watch it. Inspect by hand: ${buildRunnerTuiCommand(spec)}`,
			);
			if (signal?.aborted) {
				return tuiFailure("cancellation", "aborted", {
					abortCause: abortCause(signal),
				});
			}
			return tuiFailure("retryable-transient-ipc", "window_died");
		}
		// A session-qualified `=<session>:@N` target is not exact in tmux: once
		// @N disappears, tmux silently falls back to the session's active window.
		// Marker publication is identity-bearing and must therefore use the bare
		// immutable id, which fails closed when the just-created window has died.
		const exactWindow = windowId;
		const markerWritten = await exec(
			"tmux",
			[
				"set-option",
				"-w",
				"-t",
				exactWindow,
				"@flywheel_exec_id",
				spec.executionId,
			],
			{
				timeoutMs: 10_000,
				...(signal ? { signal } : {}),
			},
		);
		const marker = markerWritten.ok
			? await execOut(
					"tmux",
					["display-message", "-p", "-t", exactWindow, "#{@flywheel_exec_id}"],
					{
						timeoutMs: 10_000,
						...(signal ? { signal } : {}),
					},
				)
			: undefined;
		if (marker !== spec.executionId) {
			try {
				await auditedAsyncTuiWindowKill(
					exec,
					windowId,
					"marker_unproven_rollback",
					{
						timeoutMs: 10_000,
						...(signal ? { signal } : {}),
					},
				);
				const residualWindowId = await execOut(
					"tmux",
					["display-message", "-p", "-t", exactWindow, "#{window_id}"],
					{
						timeoutMs: 5_000,
						...(signal ? { signal } : {}),
					},
				);
				if (residualWindowId === undefined) {
					safeLog(
						deps.log,
						`runner-tui-window: marker rollback probe failed for ${windowId}`,
					);
				} else if (residualWindowId !== "") {
					safeLog(
						deps.log,
						`runner-tui-window: marker rollback could not prove ${windowId} disappeared`,
					);
				}
			} catch {
				// The next same-name/exec-id purge retries cleanup. Window visibility
				// remains fail-open, but an unproven marker is never published.
			}
			return tuiFailure("retryable-transient-ipc", "marker_unproven");
		}
		safeLog(
			deps.log,
			`runner-tui-window: founder TUI up (${spec.windowName}, thread=${spec.threadId})`,
		);
		return { created: true, windowId };
	} catch (err) {
		safeLog(
			deps.log,
			`runner-tail-window: ensure failed (non-fatal): ${errMessage(err)}`,
		);
		if (signal?.aborted) {
			return tuiFailure("cancellation", "aborted", {
				abortCause: abortCause(signal),
			});
		}
		const detail = errMessage(err).slice(0, 500);
		return tuiFailure(
			detail.startsWith("runner-tail-window:")
				? "permanent"
				: "retryable-transient-ipc",
			detail.startsWith("runner-tail-window:")
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

/** Explicitly tear down the founder TUI when lifecycle policy requires it. */
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
		const r =
			exec === defaultExec
				? (() => {
						let mutationResult: { ok: boolean } = { ok: false };
						const audited = auditedSignal(
							{
								source: "codex_runner_tui",
								signal: "kill-window",
								targetKind: "tmux-window",
								target,
								reason: "runner_tui_close",
							},
							{
								mutate: () => {
									mutationResult = exec("tmux", ["kill-window", "-t", target]);
									if (!mutationResult.ok) {
										throw new Error("tmux kill-window returned non-ok");
									}
								},
							},
						);
						return { ok: audited.ok && mutationResult.ok };
					})()
				: exec("tmux", ["kill-window", "-t", target]);
		if (!r.ok) {
			const execOut = deps.execOut ?? defaultExecOut;
			let windows: Array<{ id: string; name: string }> | undefined;
			try {
				const out = execOut("tmux", [
					"list-windows",
					"-t",
					`=${spec.tmuxSession}`,
					"-F",
					"#{window_id} #{window_name}",
				]);
				windows = out === undefined ? undefined : parseWindowList(out);
			} catch {
				windows = undefined;
			}
			const stillPresent = windows?.some((window) =>
				spec.windowId
					? window.id === spec.windowId
					: window.name === spec.windowName,
			);
			if (windows && !stillPresent) {
				safeLog(
					deps.log,
					`runner-tail-window: kill skipped — window already gone (${spec.windowName})`,
				);
				return;
			}
		}
		safeLog(
			deps.log,
			r.ok
				? `runner-tail-window: killed (${spec.windowName})`
				: `runner-tail-window: kill returned non-ok (non-fatal): ${spec.windowName}`,
		);
	} catch (err) {
		safeLog(
			deps.log,
			`runner-tail-window: kill threw (non-fatal): ${errMessage(err)}`,
		);
	}
}
