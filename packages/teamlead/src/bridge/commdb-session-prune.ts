/**
 * FLY-638: CommDB session-registry pruning.
 *
 * `runner_terminal_list` / Lead bootstrap read the per-project CommDB
 * (`~/.flywheel/comm/<project>/comm.db`) `sessions` table and probe tmux
 * liveness; a terminal (completed/timeout) row whose tmux window is gone renders
 * as `class=dead`. These rows are never deleted, so they pile up (~65 observed in
 * production) and pollute the list + bootstrap with stale entries.
 *
 * Two surfaces — mirroring the FLY-324 live-handler + boot-sweep shape:
 *   1. `deleteCommDbSession` — live cleanup. Called from the runner teardown path
 *      (close_runner / terminate / post-merge) once the tmux window is gone, so a
 *      closed runner's row never lingers.
 *   2. `pruneDeadTerminalCommDbSessions` — one-shot boot sweep. Clears the
 *      EXISTING backlog: every terminal row whose tmux window is provably gone.
 *
 * Safety: only terminal (completed/timeout) rows are swept, and only when the
 * tmux probe says the window is gone — a still-alive parked runner's row is left
 * untouched. The path is project-name-guarded (no traversal) and best-effort:
 * any failure logs a warning and is swallowed (a prune must never break a close
 * or block Bridge startup).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	probeTmuxWindowLiveness,
	type TmuxWindowProbe,
} from "./tmux-lookup.js";

/**
 * Resolve a project's comm.db path (matches tmux-lookup.ts's resolution).
 * Returns undefined when the project name is unsafe (path traversal) or the DB
 * file doesn't exist (nothing to prune).
 */
export function resolveCommDbPath(projectName: string): string | undefined {
	if (/[/\\]|\.\./.test(projectName)) return undefined;
	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	return existsSync(dbPath) ? dbPath : undefined;
}

/**
 * Live cleanup: drop a single CommDB session row after its runner has been torn
 * down (tmux gone). Best-effort; never throws. Returns true when a row was
 * removed. `dbPath` is injectable for tests.
 */
export function deleteCommDbSession(
	executionId: string,
	projectName: string,
	dbPath: string | undefined = resolveCommDbPath(projectName),
): boolean {
	if (!dbPath) return false;
	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath);
		return db.deleteSession(executionId) > 0;
	} catch (err) {
		console.warn(
			`[commdb-prune] delete ${executionId} (${projectName}) failed: ${(err as Error).message}`,
		);
		return false;
	} finally {
		db?.close();
	}
}

export interface CommDbPruneResult {
	/** terminal rows examined. */
	scanned: number;
	/** rows deleted (terminal + tmux PROVABLY dead). */
	pruned: number;
	/**
	 * rows KEPT — tmux is alive (parked-alive) OR the probe was indeterminate
	 * (timeout / tmux-missing / EACCES). A destructive delete must require PROOF
	 * of death, never the absence of proof of life.
	 */
	kept: number;
}

/**
 * Boot sweep: delete terminal (completed/timeout) CommDB session rows whose tmux
 * window is **provably** gone. Uses the tri-state `probeTmuxWindowLiveness` (NOT
 * the boolean `isTmuxWindowAlive`, which collapses a transient/indeterminate
 * probe failure into "not alive") so a parked-alive runner whose probe merely
 * timed out is never deleted — only a `dead` verdict deletes (Codex R1 HIGH).
 * Probe + db path are injectable for tests. Best-effort; never throws.
 */
export async function pruneDeadTerminalCommDbSessions(
	projectName: string,
	opts: {
		dbPath?: string;
		probe?: (tmuxWindow: string) => Promise<TmuxWindowProbe>;
	} = {},
): Promise<CommDbPruneResult> {
	const result: CommDbPruneResult = { scanned: 0, pruned: 0, kept: 0 };
	const dbPath = opts.dbPath ?? resolveCommDbPath(projectName);
	if (!dbPath) return result;
	const probe = opts.probe ?? probeTmuxWindowLiveness;

	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath);
		const terminal = db.listSessions(projectName, ["completed", "timeout"]);
		result.scanned = terminal.length;
		for (const s of terminal) {
			// Delete ONLY on a proven-dead window. `alive` (parked) and
			// `indeterminate` (we learned nothing) both keep the row.
			const state = await probe(s.tmux_window);
			if (state !== "dead") {
				result.kept++;
				continue;
			}
			db.deleteSession(s.execution_id);
			result.pruned++;
		}
	} catch (err) {
		console.warn(
			`[commdb-prune] boot sweep ${projectName} failed: ${(err as Error).message}`,
		);
	} finally {
		db?.close();
	}
	return result;
}
