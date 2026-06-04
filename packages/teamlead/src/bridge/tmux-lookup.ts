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
 * Resolve tmux target from CommDB.
 * Returns undefined if DB missing, session not registered, or on error.
 * Logs real CommDB errors (corruption, lock) — does NOT silently swallow.
 */
export function getTmuxTargetFromCommDb(
	executionId: string,
	projectName: string,
): TmuxTarget | undefined {
	// Path traversal guard (same as session-capture.ts)
	if (/[/\\]|\.\./.test(projectName)) return undefined;

	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	if (!existsSync(dbPath)) return undefined;

	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		const session = db.getSession(executionId);
		if (!session?.tmux_window) return undefined;
		const tw = session.tmux_window;
		const colonIdx = tw.indexOf(":");
		return {
			tmuxWindow: tw,
			sessionName: colonIdx >= 0 ? tw.slice(0, colonIdx) : tw,
		};
	} catch (err) {
		console.error(
			`[tmux-lookup] CommDB read error for ${executionId}: ${(err as Error).message}`,
		);
		return undefined;
	} finally {
		db?.close();
	}
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
 * Returns false on benign errors (session/window not found, no server).
 */
export async function isTmuxWindowAlive(tmuxWindow: string): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["list-panes", "-t", tmuxWindow], {
			timeout: TMUX_TIMEOUT,
		});
		return true;
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (
			msg.includes("session not found") ||
			msg.includes("can't find session") ||
			msg.includes("window not found") ||
			msg.includes("can't find window") ||
			msg.includes("can't find pane") ||
			msg.includes("no server running")
		) {
			return false;
		}
		console.error(`[tmux-lookup] list-panes error: ${msg}`);
		return false;
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
