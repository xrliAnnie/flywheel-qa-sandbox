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
 *   2. `pruneDeadTerminalCommDbSessions` — boot/maintenance sweep. Clears the
 *      EXISTING backlog: every eligible terminal row whose tmux window is
 *      provably gone. FLY-1066 extends eligibility to failed/blocked only while
 *      its residue-harvest kill-switch is enabled.
 *
 * Safety: only eligible terminal rows are swept (completed/timeout always;
 * failed/blocked only under the residue-harvest switch), and only when the tmux
 * probe says the window is gone — a still-alive parked runner's row is left
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
	/**
	 * Exact CommDB window targets that were proven dead immediately before their
	 * rows were successfully finalized. This evidence is intentionally returned
	 * to the caller rather than persisted in StateStore, where legacy
	 * `tmux_session` values have no trustworthy provenance.
	 */
	provenDeadTargets: ProvenDeadTmuxTarget[];
}

export interface ProvenDeadTmuxTarget {
	executionId: string;
	tmuxWindow: string;
}

/**
 * Boot/maintenance sweep: delete eligible terminal CommDB session rows whose
 * tmux window is **provably** gone. Uses the tri-state
 * `probeTmuxWindowLiveness` (NOT
 * the boolean `isTmuxWindowAlive`, which collapses a transient/indeterminate
 * probe failure into "not alive") so a parked-alive runner whose probe merely
 * timed out is never deleted — only a `dead` verdict deletes (Codex R1 HIGH).
 * Probe + db path are injectable for tests. Best-effort; never throws.
 */
export async function pruneDeadTerminalCommDbSessions(
	projectName: string,
	opts: {
		dbPath?: string;
		/** FLY-1066: include failed/blocked CRASH_PRESERVE rows. */
		includeCrashPreserve?: boolean;
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
		provenDeadTargets: [],
	};
	const dbPath = opts.dbPath ?? resolveCommDbPath(projectName);
	if (!dbPath) return result;
	const probe = opts.probe ?? probeTmuxWindowLiveness;

	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath);
		const terminal = db.listSessions(
			projectName,
			opts.includeCrashPreserve
				? ["completed", "timeout", "failed", "blocked"]
				: ["completed", "timeout"],
		);
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
				const outcome: FinalizeCommDbResult = {
					ok: true,
					outcome: "finalized",
					retiredGateCount: finalized.retiredQuestionCount,
					deletedSessionCount: finalized.deletedSessionCount,
				};
				result.pruned++;
				result.provenDeadTargets.push({
					executionId: s.execution_id,
					tmuxWindow: s.tmux_window,
				});
				try {
					opts.onFinalizeOutcome?.(s.execution_id, projectName, outcome);
				} catch (err) {
					console.warn(
						`[commdb-prune] audit successful finalize ${s.execution_id} (${projectName}) failed (non-fatal): ${(err as Error).message}`,
					);
				}
			} catch (err) {
				result.failed++;
				const outcome: FinalizeCommDbResult = {
					ok: false,
					outcome: "failed",
					retiredGateCount: 0,
					deletedSessionCount: 0,
					error: (err as Error).message,
				};
				try {
					opts.onFinalizeOutcome?.(s.execution_id, projectName, outcome);
				} catch (auditErr) {
					console.warn(
						`[commdb-prune] audit failed finalize ${s.execution_id} (${projectName}) failed (non-fatal): ${(auditErr as Error).message}`,
					);
				}
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
