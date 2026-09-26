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
	return {
		answer,
		phase: turn.phase,
		epoch: turn.epoch,
		holderExecId: turn.holder_exec_id,
	};
}

/** Format a TurnStatus for the CLI's single stdout line (the runner-facing contract). */
export function formatTurnStatus(status: TurnStatus): string {
	if (status.answer === "no-turn") {
		return "no-turn";
	}
	if (status.answer === "yours") {
		return `yours phase=${status.phase} epoch=${status.epoch}`;
	}
	return `not-yours holder=${status.holderExecId} phase=${status.phase} epoch=${status.epoch}`;
}
