/**
 * FLY-259 PR-C — tui-window: ensure the founder-facing tmux window running the
 * REAL interactive `codex resume --remote` TUI against the Lead's shared
 * remote-control daemon.
 *
 * Shape adapted from FLY-242 #249's `ensureObserverWindow` (that PR is HELD/
 * superseded — the window-lifecycle learnings carry over, the renderer does
 * not): tmux probe → ensure session → UNCONDITIONAL same-named stale-kill
 * (the dead-pane cure must not depend on any opt-out — FLY-242 R1 MED-3) →
 * create the window. Window name is EXACTLY `<project>-<leadId>` (FLY-169
 * MANAGED-title hard contract; backend info never goes into the title).
 *
 * The TUI command carries the R4 HIGH-4 command-line layer of the multi-pin:
 * `-s read-only` + `-c approval_policy="never"` explicitly on EVERY launch —
 * config.toml (codex-lead-tui-home.sh) and the sidecar's thread-params re-pin
 * are the other layers. `-C <cwd>` kills the resume cwd-menu; the trusted
 * project entry in config.toml kills the trust-menu (both spike-verified —
 * zero boot menus).
 *
 * Observation only + fail-open: ensure failures cost visibility, never the
 * Lead (the sidecar keeps serving Discord; it re-ensures on its own cadence —
 * PR-D). All side effects injected for tests.
 */

import { spawnSync } from "node:child_process";

export const TUI_TMUX_SESSION = "flywheel";

export interface TuiWindowSpec {
	projectName: string;
	leadId: string;
	/** The Lead's isolated CODEX_HOME (daemon socket + auth + pins live here). */
	codexHome: string;
	/** Thread the TUI must resume (created/owned by the sidecar — machine
	 * thread/start is the mainline; SP-3 discovery is fallback knowledge only). */
	threadId: string;
	/** Working directory for the TUI (`-C` — kills the resume cwd menu). */
	cwd: string;
	/** codex binary (default "codex"). */
	codexBin?: string;
	/** FLY-398: when true (a windowed FULL-ACCESS TUI Lead, = Claude-equal), the
	 * founder TUI must share the thread's `workspace-write` sandbox, so emit
	 * `-s workspace-write` instead of the `-s read-only` pin (pin ③ of the five-pin
	 * flip). Default/undefined keeps the `-s read-only` companion pin. */
	fullAccess?: boolean;
}

/** The command string is executed by tmux via a shell — every interpolated
 * value is system-derived config (launcher env / sidecar), NOT user input,
 * but we validate at the boundary anyway (Non-Negotiable): a value that
 * could break out of its quoting is a config error → throw (fail-loud). */
function assertShellSafe(name: string, value: string, re: RegExp): string {
	if (!re.test(value)) {
		throw new Error(
			`tui-window: ${name} contains characters unsafe for the tmux shell command: ${JSON.stringify(value)}`,
		);
	}
	return value;
}
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/; // absolute paths, no quotes/spaces/metachars
const SAFE_ID = /^[A-Za-z0-9-]+$/; // thread ids are UUID-shaped
const SAFE_BIN = /^[A-Za-z0-9_./-]+$/;

/** Build the exact TUI command line (pure — unit-testable; quoted for the
 * shell tmux spawns). The remote socket path is derived from codexHome. */
export function buildTuiCommand(spec: TuiWindowSpec): string {
	assertShellSafe("codexHome", spec.codexHome, SAFE_PATH);
	assertShellSafe("cwd", spec.cwd, SAFE_PATH);
	assertShellSafe("threadId", spec.threadId, SAFE_ID);
	if (spec.codexBin) assertShellSafe("codexBin", spec.codexBin, SAFE_BIN);
	const bin = spec.codexBin ?? "codex";
	const sock = `${spec.codexHome}/app-server-control/app-server-control.sock`;
	return [
		`CODEX_HOME="${spec.codexHome}"`,
		bin,
		"resume",
		`--remote "unix://${sock}"`,
		`-C "${spec.cwd}"`,
		// R4 HIGH-4 command-line pin layer (config.toml + thread params are the others).
		// FLY-398 (pin ③): a windowed FULL-ACCESS TUI Lead shares the thread's
		// workspace-write sandbox → emit `-s workspace-write` so the founder TUI client
		// matches the daemon/sidecar (a `-s read-only` here would downgrade the founder
		// pane below the thread's actual sandbox).
		...(spec.fullAccess ? ["-s workspace-write"] : ["-s read-only"]),
		`-c 'approval_policy="never"'`,
		spec.threadId,
	].join(" ");
}

export interface EnsureTuiWindowDeps {
	exec?: (cmd: string, args: string[]) => { ok: boolean };
	log?: (m: string) => void;
}

function defaultExec(cmd: string, args: string[]): { ok: boolean } {
	try {
		const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000 });
		return { ok: r.status === 0 };
	} catch {
		return { ok: false };
	}
}

/**
 * Ensure the TUI window. Returns true when the window was (re)created.
 * Steps (each fail-open):
 *   1. `tmux -V` probe — absent → skip all (headless box: Lead still serves
 *      Discord, only the terminal view is missing).
 *   2. ensure shared session (idempotent attach-or-create).
 *   3. UNCONDITIONAL stale-kill of `<project>-<leadId>` (old Claude dead pane
 *      from a backend switch / a previous TUI's remains).
 *   4. create the window running the real TUI.
 */
export function ensureTuiWindow(
	spec: TuiWindowSpec,
	deps: EnsureTuiWindowDeps = {},
): boolean {
	const exec = deps.exec ?? defaultExec;
	const log = deps.log ?? (() => {});
	const windowName = `${spec.projectName}-${spec.leadId}`;
	try {
		if (!exec("tmux", ["-V"]).ok) {
			log(`tui-window: tmux unavailable — skipping (${windowName})`);
			return false;
		}
		exec("tmux", ["new-session", "-Ad", "-s", TUI_TMUX_SESSION]);
		exec("tmux", ["kill-window", "-t", `=${TUI_TMUX_SESSION}:=${windowName}`]);
		const created = exec("tmux", [
			"new-window",
			"-d",
			"-t",
			`=${TUI_TMUX_SESSION}`,
			"-n",
			windowName,
			buildTuiCommand(spec),
		]);
		if (!created.ok) {
			log(
				`tui-window: create failed (non-fatal, Lead unaffected): ${windowName}`,
			);
			return false;
		}
		log(`tui-window: real TUI up (${windowName}, thread ${spec.threadId})`);
		return true;
	} catch (err) {
		log(`tui-window: ensure failed (non-fatal): ${(err as Error).message}`);
		return false;
	}
}

/** ID-scoped liveness probe for the TUI window (PR-D's death-detection input;
 * identity-echo defends against tmux resolving a missing target to the
 * session's current window — FLY-242 #248 real-tmux smoke finding). */
export function isTuiWindowAlive(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId">,
	deps: {
		execOut?: (cmd: string, args: string[]) => string | undefined;
	} = {},
): boolean {
	const windowName = `${spec.projectName}-${spec.leadId}`;
	const execOut =
		deps.execOut ??
		((cmd: string, args: string[]) => {
			try {
				const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000 });
				return r.status === 0 ? r.stdout.trim() : undefined;
			} catch {
				return undefined;
			}
		});
	const out = execOut("tmux", [
		"display-message",
		"-p",
		"-t",
		`=${TUI_TMUX_SESSION}:=${windowName}`,
		"#{window_name} #{pane_dead}",
	]);
	return out === `${windowName} 0`;
}

/**
 * Explicitly tear down the TUI window (FLY-259 PR-D review HIGH-1: on generation
 * stop / runtime shutdown the founder's `codex resume --remote` window must be
 * killed — leaving it alive orphans a TUI pointing at a dead daemon socket and
 * violates the cutover "stop the sidecar/TUI first" contract). Targets the same
 * `=session:=window` selector ensureTuiWindow creates; fail-open (never throws —
 * a missing window is already the goal state).
 */
export function killTuiWindow(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId">,
	deps: EnsureTuiWindowDeps = {},
): void {
	const exec = deps.exec ?? defaultExec;
	const log = deps.log ?? (() => {});
	const windowName = `${spec.projectName}-${spec.leadId}`;
	try {
		exec("tmux", ["kill-window", "-t", `=${TUI_TMUX_SESSION}:=${windowName}`]);
		log(`tui-window: killed (${windowName})`);
	} catch (err) {
		log(`tui-window: kill failed (non-fatal): ${(err as Error).message}`);
	}
}
