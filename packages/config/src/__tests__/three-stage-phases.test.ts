import { describe, expect, it } from "vitest";
import {
	DEFAULT_PHASE_DISPATCH,
	DEFAULT_PHASE_TIER,
	isThreeStagePhaseRole,
	nextPhase,
	resolveCompletionSessionRole,
	resolvePhaseDispatch,
	resolvePhaseModel,
	THREE_STAGE_PHASE_SEQUENCE,
} from "../three-stage-phases.js";

describe("three-stage-phases (FLY-793)", () => {
	it("sequences Design → Implement → QA", () => {
		expect(THREE_STAGE_PHASE_SEQUENCE).toEqual(["design", "implement", "qa"]);
	});

	it("keeps the legacy display-fallback tier table unchanged (values frozen)", () => {
		// FLY-1224: DEFAULT_PHASE_TIER is demoted to the LAST-RESORT display
		// fallback (unknown model, no dispatch table hit) — its values stay frozen
		// so pre-1224 display fallbacks are byte-identical.
		expect(DEFAULT_PHASE_TIER).toEqual({
			design: "heavy",
			implement: "heavy",
			qa: "medium",
		});
	});

	it("maps each phase to its dispatch spec (Annie 2026-07-13: Fable / Codex gpt-5.6-sol xhigh / Opus)", () => {
		expect(DEFAULT_PHASE_DISPATCH).toEqual({
			design: { vendor: "claude", model: "claude-fable-5" },
			implement: { vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
			qa: { vendor: "claude", model: "claude-opus-4-8" },
		});
	});

	it("resolves canonical model ids per phase (implement → gpt-5.6-sol)", () => {
		// FLY-1224 (Annie's 2026-07-13 directive): design=Fable, implement=Codex
		// gpt-5.6-sol, qa=Opus. resolvePhaseModel keeps its signature but now
		// draws from the dispatch table.
		expect(resolvePhaseModel("design")).toBe("claude-fable-5");
		expect(resolvePhaseModel("implement")).toBe("gpt-5.6-sol");
		expect(resolvePhaseModel("qa")).toBe("claude-opus-4-8");
	});

	it("zero-Sonnet invariant: no phase in the dispatch table resolves to a sonnet model", () => {
		// FLY-887 R2 (Annie's policy): the three-stage pipeline must NEVER place a
		// phase session on Sonnet, whatever the table says in the future.
		for (const phase of THREE_STAGE_PHASE_SEQUENCE) {
			expect(DEFAULT_PHASE_DISPATCH[phase].model.toLowerCase()).not.toContain(
				"sonnet",
			);
			expect(resolvePhaseDispatch(phase).model.toLowerCase()).not.toContain(
				"sonnet",
			);
		}
	});

	describe("resolvePhaseDispatch kill-switch (FLY-1224 T10)", () => {
		it("returns the codex row for implement when the env is unset", () => {
			expect(resolvePhaseDispatch("implement", {})).toEqual({
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			});
		});

		it("FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0 falls implement back to (claude, heavy)", () => {
			expect(
				resolvePhaseDispatch("implement", {
					FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "0",
				}),
			).toEqual({ vendor: "claude", model: "claude-fable-5" });
		});

		it("the kill-switch does NOT touch design / qa", () => {
			const env = { FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "0" };
			expect(resolvePhaseDispatch("design", env)).toEqual(
				DEFAULT_PHASE_DISPATCH.design,
			);
			expect(resolvePhaseDispatch("qa", env)).toEqual(
				DEFAULT_PHASE_DISPATCH.qa,
			);
		});

		it("only the exact value '0' activates the fallback", () => {
			expect(
				resolvePhaseDispatch("implement", {
					FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "false",
				}),
			).toEqual(DEFAULT_PHASE_DISPATCH.implement);
		});
	});

	describe("resolvePhaseDispatch design toggle (FLY-1245)", () => {
		// The design toggle is the MIRROR of the implement kill-switch, but the
		// direction is inverted because the two phases default to opposite vendors:
		// implement defaults to codex (=0 falls back to claude); design defaults to
		// claude/Fable (=1 opts INTO codex). The codex spec is Annie's standard
		// config (gpt-5.6-sol / xhigh) — identical to implement's default row.
		it("FLYWHEEL_THREE_STAGE_CODEX_DESIGN=1 switches design to (codex, gpt-5.6-sol, xhigh)", () => {
			expect(
				resolvePhaseDispatch("design", {
					FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1",
				}),
			).toEqual({ vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" });
		});

		it("unset → the legacy design row (claude, Fable) — byte-compat", () => {
			expect(resolvePhaseDispatch("design", {})).toEqual(
				DEFAULT_PHASE_DISPATCH.design,
			);
			expect(resolvePhaseDispatch("design", {})).toEqual({
				vendor: "claude",
				model: "claude-fable-5",
			});
		});

		it("only the exact value '1' activates codex (unlike implement's '0')", () => {
			expect(
				resolvePhaseDispatch("design", {
					FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "true",
				}),
			).toEqual(DEFAULT_PHASE_DISPATCH.design);
			expect(
				resolvePhaseDispatch("design", {
					FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0",
				}),
			).toEqual(DEFAULT_PHASE_DISPATCH.design);
		});

		it("the design toggle does NOT touch implement / qa", () => {
			const env = { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" };
			expect(resolvePhaseDispatch("implement", env)).toEqual(
				DEFAULT_PHASE_DISPATCH.implement,
			);
			expect(resolvePhaseDispatch("qa", env)).toEqual(
				DEFAULT_PHASE_DISPATCH.qa,
			);
		});

		it("the two toggles are independent (design=1 + implement=0 both apply)", () => {
			const env = {
				FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1",
				FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "0",
			};
			// design opts INTO codex …
			expect(resolvePhaseDispatch("design", env)).toEqual({
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			});
			// … while implement falls BACK to (claude, heavy).
			expect(resolvePhaseDispatch("implement", env)).toEqual({
				vendor: "claude",
				model: "claude-fable-5",
			});
		});
	});

	it("PINS implement's default dispatch byte-for-byte (FLY-1245 refactor guard)", () => {
		// Lead's hard requirement: extracting the shared CODEX_STANDARD_DISPATCH
		// constant must NOT silently change implement's dispatch. Pin the exact
		// {vendor, model, effort} triple so a drift in the shared constant is caught
		// here, not in production.
		expect(resolvePhaseDispatch("implement", {})).toEqual({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
		expect(DEFAULT_PHASE_DISPATCH.implement).toEqual({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
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
