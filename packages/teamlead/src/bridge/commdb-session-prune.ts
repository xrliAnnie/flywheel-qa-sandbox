/**
 * FLY-638: CommDB session-registry pruning.
 *
 * `runner_terminal_list` / Lead bootstrap read the per-project CommDB
 * (`~/.flywheel/comm/<project>/comm.db`) `sessions` table. Terminal rows that
 * outlive their execution bodies pile up and pollute the list + bootstrap with
 * stale entries.
 *
 * Two surfaces — mirroring the FLY-324 live-handler + boot-sweep shape:
 *   1. `finalizeCommDbSession` — live cleanup. Atomically retires unresolved
 *      gates and deletes the session after normal closeout authority.
 *   2. `pruneDeadTerminalCommDbSessions` — boot/maintenance sweep. Clears the
 *      EXISTING backlog: every eligible terminal row whose current execution
 *      body is proven dead. FLY-1066 extends eligibility to failed/blocked only
 *      while its residue-harvest kill-switch is enabled.
 *
 * Safety: only eligible terminal rows are swept (completed/timeout always;
 * failed/blocked only under the residue-harvest switch), and only when shared
 * body liveness says dead. Parked is workflow state, not a liveness veto; live
 * or unknown bodies are retained regardless of window state. The path is
 * project-name-guarded (no traversal) and best-effort:
 * any failure logs a warning and is swallowed (a prune must never break a close
 * or block Bridge startup).
 */

import { existsSync } from "node:fs";
import {
	CommDB,
	type ProvenGoneFinalizationInput,
	type Session,
	type SessionCloseoutIdentity,
} from "flywheel-comm/db";
import { RECONCILE_DELETABLE_STATES } from "./commdb-deletable-states.js";
import { commDbPathForProject } from "./commdb-path.js";
import type { ExecutionBodyLivenessReader } from "./execution-body-reader.js";

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

/** FLY-2498: closing a window only authorizes cleanup after execution death. */
export function decideCloseTmuxCommDbFinalize(input: {
	killed: boolean;
	daemon: "not_codex" | "reaped" | "absent" | "residual" | "unverifiable";
	stateStoreStatus: string | undefined;
}):
	| { finalize: true }
	| {
			finalize: false;
			reason:
				| "kill_failed"
				| "daemon_residual"
				| "daemon_unverifiable"
				| "state_store_not_deletable";
	  } {
	if (!input.killed) return { finalize: false, reason: "kill_failed" };
	if (input.daemon === "residual")
		return { finalize: false, reason: "daemon_residual" };
	if (input.daemon === "unverifiable")
		return { finalize: false, reason: "daemon_unverifiable" };
	if (
		!input.stateStoreStatus ||
		!RECONCILE_DELETABLE_STATES.has(input.stateStoreStatus)
	) {
		return { finalize: false, reason: "state_store_not_deletable" };
	}
	return { finalize: true };
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
		| "evidence_expired"
		| "closeout_identity_changed"
		| "closeout_receipt_conflict"
		| "invalid_trusted_context"
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

/** Exact CommDB row/declaration revision bound into multi-source evidence. */
export function readCommDbCloseoutIdentity(
	executionId: string,
	projectName: string,
	dbPath: string | undefined = resolveCommDbPath(projectName),
): SessionCloseoutIdentity | undefined {
	if (!dbPath) return undefined;
	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		return db.getSessionCloseoutIdentity(executionId);
	} catch (error) {
		console.warn(
			`[commdb-prune] closeout identity unavailable for ${executionId}: ${(error as Error).message}`,
		);
		return undefined;
	} finally {
		db?.close();
	}
}

/** Generation-reservation caller path for exact physically-gone evidence. */
export function finalizeProvenGoneCommDbSession(
	executionId: string,
	projectName: string,
	input: ProvenGoneFinalizationInput,
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
		const finalized = db.finalizeProvenGoneSession(executionId, input);
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
	} catch (error) {
		return {
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			retiredAskCount: 0,
			deletedSessionCount: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		db?.close();
	}
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

/** FLY-2498: exact-target/TURN guarded deletion after independent death proof. */
export function finalizeCommDbPaneLossResidue(
	executionId: string,
	projectName: string,
	expectedTmuxWindow: string,
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
		const finalized = db.finalizePaneLossResidue(
			executionId,
			expectedTmuxWindow,
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
			`[commdb-prune] finalize pane-loss residue ${executionId} (${projectName}) failed: ${(err as Error).message}`,
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
	/** rows deleted (eligible terminal + current execution body proven dead). */
	pruned: number;
	/**
	 * rows KEPT — body is alive or the shared body observation was unknown.
	 * A destructive delete requires proof of death, never absence of proof of life.
	 */
	kept: number;
	/** proven-dead rows whose atomic gate+session finalization failed. */
	failed: number;
	/**
	 * Exact CommDB target identities captured when rows were finalized after body
	 * death. The target binds the same-pass StateStore ghost cleanup; it is not
	 * liveness evidence.
	 */
	provenDeadTargets: ProvenDeadTmuxTarget[];
	/**
	 * Compatibility counter for TURN-holder vetoes. Parked declarations no longer
	 * veto a current-generation body-death fact.
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
	| "kept_target_changed"
	| "failed"
	| "not_wired";

export interface FinalizeDeadTerminalOpts {
	includeCrashPreserve?: boolean;
	/** Current-generation process truth. Window state is never a fallback. */
	readBodyLiveness?: ExecutionBodyLivenessReader;
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
	| "kept_indeterminate";

async function inspectDeadTerminalCommDbSession(
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
	let state: ReturnType<ExecutionBodyLivenessReader> = "unknown";
	try {
		state =
			opts.readBodyLiveness?.(session.execution_id, projectName) ?? "unknown";
	} catch {
		state = "unknown";
	}
	if (state === "alive") return "kept_alive";
	if (state !== "dead") return "kept_indeterminate";
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
 * Boot/maintenance sweep: delete eligible terminal CommDB rows only after the
 * shared convergence path projects current-generation process death. Parked is
 * workflow state, not a liveness veto; live or unknown bodies are retained
 * regardless of the window. Best-effort; never throws.
 */
export async function pruneDeadTerminalCommDbSessions(
	projectName: string,
	opts: {
		dbPath?: string;
		/** FLY-1066: include failed/blocked CRASH_PRESERVE rows. */
		includeCrashPreserve?: boolean;
		readBodyLiveness?: ExecutionBodyLivenessReader;
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
