import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	resolveHandoffDispatchChannelId,
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
		// FLY-1224 (T3, entry lane): the entry decision carries the phase
		// table's vendor too (design = claude, no effort).
		expect(e.dispatchVendor).toBe("claude");
		expect(e.dispatchEffort).toBeUndefined();
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

/**
 * FLY-887 R2 Step 3 — channel gating: three-stage applies only to fresh main
 * dispatches whose dispatching Lead's chatChannel ∈ pipeline.three_stage_channels.
 * Key absent = no restriction (byte-compat); empty array = OFF everywhere.
 * `dispatchChannelId` is resolved SERVER-SIDE (leadId → project.leads[].chatChannel),
 * never from the request body.
 */
describe("resolveThreeStagePolicy — three_stage_channels gating (FLY-887 R2)", () => {
	const noEnv: Record<string, string | undefined> = {};
	const CHAN = "1516209714097291335";

	it("key ABSENT → enabled regardless of channel (byte-compat with pre-gating behavior)", () => {
		for (const dispatchChannelId of [CHAN, "999", undefined]) {
			const d = resolveThreeStagePolicy({
				pipelineConfig: { three_stage: true },
				issueLabels: [],
				env: noEnv,
				dispatchChannelId,
			});
			expect(d.enabled).toBe(true);
		}
	});

	it("channel IN the allowlist → enabled", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true, three_stage_channels: [CHAN] },
			issueLabels: [],
			env: noEnv,
			dispatchChannelId: CHAN,
		});
		expect(d.enabled).toBe(true);
	});

	it("channel NOT in the allowlist → disabled with a miss-detail reason", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true, three_stage_channels: [CHAN] },
			issueLabels: [],
			env: noEnv,
			dispatchChannelId: "111222333",
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("111222333");
	});

	it("allowlist defined but dispatchChannelId UNRESOLVABLE → disabled (fail-closed)", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true, three_stage_channels: [CHAN] },
			issueLabels: [],
			env: noEnv,
			dispatchChannelId: undefined,
		});
		expect(d.enabled).toBe(false);
	});

	it("EMPTY allowlist → disabled everywhere (explicit universal OFF)", () => {
		const d = resolveThreeStagePolicy({
			pipelineConfig: { three_stage: true, three_stage_channels: [] },
			issueLabels: [],
			env: noEnv,
			dispatchChannelId: CHAN,
		});
		expect(d.enabled).toBe(false);
	});

	it("kill-switch and no-three-stage label still short-circuit FIRST", () => {
		expect(
			resolveThreeStagePolicy({
				pipelineConfig: { three_stage: true, three_stage_channels: [CHAN] },
				issueLabels: [],
				env: { FLYWHEEL_THREE_STAGE: "0" },
				dispatchChannelId: CHAN,
			}).enabled,
		).toBe(false);
		expect(
			resolveThreeStagePolicy({
				pipelineConfig: { three_stage: true, three_stage_channels: [CHAN] },
				issueLabels: ["no-three-stage"],
				env: noEnv,
				dispatchChannelId: CHAN,
			}).enabled,
		).toBe(false);
	});

	it("entry path: an out-of-allowlist channel keeps a fresh main dispatch single-session", () => {
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: { three_stage: true, three_stage_channels: [CHAN] },
			issueLabels: [],
			env: noEnv,
			dispatchChannelId: "999",
		});
		expect(e.enteredThreeStage).toBe(false);
		expect(e.role).toBe("main");
		expect(e.dispatchModel).toBeUndefined();
	});

	it("entry path: an in-allowlist channel enters three-stage with the design model", () => {
		const e = resolveThreeStageEntry({
			requestRole: "main",
			pipelineConfig: { three_stage: true, three_stage_channels: [CHAN] },
			issueLabels: [],
			env: noEnv,
			dispatchChannelId: CHAN,
		});
		expect(e.enteredThreeStage).toBe(true);
		expect(e.role).toBe("design");
		expect(e.dispatchModel).toBe("claude-fable-5");
	});
});

/**
 * FLY-902 fix: the HANDOFF-side dispatchChannelId resolution. plugin.ts's
 * resolveThreeStage closure passes this function's result into
 * resolveThreeStagePolicy — without it, a configured three_stage_channels
 * allowlist read the channel as unresolved at every handoff and fail-closed,
 * silently disabling the whole pipeline after entry.
 */
describe("resolveHandoffDispatchChannelId (FLY-902)", () => {
	const CHAN = "1516209714097291335";
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leads: [
				{
					agentId: "flywheel-eng-lead",
					chatChannel: CHAN,
					match: { labels: ["flywheel"] },
				},
				{
					agentId: "other-lead",
					chatChannel: "999888777",
					match: { labels: ["other"] },
				},
			],
		},
	] as ProjectEntry[];

	it("resolves the label-matched lead's chatChannel", () => {
		expect(
			resolveHandoffDispatchChannelId(projects, "flywheel", ["other"]),
		).toBe("999888777");
	});

	it("falls back to the FIRST lead's chatChannel when no label matches (general match, mirrors resolveLeadForIssue)", () => {
		expect(resolveHandoffDispatchChannelId(projects, "flywheel", [])).toBe(
			CHAN,
		);
	});

	it("unknown project → undefined (policy then fails closed)", () => {
		expect(
			resolveHandoffDispatchChannelId(projects, "nope", []),
		).toBeUndefined();
	});

	it("undefined projectName → undefined", () => {
		expect(
			resolveHandoffDispatchChannelId(projects, undefined, []),
		).toBeUndefined();
	});
});
