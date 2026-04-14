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
 * Kill a specific tmux window (not the whole session).
 *
 * Takes the full CommDB tmux_window target (e.g. "runner-geoforge3d:@42").
 * Using kill-window preserves other Runners sharing the same session and
 * triggers pane-exited hooks so cmux-sync event-driven cleanup runs.
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
