/**
 * FLY-907 Step 1: the unified issue-display derivation module (pure, zero I/O).
 *
 * Pins:
 *  - 1a derivePhaseDisplayState — every row of the plan's mapping table
 *    (Codex R1 #2 corrected version), incl. the FLY-543 wake-rework correction
 *    and the "completed/merged unconditionally done" post-ship contract.
 *  - 1b deriveIssueTitleBadge — issue-level aggregation per kind (incl. the
 *    543 scenario: a woken design flips the title back to 🎨设计).
 *  - 1c PHASE_DISPLAY_GLYPHS vocabulary (Annie's glyphs: green ✅, ▶, grey ◾)
 *    and the unified face-C line render (`🎨设计✅·🔨实现▶·🧪QA◾` style).
 */

import type { ThreeStagePhase } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	deriveIssueTitleBadge,
	derivePhaseDisplayState,
	PHASE_DISPLAY_GLYPH_PARTS,
	PHASE_DISPLAY_GLYPHS,
	type PhaseDisplayState,
	renderPhaseStatusLine,
} from "../issue-display.js";

describe("derivePhaseDisplayState (plan 1a mapping table)", () => {
	it("no session → pending", () => {
		expect(
			derivePhaseDisplayState({
				role: "design",
				status: undefined,
				park: "unknown",
			}),
		).toBe("pending");
	});

	it("running + not_parked/unknown → active", () => {
		for (const park of ["not_parked", "unknown"] as const) {
			expect(
				derivePhaseDisplayState({ role: "implement", status: "running", park }),
			).toBe("active");
		}
	});

	it("running + EXPLICIT park marker → done (keep-alive QA parks at status=running after its verdict; its round's work is at a boundary and must not hold the ▶ badge)", () => {
		expect(
			derivePhaseDisplayState({
				role: "qa",
				status: "running",
				park: "parked",
			}),
		).toBe("done");
	});

	it("completed / merged → done UNCONDITIONALLY (post-ship finalization contract: a finalized QA phase has no park marker and must never flip back to active)", () => {
		for (const status of ["completed", "merged"]) {
			for (const park of ["parked", "not_parked", "unknown"] as const) {
				expect(derivePhaseDisplayState({ role: "qa", status, park })).toBe(
					"done",
				);
			}
		}
	});

	it("handoff-boundary statuses + park parked/unknown → done (到达 handoff 边界=该段工作到位)", () => {
		for (const status of [
			"design_done",
			"awaiting_review",
			"approved_to_ship",
		]) {
			for (const park of ["parked", "unknown"] as const) {
				expect(
					derivePhaseDisplayState({ role: "implement", status, park }),
				).toBe("done");
			}
		}
	});

	it("handoff-boundary statuses + park not_parked → active (FLY-543: woken rework must show ▶, not a fake ✅)", () => {
		for (const status of [
			"design_done",
			"awaiting_review",
			"approved_to_ship",
		]) {
			expect(
				derivePhaseDisplayState({
					role: "implement",
					status,
					park: "not_parked",
				}),
			).toBe("active");
		}
	});

	it("failed / terminated / blocked / rejected → blocked", () => {
		for (const status of ["failed", "terminated", "blocked", "rejected"]) {
			expect(
				derivePhaseDisplayState({ role: "qa", status, park: "unknown" }),
			).toBe("blocked");
		}
	});

	it("other/unknown statuses with a session → active (conservative)", () => {
		for (const status of ["pending", "shelved-ish", "weird"]) {
			expect(
				derivePhaseDisplayState({ role: "design", status, park: "unknown" }),
			).toBe("active");
		}
	});
});

function states(
	entries: Partial<Record<ThreeStagePhase, PhaseDisplayState>>,
): Map<ThreeStagePhase, PhaseDisplayState> {
	return new Map(
		Object.entries(entries) as [ThreeStagePhase, PhaseDisplayState][],
	);
}

describe("deriveIssueTitleBadge (plan 1b aggregation)", () => {
	it("empty map + main session → stage kind (现行单 session 公式)", () => {
		expect(
			deriveIssueTitleBadge({
				phaseStates: new Map(),
				mainSessionStage: "implement",
				mainSessionStatus: "running",
			}),
		).toEqual({ kind: "stage", stage: "implement" });
	});

	it("empty map + failed/terminated/blocked main → blocked kind", () => {
		for (const status of ["failed", "terminated", "blocked"]) {
			expect(
				deriveIssueTitleBadge({
					phaseStates: new Map(),
					mainSessionStage: "implement",
					mainSessionStatus: status,
				}),
			).toEqual({ kind: "blocked" });
		}
	});

	it("empty map + completed main → completed kind", () => {
		expect(
			deriveIssueTitleBadge({
				phaseStates: new Map(),
				mainSessionStage: "ship",
				mainSessionStatus: "completed",
			}),
		).toEqual({ kind: "completed" });
	});

	it("any phase blocked → blocked (kill/terminate QA shows 🔴受阻)", () => {
		expect(
			deriveIssueTitleBadge({
				phaseStates: states({
					design: "done",
					implement: "done",
					qa: "blocked",
				}),
			}),
		).toEqual({ kind: "blocked" });
	});

	it("all existing phases done AND qa exists+done → completed (ship 收尾终态)", () => {
		expect(
			deriveIssueTitleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
			}),
		).toEqual({ kind: "completed" });
	});

	it("design+implement done but qa never spawned → NOT completed (handoff gap shows implement)", () => {
		expect(
			deriveIssueTitleBadge({
				phaseStates: states({ design: "done", implement: "done" }),
			}),
		).toEqual({ kind: "phase", phase: "implement" });
	});

	it("latest active phase wins (design done, implement active → 🔨实现)", () => {
		expect(
			deriveIssueTitleBadge({
				phaseStates: states({ design: "done", implement: "active" }),
			}),
		).toEqual({ kind: "phase", phase: "implement" });
	});

	it("qa active while implement parked-done → 🧪QA", () => {
		expect(
			deriveIssueTitleBadge({
				phaseStates: states({
					design: "done",
					implement: "done",
					qa: "active",
				}),
			}),
		).toEqual({ kind: "phase", phase: "qa" });
	});

	it("FLY-543 scenario: design woken for rework (active) while implement/qa done-ish → title back to 🎨设计? No — LAST active wins; but a lone woken design with others pending goes back to design", () => {
		// qa FAIL → wake implement: implement flips back to active → 🔨实现 (not ✅)
		expect(
			deriveIssueTitleBadge({
				phaseStates: states({
					design: "done",
					implement: "active",
					qa: "done",
				}),
			}),
		).toEqual({ kind: "phase", phase: "implement" });
		// killed design re-dispatched: design active, others not started → 🎨设计
		expect(
			deriveIssueTitleBadge({ phaseStates: states({ design: "active" }) }),
		).toEqual({ kind: "phase", phase: "design" });
	});

	it("design done, implement not yet dispatched (handoff gap, no active) → previous phase (design)", () => {
		expect(
			deriveIssueTitleBadge({ phaseStates: states({ design: "done" }) }),
		).toEqual({ kind: "phase", phase: "design" });
	});

	it("design pending only (all pending) → design", () => {
		expect(
			deriveIssueTitleBadge({ phaseStates: states({ design: "pending" }) }),
		).toEqual({ kind: "phase", phase: "design" });
	});
});

describe("PHASE_DISPLAY_GLYPHS (plan 1c vocabulary — Annie's glyphs)", () => {
	it("uses green ✅ for done, ▶ active, dark-grey ◾ pending (NOT white ⬜), 🔴 blocked", () => {
		expect(PHASE_DISPLAY_GLYPHS).toEqual({
			done: "✅ 完成",
			active: "▶ 进行中",
			pending: "◾ 未开始",
			blocked: "🔴 受阻",
		});
		expect(PHASE_DISPLAY_GLYPH_PARTS.pending.symbol).not.toBe("⬜");
	});
});

describe("renderPhaseStatusLine (unified face-C vocabulary)", () => {
	it("renders 🎨设计✅·🔨实现▶·🧪QA◾ style from the unified state machine", () => {
		expect(
			renderPhaseStatusLine({
				design: "done",
				implement: "active",
				qa: "pending",
			}),
		).toBe("🎨设计✅·🔨实现▶·🧪QA◾");
	});

	it("final done/done/done state (ship 收尾 — 不留任何「进行中」)", () => {
		expect(
			renderPhaseStatusLine({ design: "done", implement: "done", qa: "done" }),
		).toBe("🎨设计✅·🔨实现✅·🧪QA✅");
	});

	it("blocked phase renders 🔴", () => {
		expect(
			renderPhaseStatusLine({
				design: "done",
				implement: "done",
				qa: "blocked",
			}),
		).toBe("🎨设计✅·🔨实现✅·🧪QA🔴");
	});
});
