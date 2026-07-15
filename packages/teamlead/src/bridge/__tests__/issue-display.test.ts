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

function statuses(
	entries: Partial<Record<ThreeStagePhase, string>>,
): Map<ThreeStagePhase, string> {
	return new Map(Object.entries(entries) as [ThreeStagePhase, string][]);
}

function titleBadge(args: {
	phaseStates: ReadonlyMap<ThreeStagePhase, PhaseDisplayState>;
	phaseStatuses?: ReadonlyMap<ThreeStagePhase, string>;
	shipFinalizationClaimed?: boolean;
	mainSessionStage?: string;
	mainSessionStatus?: string;
}) {
	return deriveIssueTitleBadge({
		phaseStates: args.phaseStates,
		phaseStatuses: args.phaseStatuses ?? new Map(),
		shipFinalizationClaimed: args.shipFinalizationClaimed ?? false,
		mainSessionStage: args.mainSessionStage,
		mainSessionStatus: args.mainSessionStatus,
	});
}

describe("deriveIssueTitleBadge (plan 1b aggregation)", () => {
	it("empty map + main session → stage kind (现行单 session 公式)", () => {
		expect(
			titleBadge({
				phaseStates: new Map(),
				mainSessionStage: "implement",
				mainSessionStatus: "running",
			}),
		).toEqual({ kind: "stage", stage: "implement" });
	});

	it("empty map + failed/terminated/blocked main → blocked kind", () => {
		for (const status of ["failed", "terminated", "blocked"]) {
			expect(
				titleBadge({
					phaseStates: new Map(),
					mainSessionStage: "implement",
					mainSessionStatus: status,
				}),
			).toEqual({ kind: "blocked" });
		}
	});

	it("empty map + completed main → completed kind", () => {
		expect(
			titleBadge({
				phaseStates: new Map(),
				mainSessionStage: "ship",
				mainSessionStatus: "completed",
			}),
		).toEqual({ kind: "completed" });
	});

	it("single-session completed stage is clamped by a still-open ship gate", () => {
		expect(
			titleBadge({
				phaseStates: new Map(),
				mainSessionStage: "completed",
				mainSessionStatus: "awaiting_review",
			}),
		).toEqual({ kind: "stage", stage: "approve" });
		expect(
			titleBadge({
				phaseStates: new Map(),
				mainSessionStage: "completed",
				mainSessionStatus: "approved_to_ship",
			}),
		).toEqual({ kind: "stage", stage: "ship" });
	});

	it("single-session non-completed stages remain byte-compatible", () => {
		expect(
			titleBadge({
				phaseStates: new Map(),
				mainSessionStage: "pr_created",
				mainSessionStatus: "awaiting_review",
			}),
		).toEqual({ kind: "stage", stage: "pr_created" });
	});

	it("any phase blocked → blocked (kill/terminate QA shows 🔴受阻)", () => {
		expect(
			titleBadge({
				phaseStates: states({
					design: "done",
					implement: "done",
					qa: "blocked",
				}),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "blocked",
				}),
			}),
		).toEqual({ kind: "blocked" });
	});

	it("gate-open FLY-1224 shape stays at approve even when every phase display row is done", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "awaiting_review",
				}),
			}),
		).toEqual({ kind: "stage", stage: "approve" });
	});

	it("approved_to_ship outranks awaiting_review while every phase display row is done", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "approved_to_ship",
				}),
			}),
		).toEqual({ kind: "stage", stage: "ship" });
	});

	it("a validated post-ship finalization claim completes the post-merge stale-gate window", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "completed",
				}),
				shipFinalizationClaimed: true,
			}),
		).toEqual({ kind: "completed" });
	});

	it("a completed phase cannot globally override an unclaimed awaiting_review gate", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "completed",
				}),
			}),
		).toEqual({ kind: "stage", stage: "approve" });
	});

	it("all terminal phase rows complete without a post-ship claim", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
				phaseStatuses: statuses({
					design: "completed",
					implement: "merged",
					qa: "completed",
				}),
			}),
		).toEqual({ kind: "completed" });
	});

	it("display-done rows without a gate or positive ship fact fall through conservatively", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "running",
					qa: "running",
				}),
			}),
		).toEqual({ kind: "phase", phase: "qa" });
	});

	it("a validated ship claim outranks stale awaiting_review and approved_to_ship rows", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done", qa: "done" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "approved_to_ship",
				}),
				shipFinalizationClaimed: true,
			}),
		).toEqual({ kind: "completed" });
	});

	it("design+implement done but qa never spawned → NOT completed (handoff gap shows implement)", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "done" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
				}),
			}),
		).toEqual({ kind: "phase", phase: "implement" });
	});

	it("latest active phase wins (design done, implement active → 🔨实现)", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done", implement: "active" }),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "running",
				}),
			}),
		).toEqual({ kind: "phase", phase: "implement" });
	});

	it("qa active while implement parked-done → 🧪QA", () => {
		expect(
			titleBadge({
				phaseStates: states({
					design: "done",
					implement: "done",
					qa: "active",
				}),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "running",
				}),
			}),
		).toEqual({ kind: "phase", phase: "qa" });
	});

	it("FLY-543 scenario: design woken for rework (active) while implement/qa done-ish → title back to 🎨设计? No — LAST active wins; but a lone woken design with others pending goes back to design", () => {
		// qa FAIL → wake implement: implement flips back to active → 🔨实现 (not ✅)
		expect(
			titleBadge({
				phaseStates: states({
					design: "done",
					implement: "active",
					qa: "done",
				}),
				phaseStatuses: statuses({
					design: "design_done",
					implement: "awaiting_review",
					qa: "running",
				}),
			}),
		).toEqual({ kind: "phase", phase: "implement" });
		// killed design re-dispatched: design active, others not started → 🎨设计
		expect(
			titleBadge({
				phaseStates: states({ design: "active" }),
				phaseStatuses: statuses({ design: "running" }),
			}),
		).toEqual({ kind: "phase", phase: "design" });
	});

	it("design done, implement not yet dispatched (handoff gap, no active) → previous phase (design)", () => {
		expect(
			titleBadge({
				phaseStates: states({ design: "done" }),
				phaseStatuses: statuses({ design: "design_done" }),
			}),
		).toEqual({ kind: "phase", phase: "design" });
	});

	it("design pending only (all pending) → design", () => {
		expect(titleBadge({ phaseStates: states({ design: "pending" }) })).toEqual({
			kind: "phase",
			phase: "design",
		});
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
