/**
 * FLY-222: scheduler planning-core tests (planLearningRuns).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	FlywheelConfig,
	XiaohongshuCollectionConfig,
} from "flywheel-config";
import {
	emptyState,
	readState,
	type XiaohongshuState,
} from "flywheel-comm/xiaohongshu-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import {
	type CollectionDecision,
	type CollectionRunPlan,
	executeLearningPlan,
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

	it("isolates a readState failure to that collection (codex MEDIUM — no tick abort)", () => {
		const deps = {
			...makeDeps(cfgWith(ONE_COLLECTION)),
			readState: () => {
				throw new Error("corrupt state file");
			},
		};
		const d = only(planLearningRuns(deps));
		expect(d).toMatchObject({ action: "skip", reason: "state_error" });
		if (d.action === "skip") expect(d.detail).toMatch(/corrupt state file/);
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

describe("executeLearningPlan", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xhs-exec-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const PLAN: CollectionRunPlan = {
		project: "sub",
		collectionId: "c1",
		collectionLabel: "AI-视频",
		leadId: "sub-lead",
		departmentLabel: "Sub",
		targetLinearProject: "Flywheel Sandbox",
		cadence: "weekly",
		maxFetch: 20,
		videoOptIn: false,
	};
	const spawnDecision: CollectionDecision = { action: "spawn", plan: PLAN };

	it("creates the trigger issue once, persists it, and starts a run", async () => {
		const createTriggerIssue = vi.fn(async () => "ISSUE-1");
		const startRun = vi.fn(async () => ({
			ok: true as const,
			executionId: "exec-1",
		}));
		const r = await executeLearningPlan([spawnDecision], {
			stateDir: dir,
			createTriggerIssue,
			startRun,
		});
		expect(r.spawned).toEqual(["c1"]);
		expect(createTriggerIssue).toHaveBeenCalledTimes(1);
		expect(startRun).toHaveBeenCalledWith({
			issueId: "ISSUE-1",
			projectName: "sub",
			leadId: "sub-lead",
		});
		expect(readState(dir, "sub", "c1").triggerIssueId).toBe("ISSUE-1");
	});

	it("reuses the persisted trigger issue on the next tick (no re-create)", async () => {
		const createTriggerIssue = vi.fn(async () => "ISSUE-1");
		const startRun = vi.fn(async () => ({
			ok: true as const,
			executionId: "e",
		}));
		const deps = { stateDir: dir, createTriggerIssue, startRun };
		await executeLearningPlan([spawnDecision], deps);
		await executeLearningPlan([spawnDecision], deps);
		expect(createTriggerIssue).toHaveBeenCalledTimes(1); // only first tick
		expect(startRun).toHaveBeenCalledTimes(2); // both ticks
	});

	it("treats runs/start 409 as a quiet skip (in-flight guard, not an error)", async () => {
		const alert = vi.fn();
		const r = await executeLearningPlan([spawnDecision], {
			stateDir: dir,
			createTriggerIssue: async () => "ISSUE-1",
			startRun: async () => ({ ok: false, status: 409, message: "active" }),
			alert,
		});
		expect(r.skipped).toContainEqual({
			collectionId: "c1",
			reason: "already_active",
		});
		expect(r.errors).toEqual([]);
		expect(alert).not.toHaveBeenCalled();
	});

	it("records + alerts on a non-409 start error, without aborting others", async () => {
		const alert = vi.fn();
		const r = await executeLearningPlan(
			[
				{ action: "spawn", plan: { ...PLAN, collectionId: "bad" } },
				{ action: "spawn", plan: { ...PLAN, collectionId: "good" } },
			],
			{
				stateDir: dir,
				createTriggerIssue: async (p) => `ISSUE-${p.collectionId}`,
				startRun: async ({ issueId }) =>
					issueId === "ISSUE-bad"
						? { ok: false, status: 500, message: "boom" }
						: { ok: true, executionId: "e" },
				alert,
			},
		);
		expect(r.errors.map((e) => e.collectionId)).toEqual(["bad"]);
		expect(r.spawned).toEqual(["good"]);
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("treats a 500 'already in progress' duplicate as a quiet skip (Codex #1)", async () => {
		const alert = vi.fn();
		const r = await executeLearningPlan([spawnDecision], {
			stateDir: dir,
			createTriggerIssue: async () => "ISSUE-1",
			startRun: async () => ({
				ok: false,
				status: 500,
				message: "Issue already in progress",
			}),
			alert,
		});
		expect(r.skipped).toContainEqual({
			collectionId: "c1",
			reason: "already_active",
		});
		expect(r.errors).toEqual([]);
		expect(alert).not.toHaveBeenCalled();
	});

	it("records an error if createTriggerIssue throws", async () => {
		const r = await executeLearningPlan([spawnDecision], {
			stateDir: dir,
			createTriggerIssue: async () => {
				throw new Error("linear down");
			},
			startRun: async () => ({ ok: true, executionId: "e" }),
		});
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0].detail).toMatch(/linear down/);
	});

	it("passes through skip decisions (alert on tuple_invalid, quiet on not_due)", async () => {
		const alert = vi.fn();
		const r = await executeLearningPlan(
			[
				{
					action: "skip",
					project: "sub",
					collectionId: "ti",
					reason: "tuple_invalid",
					detail: "bad",
				},
				{
					action: "skip",
					project: "sub",
					collectionId: "nd",
					reason: "not_due",
					detail: "later",
				},
			],
			{
				stateDir: dir,
				createTriggerIssue: async () => "x",
				startRun: async () => ({ ok: true, executionId: "e" }),
				alert,
			},
		);
		expect(r.skipped.map((s) => s.reason).sort()).toEqual([
			"not_due",
			"tuple_invalid",
		]);
		expect(alert).toHaveBeenCalledTimes(1); // only tuple_invalid
	});
});
