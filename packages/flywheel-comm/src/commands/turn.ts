/**
 * FLY-887: `flywheel-comm turn --exec-id <id>` — a three-stage phase runner's
 * self-check for the shared-worktree TURN (single-writer activation).
 *
 * A three-stage runner shares ONE physical worktree with the other two phase
 * sessions (design/implement/qa). At any instant only the TURN holder may touch
 * that worktree (git write / run tests / edit files); the others are parked and
 * must not touch it. The Bridge grants the TURN at its handoff/wake points and
 * writes it to CommDB (`three_stage_turn`, Bridge-only writer). The wake message
 * text is NEVER authority — a late or duplicated wake carrying a stale epoch
 * must not make a runner write. So before touching the worktree for ANY reason
 * (including right after a "with-TURN" wake), the runner runs this command and
 * proceeds ONLY on `yours`.
 *
 * Resolution: the runner knows only its own execId, so we look up its session
 * row → issue_id, then read the issue's TURN and compare the holder to execId.
 */

import type { CommDB } from "../db.js";

export interface TurnStatus {
	/** `yours` is the ONLY answer that authorizes touching the worktree. */
	answer: "yours" | "not-yours" | "no-turn";
	phase?: string;
	epoch?: number;
	holderExecId?: string;
	activationId?: string;
	runId?: string;
	nodeId?: string;
	attempt?: number;
}

/**
 * Pure TURN self-check. Resolves the exec's issue via its own session row, then
 * compares the TURN holder to `execId`.
 *   - no session row / session has no issue / no TURN for the issue → `no-turn`
 *   - TURN holder === execId → `yours`
 *   - a different exec holds it → `not-yours`
 */
export function turnStatus(db: CommDB, execId: string): TurnStatus {
	const session = db.getSession(execId);
	const issueId = session?.issue_id;
	if (!issueId) {
		return { answer: "no-turn" };
	}
	const turn = db.getTurn(issueId);
	if (!turn) {
		return { answer: "no-turn" };
	}
	const answer = turn.holder_exec_id === execId ? "yours" : "not-yours";
	const activation =
		answer === "yours" ? db.resolveRunnerWorkflowActivation(execId) : undefined;
	if (activation?.state === "stale") {
		return {
			answer: "not-yours",
			phase: turn.phase,
			epoch: turn.epoch,
			holderExecId: turn.holder_exec_id,
		};
	}
	return {
		answer,
		phase: turn.phase,
		epoch: turn.epoch,
		holderExecId: turn.holder_exec_id,
		...(activation?.state === "active"
			? {
					activationId: activation.activation.activation_id,
					runId: activation.activation.run_id,
					nodeId: activation.activation.node_id,
					attempt: activation.activation.attempt,
				}
			: {}),
	};
}

export function recordTurnWait(
	db: CommDB,
	execId: string,
	status: TurnStatus,
	options: {
		observedAtMs: number;
		askAfterMs: number;
		noTurnClearMinMs?: number;
	},
): { asked: boolean; questionId?: string } {
	if (status.answer === "yours") {
		db.clearTurnWaitOnGrant(execId);
		return { asked: false };
	}
	if (status.answer === "no-turn") {
		db.observeNoTurnForWaiter({
			executionId: execId,
			observedAtMs: options.observedAtMs,
			minimumIntervalMs: options.noTurnClearMinMs ?? 30_000,
		});
		return { asked: false };
	}
	if (!status.holderExecId || !status.phase || status.epoch === undefined) {
		return { asked: false };
	}
	return db.observeTurnWait({
		executionId: execId,
		holderExecId: status.holderExecId,
		phase: status.phase,
		epoch: status.epoch,
		observedAtMs: options.observedAtMs,
		askAfterMs: options.askAfterMs,
	});
}

const DEFAULT_TURN_WAIT_ASK_MINUTES = 20;
const MIN_TURN_WAIT_ASK_MINUTES = 5;
const MAX_TURN_WAIT_ASK_MINUTES = 720;

/** Parse the operator override without allowing an accidental alert storm. */
export function turnWaitAskAfterMs(
	env: Record<string, string | undefined>,
): number {
	const raw = env.FLYWHEEL_TURN_WAIT_ASK_MINUTES;
	if (raw !== undefined && /^\d+$/.test(raw)) {
		const minutes = Number(raw);
		if (
			Number.isSafeInteger(minutes) &&
			minutes >= MIN_TURN_WAIT_ASK_MINUTES &&
			minutes <= MAX_TURN_WAIT_ASK_MINUTES
		) {
			return minutes * 60_000;
		}
	}
	return DEFAULT_TURN_WAIT_ASK_MINUTES * 60_000;
}

/** An explicit id is a debug-only read when it is not this runner's identity. */
export function isTurnDebugOverride(
	explicitExecId: string | undefined,
	envExecId: string | undefined,
): boolean {
	return Boolean(explicitExecId && explicitExecId !== envExecId);
}

export function recordTurnCommandSideEffects(
	db: CommDB,
	execId: string,
	status: TurnStatus,
	options: {
		observedAtMs: number;
		askAfterMs: number;
		debugOverride: boolean;
	},
): { waitAsked: boolean; turnWakeAcks: number; runnerReceiptAcks: number } {
	if (options.debugOverride) {
		return { waitAsked: false, turnWakeAcks: 0, runnerReceiptAcks: 0 };
	}
	const wait = recordTurnWait(db, execId, status, options);
	return {
		waitAsked: wait.asked,
		turnWakeAcks: recordTurnWakeReceipt(
			db,
			execId,
			status,
			options.observedAtMs,
		),
		runnerReceiptAcks: db.ackRunnerReceiptWakesStarted(
			execId,
			options.observedAtMs,
			"exec_cli",
		),
	};
}

export function recordTurnWakeReceipt(
	db: CommDB,
	execId: string,
	status: TurnStatus,
	ackedAtMs: number,
): number {
	if (status.answer !== "yours" || status.epoch === undefined) return 0;
	return db.ackTurnWakes({
		executionId: execId,
		epoch: status.epoch,
		...(status.activationId ? { activationId: status.activationId } : {}),
		ackedAtMs,
	});
}

/** Format a TurnStatus for the CLI's single stdout line (the runner-facing contract). */
export function formatTurnStatus(status: TurnStatus): string {
	if (status.answer === "no-turn") {
		return "no-turn";
	}
	if (status.answer === "yours") {
		const activation = status.activationId
			? ` activation=${status.activationId} run=${status.runId} node=${status.nodeId} attempt=${status.attempt}`
			: "";
		return `yours phase=${status.phase} epoch=${status.epoch}${activation}`;
	}
	return `not-yours holder=${status.holderExecId} phase=${status.phase} epoch=${status.epoch}`;
}
