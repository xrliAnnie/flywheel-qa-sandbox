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
import { CommDB, type Session } from "flywheel-comm/db";
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

const COMM_DB_ENDED_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"timeout",
	"failed",
	"blocked",
]);

/** Read-only lifecycle evidence for callers deciding whether a terminal-only
 * cleanup path is even eligible. Read failures are uncertainty and fail closed. */
export function hasEndedCommDbSession(
	executionId: string,
	projectName: string,
): boolean {
	const dbPath = resolveCommDbPath(projectName);
	if (!dbPath) return false;
	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		const session = db.getSession(executionId);
		return Boolean(
			session?.ended_at && COMM_DB_ENDED_STATUSES.has(session.status),
		);
	} catch (error) {
		console.warn(
			`[commdb-prune] terminal evidence unavailable for ${executionId}: ${(error as Error).message}`,
		);
		return false;
	} finally {
		db?.close();
	}
}

/**
 * Live cleanup: atomically retire one runner's unresolved gates and session
 * after teardown. Best-effort; never throws. `dbPath` is injectable for tests.
 */
export interface FinalizeCommDbResult {
	ok: boolean;
	outcome:
		| "finalized"
		| "no_db"
		| "target_changed"
		| "terminal_evidence_changed"
		| "turn_holder"
		| "parked"
		| "founder_wake_pending"
		| "failed";
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

/**
 * FLY-2313: retire a terminal runner's communication obligations without
 * deleting its only tmux identity. The expected target is checked in the same
 * transaction as the ledger writes; target drift fails closed with zero writes.
 */
export function finalizeCommDbSessionCommunications(
	executionId: string,
	projectName: string,
	expectedTmuxWindow: string,
	dbPath: string | undefined = resolveCommDbPath(projectName),
	deleteSessionIdentity = false,
	authoritativeTerminalStatus?: "failed" | "blocked",
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
		const finalized = db.finalizeSessionCommunications(
			executionId,
			expectedTmuxWindow,
			deleteSessionIdentity,
			authoritativeTerminalStatus,
		);
		if (!finalized.finalized) {
			return {
				ok: false,
				outcome: finalized.reason,
				retiredGateCount: 0,
				retiredAskCount: 0,
				deletedSessionCount: 0,
				error: finalized.reason,
			};
		}
		return {
			ok: true,
			outcome: "finalized",
			retiredGateCount: finalized.result.retiredQuestionCount,
			retiredAskCount: finalized.result.retiredAskCount,
			deletedSessionCount: finalized.result.deletedSessionCount,
		};
	} catch (err) {
		console.warn(
			`[commdb-prune] finalize communications ${executionId} (${projectName}) failed: ${(err as Error).message}`,
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

/** Full identity deletion after an external execution-level death proof, using
 * the same atomic terminal/TURN/parked/founder-wake guards as ledger-only
 * settlement. */
export function finalizeCommDbTerminalSession(
	executionId: string,
	projectName: string,
	expectedTmuxWindow: string,
	authoritativeTerminalStatus?: "failed" | "blocked",
	dbPath: string | undefined = resolveCommDbPath(projectName),
): FinalizeCommDbResult {
	return finalizeCommDbSessionCommunications(
		executionId,
		projectName,
		expectedTmuxWindow,
		dbPath,
		true,
		authoritativeTerminalStatus,
	);
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

export type DeadTerminalFinalizeOutcome =
	| "finalized"
	| "no_row"
	| "kept_project_mismatch"
	| "kept_status"
	| "kept_turn_holder"
	| "kept_alive"
	| "kept_indeterminate"
	| "kept_parked"
	| "kept_target_changed"
	| "failed"
	| "not_wired";

export interface FinalizeDeadTerminalOpts {
	includeCrashPreserve?: boolean;
	probe?: (tmuxWindow: string) => Promise<TmuxWindowProbe>;
	onFinalizeOutcome?: (
		executionId: string,
		projectName: string,
		result: FinalizeCommDbResult,
	) => void;
}

type DeadTerminalInspectionOutcome =
	| "eligible_dead"
	| "kept_project_mismatch"
	| "kept_status"
	| "kept_turn_holder"
	| "kept_alive"
	| "kept_indeterminate"
	| "kept_parked";

async function inspectDeadTerminalCommDbSession(
	db: CommDB,
	projectName: string,
	session: Session,
	turnHolders: ReadonlySet<string>,
	opts: FinalizeDeadTerminalOpts & { finalizeMode: "sweep" | "point" },
): Promise<DeadTerminalInspectionOutcome> {
	if (session.project_name !== projectName) {
		return "kept_project_mismatch";
	}
	const eligibleStatuses: ReadonlySet<Session["status"]> =
		opts.includeCrashPreserve
			? new Set(["completed", "timeout", "failed", "blocked"])
			: new Set(["completed", "timeout"]);
	if (!eligibleStatuses.has(session.status)) {
		return "kept_status";
	}
	if (turnHolders.has(session.execution_id)) {
		if (opts.finalizeMode === "sweep") {
			console.log(
				`[commdb-prune] prune_skipped_turn_holder: ${session.execution_id} (${projectName}) owns the current TURN — KEEPING the row`,
			);
		}
		return "kept_turn_holder";
	}
	const isParked = (): boolean => {
		try {
			return (
				db.getEffectiveDeclaredState(session.execution_id, Date.now())?.kind ===
				"parked"
			);
		} catch (error) {
			if (opts.finalizeMode === "sweep") {
				console.warn(
					`[commdb-prune] declared-state lookup failed for ${session.execution_id}: ${(error as Error).message} — KEEPING the row (fail-closed)`,
				);
			}
			return true;
		}
	};
	if (opts.finalizeMode === "point" && isParked()) {
		return "kept_parked";
	}
	const probe = opts.probe ?? probeTmuxWindowLiveness;
	const state = await probe(session.tmux_window);
	if (state === "alive") return "kept_alive";
	if (state === "indeterminate") return "kept_indeterminate";
	if (opts.finalizeMode === "sweep" && isParked()) {
		console.log(
			`[commdb-prune] prune_skipped_parked_conflict: ${session.execution_id} (${projectName}) declares itself parked while its window name does not resolve — KEEPING the row (stale mapping suspected, FLY-1319 shape)`,
		);
		return "kept_parked";
	}
	return "eligible_dead";
}

function reportFinalizeOutcome(
	opts: FinalizeDeadTerminalOpts,
	executionId: string,
	projectName: string,
	result: FinalizeCommDbResult,
): void {
	try {
		opts.onFinalizeOutcome?.(executionId, projectName, result);
	} catch (error) {
		console.warn(
			`[commdb-prune] audit ${result.ok ? "successful" : "failed"} finalize ${executionId} (${projectName}) failed (non-fatal): ${(error as Error).message}`,
		);
	}
}

function finalizeProvenDeadTerminalCommDbSession(
	db: CommDB,
	projectName: string,
	session: Session,
	opts: FinalizeDeadTerminalOpts & { finalizeMode: "sweep" | "point" },
): {
	outcome: DeadTerminalFinalizeOutcome;
	result?: FinalizeCommDbResult;
} {
	let guarded: ReturnType<CommDB["finalizeSessionUnlessTurnHolder"]>;
	try {
		guarded =
			opts.finalizeMode === "point"
				? db.finalizePaneLossResidue(session.execution_id, session.tmux_window)
				: db.finalizeSessionUnlessTurnHolder(session.execution_id);
	} catch (error) {
		const result: FinalizeCommDbResult = {
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			retiredAskCount: 0,
			deletedSessionCount: 0,
			error: (error as Error).message,
		};
		reportFinalizeOutcome(opts, session.execution_id, projectName, result);
		return { outcome: "failed", result };
	}
	if (!guarded.finalized) {
		if (opts.finalizeMode === "sweep" && guarded.reason === "turn_holder") {
			console.log(
				`[commdb-prune] prune_skipped_turn_holder_at_finalize: ${session.execution_id} (${projectName}) acquired the current TURN — KEEPING the row`,
			);
		}
		return {
			outcome:
				guarded.reason === "target_changed"
					? "kept_target_changed"
					: "kept_turn_holder",
		};
	}
	const result: FinalizeCommDbResult = {
		ok: true,
		outcome: "finalized",
		retiredGateCount: guarded.result.retiredQuestionCount,
		retiredAskCount: guarded.result.retiredAskCount,
		deletedSessionCount: guarded.result.deletedSessionCount,
	};
	reportFinalizeOutcome(opts, session.execution_id, projectName, result);
	return { outcome: "finalized", result };
}

export async function finalizeDeadTerminalCommDbSession(
	db: CommDB,
	projectName: string,
	session: Session,
	turnHolders: ReadonlySet<string>,
	opts: FinalizeDeadTerminalOpts & { finalizeMode: "sweep" | "point" },
): Promise<{
	outcome: DeadTerminalFinalizeOutcome;
	result?: FinalizeCommDbResult;
}> {
	const inspection = await inspectDeadTerminalCommDbSession(
		db,
		projectName,
		session,
		turnHolders,
		opts,
	);
	if (inspection !== "eligible_dead") return { outcome: inspection };
	return finalizeProvenDeadTerminalCommDbSession(
		db,
		projectName,
		session,
		opts,
	);
}

export async function finalizeDeadTerminalCommDbSessionById(
	projectName: string,
	executionId: string,
	opts: FinalizeDeadTerminalOpts & {
		dbPath?: string;
		openReadonly?: (dbPath: string) => CommDB;
		openWritable?: (dbPath: string) => CommDB;
	} = {},
): Promise<DeadTerminalFinalizeOutcome> {
	const dbPath = opts.dbPath ?? resolveCommDbPath(projectName);
	if (!dbPath || !existsSync(dbPath)) return "no_row";
	const openReadonly = opts.openReadonly ?? CommDB.openReadonly;
	const openWritable =
		opts.openWritable ?? ((path: string) => new CommDB(path));
	let reader: CommDB | undefined;
	let session: Session | undefined;
	let inspection: DeadTerminalInspectionOutcome;
	try {
		reader = openReadonly(dbPath);
		session = reader.getSession(executionId);
		if (!session) return "no_row";
		const turnHolders = new Set(
			reader.listTurns().map((turn) => turn.holder_exec_id),
		);
		inspection = await inspectDeadTerminalCommDbSession(
			reader,
			projectName,
			session,
			turnHolders,
			{ ...opts, finalizeMode: "point" },
		);
	} finally {
		reader?.close();
	}
	if (inspection !== "eligible_dead") return inspection;

	let writer: CommDB | undefined;
	try {
		writer = openWritable(dbPath);
		return finalizeProvenDeadTerminalCommDbSession(
			writer,
			projectName,
			session,
			{ ...opts, finalizeMode: "point" },
		).outcome;
	} catch (error) {
		const result: FinalizeCommDbResult = {
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			retiredAskCount: 0,
			deletedSessionCount: 0,
			error: (error as Error).message,
		};
		reportFinalizeOutcome(opts, executionId, projectName, result);
		return "failed";
	} finally {
		writer?.close();
	}
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
			const finalized = await finalizeDeadTerminalCommDbSession(
				db,
				projectName,
				s,
				turnHolders,
				{ ...opts, finalizeMode: "sweep" },
			);
			switch (finalized.outcome) {
				case "finalized":
					result.pruned++;
					result.provenDeadTargets.push({
						executionId: s.execution_id,
						tmuxWindow: s.tmux_window,
					});
					break;
				case "kept_turn_holder":
				case "kept_parked":
					result.parkedVetoed++;
					break;
				case "kept_alive":
				case "kept_indeterminate":
					result.kept++;
					break;
				case "failed":
					result.failed++;
					console.warn(
						`[commdb-prune] boot finalize ${s.execution_id} (${projectName}) failed: ${finalized.result?.error ?? "unknown error"}`,
					);
					break;
				default:
					break;
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
