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

import { spawnSync } from "node:child_process";

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/; // absolute paths, no quotes/spaces/metachars
const SAFE_ID = /^[A-Za-z0-9-]+$/; // thread ids are UUID-shaped
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/; // tmux session/window names

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
export type RunnerTuiWindowOutcome =
	| { created: true }
	| { created: false; reason: "tmux-absent" | "create-failed" | "died" };

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
	if (spec.codexBin) assertShellSafe("codexBin", spec.codexBin, SAFE_PATH);
	const bin = spec.codexBin ?? "codex";
	return [
		`CODEX_HOME="${spec.codexHome}"`,
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
}

function defaultExec(cmd: string, args: string[]): { ok: boolean } {
	try {
		const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000 });
		return { ok: r.status === 0 };
	} catch {
		return { ok: false };
	}
}

function defaultExecOut(cmd: string, args: string[]): string | undefined {
	try {
		const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000 });
		return r.status === 0 ? r.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Synchronous sleep — this whole module is sync (it is a chain of spawnSync
 * tmux calls on the runner-start path), so the settle must be too. */
function defaultSleep(ms: number): void {
	if (ms <= 0) return;
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		/* SharedArrayBuffer unavailable — skip the settle rather than throw */
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

/**
 * FLY-1239: PROVABLE stale cleanup before creation. tmux permits DUPLICATE
 * window names, and the old `kill-window -t =sess:=name` (result ignored)
 * against an ambiguous match fails and leaves a corpse — so a retry would pile
 * a second same-named window on top (the founder-facing "row of dead tabs" the
 * Lead forbids). Instead: enumerate the session's windows, kill every EXACT-name
 * match by IMMUTABLE window id, then re-ensure the session (killing a session's
 * LAST window destroys it — tmux sessions cannot hold zero windows), and VERIFY
 * no same-name window remains before the caller creates. Returns true only when
 * the session is PROVABLY free of same-name windows. Any inability to prove that
 * (a failed listing) returns false → the caller must NOT create (fail-open: the
 * machine run continues, the founder just misses the pane this attempt).
 */
function purgeSameNameWindows(
	spec: Pick<RunnerTuiWindowSpec, "tmuxSession" | "windowName">,
	exec: (cmd: string, args: string[]) => { ok: boolean },
	execOut: (cmd: string, args: string[]) => string | undefined,
): boolean {
	const sessionTarget = `=${spec.tmuxSession}`;
	const listWindows = (): Array<{ id: string; name: string }> | undefined => {
		const out = execOut("tmux", [
			"list-windows",
			"-t",
			sessionTarget,
			"-F",
			"#{window_id} #{window_name}",
		]);
		if (out === undefined) return undefined; // listing failed (e.g. no server / session gone)
		if (out === "") return [];
		return out.split("\n").map((line) => {
			// window_id is `@N` (no spaces); the name may contain spaces, so split
			// on the FIRST space only and keep the remainder as the name.
			const sp = line.indexOf(" ");
			return sp < 0
				? { id: line, name: "" }
				: { id: line.slice(0, sp), name: line.slice(sp + 1) };
		});
	};

	const before = listWindows();
	if (before === undefined) return false; // cannot enumerate → cannot prove clean
	for (const w of before) {
		if (w.name === spec.windowName) {
			exec("tmux", ["kill-window", "-t", w.id]); // kill by immutable id (no ambiguity)
		}
	}
	// Killing a session's LAST window destroys the session — re-ensure it. A no-op
	// if it survived; recreates the session (with a DIFFERENT-named scaffold window)
	// if the purge emptied it, so the verify listing below can still run.
	exec("tmux", ["new-session", "-Ad", "-s", spec.tmuxSession]);
	const after = listWindows();
	if (after === undefined) return false; // verify listing failed → cannot prove clean
	return !after.some((w) => w.name === spec.windowName);
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
): RunnerTuiWindowOutcome {
	const exec = deps.exec ?? defaultExec;
	const execOut = deps.execOut ?? defaultExecOut;
	assertShellSafe("tmuxSession", spec.tmuxSession, SAFE_NAME);
	assertShellSafe("windowName", spec.windowName, SAFE_NAME);
	try {
		if (!exec("tmux", ["-V"]).ok) {
			safeLog(
				deps.log,
				`runner-tui-window: tmux unavailable — skipping (${spec.windowName})`,
			);
			return { created: false, reason: "tmux-absent" };
		}
		exec("tmux", ["new-session", "-Ad", "-s", spec.tmuxSession]);
		// FLY-1239: prove no stale/duplicate same-named window remains before create.
		if (!purgeSameNameWindows(spec, exec, execOut)) {
			safeLog(
				deps.log,
				`runner-tui-window: could not prove the session is free of stale '${spec.windowName}' windows — skipping create this attempt (non-fatal, run unaffected)`,
			);
			return { created: false, reason: "create-failed" };
		}
		const created = exec("tmux", [
			"new-window",
			"-d",
			"-t",
			`=${spec.tmuxSession}`,
			"-n",
			spec.windowName,
			buildRunnerTuiCommand(spec),
		]);
		if (!created.ok) {
			safeLog(
				deps.log,
				`runner-tui-window: create failed (non-fatal, run unaffected): ${spec.windowName}`,
			);
			return { created: false, reason: "create-failed" };
		}
		// QA · FLY-1188 — PROVE it. `tmux new-window` reports success as soon as it
		// forks the shell, so it says "ok" even for a command that dies 200ms later
		// (the shipped TUI died instantly on `stdout is not a terminal`). Claiming
		// "founder TUI up" on that is how an EMPTY cmux tab — the founder's original
		// symptom — stayed invisible to the mocks AND to the operator. Let it settle,
		// then ask tmux whether the pane is actually still there.
		(deps.sleep ?? defaultSleep)(deps.settleMs ?? 800);
		if (!isRunnerTuiWindowAlive(spec, { execOut: deps.execOut })) {
			safeLog(
				deps.log,
				`runner-tui-window: founder TUI DIED immediately (${spec.windowName}) — the pane is gone right after tmux reported success (most likely the FLY-1239 rollout-landing race: 'no rollout found'). The run continues (the machine client drives the goal) but the founder CANNOT WATCH it. Inspect by hand: ${buildRunnerTuiCommand(spec)}`,
			);
			return { created: false, reason: "died" };
		}
		safeLog(
			deps.log,
			`runner-tui-window: founder TUI up (${spec.windowName}, thread ${spec.threadId})`,
		);
		return { created: true };
	} catch (err) {
		safeLog(
			deps.log,
			`runner-tui-window: ensure failed (non-fatal): ${errMessage(err)}`,
		);
		return { created: false, reason: "create-failed" };
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
	spec: Pick<RunnerTuiWindowSpec, "tmuxSession" | "windowName">,
	deps: RunnerTuiWindowDeps = {},
): void {
	const exec = deps.exec ?? defaultExec;
	try {
		const r = exec("tmux", [
			"kill-window",
			"-t",
			`=${spec.tmuxSession}:=${spec.windowName}`,
		]);
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
