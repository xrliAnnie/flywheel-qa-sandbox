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
