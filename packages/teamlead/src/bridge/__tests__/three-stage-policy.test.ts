import { describe, expect, it } from "vitest";
import {
	resolveThreeStageEntry,
	resolveThreeStagePolicy,
	threeStageKeepAliveEnabled,
} from "../three-stage-policy.js";

describe("threeStageKeepAliveEnabled (FLY-887 kill-switch)", () => {
	it("defaults ON when the env is unset", () => {
		expect(threeStageKeepAliveEnabled({})).toBe(true);
	});
	it("is OFF when FLYWHEEL_THREE_STAGE_KEEPALIVE=0", () => {
		expect(
			threeStageKeepAliveEnabled({ FLYWHEEL_THREE_STAGE_KEEPALIVE: "0" }),
		).toBe(false);
	});
	it("any non-'0' value stays ON (only an explicit 0 disables)", () => {
		expect(
			threeStageKeepAliveEnabled({ FLYWHEEL_THREE_STAGE_KEEPALIVE: "1" }),
		).toBe(true);
		expect(
			threeStageKeepAliveEnabled({ FLYWHEEL_THREE_STAGE_KEEPALIVE: "off" }),
		).toBe(true);
	});
});

describe("resolveThreeStageEntry (FLY-793 Step 4 ENTRY)", () => {
	const noEnv: Record<string, string | undefined> = {};

	it("a fresh `main` dispatch on a three-stage project STARTS at Design", () => {
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: { three_stage: true },
			issueLabels: [],
			env: noEnv,
		});
		expect(e.enteredThreeStage).toBe(true);
		expect(e.role).toBe("design");
	});

	it("FLY-887 R2: entry carries the design-phase model — model sovereignty lives in the phase table", () => {
		// The entry decision OWNS the dispatch model for a three-stage run: the
		// caller (runs-route) applies `entry.dispatchModel` unconditionally, so a
		// difficulty-sorter pin (e.g. sonnet on a light-sorted issue) can never
		// put the Design phase on a non-table model.
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: { three_stage: true },
			issueLabels: [],
			env: noEnv,
		});
		expect(e.dispatchModel).toBe("claude-fable-5");
	});

	it("FLY-887 R2: a NON-entry decision carries no dispatchModel (single-session path untouched)", () => {
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: undefined,
			issueLabels: [],
			env: noEnv,
		});
		expect(e.enteredThreeStage).toBe(false);
		expect(e.dispatchModel).toBeUndefined();
	});

	it("byte-compat: a `main` dispatch with no three-stage config stays `main`", () => {
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: undefined,
			issueLabels: [],
			env: noEnv,
		});
		expect(e.enteredThreeStage).toBe(false);
		expect(e.role).toBe("main");
	});

	it("an explicit phase role (handoff) passes through untouched — NOT re-entered", () => {
		for (const role of ["design", "implement", "qa"]) {
			const e = resolveThreeStageEntry({
				requestRole: role,
				pipelineConfig: { three_stage: true },
				issueLabels: [],
				env: noEnv,
			});
			expect(e.enteredThreeStage).toBe(false);
			expect(e.role).toBe(role);
		}
	});

	it("auto-QA (`qa`) on a three-stage project is NOT rerouted to design", () => {
		const e = resolveThreeStageEntry({
			requestRole: "qa",
			pipelineConfig: { three_stage: true },
			issueLabels: [],
			env: noEnv,
		});
		expect(e.enteredThreeStage).toBe(false);
		expect(e.role).toBe("qa");
	});

	it("`no-three-stage` label keeps a fresh dispatch as `main`", () => {
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: { three_stage: true },
			issueLabels: ["no-three-stage"],
			env: noEnv,
		});
		expect(e.enteredThreeStage).toBe(false);
		expect(e.role).toBe("main");
	});

	it("`FLYWHEEL_THREE_STAGE=0` kill-switch keeps a fresh dispatch as `main`", () => {
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: { three_stage: true },
			issueLabels: [],
			env: { FLYWHEEL_THREE_STAGE: "0" },
		});
		expect(e.enteredThreeStage).toBe(false);
		expect(e.role).toBe("main");
	});
});

describe("resolveThreeStagePolicy (FLY-793)", () => {
	const noEnv: Record<string, string | undefined> = {};

	it("is OFF by default when no pipeline config is present (byte-compat)", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: undefined,
			issueLabels: [],
			env: noEnv,
		});
		expect(d.enabled).toBe(false);
	});

	it("is ON when pipeline.three_stage === true", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true },
			issueLabels: [],
			env: noEnv,
		});
		expect(d.enabled).toBe(true);
	});

	it("is OFF when three_stage === false (explicit opt-out)", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: false },
			issueLabels: [],
			env: noEnv,
		});
		expect(d.enabled).toBe(false);
	});

	it("is OFF when the pipeline block has no three_stage key", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: {},
			issueLabels: [],
			env: noEnv,
		});
		expect(d.enabled).toBe(false);
	});

	it("FLYWHEEL_THREE_STAGE=0 hard kill-switch overrides an enabled config", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true },
			issueLabels: [],
			env: { FLYWHEEL_THREE_STAGE: "0" },
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toMatch(/kill-switch/i);
	});

	it("no-three-stage label opts a single issue out even when config enables it", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true },
			issueLabels: ["Backend", "no-three-stage"],
			env: noEnv,
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toMatch(/no-three-stage/i);
	});

	it("label match is case-insensitive", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true },
			issueLabels: ["NO-THREE-STAGE"],
			env: noEnv,
		});
		expect(d.enabled).toBe(false);
	});
});
