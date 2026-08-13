import type { PhaseLiveness } from "./phase-actor-reentry.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";

export const GHOST_PROBE_MAX_ROWS = 3;
export const TURN_GRANT_GRACE_MS = 5 * 60_000;

export type WorkflowActorRole = "design" | "implement" | "qa";

export interface WorktreeTurnRow {
	issue_id: string;
	holder_exec_id: string;
	phase: string;
	epoch: number;
	granted_at: number;
}

const TURN_RECOVERY_PRIORITY: readonly WorkflowActorRole[] = [
	"qa",
	"implement",
	"design",
];
const TERMINAL_SESSION_STATUS = new Set(["completed", "failed"]);

export interface TurnBeltReconcilerDeps {
	turnBelt: {
		listTurns(): { projectName: string; turn: WorktreeTurnRow }[];
		getTurn(issueId: string, projectName: string): WorktreeTurnRow | null;
		deleteTurn(issueId: string, projectName: string): void;
		getSessionForTurnHolder(execId: string): WorkflowActorSession | undefined;
		getActorSessionsForIssue(issueId: string): WorkflowActorSession[];
	};
	isEngineOwnedExecution?(executionId: string): boolean;
	alertWorktreeTakeoverFailure?(args: {
		session: WorkflowActorSession;
		reason: string;
	}): Promise<void>;
	probeActorAlive(session: WorkflowActorSession): Promise<PhaseLiveness>;
	wakeRecoveredTurn?(args: {
		session: WorkflowActorSession;
		epoch: number;
		previousHolderExecId: string;
		reason: string;
	}): Promise<{ ok: boolean; error?: string }>;
	grantTurn(args: {
		issueId: string;
		execId: string;
		phase: WorkflowActorRole;
		projectName: string;
		sourceEventId: string;
	}): void;
	alertLead(args: {
		session: WorkflowActorSession;
		reason: string;
	}): Promise<void>;
	logger?: { warn?: (message: string) => void };
}

/** Recover an orphaned shared-worktree TURN without depending on retired dispatch. */
export class TurnBeltReconciler {
	constructor(private readonly deps: TurnBeltReconcilerDeps) {}

	private warn(message: string): void {
		(this.deps.logger?.warn ?? console.warn)(message);
	}
	private isEngineOwned(executionId: string): boolean {
		if (!this.deps.isEngineOwnedExecution) return false;
		try {
			return this.deps.isEngineOwnedExecution(executionId);
		} catch (error) {
			this.warn(
				`engine ownership lookup failed for ${executionId}: ${(error as Error).message} — TURN recovery suppressed`,
			);
			return true;
		}
	}

	async alertWorktreeTakeoverFailure(
		session: WorkflowActorSession,
		reason: string,
	): Promise<void> {
		if (!this.isEngineOwned(session.execution_id)) return;
		const role = session.chat_thread_role ?? session.session_role;
		if (role !== "design" && role !== "implement" && role !== "qa") return;
		try {
			await this.deps.alertWorktreeTakeoverFailure?.({ session, reason });
		} catch (error) {
			this.warn(
				`worktree takeover alert failed for ${session.execution_id}: ${(error as Error).message}`,
			);
		}
	}

	async reconcileTurnBelt(scope?: {
		issueId: string;
		projectName: string;
		terminalExecId?: string;
	}): Promise<void> {
		if (scope) {
			if (scope.terminalExecId && this.isEngineOwned(scope.terminalExecId)) {
				return;
			}
			let turn: WorktreeTurnRow | null;
			try {
				turn = this.deps.turnBelt.getTurn(scope.issueId, scope.projectName);
			} catch (error) {
				this.warn(
					`reconcileTurnBelt getTurn failed for ${scope.issueId}: ${(error as Error).message}`,
				);
				return;
			}
			if (!turn) return;
			if (this.isEngineOwned(turn.holder_exec_id)) return;
			if (
				scope.terminalExecId &&
				turn.holder_exec_id !== scope.terminalExecId
			) {
				return;
			}
			await this.reconcileOneTurn(scope.projectName, turn);
			return;
		}

		let rows: { projectName: string; turn: WorktreeTurnRow }[];
		try {
			rows = this.deps.turnBelt.listTurns();
		} catch (error) {
			this.warn(
				`reconcileTurnBelt listTurns failed: ${(error as Error).message}`,
			);
			return;
		}
		for (const { projectName, turn } of rows) {
			if (this.isEngineOwned(turn.holder_exec_id)) continue;
			try {
				await this.reconcileOneTurn(projectName, turn);
			} catch (error) {
				this.warn(
					`reconcileTurnBelt failed for ${turn.issue_id}: ${(error as Error).message}`,
				);
			}
		}
	}

	private async reconcileOneTurn(
		projectName: string,
		turn: WorktreeTurnRow,
	): Promise<void> {
		const holder = this.deps.turnBelt.getSessionForTurnHolder(
			turn.holder_exec_id,
		);
		let staleReason: string;
		if (!holder) {
			const ageMs = Date.now() - turn.granted_at;
			if (ageMs < TURN_GRANT_GRACE_MS) return;
			staleReason = `holder session row missing (granted ${Math.round(ageMs / 1000)}s ago — dispatch remnant)`;
		} else if (TERMINAL_SESSION_STATUS.has(holder.status)) {
			const holderRole = holder.chat_thread_role ?? holder.session_role;
			if (holder.status === "completed" && holderRole === "qa") return;
			staleReason = `holder session is terminal (${holder.status})`;
		} else {
			const liveness = await this.deps.probeActorAlive(holder);
			if (liveness === "alive" || liveness === "indeterminate") return;
			staleReason = `holder process ${liveness}`;
		}

		const candidates = this.deps.turnBelt
			.getActorSessionsForIssue(turn.issue_id)
			.filter(
				(session) =>
					session.execution_id !== turn.holder_exec_id &&
					!TERMINAL_SESSION_STATUS.has(session.status),
			);
		for (const role of TURN_RECOVERY_PRIORITY) {
			for (const candidate of candidates.filter(
				(session) =>
					(session.chat_thread_role ?? session.session_role) === role,
			)) {
				const liveness = await this.deps.probeActorAlive(candidate);
				if (liveness === "indeterminate") {
					this.warn(
						`reconcileTurnBelt: candidate ${candidate.execution_id} liveness indeterminate on ${turn.issue_id} — leaving TURN untouched this round`,
					);
					return;
				}
				if (liveness !== "alive") continue;
				this.deps.grantTurn({
					issueId: turn.issue_id,
					execId: candidate.execution_id,
					phase: role,
					projectName,
					sourceEventId: `turn:recovery:${turn.issue_id}:${turn.holder_exec_id}:${turn.epoch}:${candidate.execution_id}`,
				});
				const wake = await this.deps.wakeRecoveredTurn?.({
					session: candidate,
					epoch: turn.epoch + 1,
					previousHolderExecId: turn.holder_exec_id,
					reason: staleReason,
				});
				await this.failClosed(
					candidate,
					`turn-belt recovered a STALE TURN on ${turn.issue_id}: ${staleReason}; holder ${turn.holder_exec_id} (epoch ${turn.epoch}) → ${candidate.execution_id} (${role}, epoch ${turn.epoch + 1}). ${wake?.ok ? `The parked ${role} actor was actively woken.` : `Durable wake is pending${wake?.error ? ` (${wake.error})` : ""}.`}`,
				);
				return;
			}
		}

		this.deps.turnBelt.deleteTurn(turn.issue_id, projectName);
		await this.failClosed(
			holder ?? {
				execution_id: turn.holder_exec_id,
				issue_id: turn.issue_id,
				project_name: projectName,
				status: "unknown",
			},
			`turn-belt: STALE TURN on ${turn.issue_id} (${staleReason}; holder ${turn.holder_exec_id}, epoch ${turn.epoch}) had NO live actor to recover to — TURN released; the next spawn's pre-launch seam re-creates it.`,
		);
	}

	private async failClosed(
		session: WorkflowActorSession,
		reason: string,
	): Promise<void> {
		this.warn(`FAIL-CLOSED ${session.issue_id}: ${reason}`);
		try {
			await this.deps.alertLead({ session, reason });
		} catch (error) {
			this.warn(`alertLead also failed: ${(error as Error).message}`);
		}
	}
}
