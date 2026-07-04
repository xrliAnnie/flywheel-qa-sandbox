import { describe, expect, it } from "vitest";
import {
	DEFAULT_PHASE_TIER,
	isThreeStagePhaseRole,
	nextPhase,
	resolveCompletionSessionRole,
	resolvePhaseModel,
	THREE_STAGE_PHASE_SEQUENCE,
} from "../three-stage-phases.js";

describe("three-stage-phases (FLY-793)", () => {
	it("sequences Design → Implement → QA", () => {
		expect(THREE_STAGE_PHASE_SEQUENCE).toEqual(["design", "implement", "qa"]);
	});

	it("maps each phase to its default tier (Fable / Opus / Sonnet)", () => {
		expect(DEFAULT_PHASE_TIER).toEqual({
			design: "heavy",
			implement: "medium",
			qa: "light",
		});
	});

	it("resolves canonical model ids per phase", () => {
		// Draws from the shared MODEL_TIERS registry so it inherits fleet-wide model
		// decisions. FLY-751 dropped the `[1m]` suffix from the `medium` tier
		// (founder-confirmed: 1M is now an explicit `opus-1m` opt-in, not the
		// default), so the implement phase (medium) resolves to plain Opus.
		expect(resolvePhaseModel("design")).toBe("claude-fable-5");
		expect(resolvePhaseModel("implement")).toBe("claude-opus-4-8");
		expect(resolvePhaseModel("qa")).toBe("claude-sonnet-5");
	});

	it("nextPhase walks the sequence and ends at QA", () => {
		expect(nextPhase("design")).toBe("implement");
		expect(nextPhase("implement")).toBe("qa");
		expect(nextPhase("qa")).toBeNull();
	});

	describe("isThreeStagePhaseRole", () => {
		it("is true only for the three phase roles", () => {
			expect(isThreeStagePhaseRole("design")).toBe(true);
			expect(isThreeStagePhaseRole("implement")).toBe(true);
			expect(isThreeStagePhaseRole("qa")).toBe(true);
		});

		it("is false for main / unknown / nullish", () => {
			expect(isThreeStagePhaseRole("main")).toBe(false);
			expect(isThreeStagePhaseRole("Design")).toBe(false); // case-sensitive
			expect(isThreeStagePhaseRole("")).toBe(false);
			expect(isThreeStagePhaseRole(null)).toBe(false);
			expect(isThreeStagePhaseRole(undefined)).toBe(false);
		});
	});

	describe("resolveCompletionSessionRole (824 R2 E2E fix)", () => {
		it("preserves a dispatched phase role even when the signal defaults to main", () => {
			// The exact 824 Track-1 bug: a phase runner completes via
			// `flywheel-comm complete` whose payload role defaults to "main". The
			// existing DB phase role MUST win, or onPhaseComplete sees "main" and the
			// handoff silently never fires.
			expect(resolveCompletionSessionRole("design", "main")).toBe("design");
			expect(resolveCompletionSessionRole("implement", "main")).toBe(
				"implement",
			);
			expect(resolveCompletionSessionRole("qa", "main")).toBe("qa");
		});

		it("preserves a phase role even when the incoming role is missing", () => {
			expect(resolveCompletionSessionRole("design", undefined)).toBe("design");
			expect(resolveCompletionSessionRole("design", null)).toBe("design");
		});

		it("byte-compat: a non-phase existing role falls through to the incoming role", () => {
			expect(resolveCompletionSessionRole("main", "main")).toBe("main");
			expect(resolveCompletionSessionRole(undefined, "main")).toBe("main");
			expect(resolveCompletionSessionRole(null, undefined)).toBe("main");
			// A first-ever completion for a fresh phase session (no DB row yet) still
			// takes the incoming role — the dispatch's started event set it first.
			expect(resolveCompletionSessionRole(undefined, "qa")).toBe("qa");
		});
	});
});
