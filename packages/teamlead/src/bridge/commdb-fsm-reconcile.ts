/**
 * FLY-817: CommDB ↔ Bridge-FSM reconcile — the FLY-638 blind-spot fix.
 *
 * `runner_terminal_list` / Lead bootstrap read the per-project CommDB `sessions`
 * table (status ∈ {running, completed, timeout}) + a live tmux probe; they CANNOT
 * see the Bridge WorkflowFSM (`packages/terminal-mcp/src/lifecycle.ts`). The
 * CommDB `status` CHECK constraint cannot even represent `terminated/failed/
 * blocked/…`, so the only way a CommDB row leaves is a DELETE — fired from the
 * close_runner / terminate / post-merge / crash-reap teardown paths. Any FSM
 * terminal transition that skips those paths (`reapOrphans → failed`, a
 * `--route blocked` completion, a `completed` runner the Lead never explicitly
 * closed) leaves an eternal CommDB `running` row that renders as an
 * `alive=false status=running` zombie. FLY-638's boot sweep only scans CommDB
 * `{completed,timeout}` rows, so it never touches these.
 *
 * This is the FLY-638 sibling for CommDB `running` rows: delete a `running` row
 * IFF its Bridge FSM status is a **non-preserve terminal outcome**
 * (`RECONCILE_DELETABLE_STATES`) AND its tmux target is **provably dead**
 * (tri-state probe === "dead"). Both conditions are required (Codex design R1):
 *   - FSM terminal alone is NOT sufficient — a just-completed runner whose
 *     teardown is still pending has a LIVE tmux window, and deleting the CommDB
 *     row (the source-of-truth tmux target, per tmux-lookup.ts) would strand it.
 *     Keeping `alive`/`indeterminate` rows preserves the teardown target.
 *   - `failed`/`blocked` (CRASH_PRESERVE) are deliberately EXCLUDED: retry's
 *     `closeRunner(forcePreserved: true)` reads the CommDB tmux target to tear
 *     the preserved window/tab down. Hiding their CommDB residue from the list is
 *     a read-model concern, tracked separately.
 *
 * Safety, structurally (never a whitelist): a missing or non-terminal FSM row is
 * always kept (no proof of a final outcome), so genuinely-alive runners and
 * FSM-less test-scratch CommDBs are exempt; terminal states never transition
 * back to running and a retry successor is a DIFFERENT execution_id, so deleting
 * by execution_id can never orphan a live runner. Best-effort: any failure logs
 * a warning and is swallowed (a reconcile must never block Bridge boot).
 */

import { CommDB } from "flywheel-comm/db";
import { AUTO_CLOSE_STATES, CRASH_PRESERVE_STATES } from "./close-runner.js";
import {
	type FinalizeCommDbResult,
	resolveCommDbPath,
} from "./commdb-session-prune.js";
import {
	probeTmuxWindowLiveness,
	type TmuxWindowProbe,
} from "./tmux-lookup.js";

/**
 * FSM outcome states this reconcile may delete a CommDB `running` row for.
 * = `AUTO_CLOSE_STATES` {completed,rejected,deferred,shelved,terminated} ∪ {approved}
 * = `OUTCOME_STATUSES` − {approved_to_ship, failed, blocked}.
 *
 * `approved` is a legacy terminal FSM state (WORKFLOW_TRANSITIONS `approved: []`,
 * in OUTCOME_STATUSES) that `CLOSE_ELIGIBLE_STATES` omits — included here so a
 * `CommDB=running + FSM=approved` row is not left behind forever (Codex R1). The
 * excluded states are: `approved_to_ship` (runner still ships → non-terminal) and
 * `failed`/`blocked` (CRASH_PRESERVE — teardown target must survive).
 */
export const RECONCILE_DELETABLE_STATES: ReadonlySet<string> = new Set([
	...AUTO_CLOSE_STATES,
	"approved",
]);

export interface CommDbFsmReconcileResult {
	/** CommDB `running` rows examined. */
	scanned: number;
	/** rows deleted (deletable-terminal FSM + tmux PROVABLY dead). */
	reconciled: number;
	/** kept — FSM row missing OR a non-terminal/non-deletable state. */
	keptNonTerminal: number;
	/** kept — FSM is `failed`/`blocked` (CRASH_PRESERVE; never deleted here). */
	keptPreserve: number;
	/** kept — deletable-terminal FSM but tmux target alive/indeterminate. */
	keptAliveTarget: number;
	/** proven-dead candidates whose atomic CommDB finalization failed. */
	finalizeFailed: number;
}

/** FSM-status lookup: execution_id → status (undefined ⇒ no FSM row). */
export type FsmStatusLookup = (executionId: string) => string | undefined;

/**
 * Reconcile one project's CommDB against the Bridge FSM. Deletes a `running` row
 * IFF (1) its FSM status ∈ `RECONCILE_DELETABLE_STATES` AND (2) its tmux target
 * probes `dead`. `dbPath` / `probe` are injectable for tests. Best-effort; never
 * throws.
 */
export async function reconcileCommDbRunningAgainstFsm(
	projectName: string,
	fsmStatusOf: FsmStatusLookup,
	opts: {
		dbPath?: string;
		probe?: (tmuxWindow: string) => Promise<TmuxWindowProbe>;
		finalizeSession?: (db: CommDB, executionId: string) => unknown;
		onFinalizeOutcome?: (
			executionId: string,
			projectName: string,
			result: FinalizeCommDbResult,
		) => void;
	} = {},
): Promise<CommDbFsmReconcileResult> {
	const result: CommDbFsmReconcileResult = {
		scanned: 0,
		reconciled: 0,
		keptNonTerminal: 0,
		keptPreserve: 0,
		keptAliveTarget: 0,
		finalizeFailed: 0,
	};
	const dbPath = opts.dbPath ?? resolveCommDbPath(projectName);
	if (!dbPath) return result;
	const probe = opts.probe ?? probeTmuxWindowLiveness;
	const finalizeSession =
		opts.finalizeSession ??
		((db: CommDB, executionId: string) => db.finalizeSession(executionId));

	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath);
		const running = db.listSessions(projectName, ["running"]);
		result.scanned = running.length;
		for (const s of running) {
			const fsm = fsmStatusOf(s.execution_id);
			// CRASH_PRESERVE (failed/blocked) — decided by FSM alone, never probed
			// (BLOCKER 1: the CommDB tmux target must survive for retry cleanup).
			if (fsm && CRASH_PRESERVE_STATES.has(fsm)) {
				result.keptPreserve++;
				continue;
			}
			// FSM row missing (test-scratch) OR a non-deletable / non-terminal state
			// (running/reconnecting/awaiting_review/approved_to_ship/pending/…) → keep.
			if (!fsm || !RECONCILE_DELETABLE_STATES.has(fsm)) {
				result.keptNonTerminal++;
				continue;
			}
			// Deletable terminal outcome → require a PROVEN-dead tmux target so a
			// pending-teardown window is never stranded (BLOCKER 2, mirrors FLY-638).
			const state = await probe(s.tmux_window);
			if (state !== "dead") {
				result.keptAliveTarget++;
				continue;
			}
			try {
				const raw = finalizeSession(db, s.execution_id) as
					| { retiredQuestionCount?: number; deletedSessionCount?: number }
					| undefined;
				opts.onFinalizeOutcome?.(s.execution_id, projectName, {
					ok: true,
					outcome: "finalized",
					retiredGateCount: raw?.retiredQuestionCount ?? 0,
					deletedSessionCount: raw?.deletedSessionCount ?? 0,
				});
				result.reconciled++;
			} catch (err) {
				result.finalizeFailed++;
				opts.onFinalizeOutcome?.(s.execution_id, projectName, {
					ok: false,
					outcome: "failed",
					retiredGateCount: 0,
					deletedSessionCount: 0,
					error: (err as Error).message,
				});
				console.warn(
					`[commdb-fsm-reconcile] finalize ${s.execution_id} failed: ${(err as Error).message}`,
				);
			}
		}
	} catch (err) {
		console.warn(
			`[commdb-fsm-reconcile] ${projectName} failed: ${(err as Error).message}`,
		);
	} finally {
		db?.close();
	}
	return result;
}
