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
 *   1. `finalizeCommDbSession` — live cleanup. Atomically retires unresolved
 *      gates and deletes the session once the tmux window is gone.
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
import { CommDB } from "flywheel-comm/db";
import { commDbPathForProject } from "./commdb-path.js";
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
	const dbPath = commDbPathForProject(projectName);
	return existsSync(dbPath) ? dbPath : undefined;
}

/**
 * Live cleanup: atomically retire one runner's unresolved gates and session
 * after teardown. Best-effort; never throws. `dbPath` is injectable for tests.
 */
export interface FinalizeCommDbResult {
	ok: boolean;
	outcome: "finalized" | "no_db" | "failed";
	retiredGateCount: number;
	deletedSessionCount: number;
	error?: string;
}

export function finalizeCommDbSession(
	executionId: string,
	projectName: string,
	dbPath: string | undefined = resolveCommDbPath(projectName),
): FinalizeCommDbResult {
	if (!dbPath) {
		return {
			ok: true,
			outcome: "no_db",
			retiredGateCount: 0,
			deletedSessionCount: 0,
		};
	}
	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath, false);
		const result = db.finalizeSession(executionId);
		return {
			ok: true,
			outcome: "finalized",
			retiredGateCount: result.retiredQuestionCount,
			deletedSessionCount: result.deletedSessionCount,
		};
	} catch (err) {
		console.warn(
			`[commdb-prune] finalize ${executionId} (${projectName}) failed: ${(err as Error).message}`,
		);
		return {
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			deletedSessionCount: 0,
			error: (err as Error).message,
		};
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
	/** proven-dead rows whose atomic gate+session finalization failed. */
	failed: number;
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
		onFinalizeOutcome?: (
			executionId: string,
			projectName: string,
			result: FinalizeCommDbResult,
		) => void;
	} = {},
): Promise<CommDbPruneResult> {
	const result: CommDbPruneResult = {
		scanned: 0,
		pruned: 0,
		kept: 0,
		failed: 0,
	};
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
			try {
				const finalized = db.finalizeSession(s.execution_id);
				opts.onFinalizeOutcome?.(s.execution_id, projectName, {
					ok: true,
					outcome: "finalized",
					retiredGateCount: finalized.retiredQuestionCount,
					deletedSessionCount: finalized.deletedSessionCount,
				});
				result.pruned++;
			} catch (err) {
				result.failed++;
				opts.onFinalizeOutcome?.(s.execution_id, projectName, {
					ok: false,
					outcome: "failed",
					retiredGateCount: 0,
					deletedSessionCount: 0,
					error: (err as Error).message,
				});
				console.warn(
					`[commdb-prune] boot finalize ${s.execution_id} (${projectName}) failed: ${(err as Error).message}`,
				);
			}
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
