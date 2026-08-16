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
	/**
	 * FLY-1328: checkpoint-less asks cascade-retired by this teardown. Required
	 * so a construction site that forgets to carry the real count is a compile
	 * error rather than a silent zero in the forensic record.
	 */
	retiredAskCount: number;
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
			retiredAskCount: 0,
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
			retiredAskCount: result.retiredAskCount,
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
			retiredAskCount: 0,
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
	/**
	 * FLY-1329 (A4): rows KEPT because the runner declared itself parked, despite a
	 * `dead` probe. That probe's `dead` only means tmux could not FIND the window
	 * at the name we passed — a stale mapping reads identically to a real death,
	 * and deleting on it is how a live runner's row vanished in FLY-1319.
	 */
	parkedVetoed: number;
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
		parkedVetoed: 0,
	};
	const dbPath = opts.dbPath ?? resolveCommDbPath(projectName);
	if (!dbPath) return result;
	const probe = opts.probe ?? probeTmuxWindowLiveness;

	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath);
		const turnHolders = new Set(
			db.listTurns().map((turn) => turn.holder_exec_id),
		);
		const terminal = db.listSessions(
			projectName,
			opts.includeCrashPreserve
				? ["completed", "timeout", "failed", "blocked"]
				: ["completed", "timeout"],
		);
		result.scanned = terminal.length;
		for (const s of terminal) {
			// FLY-1374: TURN is current writer authority. A stale tmux mapping can
			// make a live parked holder's old target look dead; deleting its session
			// row also deletes turn self-check + mailbox identity. The write path
			// therefore vetoes before any liveness probe.
			if (turnHolders.has(s.execution_id)) {
				result.parkedVetoed++;
				console.log(
					`[commdb-prune] prune_skipped_turn_holder: ${s.execution_id} (${projectName}) owns the current TURN — KEEPING the row`,
				);
				continue;
			}
			// Delete ONLY on a proven-dead window. `alive` (parked) and
			// `indeterminate` (we learned nothing) both keep the row.
			const state = await probe(s.tmux_window);
			if (state !== "dead") {
				result.kept++;
				continue;
			}
			// FLY-1329 (A4): `dead` here is `isTmuxAbsenceMessage` — tmux could not
			// FIND the window at this name. That is NOT proof the process died: a
			// stale `tmux_window` mapping produces it on a perfectly healthy runner,
			// and deleting the row is how a live runner stopped being recognized in
			// FLY-1319. An unexpired park declaration is the runner contradicting
			// this reading, so it vetoes the delete. Fail-closed: a lookup that
			// throws also keeps the row.
			let parked: boolean;
			try {
				parked =
					db.getEffectiveDeclaredState(s.execution_id, Date.now())?.kind ===
					"parked";
			} catch (err) {
				parked = true;
				console.warn(
					`[commdb-prune] declared-state lookup failed for ${s.execution_id}: ${(err as Error).message} — KEEPING the row (fail-closed)`,
				);
			}
			if (parked) {
				result.parkedVetoed++;
				console.log(
					`[commdb-prune] prune_skipped_parked_conflict: ${s.execution_id} (${projectName}) declares itself parked while its window name does not resolve — KEEPING the row (stale mapping suspected, FLY-1319 shape)`,
				);
				continue;
			}
			try {
				const guarded = db.finalizeSessionUnlessTurnHolder(s.execution_id);
				if (!guarded.finalized) {
					result.parkedVetoed++;
					console.log(
						`[commdb-prune] prune_skipped_turn_holder_at_finalize: ${s.execution_id} (${projectName}) acquired the current TURN — KEEPING the row`,
					);
					continue;
				}
				const finalized = guarded.result;
				const outcome: FinalizeCommDbResult = {
					ok: true,
					outcome: "finalized",
					retiredGateCount: finalized.retiredQuestionCount,
					retiredAskCount: finalized.retiredAskCount,
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
					retiredAskCount: 0,
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
