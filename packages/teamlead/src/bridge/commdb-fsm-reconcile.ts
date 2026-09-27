/**
 * FLY-817: CommDB ↔ Bridge-FSM reconcile — the FLY-638 blind-spot fix.
 *
 * `runner_terminal_list` / Lead bootstrap read the per-project CommDB `sessions`
 * table (status ∈ {running, completed, timeout}); they CANNOT
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
 * (`RECONCILE_DELETABLE_STATES`) AND the shared execution-body observation is
 * **dead**. Both conditions are required:
 *   - FSM terminal alone is NOT sufficient — a just-completed runner may still
 *     be draining. Keeping `alive`/`unknown` rows preserves its cleanup target.
 *   - `failed`/`blocked` (CRASH_PRESERVE) remain excluded by default: retry's
 *     `closeRunner(forcePreserved: true)` reads the CommDB tmux target to tear
 *     the preserved window/tab down. FLY-1066's opt-in harvest may finalize one
 *     only after body death is proven. A remaining window is UI residue only.
 *
 * Safety, structurally (never a whitelist): absent-FSM rows require the explicit
 * harvest option, a valid age beyond its dispatch guard, and proven body death.
 * Otherwise they retain the exact FLY-817 keep behavior. Terminal states never
 * transition back to running and a retry successor is a DIFFERENT execution_id,
 * so deleting by execution_id can never orphan a live runner. Best-effort: any
 * failure logs a warning and is swallowed (a reconcile must never block boot).
 */

import { CommDB } from "flywheel-comm/db";
import { CRASH_PRESERVE_STATES } from "./close-runner.js";
import type { CodexTerminalHarvestResult } from "./codex-terminal-harvest.js";
import { RECONCILE_DELETABLE_STATES } from "./commdb-deletable-states.js";
import {
	type FinalizeCommDbResult,
	resolveCommDbPath,
} from "./commdb-session-prune.js";

export { RECONCILE_DELETABLE_STATES } from "./commdb-deletable-states.js";

export interface CommDbFsmReconcileResult {
	/** CommDB `running` rows examined. */
	scanned: number;
	/** rows deleted (deletable-terminal FSM + execution body proven dead). */
	reconciled: number;
	/** kept — FSM row missing OR a non-terminal/non-deletable state. */
	keptNonTerminal: number;
	/** kept — FSM is `failed`/`blocked` and harvest is off or body is not dead. */
	keptPreserve: number;
	/** kept — deletable-terminal FSM but body is alive/unknown. */
	keptAliveTarget: number;
	/** proven-dead candidates whose atomic CommDB finalization failed. */
	finalizeFailed: number;
	/**
	 * Compatibility counter: rows retained by TURN/target CAS guards. Parked
	 * workflow declarations no longer veto a proven body death.
	 */
	parkedVetoed: number;
	/** FLY-2498: parked declarations overridden by independent execution absence. */
	parkedOverridden: number;
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
 * IFF (1) its FSM status ∈ `RECONCILE_DELETABLE_STATES` AND (2) its execution
 * body is proven dead. Best-effort; never throws.
 */
export async function reconcileCommDbRunningAgainstFsm(
	projectName: string,
	fsmStatusOf: FsmStatusLookup,
	opts: {
		dbPath?: string;
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
		executionAbsence?: (
			executionId: string,
			projectName: string,
		) => Promise<"alive" | "dead" | "unknown">;
		/** FLY-2555: explicit full-harvest opt-in; a close attempt retains this pass. */
		harvestCodexDaemon?: (
			executionId: string,
			projectName: string,
			tmuxWindow: string,
			targetUnchangedAndNoTurn: () => boolean,
		) => Promise<CodexTerminalHarvestResult>;
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
		parkedOverridden: 0,
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
			// FLY-1374: a TURN holder is an active writer even when StateStore
			// still carries the prior activation's terminal status. Never let a
			// stale lifecycle state authorize deletion of its turn/mailbox identity.
			if (turnHolders.has(s.execution_id)) {
				result.parkedVetoed++;
				console.log(
					`[commdb-fsm-reconcile] prune_skipped_turn_holder: ${s.execution_id} (${projectName}) owns the current TURN — KEEPING the row`,
				);
				continue;
			}
			const fsm = fsmStatusOf(s.execution_id);
			let harvestKind: "orphan" | "preserve" | undefined;
			// Preserve rows remain outside the legacy pass. The explicit harvest
			// pass may settle them, but only from the shared execution-body truth.
			if (fsm && CRASH_PRESERVE_STATES.has(fsm)) {
				if (!opts.harvest) {
					result.keptPreserve++;
					continue;
				}
				harvestKind = "preserve";
			}
			// FLY-1066 CommDB-only orphan: the 24h guard is the actual mid-dispatch
			// safety boundary. Missing/invalid/future timestamps fail closed before
			// body sampling; alive/unknown bodies are always kept.
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
				harvestKind = "orphan";
			}
			// FSM row missing with harvest off, OR a non-deletable / non-terminal
			// state (running/reconnecting/awaiting_review/approved_to_ship/pending/…).
			if (!harvestKind && (!fsm || !RECONCILE_DELETABLE_STATES.has(fsm))) {
				result.keptNonTerminal++;
				continue;
			}
			let body = opts.executionAbsence
				? await opts
						.executionAbsence(s.execution_id, projectName)
						.catch(() => "unknown" as const)
				: "unknown";
			let canFinalizeCodex: (() => boolean) | undefined;
			if (
				body !== "dead" &&
				opts.harvest &&
				opts.harvestCodexDaemon &&
				(fsm === "completed" || fsm === "failed" || fsm === "terminated")
			) {
				const currentDb = db;
				const harvest = await opts
					.harvestCodexDaemon(
						s.execution_id,
						projectName,
						s.tmux_window,
						() =>
							currentDb.getSession(s.execution_id)?.tmux_window ===
								s.tmux_window &&
							!currentDb
								.listTurns()
								.some((turn) => turn.holder_exec_id === s.execution_id),
					)
					.catch(() => "keep" as const);
				if (typeof harvest === "object") {
					body = "dead";
					canFinalizeCodex = harvest.canFinalize;
				}
			}
			if (body !== "dead") {
				if (harvestKind === "preserve") {
					result.keptPreserve++;
					result.harvest!.keptPreserveAlive++;
				} else if (harvestKind === "orphan") {
					result.keptNonTerminal++;
					result.harvest!.keptOrphanCandidate++;
				} else {
					result.keptAliveTarget++;
				}
				continue;
			}
			try {
				if (
					db.getEffectiveDeclaredState(s.execution_id, Date.now())?.kind ===
					"parked"
				) {
					result.parkedOverridden++;
				}
			} catch {
				// Parked is diagnostic workflow state only; read failures cannot veto
				// a current-generation body-death fact.
			}
			try {
				if (canFinalizeCodex && !canFinalizeCodex()) {
					result.parkedVetoed++;
					continue;
				}
				const raw = (
					opts.finalizeSession
						? opts.finalizeSession(db, s.execution_id)
						: finalizePaneLossResidue(db, s.execution_id, s.tmux_window)
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
						`[commdb-fsm-reconcile] target identity changed for ${s.execution_id} — KEEPING the row`,
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
