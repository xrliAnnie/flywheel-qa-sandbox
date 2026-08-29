import { describe, expect, it } from "vitest";
import {
	type AutocontinueBudget,
	type AutocontinuePhase,
	buildGoalContract,
	resolveAutocontinueTarget,
} from "../bridge/autocontinue-goal.js";

const budget: AutocontinueBudget = {
	maxContinuationTurns: 40,
	maxWallClockMinutes: 180,
	maxNoProgressTurns: 2,
};

describe("buildGoalContract (FLY-818) — goal contract text", () => {
	it("monolithic (FLY-793 off) drives the whole pipeline to PR, stops at approve gate", () => {
		const c = buildGoalContract({
			phase: "monolithic",
			issueIdentifier: "FLY-999",
			budget,
		});
		expect(c).toContain("FLY-999");
		expect(c).toContain("开 PR");
		expect(c).toContain("approve gate");
		expect(c).toContain("阶段:monolithic");
	});

	it("each phase-agent has its own outcome + stop boundary (FLY-793 three-stage)", () => {
		const design = buildGoalContract({
			phase: "design",
			issueIdentifier: "FLY-1",
			budget,
		});
		expect(design).toContain("design_review gate");
		expect(design).toContain("exploration/research/plan");

		const impl = buildGoalContract({
			phase: "implement",
			issueIdentifier: "FLY-1",
			budget,
		});
		expect(impl).toContain("TDD");
		expect(impl).toContain("approve gate");

		const qa = buildGoalContract({
			phase: "qa",
			issueIdentifier: "FLY-1",
			budget,
		});
		expect(qa).toContain("verdict");
	});

	it("encodes the blocking-gate hard-stop vs non-blocking-ask continue distinction (Codex R1#3)", () => {
		const c = buildGoalContract({
			phase: "monolithic",
			issueIdentifier: "FLY-1",
			budget,
		});
		// blocking gate = hard stop
		expect(c).toContain("阻塞 gate");
		expect(c).toContain("停下等答复");
		// non-blocking ask = keep working
		expect(c).toContain("flywheel-comm ask");
		expect(c).toContain("非阻塞");
	});

	it("embeds the mandatory budget numbers + no-progress stop (防空转)", () => {
		const c = buildGoalContract({
			phase: "monolithic",
			issueIdentifier: "FLY-1",
			budget: {
				maxContinuationTurns: 12,
				maxWallClockMinutes: 90,
				maxNoProgressTurns: 3,
			},
		});
		expect(c).toContain("12");
		expect(c).toContain("90");
		expect(c).toContain("3");
		expect(c).toContain("无进展");
	});

	it("states ship stays founder-gated (never self-ship)", () => {
		const c = buildGoalContract({
			phase: "implement",
			issueIdentifier: "FLY-1",
			budget,
		});
		expect(c).toContain("绝不自 ship");
		expect(c).toContain("founder");
	});

	it("is deterministic (same input → byte-identical output; stable for re-read after compaction)", () => {
		const args = {
			phase: "design" as AutocontinuePhase,
			issueIdentifier: "FLY-7",
			issueTitle: "some title",
			budget,
		};
		expect(buildGoalContract(args)).toBe(buildGoalContract(args));
	});

	it("includes the issue title when provided", () => {
		const c = buildGoalContract({
			phase: "monolithic",
			issueIdentifier: "FLY-5",
			issueTitle: "auto-continue runner",
			budget,
		});
		expect(c).toContain("auto-continue runner");
	});
});

describe("resolveAutocontinueTarget (FLY-818 M0) — backend eligibility + phase", () => {
	it("claude-tmux main runner is eligible → monolithic (byte-compat default)", () => {
		const t = resolveAutocontinueTarget({
			adapterType: "claude-tmux",
			sessionRole: "main",
		});
		expect(t).toEqual({ armEligible: true, phase: "monolithic" });
	});

	it("undefined/legacy adapter_type is treated as claude default (eligible, monolithic)", () => {
		expect(resolveAutocontinueTarget({}).armEligible).toBe(true);
		expect(resolveAutocontinueTarget({}).phase).toBe("monolithic");
		expect(resolveAutocontinueTarget({ adapterType: "" }).armEligible).toBe(
			true,
		);
	});

	it("FLY-793 three-stage roles map to their phase (reserved until 793 lands)", () => {
		expect(
			resolveAutocontinueTarget({
				adapterType: "claude-tmux",
				sessionRole: "design",
			}).phase,
		).toBe("design");
		expect(
			resolveAutocontinueTarget({
				adapterType: "claude-tmux",
				sessionRole: "implement",
			}).phase,
		).toBe("implement");
		expect(
			resolveAutocontinueTarget({
				adapterType: "claude-tmux",
				sessionRole: "qa",
			}).phase,
		).toBe("qa");
	});

	it("an unknown role on a claude runner defaults to monolithic (byte-compat)", () => {
		expect(
			resolveAutocontinueTarget({
				adapterType: "claude-tmux",
				sessionRole: "something-new",
			}).phase,
		).toBe("monolithic");
	});

	it("non-Claude / no-transport backends are NOT arm-eligible (codex/agy/kimi)", () => {
		for (const adapterType of ["codex", "antigravity-tmux", "kimi-tmux"]) {
			const t = resolveAutocontinueTarget({ adapterType, sessionRole: "main" });
			expect(t.armEligible).toBe(false);
			expect(t.reason).toBeTruthy();
		}
	});
});
