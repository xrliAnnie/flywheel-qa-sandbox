/**
 * GEO-270: Shared tmux target resolution and lifecycle helpers.
 *
 * Used by:
 * - HeartbeatService.checkStaleCompleted() (detection)
 * - POST /api/sessions/:id/close-tmux (close)
 *
 * Source of truth: CommDB tmux_window (not StateStore.tmux_session,
 * which is unreliably populated in production).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CommDB } from "flywheel-comm/db";

const execFileAsync = promisify(execFile);
const TMUX_TIMEOUT = 5000;

export interface TmuxTarget {
	/** Full CommDB tmux_window value (e.g. "GEO-208:@0") */
	tmuxWindow: string;
	/** Parsed session name (e.g. "GEO-208") */
	sessionName: string;
}

/**
 * FLY-560 Feature C: a resolved attach target for the founder's pinned
 * `tmux attach` rescue command.
 *  - `cmux`: the per-runner cmux linked session `cmux-<window_name>` — lands
 *    exactly on that runner's window, isolated from the shared base session,
 *    and its name is stable across runner restarts (window_name = issueId +
 *    runner + title; only the `@id` changes). Preferred.
 *  - `base`: degraded fallback when the cmux linked session can't be resolved
 *    (cmux not running / probe indeterminate) — attach the shared base session
 *    and `select-window` to the exact window id.
 */
export interface AttachTarget {
	kind: "cmux" | "base";
	/** Session name to attach to (cmux linked session, or base session). */
	session: string;
	/** Full `base:@id` window target — only set/used for the base fallback. */
	tmuxWindow?: string;
	/**
	 * FLY-907 (Step 3): the live `#{window_name}` read during resolution, when
	 * available (undefined when display-message failed). Callers use it to
	 * verify the window actually belongs to the issue being rendered
	 * (`buildWindowLabel` = `<identifier>-<runner>-<title>`, FLY-272) before
	 * rendering the attach command — a cross-wired CommDB row (FLY-543/923)
	 * must degrade, never render a link into another issue's window.
	 */
	windowName?: string;
}

/** Test seam: run a tmux subcommand and return its stdout. */
export type TmuxRunner = (args: string[]) => Promise<{ stdout: string }>;

const defaultTmuxRunner: TmuxRunner = (args) =>
	execFileAsync("tmux", args, { timeout: TMUX_TIMEOUT });

/**
 * FLY-560 Feature C: resolve the best `tmux attach` target for a runner's
 * window. Reads the live tmux server: get the window's `window_name`, build the
 * cmux linked-session name `cmux-<window_name>`, and verify it exists with an
 * EXACT (`=`) match (cmux-sync's own convention — avoids prefix-match attaching
 * to the wrong session). Any failure (display-message error, cmux session
 * absent, probe timeout) degrades to the base-session fallback, which always
 * works. Never throws.
 */
export async function resolveCmuxAttachTarget(
	tmuxWindow: string,
	runTmux: TmuxRunner = defaultTmuxRunner,
): Promise<AttachTarget> {
	const colonIdx = tmuxWindow.indexOf(":");
	const baseSession =
		colonIdx >= 0 ? tmuxWindow.slice(0, colonIdx) : tmuxWindow;
	try {
		const { stdout } = await runTmux([
			"display-message",
			"-p",
			"-t",
			tmuxWindow,
			"#{window_name}",
		]);
		const windowName = stdout.trim();
		if (windowName) {
			const cmuxSession = `cmux-${windowName}`;
			try {
				// Exact-match probe — `=` prevents fnmatch/prefix resolution.
				await runTmux(["has-session", "-t", `=${cmuxSession}`]);
				return { kind: "cmux", session: cmuxSession, windowName };
			} catch {
				// cmux session absent or probe failed — fall through to base.
			}
			return { kind: "base", session: baseSession, tmuxWindow, windowName };
		}
	} catch {
		// display-message failed (window gone / tmux missing) — base fallback.
	}
	return { kind: "base", session: baseSession, tmuxWindow };
}

/** FLY-560 Feature C: options for rendering the attach command. */
export interface AttachCommandOpts {
	/**
	 * Machine-aware extension point (multi-machine future, NOT used in
	 * single-machine mode): when set, the local command is wrapped as
	 * `ssh <sshHost> -t '<local cmd>'` so Annie can attach to a runner on a
	 * different host (e.g. over Tailscale). The session lives on the runner's
	 * machine; cross-machine attach needs the machine identity. Left unset today.
	 */
	sshHost?: string;
}

/**
 * FLY-560 Feature C: render the copy-pasteable `tmux attach` command for a
 * resolved target. Uses EXACT (`=`) tmux targets (matches cmux-sync) so a
 * prefix collision can never attach Annie to the wrong session. Structured as
 * `<optional ssh prefix> + tmux attach …` for the machine-aware future.
 */
export function buildAttachCommand(
	target: AttachTarget,
	opts: AttachCommandOpts = {},
): string {
	let cmd: string;
	// FLY-756: prefix `env -u TMUX` so this rescue command attaches cleanly even
	// when pasted into a shell that has `$TMUX` set — exactly the cmux dead
	// surface the founder copies it into. Without it, `tmux attach` refuses with
	// "sessions should be nested with care, unset $TMUX" (tmux keys nesting off
	// `$TMUX`). Same nested-attach failure mode as the cmux-sync heal/create
	// injection sites hardened in scripts/flywheel-cmux-sync.sh.
	if (target.kind === "cmux") {
		cmd = `env -u TMUX tmux attach -t '=${target.session}'`;
	} else {
		// Degraded fallback: attach the shared base session, then jump to the
		// exact window. NOTE: changes the base session's active window for any
		// client attached directly to it (cmux uses linked sessions, so normally
		// unaffected). The `\;` separates tmux commands at the shell.
		cmd = `env -u TMUX tmux attach -t '=${target.session}' \\; select-window -t '=${target.tmuxWindow}'`;
	}
	if (opts.sshHost) {
		const escaped = cmd.replace(/'/g, "'\\''");
		cmd = `ssh ${opts.sshHost} -t '${escaped}'`;
	}
	return cmd;
}

/**
 * FLY-228 (Codex code-review MED-3): discriminated tmux-target lookup.
 *   - `found`: target resolved.
 *   - `gone`:  DB missing / session not registered / no tmux_window → there is
 *              genuinely nothing to clean up (callers treat as cleanup success).
 *   - `error`: CommDB READ error (corruption / lock) → we could NOT determine
 *              whether tmux is alive; callers must treat this as cleanup-pending
 *              (never report unqualified success while the process may be live).
 */
export type TmuxTargetLookup =
	| { kind: "found"; target: TmuxTarget }
	| { kind: "gone" }
	| { kind: "error"; error: string };

export function lookupTmuxTarget(
	executionId: string,
	projectName: string,
): TmuxTargetLookup {
	// Path traversal guard (same as session-capture.ts) — an invalid project
	// name means there is nothing we can/should clean up.
	if (/[/\\]|\.\./.test(projectName)) return { kind: "gone" };

	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	if (!existsSync(dbPath)) return { kind: "gone" };

	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		const session = db.getSession(executionId);
		if (!session?.tmux_window) return { kind: "gone" };
		const tw = session.tmux_window;
		const colonIdx = tw.indexOf(":");
		return {
			kind: "found",
			target: {
				tmuxWindow: tw,
				sessionName: colonIdx >= 0 ? tw.slice(0, colonIdx) : tw,
			},
		};
	} catch (err) {
		const msg = (err as Error).message;
		console.error(`[tmux-lookup] CommDB read error for ${executionId}: ${msg}`);
		return { kind: "error", error: msg };
	} finally {
		db?.close();
	}
}

/**
 * Resolve tmux target from CommDB.
 * Returns undefined if DB missing, session not registered, or on error.
 * Logs real CommDB errors (corruption, lock) — does NOT silently swallow.
 *
 * NOTE: collapses `gone` and `error` to `undefined`. Callers that must
 * distinguish a CommDB read error from "already gone" (e.g. terminate's
 * observable partial-failure contract) should use `lookupTmuxTarget` directly.
 */
export function getTmuxTargetFromCommDb(
	executionId: string,
	projectName: string,
): TmuxTarget | undefined {
	const r = lookupTmuxTarget(executionId, projectName);
	return r.kind === "found" ? r.target : undefined;
}

/**
 * Check if a tmux session is alive.
 * Returns false on benign errors (no server, session not found).
 * Logs real errors (ENOENT, EACCES, timeout).
 */
export async function isTmuxSessionAlive(
	sessionName: string,
): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["has-session", "-t", `=${sessionName}`], {
			timeout: TMUX_TIMEOUT,
		});
		return true;
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (
			msg.includes("session not found") ||
			msg.includes("can't find session") ||
			msg.includes("no server running")
		) {
			return false;
		}
		console.error(`[tmux-lookup] has-session error: ${msg}`);
		return false;
	}
}

/**
 * A tmux error message that PROVES the window/session is genuinely absent — as
 * opposed to a transient failure (timeout / ENOENT / EACCES) where we learned
 * nothing. Shared by the boolean `isTmuxWindowAlive` and the tri-state
 * `probeTmuxWindowLiveness` so they agree on what "provably dead" means.
 */
function isTmuxAbsenceMessage(msg: string): boolean {
	return (
		msg.includes("session not found") ||
		msg.includes("can't find session") ||
		msg.includes("window not found") ||
		msg.includes("can't find window") ||
		msg.includes("can't find pane") ||
		msg.includes("no server running")
	);
}

/**
 * FLY-1082 (Task 2.3): SERVER-level tri-state probe — is the default tmux
 * server (the one hosting every runner) alive at all?
 *   - "up"      — `list-sessions` succeeded (a serving tmux server exists;
 *                 note tmux exits when its last session closes, so "down" is
 *                 also the NORMAL zero-runner state — the server-loss
 *                 coordinator only treats it as a loss while StateStore still
 *                 holds running tmux sessions);
 *   - "down"    — tmux PROVED "no server running";
 *   - "unknown" — timeout / ENOENT / any other error (never treated as loss).
 */
export async function probeTmuxServer(
	runTmux: TmuxRunner = defaultTmuxRunner,
): Promise<"up" | "down" | "unknown"> {
	try {
		await runTmux(["list-sessions"]);
		return "up";
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (msg.includes("no server running")) return "down";
		return "unknown";
	}
}

/**
 * Tri-state per-window liveness (FLY-245 D2, Codex code-review R1 HIGH-4):
 *   - `alive`         — `list-panes` succeeded;
 *   - `dead`          — tmux PROVED the window/session is absent;
 *   - `indeterminate` — timeout / ENOENT (tmux missing) / EACCES / any other
 *                       error: we could NOT determine liveness.
 *
 * The retry-recovery path (started-evidence.ts) MUST distinguish `dead` from
 * `indeterminate`: a transient probe failure read as "dead" would re-dispatch a
 * second Runner for a non-idempotent retry. The legacy boolean
 * `isTmuxWindowAlive` collapses both into `false` and is kept for callers whose
 * existing semantics already treat "not provably alive" conservatively.
 */
export type TmuxWindowProbe = "alive" | "dead" | "indeterminate";

export async function probeTmuxWindowLiveness(
	tmuxWindow: string,
): Promise<TmuxWindowProbe> {
	try {
		await execFileAsync("tmux", ["list-panes", "-t", tmuxWindow], {
			timeout: TMUX_TIMEOUT,
		});
		return "alive";
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (isTmuxAbsenceMessage(msg)) return "dead";
		console.error(
			`[tmux-lookup] list-panes INDETERMINATE (fail-closed for retry recovery): ${msg}`,
		);
		return "indeterminate";
	}
}

/**
 * Check if a specific tmux window is alive.
 *
 * Takes the full CommDB tmux_window target (e.g. "runner-geoforge3d:@42")
 * and verifies the window still exists via `list-panes -t <sessionName:@id>`.
 *
 * Under the shared-session model (FLY-102 PR #146) `isTmuxSessionAlive` is
 * too coarse: it returns true whenever any sibling Runner keeps the session
 * alive, leading to false "still alive" reports for windows that have been
 * closed via `kill-window`. Use this helper for per-execution liveness.
 *
 * Returns false on benign errors (session/window not found, no server). For the
 * retry-recovery path that must NOT confuse a transient failure with "dead",
 * use `probeTmuxWindowLiveness` instead.
 */
export async function isTmuxWindowAlive(tmuxWindow: string): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["list-panes", "-t", tmuxWindow], {
			timeout: TMUX_TIMEOUT,
		});
		return true;
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (isTmuxAbsenceMessage(msg)) {
			return false;
		}
		console.error(`[tmux-lookup] list-panes error: ${msg}`);
		return false;
	}
}

/**
 * FLY-720: 4-state per-runner PROCESS liveness (as opposed to window existence).
 *
 * Under cmux `remain-on-exit on` (see scripts/flywheel-cmux-sync.sh) a crashed
 * Runner's tmux window PERSISTS with a dead `[exited]` pane (the FLY-622
 * dead-pin). `isTmuxWindowAlive` / `probeTmuxWindowLiveness` only test window
 * existence via `list-panes` success, so they read that corpse as alive — which
 * is exactly why the FLY-623 heartbeat readopt loop re-adopts a crashed Runner
 * forever and it never gets reaped. This probe reads `#{pane_dead}` on each pane
 * to distinguish a dead process (window still there) from window absence:
 *   - `alive`         — `list-panes` succeeded and ≥1 pane is live (`pane_dead=0`);
 *   - `dead_pin`      — `list-panes` succeeded, ≥1 pane, and EVERY pane is dead
 *                       (`pane_dead=1`): window EXISTS, process is a corpse;
 *   - `absent`        — tmux PROVED the window/session/server is gone (NOT a
 *                       dead-pin) — left to the existing `reapOrphans → failed`
 *                       orphan path, not the crash reaper;
 *   - `indeterminate` — timeout / ENOENT / EACCES / unparseable: could NOT
 *                       determine liveness → caller treats as alive-for-suppression
 *                       (never reap), GEO-374 guard.
 *
 * The `TmuxRunner` seam keeps it unit-testable without a real tmux server.
 */
export type RunnerLiveness = "alive" | "dead_pin" | "absent" | "indeterminate";

export async function probeRunnerProcessLiveness(
	tmuxWindow: string,
	runTmux: TmuxRunner = defaultTmuxRunner,
): Promise<RunnerLiveness> {
	let stdout: string;
	try {
		({ stdout } = await runTmux([
			"list-panes",
			"-t",
			tmuxWindow,
			"-F",
			"#{pane_dead}",
		]));
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (isTmuxAbsenceMessage(msg)) return "absent";
		console.error(
			`[tmux-lookup] pane-dead probe INDETERMINATE (fail-closed): ${msg}`,
		);
		return "indeterminate";
	}
	const panes = stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	// No panes parsed (empty output) — we learned nothing definitive.
	if (panes.length === 0) return "indeterminate";
	// Every pane is a remain-on-exit corpse → the Runner process is dead while
	// the window still exists. Any live pane → alive.
	return panes.every((p) => p === "1") ? "dead_pin" : "alive";
}

/**
 * FLY-720: capture a runner window's scrollback (crash forensics) BEFORE the
 * crash reaper tears the window down. `-p` prints to stdout, `-S -` starts at
 * the beginning of history. Runner windows are single-pane (one claude/codex
 * process) — the window target captures that pane. Best-effort: returns the
 * error text instead of throwing so the reaper can record it and still reap.
 */
export async function captureRunnerScrollback(
	tmuxWindow: string,
	runTmux: TmuxRunner = defaultTmuxRunner,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	try {
		const { stdout } = await runTmux([
			"capture-pane",
			"-t",
			tmuxWindow,
			"-p",
			"-S",
			"-",
		]);
		return { ok: true, text: stdout };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		return { ok: false, error: msg };
	}
}

/**
 * FLY-195: type a literal line of text into a tmux window and press Enter.
 *
 * Used ONLY by the restricted recovery-nudge endpoint (plan §3.5) — the text
 * it sends is allowlist-gated upstream; this helper just performs the
 * keystroke delivery. `-l` sends the text literally (no key-name expansion)
 * and `--` guards a leading dash. Enter is sent as a second send-keys, the
 * same pattern TrustPromptHandler uses against the Claude Code TUI.
 */
export async function sendKeysToWindow(
	tmuxWindow: string,
	text: string,
): Promise<{ sent: boolean; error?: string }> {
	try {
		await execFileAsync(
			"tmux",
			["send-keys", "-t", tmuxWindow, "-l", "--", text],
			{ timeout: TMUX_TIMEOUT },
		);
		await execFileAsync("tmux", ["send-keys", "-t", tmuxWindow, "Enter"], {
			timeout: TMUX_TIMEOUT,
		});
		return { sent: true };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		console.error(`[tmux-lookup] send-keys error: ${msg}`);
		return { sent: false, error: msg };
	}
}

/**
 * FLY-368: send a bare Enter to a tmux window (no text typed first).
 *
 * Used ONLY by the auto-repair bot's Lead resume-menu unstick — accepting the
 * "Resume from summary (recommended)" default is a single Enter, NOT a typed
 * phrase, so `sendKeysToWindow` (which types text THEN Enter) is the wrong tool.
 * The caller gates this behind `isSafeResumeMenuForEnter` + a durable
 * audit-before-send (lead-resume-enter.ts).
 */
export async function sendEnterToWindow(
	tmuxWindow: string,
): Promise<{ sent: boolean; error?: string }> {
	try {
		await execFileAsync("tmux", ["send-keys", "-t", tmuxWindow, "Enter"], {
			timeout: TMUX_TIMEOUT,
		});
		return { sent: true };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		console.error(`[tmux-lookup] send-enter error: ${msg}`);
		return { sent: false, error: msg };
	}
}

/**
 * Kill a specific tmux window (not the whole session).
 *
 * Takes the full CommDB tmux_window target (e.g. "runner-geoforge3d:@42").
 * Using kill-window preserves other Runners sharing the same session.
 *
 * cmux-sync cleanup is signaled by `pane-died` (registered globally —
 * see scripts/flywheel-cmux-sync.sh::register_global_hooks) when a
 * `remain-on-exit on` pane's process exits — that fires before this
 * kill-window call and is what actually drives the event-driven cleanup
 * path. kill-window itself just closes the now-dead window; tmux 3.5a
 * does not reliably emit a second hook for kill-window on an already-dead
 * pane, and the cleanup is already queued by then.
 *
 * Distinguishes benign (already dead) from real errors.
 */
export async function killTmuxWindow(
	tmuxWindow: string,
): Promise<{ killed: boolean; error?: string }> {
	try {
		await execFileAsync("tmux", ["kill-window", "-t", tmuxWindow], {
			timeout: TMUX_TIMEOUT,
		});
		return { killed: true };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (
			msg.includes("window not found") ||
			msg.includes("can't find window") ||
			msg.includes("can't find pane") ||
			msg.includes("session not found") ||
			msg.includes("can't find session") ||
			msg.includes("no server running")
		) {
			return { killed: true }; // already dead = success
		}
		console.error(`[tmux-lookup] kill-window error: ${msg}`);
		return { killed: false, error: msg };
	}
}

/**
 * FLY-638: kill the per-runner cmux LINKED session (`cmux-<window_name>`).
 *
 * cmux-sync creates a linked session named `cmux-<window_name>` for each runner
 * window so the founder can watch it as its own cmux tab. `killTmuxWindow` (a
 * `kill-window` on the shared base session) removes the window, but the linked
 * cmux session keeps a client attached and lingers — accumulating stale
 * `cmux-FLY-X-…` tabs in the founder's cmux UI (the gap FLY-638 fixes).
 *
 * Resolve the window's `window_name` and kill the matching cmux session by EXACT
 * (`=`) name (cmux-sync's own convention — avoids fnmatch/prefix-matching the
 * wrong session). MUST run while the window is still alive (i.e. BEFORE
 * `killTmuxWindow`) so `display-message` can read the name.
 *
 * `kill-session` on the linked cmux session does NOT take down the window in the
 * shared base session — the window is still linked there and is closed
 * separately by `killTmuxWindow`. Best-effort: a missing window / cmux session /
 * tmux server is benign success. Never throws.
 */
export async function killCmuxLinkedSession(
	tmuxWindow: string,
	runTmux: TmuxRunner = defaultTmuxRunner,
): Promise<{ killed: boolean; cmuxSession?: string; error?: string }> {
	let windowName: string;
	try {
		const { stdout } = await runTmux([
			"display-message",
			"-p",
			"-t",
			tmuxWindow,
			"#{window_name}",
		]);
		windowName = stdout.trim();
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		// Window already gone → its linked cmux session is gone too. Benign.
		if (isTmuxAbsenceMessage(msg)) return { killed: true };
		console.error(`[tmux-lookup] cmux display-message error: ${msg}`);
		return { killed: false, error: msg };
	}
	if (!windowName) return { killed: true }; // nothing resolved → nothing to kill
	const cmuxSession = `cmux-${windowName}`;
	try {
		await runTmux(["kill-session", "-t", `=${cmuxSession}`]);
		return { killed: true, cmuxSession };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (isTmuxAbsenceMessage(msg)) return { killed: true, cmuxSession }; // already gone
		console.error(`[tmux-lookup] cmux kill-session error: ${msg}`);
		return { killed: false, cmuxSession, error: msg };
	}
}
