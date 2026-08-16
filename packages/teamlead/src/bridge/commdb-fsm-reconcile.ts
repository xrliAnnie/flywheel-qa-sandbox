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
 *   - `failed`/`blocked` (CRASH_PRESERVE) remain excluded by default: retry's
 *     `closeRunner(forcePreserved: true)` reads the CommDB tmux target to tear
 *     the preserved window/tab down. FLY-1066's opt-in harvest may finalize one
 *     only after the target is provably dead, when that teardown target and its
 *     scrollback no longer exist.
 *
 * Safety, structurally (never a whitelist): absent-FSM rows require the explicit
 * harvest option, a valid age beyond its dispatch guard, and a proven-dead target.
 * Otherwise they retain the exact FLY-817 keep behavior. Terminal states never
 * transition back to running and a retry successor is a DIFFERENT execution_id,
 * so deleting by execution_id can never orphan a live runner. Best-effort: any
 * failure logs a warning and is swallowed (a reconcile must never block boot).
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
	/** kept — FSM is `failed`/`blocked` and harvest is off or target not dead. */
	keptPreserve: number;
	/** kept — deletable-terminal FSM but tmux target alive/indeterminate. */
	keptAliveTarget: number;
	/** proven-dead candidates whose atomic CommDB finalization failed. */
	finalizeFailed: number;
	/**
	 * FLY-1329 (A4): rows kept because the runner declared itself parked (or the
	 * park lookup threw and we fail closed) — a `dead` probe here is only a stale
	 * window name, not proof the process died.
	 */
	parkedVetoed: number;
	/** FLY-1066 opt-in counters; absent preserves the exact FLY-817 result shape. */
	harvest?: {
		orphanHarvested: number;
		preserveHarvested: number;
		keptOrphanCandidate: number;
		keptPreserveAlive: number;
	};
}

/** FSM-status lookup: execution_id → status (undefined ⇒ no FSM row). */
export type FsmStatusLookup = (executionId: string) => string | undefined;

function parseHarvestStartedAt(
	startedAt: string | undefined,
	nowMs: number,
): number | undefined {
	if (!startedAt || !Number.isFinite(nowMs)) return undefined;
	const iso = startedAt.includes("T")
		? startedAt
		: `${startedAt.replace(" ", "T")}Z`;
	const startedAtMs = Date.parse(iso);
	if (!Number.isFinite(startedAtMs) || startedAtMs > nowMs) return undefined;
	return startedAtMs;
}

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
		harvest?: {
			orphanMinAgeMs: number;
			nowMs: () => number;
		};
		finalizeSession?: (db: CommDB, executionId: string) => unknown;
		finalizePaneLossResidue?: (
			db: CommDB,
			executionId: string,
			expectedTmuxWindow: string,
		) => unknown;
		onFinalizeOutcome?: (
			executionId: string,
			projectName: string,
			result: FinalizeCommDbResult,
		) => void;
		/**
		 * FLY-1329 (A4): does this execId hold an UNEXPIRED park declaration? The
		 * default reads it through the sweep's already-open CommDB handle; tests
		 * inject to exercise the fail-closed path. Undefined here would fall back to
		 * that default (see body).
		 */
		isParked?: (executionId: string) => boolean;
		parkedGenerationEvidence?: (
			executionId: string,
			tmuxWindow: string,
		) => Promise<"superseded" | "same_generation" | "unavailable">;
	} = {},
): Promise<CommDbFsmReconcileResult> {
	const result: CommDbFsmReconcileResult = {
		scanned: 0,
		reconciled: 0,
		keptNonTerminal: 0,
		keptPreserve: 0,
		keptAliveTarget: 0,
		finalizeFailed: 0,
		parkedVetoed: 0,
	};
	if (opts.harvest) {
		result.harvest = {
			orphanHarvested: 0,
			preserveHarvested: 0,
			keptOrphanCandidate: 0,
			keptPreserveAlive: 0,
		};
	}
	const dbPath = opts.dbPath ?? resolveCommDbPath(projectName);
	if (!dbPath) return result;
	const probe = opts.probe ?? probeTmuxWindowLiveness;
	const finalizeSession =
		opts.finalizeSession ??
		((db: CommDB, executionId: string) =>
			db.finalizeSessionUnlessTurnHolder(executionId));
	const finalizePaneLossResidue =
		opts.finalizePaneLossResidue ??
		((db: CommDB, executionId: string, expectedTmuxWindow: string) =>
			db.finalizePaneLossResidue(executionId, expectedTmuxWindow));

	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath);
		const turnHolders = new Set(
			db.listTurns().map((turn) => turn.holder_exec_id),
		);
		const running = db.listSessions(projectName, ["running"]);
		result.scanned = running.length;
		for (const s of running) {
			let parkedSuperseded = false;
			// FLY-1374: a TURN holder is an active writer even when StateStore
			// still carries the prior activation's terminal status. Never let a
			// stale tmux target authorize deletion of its turn/mailbox identity.
			if (turnHolders.has(s.execution_id)) {
				result.parkedVetoed++;
				console.log(
					`[commdb-fsm-reconcile] prune_skipped_turn_holder: ${s.execution_id} (${projectName}) owns the current TURN — KEEPING the row`,
				);
				continue;
			}
			const fsm = fsmStatusOf(s.execution_id);
			let harvestKind: "orphan" | "preserve" | undefined;
			let targetProvenDead = false;
			// FLY-817 legacy: preserve targets are never probed. FLY-1066 opt-in:
			// once the target is PROVEN dead, the teardown target + scrollback no
			// longer exist, so the stale registration can be finalized safely.
			if (fsm && CRASH_PRESERVE_STATES.has(fsm)) {
				if (!opts.harvest) {
					result.keptPreserve++;
					continue;
				}
				const state = await probe(s.tmux_window);
				if (state !== "dead") {
					result.keptPreserve++;
					result.harvest!.keptPreserveAlive++;
					continue;
				}
				targetProvenDead = true;
				harvestKind = "preserve";
			}
			// FLY-1066 CommDB-only orphan: the 24h guard is the actual mid-dispatch
			// safety boundary. Missing/invalid/future timestamps fail closed before
			// probing; alive/indeterminate targets are always kept.
			if (!fsm && opts.harvest) {
				const nowMs = opts.harvest.nowMs();
				const startedAtMs = parseHarvestStartedAt(s.started_at, nowMs);
				if (
					startedAtMs === undefined ||
					nowMs - startedAtMs <= opts.harvest.orphanMinAgeMs
				) {
					result.keptNonTerminal++;
					result.harvest!.keptOrphanCandidate++;
					continue;
				}
				const state = await probe(s.tmux_window);
				if (state !== "dead") {
					result.keptNonTerminal++;
					result.harvest!.keptOrphanCandidate++;
					continue;
				}
				targetProvenDead = true;
				harvestKind = "orphan";
			}
			// FSM row missing with harvest off, OR a non-deletable / non-terminal
			// state (running/reconnecting/awaiting_review/approved_to_ship/pending/…).
			if (!harvestKind && (!fsm || !RECONCILE_DELETABLE_STATES.has(fsm))) {
				result.keptNonTerminal++;
				continue;
			}
			// Deletable terminal outcome → require a PROVEN-dead tmux target so a
			// pending-teardown window is never stranded (BLOCKER 2, mirrors FLY-638).
			if (!targetProvenDead) {
				const state = await probe(s.tmux_window);
				if (state !== "dead") {
					result.keptAliveTarget++;
					continue;
				}
			}
			// FLY-1329 (A4, Codex R1 HIGH-2): an unexpired park declaration vetoes
			// the delete. The `dead` verdict above is `isTmuxAbsenceMessage` — tmux
			// could not find the window at this name, which a stale mapping produces
			// on a live parked runner (the FLY-1319 shape). This is the running-face
			// delete site that runs FIRST on boot, before the terminal-face prune the
			// veto also guards. Fail-closed: a lookup that throws keeps the row.
			const activeDb = db;
			let parked: boolean;
			try {
				parked = opts.isParked
					? opts.isParked(s.execution_id)
					: activeDb.getEffectiveDeclaredState(s.execution_id, Date.now())
							?.kind === "parked";
			} catch (err) {
				parked = true;
				console.warn(
					`[commdb-fsm-reconcile] declared-state lookup failed for ${s.execution_id}: ${(err as Error).message} — KEEPING the row (fail-closed)`,
				);
			}
			if (parked) {
				const evidence = opts.parkedGenerationEvidence
					? await opts
							.parkedGenerationEvidence(s.execution_id, s.tmux_window)
							.catch(() => "unavailable" as const)
					: "unavailable";
				if (evidence === "superseded") {
					parkedSuperseded = true;
				} else {
					result.parkedVetoed++;
					console.log(
						`[commdb-fsm-reconcile] prune_skipped_parked_conflict: ${s.execution_id} (${projectName}) declares itself parked while its window name does not resolve — KEEPING the row (stale mapping suspected, FLY-1319 shape)`,
					);
					continue;
				}
			}
			try {
				const raw = (
					parkedSuperseded
						? finalizePaneLossResidue(db, s.execution_id, s.tmux_window)
						: finalizeSession(db, s.execution_id)
				) as
					| {
							finalized?: boolean;
							reason?: string;
							result?: {
								retiredQuestionCount?: number;
								retiredAskCount?: number;
								deletedSessionCount?: number;
							};
							retiredQuestionCount?: number;
							retiredAskCount?: number;
							deletedSessionCount?: number;
					  }
					| undefined;
				if (raw?.finalized === false && raw.reason === "turn_holder") {
					result.parkedVetoed++;
					console.log(
						`[commdb-fsm-reconcile] prune_skipped_turn_holder_at_finalize: ${s.execution_id} (${projectName}) acquired the current TURN — KEEPING the row`,
					);
					continue;
				}
				if (raw?.finalized === false && raw.reason === "target_changed") {
					result.parkedVetoed++;
					console.log(
						`[commdb-fsm-reconcile] pane-loss target changed for ${s.execution_id} — KEEPING the row`,
					);
					continue;
				}
				const finalized = raw?.finalized === true ? raw.result : raw;
				opts.onFinalizeOutcome?.(s.execution_id, projectName, {
					ok: true,
					outcome: "finalized",
					retiredGateCount: finalized?.retiredQuestionCount ?? 0,
					retiredAskCount: finalized?.retiredAskCount ?? 0,
					deletedSessionCount: finalized?.deletedSessionCount ?? 0,
				});
				result.reconciled++;
				if (harvestKind === "orphan") result.harvest!.orphanHarvested++;
				if (harvestKind === "preserve") result.harvest!.preserveHarvested++;
			} catch (err) {
				result.finalizeFailed++;
				opts.onFinalizeOutcome?.(s.execution_id, projectName, {
					ok: false,
					outcome: "failed",
					retiredGateCount: 0,
					retiredAskCount: 0,
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
