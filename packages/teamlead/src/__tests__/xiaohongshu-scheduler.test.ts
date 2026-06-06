/**
 * FLY-222: scheduler planning-core tests (planLearningRuns).
 */

import type {
	FlywheelConfig,
	XiaohongshuCollectionConfig,
} from "flywheel-config";
import {
	emptyState,
	type XiaohongshuState,
} from "flywheel-comm/xiaohongshu-state";
import { describe, expect, it } from "vitest";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import {
	type CollectionDecision,
	planLearningRuns,
} from "../xiaohongshu-scheduler.js";

const NOW = new Date("2026-06-06T00:00:00Z");

function lead(agentId: string, labels: string[], canSpawn = true): LeadConfig {
	return { agentId, match: { labels }, canSpawnRunners: canSpawn } as LeadConfig;
}
function project(name: string, leads: LeadConfig[]): ProjectEntry {
	return { projectName: name, leads } as ProjectEntry;
}

const PROJECTS: ProjectEntry[] = [project("sub", [lead("sub-lead", ["Sub"])])];

function cfgWith(
	collections: XiaohongshuCollectionConfig[],
	opts: { enabled?: boolean; video_opt_in?: boolean } = {},
): FlywheelConfig {
	return {
		xiaohongshu_learning: {
			enabled: opts.enabled ?? true,
			video_opt_in: opts.video_opt_in,
			collections,
		},
	} as unknown as FlywheelConfig;
}

const ONE_COLLECTION = [
	{
		collection_id: "c1",
		label: "AI-视频",
		lead_id: "sub-lead",
		department_label: "Sub",
		target_linear_project: "Flywheel Sandbox",
	},
];

function makeDeps(
	cfg: FlywheelConfig | null,
	state?: Partial<XiaohongshuState>,
) {
	return {
		projects: PROJECTS,
		loadProjectConfig: () => cfg,
		readState: (p: string, c: string): XiaohongshuState => ({
			...emptyState(p, c, NOW),
			...state,
		}),
		now: () => NOW,
	};
}

function only(decisions: CollectionDecision[]): CollectionDecision {
	expect(decisions).toHaveLength(1);
	return decisions[0];
}

describe("planLearningRuns", () => {
	it("plans a spawn for an enabled, tuple-valid, due collection (with defaults)", () => {
		const d = only(planLearningRuns(makeDeps(cfgWith(ONE_COLLECTION))));
		expect(d.action).toBe("spawn");
		if (d.action === "spawn") {
			expect(d.plan).toMatchObject({
				project: "sub",
				collectionId: "c1",
				leadId: "sub-lead",
				targetLinearProject: "Flywheel Sandbox",
				cadence: "weekly", // default
				maxFetch: 20, // default
				videoOptIn: false, // default
			});
		}
	});

	it("carries explicit cadence/max_fetch/video_opt_in", () => {
		const cfg = cfgWith(
			[{ ...ONE_COLLECTION[0], cadence: "daily", max_fetch: 13 }],
			{ video_opt_in: true },
		);
		const d = only(planLearningRuns(makeDeps(cfg)));
		if (d.action === "spawn") {
			expect(d.plan.cadence).toBe("daily");
			expect(d.plan.maxFetch).toBe(13);
			expect(d.plan.videoOptIn).toBe(true);
		}
	});

	it("skips a not-due collection", () => {
		const d = only(
			planLearningRuns(
				makeDeps(cfgWith(ONE_COLLECTION), {
					nextDueAt: "2030-01-01T00:00:00Z",
				}),
			),
		);
		expect(d).toMatchObject({ action: "skip", reason: "not_due" });
	});

	it("skips a tuple-invalid collection (wrong lead_id) without aborting", () => {
		const cfg = cfgWith([{ ...ONE_COLLECTION[0], lead_id: "ghost" }]);
		const d = only(planLearningRuns(makeDeps(cfg)));
		expect(d).toMatchObject({ action: "skip", reason: "tuple_invalid" });
	});

	it("emits nothing when config is disabled / absent / has no collections", () => {
		expect(planLearningRuns(makeDeps(null))).toEqual([]);
		expect(
			planLearningRuns(makeDeps(cfgWith(ONE_COLLECTION, { enabled: false }))),
		).toEqual([]);
		expect(planLearningRuns(makeDeps(cfgWith([])))).toEqual([]);
	});

	it("processes multiple collections independently (one bad, one good)", () => {
		const cfg = cfgWith([
			{ ...ONE_COLLECTION[0], collection_id: "bad", lead_id: "ghost" },
			{ ...ONE_COLLECTION[0], collection_id: "good" },
		]);
		const decisions = planLearningRuns(makeDeps(cfg));
		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({ action: "skip", collectionId: "bad" });
		expect(decisions[1]).toMatchObject({ action: "spawn" });
	});
});
