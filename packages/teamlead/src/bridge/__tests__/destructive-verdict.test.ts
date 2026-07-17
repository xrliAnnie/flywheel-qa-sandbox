import { describe, expect, it } from "vitest";
import {
	type DestructiveVerdictInput,
	decideDestructive,
} from "../destructive-verdict.js";

/**
 * FLY-1329 A1: the four-input destructive verdict.
 *
 * The FLY-1319 incident: `handoff()` read `absent` (a CommDB window-name miss)
 * as proof of death and closed a park-alive implement session whose process was
 * still running. Liveness ALONE never authorizes destruction — the verdict takes
 * (action, lifecycle authority, declared state, liveness).
 */

function input(
	over: Partial<DestructiveVerdictInput> = {},
): DestructiveVerdictInput {
	return {
		action: "handoff_close",
		authority: "none",
		declaredParked: false,
		liveness: "alive",
		...over,
	};
}

describe("FLY-1329 A1 destructive verdict — authorizing branches", () => {
	it("dead_pin authorizes a liveness-derived handoff close (positive death evidence)", () => {
		const v = decideDestructive(input({ liveness: "dead_pin" }));
		expect(v.allowed).toBe(true);
		expect(v.authorizedBy).toBe("dead_pin");
	});

	it("dead_pin authorizes a wake-replacement spawn", () => {
		const v = decideDestructive(
			input({ action: "wake_replacement_spawn", liveness: "dead_pin" }),
		);
		expect(v.allowed).toBe(true);
	});

	it("post-ship finalization claim authorizes regardless of liveness", () => {
		for (const liveness of [
			"alive",
			"absent",
			"indeterminate",
			"dead_pin",
		] as const) {
			const v = decideDestructive(
				input({
					action: "commdb_residue_prune",
					authority: "post_ship_claim",
					liveness,
				}),
			);
			expect(v.allowed, `liveness=${liveness}`).toBe(true);
			expect(v.authorizedBy).toBe("post_ship_claim");
		}
	});

	it("founder/issue-terminal disposition authorizes regardless of liveness", () => {
		const v = decideDestructive(
			input({
				action: "commdb_residue_prune",
				authority: "founder_disposition",
				liveness: "absent",
			}),
		);
		expect(v.allowed).toBe(true);
		expect(v.authorizedBy).toBe("founder_disposition");
	});

	/**
	 * R2-1 correction to v2's absolute wording: after a NORMAL teardown the window
	 * is necessarily `absent`. A fresh-terminal FSM row's CommDB residue MUST stay
	 * prunable on `absent` — otherwise A4 could never clean up anything.
	 */
	it("fresh FSM-terminal authority prunes CommDB residue on absent (normal teardown shape)", () => {
		const v = decideDestructive(
			input({
				action: "commdb_residue_prune",
				authority: "fsm_terminal",
				liveness: "absent",
			}),
		);
		expect(v.allowed).toBe(true);
		expect(v.authorizedBy).toBe("fsm_terminal");
	});

	it("fresh FSM-terminal authority prunes CommDB residue on dead_pin too", () => {
		const v = decideDestructive(
			input({
				action: "commdb_residue_prune",
				authority: "fsm_terminal",
				liveness: "dead_pin",
			}),
		);
		expect(v.allowed).toBe(true);
	});

	it("a legitimate completed assertion (FLY-324) authorizes without requiring dead_pin", () => {
		const v = decideDestructive(
			input({
				action: "completed_assertion",
				authority: "completed_assertion",
				liveness: "alive",
			}),
		);
		expect(v.allowed).toBe(true);
	});

	/**
	 * Codex R1 MEDIUM: dead_pin authorizes liveness-derived CLEANUPS only. Asserting
	 * a session COMPLETED is an FSM claim about its work, and "the process died" is
	 * not evidence the work completed legitimately — so death must NOT authorize a
	 * completed_assertion. That needs a completion authority.
	 */
	it("dead_pin does NOT authorize a completed_assertion — death is not a completion", () => {
		const v = decideDestructive(
			input({
				action: "completed_assertion",
				authority: "none",
				liveness: "dead_pin",
			}),
		);
		expect(v.allowed).toBe(false);
		expect(v.vetoedBy).toBe("liveness");
	});

	it("dead_pin still authorizes each liveness-derived cleanup action", () => {
		for (const action of [
			"handoff_close",
			"wake_replacement_spawn",
			"commdb_residue_prune",
		] as const) {
			const v = decideDestructive(
				input({ action, authority: "none", liveness: "dead_pin" }),
			);
			expect(v.allowed, `action=${action}`).toBe(true);
			expect(v.authorizedBy).toBe("dead_pin");
		}
	});

	it("a completed_assertion is still authorized by its completion authority on dead_pin", () => {
		// The authority branch runs before the liveness branch, so a legitimate
		// completion authority still authorizes regardless of the death probe.
		const v = decideDestructive(
			input({
				action: "completed_assertion",
				authority: "completed_assertion",
				liveness: "dead_pin",
			}),
		);
		expect(v.allowed).toBe(true);
		expect(v.authorizedBy).toBe("completed_assertion");
	});
});

describe("FLY-1329 A1 destructive verdict — veto rules", () => {
	/** THE FLY-1319 INCIDENT, as a unit assertion. */
	it("absent NEVER authorizes closing a non-terminal session (FLY-1319 regression)", () => {
		const v = decideDestructive(input({ liveness: "absent" }));
		expect(v.allowed).toBe(false);
		expect(v.reason).toContain("absent");
	});

	it("absent never authorizes a wake-replacement spawn (double-spawn guard)", () => {
		const v = decideDestructive(
			input({ action: "wake_replacement_spawn", liveness: "absent" }),
		);
		expect(v.allowed).toBe(false);
	});

	it("indeterminate never authorizes destruction", () => {
		for (const action of [
			"handoff_close",
			"wake_replacement_spawn",
			"commdb_residue_prune",
			"completed_assertion",
		] as const) {
			const v = decideDestructive(input({ action, liveness: "indeterminate" }));
			expect(v.allowed, `action=${action}`).toBe(false);
		}
	});

	it("alive never authorizes destruction without independent authority", () => {
		const v = decideDestructive(input({ liveness: "alive" }));
		expect(v.allowed).toBe(false);
	});

	/** An unexpired parked declaration VETOES A4/A5 even with terminal authority. */
	it("unexpired parked declaration vetoes CommDB residue prune (fsm_terminal authority)", () => {
		const v = decideDestructive(
			input({
				action: "commdb_residue_prune",
				authority: "fsm_terminal",
				declaredParked: true,
				liveness: "absent",
			}),
		);
		expect(v.allowed).toBe(false);
		expect(v.vetoedBy).toBe("parked_declaration");
		expect(v.auditKind).toBe("prune_skipped_parked_conflict");
	});

	it("unexpired parked declaration vetoes a completed assertion (FLY-324)", () => {
		const v = decideDestructive(
			input({
				action: "completed_assertion",
				authority: "completed_assertion",
				declaredParked: true,
				liveness: "alive",
			}),
		);
		expect(v.allowed).toBe(false);
		expect(v.vetoedBy).toBe("parked_declaration");
		expect(v.auditKind).toBe("prune_skipped_parked_conflict");
	});

	/**
	 * The parked veto is scoped to the A4/A5 reconcile contexts. `handoff_close`
	 * on a dead_pin corpse is the pipeline's own boundary: the park marker there
	 * describes the session we are handing off FROM, so it must not veto.
	 */
	it("parked declaration does NOT veto a dead_pin handoff close (pipeline's own boundary)", () => {
		const v = decideDestructive(
			input({
				action: "handoff_close",
				declaredParked: true,
				liveness: "dead_pin",
			}),
		);
		expect(v.allowed).toBe(true);
	});

	/** post_ship / founder authority outrank the parked veto (they are terminal by construction). */
	it("post-ship claim outranks the parked veto", () => {
		const v = decideDestructive(
			input({
				action: "commdb_residue_prune",
				authority: "post_ship_claim",
				declaredParked: true,
				liveness: "alive",
			}),
		);
		expect(v.allowed).toBe(true);
	});
});

/**
 * Codex R2 MEDIUM: an authority only grants a right over the action its domain
 * actually covers. Round 1 left the authority branch as a blanket "any non-`none`
 * authority authorizes any action", which allowed nonsense pairs the review
 * reproduced. These pin the ACTION_AUTHORITY_MATRIX so a mismatched authority
 * grants NO right and the verdict falls through to liveness.
 */
describe("FLY-1329 A1 verdict — authority/action matrix (Codex R2)", () => {
	it("fsm_terminal does NOT authorize wake_replacement_spawn (the review's counterexample)", () => {
		const v = decideDestructive(
			input({
				action: "wake_replacement_spawn",
				authority: "fsm_terminal",
				liveness: "absent",
			}),
		);
		expect(v.allowed).toBe(false);
		expect(v.vetoedBy).toBe("liveness");
		// Codex R3: even on the `absent` FLY-1319-trap branch, the audit body must
		// name the held-but-non-covering authority, not silently drop it.
		expect(v.reason).toContain("does not cover");
	});

	it("the audit body names a held-but-non-covering authority on a non-absent liveness too", () => {
		const v = decideDestructive(
			input({
				action: "wake_replacement_spawn",
				authority: "fsm_terminal",
				liveness: "indeterminate",
			}),
		);
		expect(v.allowed).toBe(false);
		expect(v.reason).toContain("does not cover");
	});

	it("completed_assertion does NOT authorize handoff_close (the other counterexample)", () => {
		const v = decideDestructive(
			input({
				action: "handoff_close",
				authority: "completed_assertion",
				liveness: "alive",
			}),
		);
		expect(v.allowed).toBe(false);
	});

	it("fsm_terminal STILL authorizes the A4 residue prune it is meant for", () => {
		const v = decideDestructive(
			input({
				action: "commdb_residue_prune",
				authority: "fsm_terminal",
				liveness: "absent",
			}),
		);
		expect(v.allowed).toBe(true);
		expect(v.authorizedBy).toBe("fsm_terminal");
	});

	it("completed_assertion STILL authorizes the A5 completed assertion it is meant for", () => {
		const v = decideDestructive(
			input({
				action: "completed_assertion",
				authority: "completed_assertion",
				liveness: "alive",
			}),
		);
		expect(v.allowed).toBe(true);
	});

	it("founder_disposition covers every action (top authority)", () => {
		for (const action of [
			"handoff_close",
			"wake_replacement_spawn",
			"commdb_residue_prune",
			"completed_assertion",
		] as const) {
			const v = decideDestructive(
				input({ action, authority: "founder_disposition", liveness: "alive" }),
			);
			expect(v.allowed).toBe(true);
		}
	});

	it("a mismatched authority does not block a dead_pin cleanup from still authorizing via liveness", () => {
		// completed_assertion doesn't cover handoff_close, but dead_pin does — the
		// fall-through to liveness must still authorize the liveness-derived cleanup.
		const v = decideDestructive(
			input({
				action: "handoff_close",
				authority: "completed_assertion",
				liveness: "dead_pin",
			}),
		);
		expect(v.allowed).toBe(true);
		expect(v.authorizedBy).toBe("dead_pin");
	});
});
