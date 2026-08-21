/**
 * FLY-1188 M4c — spawn + socket lifecycle for the runner-side codex
 * remote-control daemon (`codex app-server --remote-control --listen
 * unix://<sock>`). This is the process primitive the daemon-mode runtime
 * composes on top of (spawn → wait-for-socket → connect (M4b) → client (M4a)).
 *
 * SUN_LEN note (load-bearing): a macOS unix socket path must fit in
 * sockaddr_un.sun_path (~104 bytes). A per-runner CODEX_HOME lives at
 * `~/.flywheel/codex-homes/<execId-UUID>/...` (~120 chars incl. the daemon's
 * own `app-server-control/...` relpath) — too long. So the socket is placed at
 * a SHORT path derived from a hash of the execId, INDEPENDENT of CODEX_HOME
 * (the daemon's `--listen` flag accepts any path; CODEX_HOME still points at
 * the per-runner home for auth/config). Verified in the V3 isolation probe:
 * scratchpad-length socket paths fail with "path must be shorter than SUN_LEN".
 *
 * All OS effects (spawn, fs) are injected so the lifecycle is unit-testable.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripInheritedSecretEnv, stripSecretEnv } from "./codex-home.js";
import { withSyncOpMarker } from "./sync-op-marker.js";

/** macOS sockaddr_un.sun_path is 104 bytes; keep a byte of headroom. */
export const SUN_PATH_MAX = 103;

/**
 * Root dir for runner daemon control sockets. Under the user's HOME (not
 * world-writable /tmp) so the unauthenticated control socket can't be
 * pre-planted or hijacked, and SHORT so paths fit SUN_LEN (~/.flywheel/cdx-sock
 * + 16-hex + .sock is well under 103 bytes). Override for tests / a machine
 * whose home path is pathologically long (assertSocketPathFitsSunLen guards).
 */
export function daemonSocketDir(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT?.trim() ||
		join(homedir(), ".flywheel", "cdx-sock")
	);
}

/**
 * A SHORT, deterministic control-socket path for one runner execution. Derived
 * from a hash of the execId (not the execId itself) so the path stays well
 * under SUN_LEN regardless of how long the execId / CODEX_HOME is, and is
 * reproducible across a daemon restart (reconnect to the same socket).
 */
export function resolveDaemonSocketPath(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const short = createHash("sha1")
		.update(executionId)
		.digest("hex")
		.slice(0, 16);
	return join(daemonSocketDir(env), `${short}.sock`);
}

/** Durable per-execution ownership state shared by the adapter, liveness
 * probe, and teardown reaper. Keeping the path primitive here prevents Bridge
 * callers from reimplementing weaker ownership lookup. */
export function codexSessionStateDir(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const base =
		env.FLYWHEEL_CODEX_SESSION_DIR?.trim() ||
		join(homedir(), ".flywheel", "state", "codex-sessions");
	return join(base, executionId);
}

export type CodexDaemonLiveness = "alive" | "absent" | "unknown";
export type ProcessGroupState = "alive" | "absent" | "unknown";

export interface CodexDaemonOwnershipDeps {
	env?: NodeJS.ProcessEnv;
	isSocketLive?: (socketPath: string) => Promise<boolean>;
	socketHolderPids?: (socketPath: string) => number[];
	processGroupOf?: (pid: number) => number | undefined;
	processGroupState?: (pgid: number) => ProcessGroupState;
	killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	exitWaitMs?: number;
	logger?: (message: string) => void;
}

export interface CodexDaemonReapResult {
	outcome: "reaped" | "absent" | "residual" | "unverifiable";
	pgid?: number;
	socketPath: string;
}

function readPersistedDaemonPgid(
	executionId: string,
	env: NodeJS.ProcessEnv,
): number | undefined {
	try {
		const raw = JSON.parse(
			readFileSync(
				join(codexSessionStateDir(executionId, env), "session.json"),
				"utf8",
			),
		) as { daemonPgid?: unknown; daemonPid?: unknown };
		// daemonPid is a read-only migration fallback for pre-FLY-1940 state. New
		// writes use daemonPgid exclusively.
		const candidate = raw.daemonPgid ?? raw.daemonPid;
		return typeof candidate === "number" &&
			Number.isSafeInteger(candidate) &&
			candidate > 1
			? candidate
			: undefined;
	} catch {
		return undefined;
	}
}

function defaultProcessGroupState(pgid: number): ProcessGroupState {
	try {
		process.kill(-pgid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "absent";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

async function inspectCodexDaemonOwnership(
	executionId: string,
	deps: CodexDaemonOwnershipDeps,
): Promise<{
	liveness: CodexDaemonLiveness;
	pgid?: number;
	socketPath: string;
	socketLive: boolean;
	groupState: ProcessGroupState;
}> {
	const env = deps.env ?? process.env;
	const socketPath = resolveDaemonSocketPath(executionId, env);
	const pgid = readPersistedDaemonPgid(executionId, env);
	if (pgid === undefined) {
		return {
			liveness: "unknown",
			socketPath,
			socketLive: await (deps.isSocketLive ?? defaultIsSocketLive)(socketPath),
			groupState: "unknown",
		};
	}
	const isSocketLive = deps.isSocketLive ?? defaultIsSocketLive;
	const socketLive = await isSocketLive(socketPath);
	const processGroupState = deps.processGroupState ?? defaultProcessGroupState;
	const groupState = processGroupState(pgid);
	if (!socketLive) {
		return {
			liveness: groupState === "absent" ? "absent" : "unknown",
			pgid,
			socketPath,
			socketLive,
			groupState,
		};
	}
	if (groupState !== "alive") {
		return {
			liveness: "unknown",
			pgid,
			socketPath,
			socketLive,
			groupState,
		};
	}
	const holders = (deps.socketHolderPids ?? defaultSocketHolderPids)(
		socketPath,
	);
	const processGroupOf = deps.processGroupOf ?? defaultProcessGroupOf;
	const proven = holders
		.slice(0, 10)
		.some((holder) => processGroupOf(holder) === pgid);
	return {
		liveness: proven ? "alive" : "unknown",
		pgid,
		socketPath,
		socketLive,
		groupState,
	};
}

/** Non-destructive daemon evidence used by workflow quiescence. `absent`
 * requires BOTH a dead socket and an absent persisted group. */
export async function probeCodexDaemonLiveness(
	executionId: string,
	deps: CodexDaemonOwnershipDeps = {},
): Promise<CodexDaemonLiveness> {
	return (await inspectCodexDaemonOwnership(executionId, deps)).liveness;
}

/** Reap the detached daemon owned by one execution. Destructive signalling is
 * authorized only when a live socket holder belongs to the persisted group.
 * The persisted PGID alone is never authority: session state can outlive the
 * daemon long enough for the OS to recycle that group id. */
export async function reapCodexDaemonForExecution(
	executionId: string,
	deps: CodexDaemonOwnershipDeps = {},
): Promise<CodexDaemonReapResult> {
	const initial = await inspectCodexDaemonOwnership(executionId, deps);
	if (initial.liveness === "absent") {
		return {
			outcome: "absent",
			...(initial.pgid !== undefined ? { pgid: initial.pgid } : {}),
			socketPath: initial.socketPath,
		};
	}
	if (
		initial.pgid === undefined ||
		initial.groupState !== "alive" ||
		initial.liveness !== "alive"
	) {
		return {
			outcome: "unverifiable",
			...(initial.pgid !== undefined ? { pgid: initial.pgid } : {}),
			socketPath: initial.socketPath,
		};
	}
	const processGroupOf = deps.processGroupOf ?? defaultProcessGroupOf;
	const killGroup =
		deps.killGroup ??
		createDefaultKillGroup({
			processGroupOf,
			logger: deps.logger,
		});
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const waitMs = deps.exitWaitMs ?? codexDaemonExitWaitMs(deps.env);
	const waitForAbsent = async (): Promise<boolean> => {
		const deadline = now() + waitMs;
		for (;;) {
			if (
				(await inspectCodexDaemonOwnership(executionId, deps)).liveness ===
				"absent"
			) {
				return true;
			}
			if (now() >= deadline) return false;
			await sleep(Math.min(100, Math.max(1, deadline - now())));
		}
	};
	try {
		killGroup(initial.pgid, "SIGTERM");
	} catch {
		// Continue to the proof. A raced-away group is success only if the shared
		// probe proves both group and socket absent.
	}
	if (await waitForAbsent()) {
		return {
			outcome: "reaped",
			pgid: initial.pgid,
			socketPath: initial.socketPath,
		};
	}
	try {
		killGroup(initial.pgid, "SIGKILL");
	} catch {
		// proof below decides the result
	}
	return (await waitForAbsent())
		? { outcome: "reaped", pgid: initial.pgid, socketPath: initial.socketPath }
		: {
				outcome: "residual",
				pgid: initial.pgid,
				socketPath: initial.socketPath,
			};
}

/** Fail closed if a socket path cannot bind (SUN_LEN) — a clear error beats a
 * cryptic EINVAL from the daemon at listen time. */
export function assertSocketPathFitsSunLen(socketPath: string): void {
	const bytes = Buffer.byteLength(socketPath, "utf8");
	if (bytes > SUN_PATH_MAX) {
		throw new Error(
			`daemon socket path is ${bytes} bytes, exceeds SUN_LEN (${SUN_PATH_MAX}): ${socketPath}`,
		);
	}
}

/**
 * FLY-1188 M4d: build the `-c` sandbox-config overrides for the daemon spawn
 * (workspace-write writable roots + network access), mirroring the exec-cycle's
 * `buildCodexCycleArgv` fresh-mode shape (`sandbox_workspace_write.writable_roots`
 * as a JSON array, `sandbox_workspace_write.network_access=true`). Pure +
 * exported so the exact override strings are unit-testable. Values ride
 * SEPARATE argv elements (no shell), so paths need no escaping.
 */
export function buildDaemonSandboxArgs(opts: {
	sandboxWritableRoots?: string[];
	sandboxNetworkAccess?: boolean;
}): string[] {
	const args: string[] = [];
	if (opts.sandboxWritableRoots && opts.sandboxWritableRoots.length > 0) {
		args.push(
			"-c",
			`sandbox_workspace_write.writable_roots=${JSON.stringify(opts.sandboxWritableRoots)}`,
		);
	}
	if (opts.sandboxNetworkAccess) {
		args.push("-c", "sandbox_workspace_write.network_access=true");
	}
	return args;
}

/**
 * FLY-1565: apps/connector tool approval modes codex accepts (real-machine
 * enum from codex 0.146.0 config load: `auto`, `prompt`, `writes`, `approve`).
 * `approve` is the auto-grant state — it is exactly what codex persists
 * per-tool after a human answers "approve, don't ask again".
 */
const APPS_APPROVAL_MODES = new Set(["auto", "prompt", "writes", "approve"]);

/**
 * FLY-1565: build the `-c apps._default.default_tools_approval_mode="<mode>"`
 * daemon spawn override. Apps/connector tool calls (e.g. the GitHub connector's
 * create_blob / create_branch / create_pull_request) elicit a PER-TOOL approval
 * regardless of `approval_policy = "never"` — an unattended runner daemon has
 * nobody to answer, so the elicitation wedges the turn until a human presses a
 * key (the FLY-1564 stalls). Presetting the apps-wide default to `approve`
 * removes the elicitation. Same defensive whitelist shape as
 * `buildDaemonEffortArgs`: an unknown value is warned + ignored, never spliced.
 */
export function buildDaemonAppsApprovalArgs(mode?: string): string[] {
	if (!mode) return [];
	if (!APPS_APPROVAL_MODES.has(mode)) {
		console.warn(
			`[codex-daemon] unsupported apps approval mode "${mode}" — ignoring (daemon uses CODEX_HOME config default)`,
		);
		return [];
	}
	return ["-c", `apps._default.default_tools_approval_mode="${mode}"`];
}

/** FLY-1224: effort values the daemon spawn accepts (mirrors RoleEffort). */
const DAEMON_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * FLY-1224: build the `-c model_reasoning_effort="<effort>"` daemon spawn
 * override for a per-phase reasoning effort. The value only ever comes from
 * the phase table (a controlled enum), but the argv builder still whitelists
 * defensively — an unknown value is warned + ignored (the CODEX_HOME config
 * default applies), never spliced into the config override. The quoted value
 * is TOML string syntax (`codex -c key=value` parses the value as TOML);
 * verified against the real codex CLI. Absent → no argv (byte-compatible).
 */
export function buildDaemonEffortArgs(effort?: string): string[] {
	if (!effort) return [];
	if (!DAEMON_EFFORTS.has(effort)) {
		console.warn(
			`[codex-daemon] unsupported effort "${effort}" — ignoring (daemon uses CODEX_HOME config default)`,
		);
		return [];
	}
	return ["-c", `model_reasoning_effort="${effort}"`];
}

/** Minimal spawned-child surface the lifecycle needs (injectable). */
export interface DaemonChild {
	readonly pid?: number;
	kill(signal?: NodeJS.Signals | number): boolean;
	once(
		event: "exit",
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
	once(event: "error", cb: (err: Error) => void): void;
	readonly exitCode: number | null;
	/**
	 * The signal that terminated the child, if any. Node keeps `exitCode` null
	 * when a process is killed by a signal — the fact of exit shows up here (and
	 * in the `exit` event), so exit-confirmation must consult BOTH.
	 */
	readonly signalCode?: NodeJS.Signals | null;
}

export type DaemonSpawnFn = (
	bin: string,
	args: string[],
	opts: { env: NodeJS.ProcessEnv },
) => DaemonChild;

export interface SpawnCodexDaemonOptions {
	codexBin: string;
	/** Per-runner CODEX_HOME (auth/config); NOT where the socket lives. */
	codexHome: string;
	/** SHORT socket path (see resolveDaemonSocketPath). */
	socketPath: string;
	/**
	 * FLY-1188 M4d: sandbox writable roots for the daemon's workspace-write
	 * threads, delivered as a `-c sandbox_workspace_write.writable_roots=[...]`
	 * override on the app-server spawn (the SAME mechanism the exec-cycle used
	 * via `codex exec -c`; `codex app-server` documents `-c/--config` overrides).
	 * A linked worktree's commit/index/locks live under the MAIN repo's `.git`,
	 * outside the thread's implicit cwd root, so `git add/commit` dies in the
	 * Seatbelt sandbox WITHOUT these extra roots (the FLY-1188 sandbox fix, in
	 * daemon form). Empty/undefined → no override (codex's config.toml default).
	 */
	sandboxWritableRoots?: string[];
	/**
	 * FLY-1188 M4d: grant the daemon's workspace-write threads network access
	 * (`-c sandbox_workspace_write.network_access=true`) — flywheel-comm's
	 * Bridge POST, `git push`, and `gh` all need it (QA Finding 1, daemon form).
	 */
	sandboxNetworkAccess?: boolean;
	/**
	 * FLY-1565: apps/connector-wide default tool approval mode delivered as a
	 * daemon config override (`-c apps._default.default_tools_approval_mode`).
	 * An unattended daemon cannot answer a per-tool elicitation — `approve`
	 * presets auto-grant so connector tool calls never wedge the turn waiting
	 * for a human. Absent → CODEX_HOME config default (byte-compatible).
	 */
	appsDefaultToolsApprovalMode?: string;
	/**
	 * FLY-1224: per-phase reasoning effort delivered as a daemon config
	 * override (`-c model_reasoning_effort="<effort>"`) — the app-server's
	 * thread/start has no effort field, so the daemon `-c` override is the
	 * (already-proven) mechanism. Absent → CODEX_HOME config default.
	 */
	effort?: string;
	/** Base env to layer CODEX_HOME onto (default process.env). */
	env?: NodeJS.ProcessEnv;
	/**
	 * FLY-1188 HIGH-3 (Codex full-PR review): the pid of a PRIOR daemon for THIS
	 * execution, persisted across a Bridge restart. `detached:false` does NOT
	 * kill the daemon child when the parent Bridge dies on Unix (it is reparented
	 * to init and keeps running), so on a resuming redrive the prior daemon can
	 * still be LISTENING on this execution's socket and block the fresh spawn. The
	 * socket path is execution-private and we hold its single-owner lock, so a
	 * live listener there is provably our own orphan whose pid is exactly this —
	 * safe to REAP + reclaim (no pid-recycle risk: a live socket ⟺ that same pid
	 * still alive). Undefined → the safe refuse-to-clobber behavior is kept.
	 */
	reapOrphanPid?: number;
	/** Kill a pid (default `process.kill`); injectable for tests. */
	killPid?: (pid: number, signal: NodeJS.Signals) => void;
	/**
	 * FLY-1188 HIGH-3 R2 (Codex full-PR review + Lead ruling): the OS-authoritative
	 * set of pids currently holding the socket at `p` (default: `lsof -t <p>`).
	 * The reap is FAIL-CLOSED — a persisted `reapOrphanPid` is killed ONLY if it
	 * is proven to be a current holder of THIS socket. A persisted pid that no
	 * longer holds the socket (within-run-restart lag, pid recycle, a tampered
	 * session.json) is NOT ours to kill → skip + log. `[]` (no proof / lsof
	 * absent) also means skip. "Destructive op not provable = don't act."
	 */
	socketHolderPids?: (p: string) => number[];
	/**
	 * QA · FLY-1188 HIGH-2 — signal an entire PROCESS GROUP (default
	 * `process.kill(-pgid, sig)`).
	 *
	 * `opts.codexBin` is the rotation shim, a shell script: the real
	 * `codex app-server` is its CHILD, so killing the pid we spawned killed only
	 * the shim and left a ~178MB app-server holding this socket, reparented to
	 * PID 1. We therefore spawn the daemon DETACHED — it leads its own process
	 * group — and signal the GROUP, which reaches the shim and the app-server
	 * alike. The group is one we created, so nothing but our own descendants can
	 * be in it: killing it cannot touch a production process.
	 *
	 * Only used when the daemon was spawned through the REAL spawn seam (or when
	 * a test injects this) — with a fake `spawnFn`, a fake pid must never reach a
	 * real `kill(-pid)`.
	 */
	killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
	/**
	 * QA · FLY-1188 HIGH-2 — the process-group id of a pid (default
	 * `ps -o pgid= -p <pid>`), the second half of the reap's proof. `undefined`
	 * (ps missing, process gone, unparseable) = no proof → do not kill.
	 */
	processGroupOf?: (pid: number) => number | undefined;
	/**
	 * FLY-1940: synchronously persist the detached daemon's process-group
	 * identity immediately after spawn and before any socket wait. A throw is
	 * fail-close: the just-spawned group is killed and proven gone before spawn
	 * rejects, so Bridge crash recovery never inherits an unowned daemon.
	 */
	onSpawnIdentity?: (pgid: number) => void;
	spawnFn?: DaemonSpawnFn;
	/** Socket-appeared probe (default: fs statSync). */
	socketExists?: (p: string) => boolean;
	/**
	 * Is a live daemon already listening at this socket? (default: a bounded
	 * net.connect probe). Guards against clobbering a concurrent same-exec
	 * daemon — an existing socket is only removed once proven NOT live.
	 */
	isSocketLive?: (p: string) => Promise<boolean>;
	/**
	 * Ensure the socket's parent dir exists AND is safe (default: create 0700,
	 * or on a pre-existing dir reject a symlink / foreign owner and enforce
	 * 0700). The control socket is unauthenticated, so its dir must be ours.
	 */
	ensureDir?: (dir: string) => void;
	/** Remove a stale socket file before bind (default: fs rm, ignore ENOENT). */
	removeStaleSocket?: (p: string) => void;
	/**
	 * Acquire the atomic single-owner lock for this execution's daemon
	 * (default: an O_EXCL lockfile at `<socketPath>.lock` with PID-liveness
	 * stale reclaim). THROWS if a live process already holds it. Held for the
	 * daemon's lifetime and released only once the daemon is PROVEN dead — by
	 * `handle.ensureDead()`, or by the failed-spawn cleanup. NOT by `stop()`,
	 * which merely fires the signal (Codex R9 MEDIUM): releasing any earlier
	 * would let a concurrent same-exec spawn bind this socket path while we are
	 * still tearing the old daemon down.
	 */
	acquireLock?: AcquireDaemonLockFn;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Max wait for the socket to appear (default 30s). */
	socketWaitTimeoutMs?: number;
	/** Socket poll interval (default 200ms). */
	socketPollMs?: number;
	/** Bounded wait for child exit/socket shutdown (default 10s; env-overridable). */
	childExitWaitMs?: number;
	logger?: (m: string) => void;
}

/** The held single-owner lock; release() is idempotent. */
export interface DaemonLock {
	release(): void;
}

export type AcquireDaemonLockFn = (lockPath: string) => DaemonLock;

export interface DaemonHandle {
	child: DaemonChild;
	socketPath: string;
	/**
	 * Terminate the daemon (default SIGTERM): signals its whole PROCESS GROUP —
	 * the shim AND the `codex app-server` it forked (QA · FLY-1188 HIGH-2:
	 * killing just the pid we spawned left the app-server running, reparented to
	 * PID 1).
	 *
	 * This only FIRES the signal. It does NOT release the single-owner lock and
	 * does not wait: every caller must follow it with `ensureDead()`, which is
	 * what proves the daemon is gone and hands the socket path on.
	 */
	stop(signal?: NodeJS.Signals): void;
	/**
	 * QA · FLY-1188 HIGH-2 — confirm the daemon is REALLY gone, escalating to a
	 * group SIGKILL if it is not, and unlink the socket once it is. Resolves true
	 * when nothing is listening any more.
	 *
	 * Verification is by SOCKET, never by pid: the pid we hold is the shim's, and
	 * `process.kill(pid, 0)` on it reports "dead" while the app-server grandchild
	 * that actually owns the socket is still very much alive. That false probe is
	 * precisely what hid this leak (it fooled the first cut of the QA harness too).
	 */
	ensureDead(): Promise<boolean>;
}

/**
 * Spawn the runner daemon and resolve once its control socket is listening.
 * Rejects if the daemon exits/errors before the socket appears, or the
 * socket-wait times out (the daemon is killed on timeout so nothing leaks).
 */
export async function spawnCodexDaemon(
	opts: SpawnCodexDaemonOptions,
): Promise<DaemonHandle> {
	assertSocketPathFitsSunLen(opts.socketPath);

	const log = opts.logger ?? (() => {});
	const now = opts.now ?? Date.now;
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const spawnFn = opts.spawnFn ?? defaultSpawnFn;
	const socketExists = opts.socketExists ?? defaultSocketExists;
	const isSocketLive = opts.isSocketLive ?? defaultIsSocketLive;
	const ensureDir = opts.ensureDir ?? defaultEnsureSecureDir;
	const removeStaleSocket = opts.removeStaleSocket ?? defaultRemoveStaleSocket;
	const acquireLock = opts.acquireLock ?? defaultAcquireDaemonLock;
	const killPid = opts.killPid ?? ((pid, sig) => process.kill(pid, sig));
	const socketHolderPids = opts.socketHolderPids ?? defaultSocketHolderPids;
	const processGroupOf = opts.processGroupOf ?? defaultProcessGroupOf;
	// QA · FLY-1188 HIGH-2: a real `kill(-pgid)` is only ever reachable for a
	// daemon we really spawned. With an injected (fake) spawnFn and no injected
	// killGroup there is NO group to signal — a made-up pid must never be able to
	// reach `process.kill(-pid)` and take out an unrelated group on this machine.
	const killGroup =
		opts.killGroup ??
		(opts.spawnFn
			? undefined
			: createDefaultKillGroup({ processGroupOf, logger: log }));
	const timeoutMs = opts.socketWaitTimeoutMs ?? 30_000;
	const pollMs = opts.socketPollMs ?? 200;
	const childExitWaitMs =
		opts.childExitWaitMs ?? codexDaemonExitWaitMs(process.env);

	ensureDir(dirnameOf(opts.socketPath));

	// R-M4c R2 HIGH: single-owner must be ATOMIC. An O_EXCL lockfile is the gate
	// — only the process holding `<socket>.lock` may own this exec's daemon, so
	// a concurrent same-exec spawn (the loser) never reaches the socket dance
	// and thus can never unlink the winner's live socket. THROWS if a live
	// holder exists; reclaims a stale (dead-holder) lock.
	const lock = acquireLock(`${opts.socketPath}.lock`);
	// Cleanup releases the lock itself (LAST, after socket cleanup); the outer
	// catch must not double-release. `lockHandled` tracks that.
	let lockHandled = false;
	// Codex R9 MEDIUM: releasing the lock is what lets the NEXT owner bind this
	// socket path, so it must happen only once this daemon is provably dead and
	// its socket unlinked — never in stop(), which merely fires the signal. A
	// release in that gap lets a concurrent same-exec spawn bind a NEW daemon
	// whose live socket our own late unlink would then delete.
	let lockReleased = false;
	const releaseLock = (): void => {
		if (lockReleased) return;
		lockReleased = true;
		lock.release();
	};

	try {
		// A leftover socket from a CRASHED daemon blocks bind. Now that we hold
		// the lock the socket is provably ours to reason about, but stay careful:
		// only remove a socket the probe proves NOT live (unknown → refuse).
		if (socketExists(opts.socketPath)) {
			if (await isSocketLive(opts.socketPath)) {
				// FLY-1188 HIGH-3 R2 (Codex full-PR review + Lead ruling): a LIVE
				// listener at this execution-private socket is our OWN prior daemon
				// orphaned by a Bridge restart (detached:false does not kill the child
				// on parent death). We may reclaim it — but ONLY by killing a pid we
				// can PROVE is the current holder of THIS socket. FAIL-CLOSED: verify
				// the persisted reapOrphanPid against the OS socket-holder table; if it
				// is not a proven holder (pid recycle, a within-run-restart persist
				// lag, a tampered session.json, or lsof unavailable) we do NOT kill —
				// we refuse to clobber. "Destructive op not provable = don't act."
				const holders =
					opts.reapOrphanPid !== undefined
						? socketHolderPids(opts.socketPath)
						: [];
				// QA · FLY-1188 HIGH-2 made the old proof unsatisfiable: the socket is
				// held by the `codex app-server` GRANDCHILD, while the pid we persist
				// is the shim's, so `holders.includes(reapOrphanPid)` was never true
				// and the reap always refused — the two defects covered for each other.
				// The daemon is now spawned DETACHED, so the persisted pid is also its
				// process-GROUP id, and the group is the honest unit of ownership.
				// Two independent OS facts still gate the kill: the OS says pid H holds
				// THIS execution-private socket (lsof), AND the OS says H belongs to the
				// group we recorded (ps). Otherwise: refuse. Not provable = don't act.
				// Codex R9 HIGH: BOTH facts, ALWAYS. An `h === reapOrphanPid` shortcut
				// would let a single fact (lsof) authorize a destructive kill, and it
				// is not even reachable in the real shape — we persist the GROUP
				// LEADER (the shim), and the socket is held by the app-server. A group
				// leader is in its own group, so the two-fact rule subsumes the
				// identity case anyway; `ps` failing simply means NO proof → refuse.
				const proofDeadline = now() + 20_000;
				let provenHolder = false;
				if (opts.reapOrphanPid !== undefined) {
					for (const holder of holders.slice(0, 10)) {
						if (now() >= proofDeadline) break;
						if (processGroupOf(holder) === opts.reapOrphanPid) {
							provenHolder = true;
							break;
						}
					}
				}
				if (opts.reapOrphanPid !== undefined && provenHolder) {
					log(
						`reaping proven orphan (group=${opts.reapOrphanPid} holds ${opts.socketPath}, holders=[${holders.join(",")}]) to reclaim the socket`,
					);
					try {
						// Signal the GROUP: the shim AND the app-server it forked. Killing
						// only the recorded pid would leave the app-server on the socket.
						if (killGroup) killGroup(opts.reapOrphanPid, "SIGKILL");
						else killPid(opts.reapOrphanPid, "SIGKILL");
					} catch {
						/* already gone — fall through to the liveness re-check */
					}
					const reapDeadline = now() + childExitWaitMs;
					while (
						now() < reapDeadline &&
						(await isSocketLive(opts.socketPath))
					) {
						await sleep(Math.min(pollMs, Math.max(0, reapDeadline - now())));
					}
					if (await isSocketLive(opts.socketPath)) {
						// The reap did not take — never clobber a still-live daemon.
						throw new Error(
							`orphan codex daemon at ${opts.socketPath} did not die after reap (pid=${opts.reapOrphanPid}) — refusing to clobber it`,
						);
					}
					removeStaleSocket(opts.socketPath);
				} else {
					if (opts.reapOrphanPid !== undefined) {
						log(
							`NOT reaping: persisted pid ${opts.reapOrphanPid} is not a proven holder of ${opts.socketPath} (holders=[${holders.join(",")}]) — refusing to kill an unrelated process`,
						);
					}
					throw new Error(
						`a live codex daemon is already listening at ${opts.socketPath} — refusing to clobber it`,
					);
				}
			} else {
				removeStaleSocket(opts.socketPath);
			}
		}

		const child = spawnFn(
			opts.codexBin,
			[
				"app-server",
				"--remote-control",
				"--listen",
				`unix://${opts.socketPath}`,
				// FLY-1188 M4d: sandbox config overrides (same `-c key=value` shape
				// as the exec-cycle's `codex exec`; `codex app-server` accepts
				// `-c/--config`). Passed as SEPARATE argv elements (no shell) so a
				// path with a metachar can never break out — codex parses the value.
				...buildDaemonSandboxArgs(opts),
				// FLY-1565: apps-wide tool approval preset (whitelisted).
				...buildDaemonAppsApprovalArgs(opts.appsDefaultToolsApprovalMode),
				// FLY-1224: per-phase reasoning effort override (whitelisted).
				...buildDaemonEffortArgs(opts.effort),
			],
			{
				// R-M4c HIGH: NEVER let a GitHub token reach the codex process env
				// — it lives only in the 0600 config.toml (FLY-123). The adapter's
				// explicitly constructed env is authoritative; the defensive fallback
				// constructs a safe base with no inherited FLYWHEEL_* values.
				env: {
					...stripSecretEnv(opts.env ?? stripInheritedSecretEnv(process.env)),
					CODEX_HOME: opts.codexHome,
				},
			},
		);
		log(
			`codex daemon spawned (pid=${child.pid ?? "?"}) socket=${opts.socketPath}`,
		);

		// Latch an early exit/error so the socket-wait can bail out immediately
		// instead of polling a socket that will never appear. `childReaped` marks
		// that there is no live process left to wait on (already exited, or the
		// spawn errored so it never ran) — cleanup then skips the exit wait.
		let deadReason: string | null = null;
		let childReaped = false;
		child.once("exit", (code, signal) => {
			childReaped = true;
			deadReason ??= `daemon exited early (code=${code} signal=${signal})`;
		});
		child.once("error", (err) => {
			childReaped = true;
			deadReason ??= `daemon spawn error: ${err.message}`;
		});

		/**
		 * QA · FLY-1188 HIGH-2 — signal the daemon's whole process TREE.
		 *
		 * `opts.codexBin` is the rotation shim (a shell script that must fork
		 * `codex` rather than exec it, so it can read the exit code and rotate the
		 * account on a 429). So the process we spawned is the shim, and the real
		 * `codex app-server` — the thing holding the socket and ~178MB — is its
		 * CHILD. `child.kill()` reaped the shim and left the app-server behind,
		 * reparented to PID 1, on every single run.
		 *
		 * We spawn detached, so the child leads its own process group and the
		 * group holds exactly our own descendants. Signalling the group reaches
		 * both. If there is no group to signal (an injected spawnFn in tests),
		 * fall back to the single child — never guess a group id.
		 */
		const killTree = (signal: NodeJS.Signals): void => {
			const pid = child.pid;
			if (killGroup && pid !== undefined) {
				try {
					killGroup(pid, signal);
					return;
				} catch {
					/* group gone / not a leader — fall through to the child */
				}
			}
			try {
				child.kill(signal);
			} catch {
				/* already gone */
			}
		};

		const handle: DaemonHandle = {
			child,
			socketPath: opts.socketPath,
			// Fire the signal at the whole tree. The lock is deliberately NOT
			// released here: every stop() in this codebase is followed by
			// ensureDead() (goal-runtime drains on every path), and only ensureDead
			// can know the daemon is really gone.
			stop: (signal: NodeJS.Signals = "SIGTERM") => {
				killTree(signal);
			},
			ensureDead: async (): Promise<boolean> => {
				// Verify by SOCKET. The shim's pid says nothing about the app-server
				// that actually owns it, and a graceful SIGTERM the shim honours but
				// the app-server ignores would look like a clean exit while the daemon
				// kept listening. Only "nobody is listening any more" is proof.
				const settle = async (): Promise<boolean> => {
					const deadline = now() + childExitWaitMs;
					while (now() < deadline && (await isSocketLive(opts.socketPath))) {
						await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
					}
					return !(await isSocketLive(opts.socketPath));
				};
				if (!(await settle())) {
					log(
						`daemon still listening on ${opts.socketPath} after stop — escalating to a group SIGKILL`,
					);
					killTree("SIGKILL");
					if (!(await settle())) {
						log(
							`WARNING: codex daemon at ${opts.socketPath} SURVIVED a group SIGKILL — HOLDING the lock + leaving the socket rather than clobbering a live daemon`,
						);
						return false; // lock stays held: nobody else may bind this socket
					}
				}
				// Nothing is listening: the socket file is now just litter. Removing it
				// is also what makes an orphan visible — a leftover socket with no
				// listener is a clean teardown, a socket with one is a leak. Unlink
				// and release the lock together, still under our ownership, so the
				// next owner can never be bound while we are still cleaning up.
				removeStaleSocket(opts.socketPath);
				releaseLock();
				return true;
			},
		};

		// R-M4c R3 HIGH-2: a failed spawn must hold the lock through the ENTIRE
		// cleanup and release it LAST. We SIGKILL the child directly (NOT
		// handle.stop, which would release the lock early), bounded-wait for it
		// to actually exit, and only THEN unlink the socket + release the lock —
		// so a new owner can't acquire the lock and bind during cleanup and then
		// have its live socket clobbered by us. If exit is NOT confirmed within
		// the bound (a daemon somehow surviving SIGKILL), we KEEP the lock held
		// and LEAVE the socket, failing loud rather than clobbering a
		// possibly-live daemon.
		const cleanupAndThrow = async (error: string | Error): Promise<never> => {
			// The whole TREE (QA · FLY-1188 HIGH-2) — a failed spawn that reaped only
			// the shim would leak the app-server exactly like a successful one did.
			killTree("SIGKILL");
			const exitDeadline = now() + childExitWaitMs;
			while (!childReaped && child.exitCode === null && now() < exitDeadline) {
				await sleep(Math.min(50, Math.max(0, exitDeadline - now())));
			}
			// Codex R9 HIGH: the shim exiting is NOT the daemon dying — the app-server
			// it forked can still hold the socket. Proving cleanup by `childReaped`
			// alone is the same false probe QA caught, and here it would UNLINK a
			// socket a live daemon still owns. Ask the socket, under the lock.
			const socketDeadline = now() + childExitWaitMs;
			while (now() < socketDeadline && (await isSocketLive(opts.socketPath))) {
				await sleep(Math.min(pollMs, Math.max(0, socketDeadline - now())));
			}
			const stillListening = await isSocketLive(opts.socketPath);
			if (!stillListening && (childReaped || child.exitCode !== null)) {
				removeStaleSocket(opts.socketPath);
				releaseLock();
				lockHandled = true;
			} else {
				lockHandled = true; // keep the lock held; the outer catch won't release
				log(
					`WARNING: codex daemon could not be CONFIRMED dead after SIGKILL within ${childExitWaitMs}ms (socket still listening=${stillListening}) — holding lock + leaving socket ${opts.socketPath} to avoid clobbering a possibly-live daemon`,
				);
			}
			throw typeof error === "string" ? new Error(error) : error;
		};

		if (opts.onSpawnIdentity) {
			const pgid = child.pid;
			if (!Number.isInteger(pgid) || (pgid ?? 0) <= 1) {
				return await cleanupAndThrow(
					"codex daemon spawn did not expose a safe process-group identity",
				);
			}
			try {
				opts.onSpawnIdentity(pgid as number);
			} catch (error) {
				return await cleanupAndThrow(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}

		const deadline = now() + timeoutMs;
		while (true) {
			if (deadReason) return await cleanupAndThrow(deadReason);
			if (socketExists(opts.socketPath)) {
				log(`codex daemon socket up: ${opts.socketPath}`);
				return handle;
			}
			if (now() >= deadline) {
				return await cleanupAndThrow(
					`codex daemon socket did not appear within ${timeoutMs}ms: ${opts.socketPath}`,
				);
			}
			await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
		}
	} catch (err) {
		// Any failure before/while establishing the daemon releases the lock so
		// a retry isn't blocked by our own stale lease — UNLESS cleanup already
		// decided the lock's fate (released it, or is deliberately holding it
		// because a possibly-live daemon could not be confirmed dead).
		if (!lockHandled) releaseLock();
		throw err;
	}
}

// ── default (real) OS seams ──────────────────────────────────────────────

function dirnameOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i <= 0 ? "/" : p.slice(0, i);
}

function defaultSpawnFn(
	bin: string,
	args: string[],
	opts: { env: NodeJS.ProcessEnv },
): DaemonChild {
	// Tests inject spawnFn, so the real spawn is never touched in unit tests.
	return spawn(bin, args, {
		env: opts.env,
		stdio: ["ignore", "ignore", "ignore"],
		// QA · FLY-1188 HIGH-2: `detached: true` puts the daemon in its OWN process
		// group, led by the pid we get back. That group contains the rotation shim
		// AND the `codex app-server` it forks — and NOTHING else on this machine —
		// so teardown can signal the group and take the whole tree down at once.
		// (`detached: false` never protected anything here: on Unix it does not kill
		// the child when the parent dies either. It only cost us the group.)
		detached: true,
	}) as unknown as DaemonChild;
}

/**
 * QA · FLY-1188 HIGH-2 — signal a whole process group. `process.kill` with a
 * NEGATIVE pid is the POSIX "signal the group" call.
 *
 * `kill(-0)` would signal OUR OWN group — the Bridge, every Lead, every Runner —
 * so 0, negatives and 1 are refused outright, as are our own pid and our parent's.
 *
 * The real guarantee is upstream, and it is structural: the only two pgids that
 * ever reach here are (a) the leader of a group WE created via a detached spawn,
 * and (b) a group the OS twice proved owns this execution-private socket (lsof
 * says pid H holds it; ps says H is in that group). Neither can be a production
 * process's group. "Destructive op not provable = don't act."
 */
export function createDefaultKillGroup(options: {
	processGroupOf: (pid: number) => number | undefined;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	pid?: number;
	ppid?: number;
	logger?: (message: string) => void;
}): (pgid: number, signal: NodeJS.Signals) => void {
	const pid = options.pid ?? process.pid;
	const ppid = options.ppid ?? process.ppid;
	const kill =
		options.kill ?? ((target, signal) => process.kill(target, signal));
	const logger = options.logger ?? (() => {});
	let ownPgidResolved = false;
	let ownPgid: number | undefined;
	return (pgid, signal) => {
		if (!Number.isInteger(pgid) || pgid <= 1) return;
		if (pgid === pid || pgid === ppid) {
			logger(
				`[CodexDaemon] REFUSING group signal to protected pid-derived PGID ${pgid} (signal=${signal})`,
			);
			return;
		}
		if (!ownPgidResolved) {
			ownPgid = options.processGroupOf(pid);
			ownPgidResolved = true;
		}
		if (ownPgid !== undefined && pgid === ownPgid) {
			logger(
				`[CodexDaemon] REFUSING group signal to Bridge process group ${pgid} (signal=${signal})`,
			);
			return;
		}
		logger(`[CodexDaemon] group signal pgid=${pgid} signal=${signal}`);
		kill(-pgid, signal);
	};
}

export function codexDaemonExitWaitMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const configured = env.FLYWHEEL_CODEX_DAEMON_EXIT_WAIT_MS?.trim();
	if (!configured) return 10_000;
	const parsed = Number(configured);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10_000;
}

/**
 * QA · FLY-1188 HIGH-2 — the process-group id of `pid` (`ps -o pgid= -p <pid>`).
 * Half of the reap's proof: it ties a socket holder the OS reported back to the
 * group we recorded. Any failure (ps missing, process gone, unparseable) yields
 * `undefined` = NO proof → the caller refuses to kill.
 */
function defaultProcessGroupOf(pid: number): number | undefined {
	try {
		const out = withSyncOpMarker("codex-daemon:ps-pgid", () =>
			execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
		const pgid = Number.parseInt(out.trim(), 10);
		return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * FLY-1188 HIGH-3 R2: the pids currently holding the unix socket at `p`, from
 * the OS (`lsof -t -- <p>`). This is the AUTHORITATIVE identity check the reap
 * gates on — a persisted pid is killed only if it appears here. Bounded (2s, no
 * shell) and total: any failure (lsof missing/ENOENT, no holder, parse error)
 * yields `[]`, which the caller treats as "not provable" → refuse to kill.
 */
function defaultSocketHolderPids(p: string): number[] {
	try {
		const out = withSyncOpMarker("codex-daemon:lsof-socket", () =>
			execFileSync("lsof", ["-t", "--", p], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
		return out
			.split("\n")
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((n) => Number.isInteger(n) && n > 0);
	} catch {
		// lsof absent, no holder (exit 1), or any error → no proof → empty.
		return [];
	}
}

function defaultSocketExists(p: string): boolean {
	try {
		return statSync(p).isSocket();
	} catch {
		return false;
	}
}

/**
 * Probe whether the socket must be treated as LIVE (unsafe to clobber). A
 * bounded net.connect: `connect` → live. Only a DEFINITE "no listener" error
 * (ENOENT / ECONNREFUSED) is safe-to-remove (resolves false). Every other
 * outcome — EACCES, EMFILE, a hang → timeout — is UNKNOWN and resolves true,
 * so an ambiguous result never unlinks a possibly-live daemon (R2 MEDIUM).
 * The probe connects and immediately disconnects — it never sends a frame.
 */
function defaultIsSocketLive(socketPath: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const sock = connect(socketPath);
		const timer = setTimeout(() => done(true), 1000); // hang → unknown → live
		(timer as { unref?: () => void }).unref?.();
		function done(live: boolean): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			resolve(live);
		}
		sock.once("connect", () => done(true));
		sock.once("error", (err: NodeJS.ErrnoException) => {
			const code = err.code;
			// definite "nothing is listening" → stale; anything else → unknown.
			done(!(code === "ENOENT" || code === "ECONNREFUSED"));
		});
	});
}

/**
 * Read the holder pid from a lock file WITHOUT following a symlink and WITHOUT
 * risking a block / OOM (R5 MEDIUM). The predictable lockPath could be
 * pre-planted (by a same-uid sandboxed runner) as a symlink, FIFO, device, or
 * huge file: open O_NOFOLLOW|O_NONBLOCK (refuses a symlink, never blocks on a
 * FIFO), require a small REGULAR file, then read. Any anomaly → undefined
 * (caller treats an unreadable lock as HELD, never reclaims).
 */
function readLockHolderPid(lockPath: string): number | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(
			lockPath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > 4096) return undefined;
		const buf = Buffer.alloc(st.size);
		const n = readSync(fd, buf, 0, st.size, 0);
		const parsed = JSON.parse(buf.subarray(0, n).toString("utf8"));
		return typeof parsed?.pid === "number" ? parsed.pid : undefined;
	} catch {
		return undefined; // ELOOP (symlink), parse error, gone, etc → unknown
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/** Is this pid a live process? (0-signal probe; EPERM means it exists.) */
function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Atomic single-owner lock at `<socket>.lock`. R3 HIGH-1: the lock's content
 * must be published ATOMICALLY — write the PID to a private temp, then
 * `linkSync(temp, lockPath)` (atomic; EEXIST if held). A reader therefore never
 * sees a half-written lock (the empty-file window an `open(O_EXCL)`+`write`
 * would leave). An UNREADABLE / malformed lock is treated as HELD (unknown),
 * never reclaimed — only a readable, provably-DEAD holder is reclaimable.
 * release() only unlinks a lock this process still owns, and is idempotent.
 */
function defaultAcquireDaemonLock(lockPath: string): DaemonLock {
	const publish = (): void => {
		// R4 HIGH: the temp path must be UNPREDICTABLE and created O_EXCL, or a
		// sandboxed runner could pre-plant a symlink at a predictable temp path
		// and redirect this (non-sandboxed) write to overwrite an arbitrary
		// parent-writable file. A random name + "wx" (O_CREAT|O_EXCL|O_WRONLY)
		// refuses a pre-existing file/symlink; the fully-written temp is then
		// atomically published via link.
		const tmp = `${lockPath}.tmp.${randomBytes(8).toString("hex")}`;
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
		} finally {
			closeSync(fd);
		}
		try {
			linkSync(tmp, lockPath); // atomic publish; throws EEXIST if held
		} finally {
			try {
				unlinkSync(tmp);
			} catch {
				/* temp already gone */
			}
		}
	};

	try {
		publish();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// Held — the lock was published via link, so this read is complete.
		// Read it WITHOUT following a symlink / blocking (R5 MEDIUM).
		const holderPid = readLockHolderPid(lockPath);
		// R3 HIGH-1: unreadable → HELD (unknown), do NOT reclaim.
		if (holderPid == null) {
			throw new Error(
				`codex daemon lock ${lockPath} is held (unreadable — refusing to reclaim)`,
			);
		}
		if (defaultIsPidAlive(holderPid)) {
			throw new Error(
				`another codex daemon spawn owns ${lockPath} (pid ${holderPid})`,
			);
		}
		// Provably-dead holder — reclaim: drop the stale lock, re-publish.
		try {
			unlinkSync(lockPath);
		} catch {
			/* raced with another reclaimer */
		}
		try {
			publish();
		} catch (err2) {
			if ((err2 as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(
					`codex daemon lock ${lockPath} was re-acquired concurrently`,
				);
			}
			throw err2;
		}
	}

	let released = false;
	return {
		release: (): void => {
			if (released) return;
			released = true;
			try {
				// only unlink a lock we still own (never another process's), read
				// without following a symlink / blocking (R5 MEDIUM).
				if (readLockHolderPid(lockPath) === process.pid) unlinkSync(lockPath);
			} catch {
				/* already gone / reclaimed by someone else */
			}
		},
	};
}

/**
 * Create the socket dir 0700, or on a pre-existing dir REJECT a symlink / a
 * foreign owner and force 0700. The control socket is unauthenticated, so a
 * dir another user could have pre-planted (world-writable /tmp being the
 * classic vector) must never be trusted.
 */
function defaultEnsureSecureDir(dir: string): void {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(dir);
	} catch {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return;
	}
	if (st.isSymbolicLink()) {
		throw new Error(`refusing daemon socket dir that is a symlink: ${dir}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`daemon socket dir path is not a directory: ${dir}`);
	}
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid != null && st.uid !== uid) {
		throw new Error(
			`refusing daemon socket dir owned by uid ${st.uid} (not ${uid}): ${dir}`,
		);
	}
	// We own it (or the platform has no uids) — strip any group/world bits.
	if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function defaultRemoveStaleSocket(p: string): void {
	try {
		rmSync(p, { force: true });
	} catch {
		/* nothing to remove */
	}
}
