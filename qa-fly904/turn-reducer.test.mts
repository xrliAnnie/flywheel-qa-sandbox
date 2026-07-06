// FLY-904 scratch — vitest suite for the TURN-protocol reducer mirroring FLY-887 R2.
// Oracle: engineering/doc/FLY-904-qa-e2e-529-room/plan.md §2.4 (T1-T8), §2.5 (X1-X6b),
// §2.6 (I1-I4). One case per authoritative transition row and per illegal-event row.
import { describe, expect, test } from "vitest";
import {
	FIX_ROUNDS_CAP,
	initialState,
	nextTurn,
	type TurnEvent,
	type TurnResult,
	type TurnState,
} from "./turn-reducer.mts";

const PHASES = ["design", "implement", "qa"] as const;

// I1: at most one phase running; before finalize the running phase IS the TURN
// holder; after finalize (turn=null) nothing runs.
function assertI1(state: TurnState): void {
	const running = PHASES.filter((p) => state[p] === "running");
	expect(running.length).toBeLessThanOrEqual(1);
	if (state.turn === null) {
		expect(running).toEqual([]);
	} else {
		expect(running).toEqual([state.turn]);
	}
}

// I4 wrapper: deep-clone snapshot before the call, deep-equal after — the input
// must never be mutated on ANY call path; on ok:false the returned state must be
// the exact same reference as the input. Also folds I1 into every case.
function call(state: TurnState, event: TurnEvent): TurnResult {
	const snapshot = structuredClone(state);
	const result = nextTurn(state, event);
	expect(state).toEqual(snapshot);
	if (result.ok) {
		// I1 binds states the reducer PRODUCES; refused inputs may be
		// deliberately corrupt fixtures (e.g. X2's turn=qa ∧ qa=parked).
		assertI1(result.state);
	} else {
		expect(result.state).toBe(state);
	}
	return result;
}

function grant(state: TurnState, event: TurnEvent): TurnState {
	const result = call(state, event);
	expect(result.ok).toBe(true);
	return result.state;
}

function refuse(
	state: TurnState,
	event: TurnEvent,
	reason: "not_your_turn" | "bad_state" | "fix_cap_exceeded",
): void {
	const result = call(state, event);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe(reason);
	}
}

function mkState(partial: Partial<TurnState>): TurnState {
	return { ...initialState, ...partial };
}

// Canonical mid-pipeline fixtures (hand-built to match reachable states).
const afterT1 = mkState({
	turn: "implement",
	epoch: 2,
	design: "parked",
	implement: "running",
});
const afterT2 = mkState({
	turn: "qa",
	epoch: 3,
	design: "parked",
	implement: "parked",
	qa: "running",
});
const afterT5 = mkState({
	turn: "qa",
	epoch: 3,
	design: "parked",
	implement: "parked",
	qa: "running",
	verdict: "pass",
});
const finalized = mkState({
	turn: null,
	epoch: 3,
	design: "closed",
	implement: "closed",
	qa: "closed",
	verdict: "pass",
	worktreePresent: false,
});

describe("transitions (plan §2.4)", () => {
	test("T1 design complete → implement spawned", () => {
		const next = grant(initialState, { type: "phase_design_complete" });
		expect(next).toEqual(
			mkState({
				turn: "implement",
				epoch: 2,
				design: "parked",
				implement: "running",
			}),
		);
	});

	test("T2 needs_review (qa absent) → qa spawned", () => {
		const next = grant(afterT1, { type: "needs_review" });
		expect(next).toEqual(afterT2);
	});

	test("T3 qa_fail under cap → implement woken, fixRounds+1", () => {
		const next = grant(afterT2, { type: "qa_fail" });
		expect(next).toEqual(
			mkState({
				turn: "implement",
				epoch: 4,
				design: "parked",
				implement: "running",
				qa: "parked",
				fixRounds: 1,
			}),
		);
	});

	test("T4 needs_review (qa parked) → qa woken for RE-TEST", () => {
		const fixing = mkState({
			turn: "implement",
			epoch: 4,
			design: "parked",
			implement: "running",
			qa: "parked",
			fixRounds: 1,
		});
		const next = grant(fixing, { type: "needs_review" });
		expect(next).toEqual(
			mkState({
				turn: "qa",
				epoch: 5,
				design: "parked",
				implement: "parked",
				qa: "running",
				fixRounds: 1,
			}),
		);
	});

	test("T5 qa_pass → verdict pass, TURN and statuses unchanged, epoch unchanged", () => {
		const next = grant(afterT2, { type: "qa_pass" });
		expect(next).toEqual(afterT5);
	});

	test("T6 merged after pass → unified finalize (closed/closed/closed, turn null, worktree gone)", () => {
		const next = grant(afterT5, { type: "merged" });
		expect(next).toEqual(finalized);
	});

	test("T7 design_redo parks running implement, wakes parked design", () => {
		const next = grant(afterT1, { type: "design_redo" });
		expect(next).toEqual(
			mkState({
				turn: "design",
				epoch: 3,
				design: "running",
				implement: "parked",
			}),
		);
	});

	test("T8 redo handback (implement not absent) → implement woken", () => {
		const redoing = mkState({
			turn: "design",
			epoch: 3,
			design: "running",
			implement: "parked",
		});
		const next = grant(redoing, { type: "phase_design_complete" });
		expect(next).toEqual(
			mkState({
				turn: "implement",
				epoch: 4,
				design: "parked",
				implement: "running",
			}),
		);
	});
});

describe("illegal / out-of-order events (plan §2.5)", () => {
	test("X1 not_your_turn — handback signal from a phase that does not hold TURN", () => {
		// turn=implement, qa handback signal
		refuse(afterT1, { type: "qa_fail" }, "not_your_turn");
		// turn=design (initial), implement handback signal
		refuse(initialState, { type: "needs_review" }, "not_your_turn");
		// turn=qa, design handback signal
		refuse(afterT2, { type: "phase_design_complete" }, "not_your_turn");
		// turn=implement, qa_pass
		refuse(afterT1, { type: "qa_pass" }, "not_your_turn");
	});

	test("X2 bad_state — TURN holder (or ownerless event) with unmet guard", () => {
		// design_redo while design is running, not parked
		refuse(initialState, { type: "design_redo" }, "bad_state");
		// design_redo while qa is running (not an 887-defined scenario)
		refuse(afterT2, { type: "design_redo" }, "bad_state");
		// turn=qa but qa not running: qa_pass guard unmet, owner matches turn
		const oddQa = mkState({
			turn: "qa",
			epoch: 3,
			design: "parked",
			implement: "parked",
			qa: "parked",
		});
		refuse(oddQa, { type: "qa_pass" }, "bad_state");
	});

	test("X3 fix_cap_exceeded — qa_fail at the cap refuses, TURN does not flip", () => {
		const atCap = mkState({
			turn: "qa",
			epoch: 9,
			design: "parked",
			implement: "parked",
			qa: "running",
			fixRounds: FIX_ROUNDS_CAP,
		});
		refuse(atCap, { type: "qa_fail" }, "fix_cap_exceeded");
	});

	test("X4 merged before approve gate (verdict=none) is refused", () => {
		refuse(initialState, { type: "merged" }, "bad_state");
		refuse(afterT2, { type: "merged" }, "bad_state");
	});

	test("X5 any event after finalize (turn=null) is refused", () => {
		refuse(finalized, { type: "phase_design_complete" }, "bad_state");
		refuse(finalized, { type: "needs_review" }, "bad_state");
		refuse(finalized, { type: "qa_fail" }, "bad_state");
		refuse(finalized, { type: "qa_pass" }, "bad_state");
		refuse(finalized, { type: "design_redo" }, "bad_state");
		refuse(finalized, { type: "merged" }, "bad_state");
	});

	test("X6a design_redo after qa_pass (ship pending) is refused", () => {
		refuse(afterT5, { type: "design_redo" }, "bad_state");
	});

	test("X6b qa_fail after qa_pass (ship pending) is refused — precedence 0.5 beats T3 and the cap", () => {
		refuse(afterT5, { type: "qa_fail" }, "bad_state");
		// Even at the cap, verdict=pass must yield bad_state, not fix_cap_exceeded.
		const passedAtCap = mkState({ ...afterT5, fixRounds: FIX_ROUNDS_CAP });
		refuse(passedAtCap, { type: "qa_fail" }, "bad_state");
	});
});

describe("invariants (plan §2.6)", () => {
	test("full happy-path chain T1→T2→T3→T4→T5→T6 with epoch sequence 1,2,3,4,5,5,5", () => {
		const chain: TurnEvent["type"][] = [
			"phase_design_complete",
			"needs_review",
			"qa_fail",
			"needs_review",
			"qa_pass",
			"merged",
		];
		let state = initialState;
		const epochs: number[] = [state.epoch];
		for (const type of chain) {
			const prevEpoch = state.epoch;
			state = grant(state, { type } as TurnEvent);
			// I2: epoch is monotonically non-decreasing, only grants bump it
			expect(state.epoch).toBeGreaterThanOrEqual(prevEpoch);
			// I3: worktree survives until merged, gone exactly after merged
			expect(state.worktreePresent).toBe(state.turn !== null);
			epochs.push(state.epoch);
		}
		expect(epochs).toEqual([1, 2, 3, 4, 5, 5, 5]);
		expect(state).toEqual(
			mkState({
				turn: null,
				epoch: 5,
				design: "closed",
				implement: "closed",
				qa: "closed",
				verdict: "pass",
				fixRounds: 1,
				worktreePresent: false,
			}),
		);
	});

	// QA-added (FLY-904 scenario 2): the design-redo round trip exists in the suite
	// only as disconnected T7/T8 unit rows against hand-built fixtures. This chains
	// T1→T7→T8→T2→T5→T6 to prove epoch stays strictly increasing across the redo
	// (grants) and flat on qa_pass/merged, and that a redo does not leave residue.
	test("design-redo round-trip chain T1→T7→T8→T2→T5→T6 with epoch sequence 1,2,3,4,5,5,5", () => {
		const chain: TurnEvent["type"][] = [
			"phase_design_complete", // T1
			"design_redo", // T7 — Lead wakes parked design, parks running implement
			"phase_design_complete", // T8 — redo handback re-wakes implement
			"needs_review", // T2
			"qa_pass", // T5
			"merged", // T6
		];
		let state = initialState;
		const epochs: number[] = [state.epoch];
		for (const type of chain) {
			const prevEpoch = state.epoch;
			state = grant(state, { type } as TurnEvent);
			expect(state.epoch).toBeGreaterThanOrEqual(prevEpoch);
			expect(state.worktreePresent).toBe(state.turn !== null);
			epochs.push(state.epoch);
		}
		expect(epochs).toEqual([1, 2, 3, 4, 5, 5, 5]);
		expect(state).toEqual(
			mkState({
				turn: null,
				epoch: 5,
				design: "closed",
				implement: "closed",
				qa: "closed",
				verdict: "pass",
				fixRounds: 0,
				worktreePresent: false,
			}),
		);
	});
});
