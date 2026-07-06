// FLY-904 scratch — pure-TypeScript reducer mirroring the FLY-887 R2 TURN protocol.
// Semantic mirror of the authoritative state table in
// engineering/doc/FLY-887-phase-session-keepalive/plan.md (transcribed in
// engineering/doc/FLY-904-qa-e2e-529-room/research.md §1); contract in plan.md §2.
// Zero deps, zero I/O, never wired into packages/ or the pnpm workspace.

export type Phase = "design" | "implement" | "qa";
export type PhaseStatus = "absent" | "running" | "parked" | "closed";

export interface TurnState {
	turn: Phase | null; // TURN holder; null only after finalize
	epoch: number; // +1 on every grant, strictly increasing; starts at 1
	design: PhaseStatus; // starts "running"
	implement: PhaseStatus; // starts "absent"
	qa: PhaseStatus; // starts "absent"
	verdict: "none" | "pass"; // "pass" after qa_pass (approve gate pending)
	fixRounds: number; // qa_fail counter; cap below
	worktreePresent: boolean; // true until the merged finalize
}

export const FIX_ROUNDS_CAP = 3;

// Initial state: design dispatched holding TURN epoch 1.
export const initialState: TurnState = Object.freeze({
	turn: "design",
	epoch: 1,
	design: "running",
	implement: "absent",
	qa: "absent",
	verdict: "none",
	fixRounds: 0,
	worktreePresent: true,
});

export type TurnEvent =
	| { type: "phase_design_complete" } // design handback (first pass and post-redo, T1/T8)
	| { type: "needs_review" } // implement handback (first pass and RE-TEST, T2/T4)
	| { type: "qa_fail" } // QA handback → fix loop (T3)
	| { type: "qa_pass" } // approve gate pending, TURN stays with QA (T5)
	| { type: "design_redo" } // Lead wakes parked design (T7)
	| { type: "merged" }; // verified merge → unified finalize (T6)

export type TurnResult =
	| { ok: true; state: TurnState }
	| {
			ok: false;
			reason: "not_your_turn" | "bad_state" | "fix_cap_exceeded";
			state: TurnState;
	  };

// Owner phase of each handback-type event, for the not_your_turn check.
const HANDBACK_OWNER: Partial<Record<TurnEvent["type"], Phase>> = {
	phase_design_complete: "design",
	needs_review: "implement",
	qa_fail: "qa",
	qa_pass: "qa",
};

export function nextTurn(state: TurnState, event: TurnEvent): TurnResult {
	const refuse = (
		reason: "not_your_turn" | "bad_state" | "fix_cap_exceeded",
	): TurnResult => ({ ok: false, reason, state });
	const grant = (next: TurnState): TurnResult => ({ ok: true, state: next });

	// Refusal precedence per plan §2.5 — rule 0: nothing after finalize (X5).
	if (state.turn === null) {
		return refuse("bad_state");
	}

	// Rule 0.5: ship pending (verdict=pass) never rolls back (X6a/X6b),
	// checked before any grant and before the fix cap.
	if (
		state.verdict === "pass" &&
		(event.type === "qa_fail" || event.type === "design_redo")
	) {
		return refuse("bad_state");
	}

	// Rule 1: fix cap (X3) — only a legitimate in-turn qa_fail can hit it.
	if (
		event.type === "qa_fail" &&
		state.turn === "qa" &&
		state.qa === "running" &&
		state.fixRounds >= FIX_ROUNDS_CAP
	) {
		return refuse("fix_cap_exceeded");
	}

	// Rule 2: handback signal from a phase that does not hold TURN (X1).
	const owner = HANDBACK_OWNER[event.type];
	if (owner !== undefined && owner !== state.turn) {
		return refuse("not_your_turn");
	}

	// Rule 3 + grants: remaining guards refuse as bad_state (X2/X4).
	switch (event.type) {
		case "phase_design_complete": // T1 (implement absent → spawn) / T8 (parked → wake)
			if (state.design !== "running") {
				return refuse("bad_state");
			}
			return grant({
				...state,
				design: "parked",
				implement: "running",
				turn: "implement",
				epoch: state.epoch + 1,
			});

		case "needs_review": // T2 (qa absent → spawn) / T4 (parked → RE-TEST wake)
			if (state.implement !== "running" || state.qa === "running" || state.qa === "closed") {
				return refuse("bad_state");
			}
			return grant({
				...state,
				implement: "parked",
				qa: "running",
				turn: "qa",
				epoch: state.epoch + 1,
			});

		case "qa_fail": // T3 — verdict=none guaranteed by rule 0.5, cap by rule 1
			if (state.qa !== "running") {
				return refuse("bad_state");
			}
			return grant({
				...state,
				fixRounds: state.fixRounds + 1,
				qa: "parked",
				implement: "running",
				turn: "implement",
				epoch: state.epoch + 1,
			});

		case "qa_pass": // T5 — approve gate pending; TURN, statuses, epoch all unchanged
			if (state.qa !== "running") {
				return refuse("bad_state");
			}
			return grant({ ...state, verdict: "pass" });

		case "design_redo": // T7 — only implement can be the parked-aside running phase
			if (state.design !== "parked" || state.qa === "running") {
				return refuse("bad_state");
			}
			return grant({
				...state,
				design: "running",
				implement: state.implement === "running" ? "parked" : state.implement,
				turn: "design",
				epoch: state.epoch + 1,
			});

		case "merged": // T6 — unified finalize, only after the approve gate (X4)
			if (state.verdict !== "pass") {
				return refuse("bad_state");
			}
			return grant({
				...state,
				design: state.design === "absent" ? "absent" : "closed",
				implement: state.implement === "absent" ? "absent" : "closed",
				qa: state.qa === "absent" ? "absent" : "closed",
				turn: null,
				worktreePresent: false,
			});

		default:
			return refuse("bad_state");
	}
}
