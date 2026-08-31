/**
 * FLY-222: scheduler planning-core tests (planLearningRuns).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emptyState,
	readState,
	type XiaohongshuState,
} from "flywheel-comm/xiaohongshu-state";
import type {
	FlywheelConfig,
	XiaohongshuCollectionConfig,
} from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import {
	buildTriggerBody,
	type CollectionDecision,
	type CollectionRunPlan,
	executeLearningPlan,
	planLearningRuns,
} from "../xiaohongshu-scheduler.js";

const NOW = new Date("2026-06-06T00:00:00Z");

function lead(agentId: string, labels: string[], canSpawn = true): LeadConfig {
	return {
		agentId,
		match: { labels },
		canSpawnRunners: canSpawn,
	} as LeadConfig;
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
		learningEnabled: () => true,
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
				// FLY-286 post-hoc params resolved to their config defaults
				reviewChannel: "web-local",
				firstRunCap: 15,
				firstRunAnalyzeLimit: 200,
				autoCreate: true,
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

	it("carries post-hoc params while fixing auto_create true", () => {
		const cfg = cfgWith([
			{
				...ONE_COLLECTION[0],
				first_run_cap: 3,
				first_run_analyze_limit: 50,
				auto_create: false,
			},
		]);
		const d = only(planLearningRuns(makeDeps(cfg)));
		if (d.action === "spawn") {
			expect(d.plan.firstRunCap).toBe(3);
			expect(d.plan.firstRunAnalyzeLimit).toBe(50);
			expect(d.plan.autoCreate).toBe(true);
			expect(d.plan.reviewChannel).toBe("web-local");
		}
	});

	it("preserves the falsy first_run_cap: 0 (nullish-coalescing, not || → must NOT fall to 15)", () => {
		const cfg = cfgWith([{ ...ONE_COLLECTION[0], first_run_cap: 0 }]);
		const d = only(planLearningRuns(makeDeps(cfg)));
		if (d.action === "spawn") expect(d.plan.firstRunCap).toBe(0);
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

	it("emits nothing when the store gate is off, config is absent, or collections are empty", () => {
		expect(planLearningRuns(makeDeps(null))).toEqual([]);
		expect(
			planLearningRuns({
				...makeDeps(cfgWith(ONE_COLLECTION)),
				learningEnabled: () => false,
			}),
		).toEqual([]);
		expect(planLearningRuns(makeDeps(cfgWith([])))).toEqual([]);
	});

	it("isolates a store failure to one project and continues planning others", () => {
		const projects = [
			project("broken", [lead("sub-lead", ["Sub"])]),
			project("sub", [lead("sub-lead", ["Sub"])]),
		];
		const warn = vi.fn();
		const decisions = planLearningRuns({
			...makeDeps(cfgWith(ONE_COLLECTION)),
			projects,
			learningEnabled: (name) => {
				if (name === "broken") throw new Error("store unavailable");
				return true;
			},
			warn,
		});
		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({
			action: "skip",
			project: "broken",
			reason: "flag_error",
		});
		expect(decisions[1]).toMatchObject({ action: "spawn" });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("store unavailable"),
		);
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
		reviewChannel: "web-local",
		firstRunCap: 15,
		firstRunAnalyzeLimit: 200,
		autoCreate: true,
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

	it("calls createTriggerIssue each tick (find-or-create + body re-sync) on the SAME id, no duplicate", async () => {
		// createTriggerIssue is now idempotent (find-or-create by stable title) and
		// runs OUTSIDE the mutex; it is invoked every tick to re-sync the trigger
		// body to current config, always returning the same id — no duplicate issue.
		const createTriggerIssue = vi.fn(async () => "ISSUE-1");
		const startRun = vi.fn(async () => ({
			ok: true as const,
			executionId: "e",
		}));
		const deps = { stateDir: dir, createTriggerIssue, startRun };
		await executeLearningPlan([spawnDecision], deps);
		await executeLearningPlan([spawnDecision], deps);
		expect(createTriggerIssue).toHaveBeenCalledTimes(2); // each tick re-syncs body
		expect(startRun).toHaveBeenCalledTimes(2); // both ticks
		expect(readState(dir, "sub", "c1").triggerIssueId).toBe("ISSUE-1");
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

describe("buildTriggerBody (the YAML the skill reads — cross-artifact contract)", () => {
	const plan: CollectionRunPlan = {
		project: "sub",
		collectionId: "c1",
		collectionLabel: "AI-视频",
		leadId: "sub-lead",
		departmentLabel: "Sub",
		targetLinearProject: "Flywheel Sandbox",
		cadence: "weekly",
		maxFetch: 20,
		videoOptIn: false,
		reviewChannel: "web-local",
		firstRunCap: 15,
		firstRunAnalyzeLimit: 200,
		autoCreate: true,
	};
	const body = buildTriggerBody(plan, "FLY");

	it("emits every param name the skill reads", () => {
		for (const key of [
			"project:",
			"collection_id:",
			"collection_label:",
			"lead_id:",
			"linear_team:",
			"target_linear_project:",
			"cadence:",
			"max_fetch:",
			"video_opt_in:",
			"review_channel:",
			"first_run_cap:",
			"first_run_analyze_limit:",
			"auto_create:",
		]) {
			expect(body).toContain(key);
		}
		expect(body).toContain("review_channel: web-local");
		expect(body).toContain("first_run_cap: 15");
		expect(body).toContain("first_run_analyze_limit: 200");
		expect(body).toContain("auto_create: true");
		expect(body).toContain("linear_team: FLY");
	});

	it("deliberately EXCLUDES base_url (the skill reads $FLYWHEEL_BRIDGE_URL from env)", () => {
		expect(body).not.toContain("base_url");
	});
});

// FLY-709 P4.4: per-collection runner model — planner carries it verbatim,
// executor passes it into the /api/runs/start args ONLY when configured
// (absent = today's request shape byte-for-byte).
describe("collections[].model pass-through (FLY-709)", () => {
	it("planner carries col.model into plan.model; absent stays undefined", () => {
		const withModel = only(
			planLearningRuns(
				makeDeps(cfgWith([{ ...ONE_COLLECTION[0], model: "haiku" }])),
			),
		);
		expect(withModel.action).toBe("spawn");
		if (withModel.action === "spawn") {
			expect(withModel.plan.model).toBe("haiku");
		}
		const without = only(planLearningRuns(makeDeps(cfgWith(ONE_COLLECTION))));
		if (without.action === "spawn") {
			expect(without.plan.model).toBeUndefined();
		}
	});

	it("executor forwards plan.model to startRun; absent = no model key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "xhs-model-"));
		try {
			const createTriggerIssue = vi.fn(async () => "ISSUE-M");
			const startRun = vi.fn(async () => ({
				ok: true as const,
				executionId: "exec-m",
			}));
			const basePlan: CollectionRunPlan = {
				project: "sub",
				collectionId: "c1",
				collectionLabel: "AI-视频",
				leadId: "sub-lead",
				departmentLabel: "Sub",
				targetLinearProject: "Flywheel Sandbox",
				cadence: "weekly",
				maxFetch: 20,
				videoOptIn: false,
				reviewChannel: "web-local",
				firstRunCap: 15,
				firstRunAnalyzeLimit: 200,
				autoCreate: true,
			};
			await executeLearningPlan(
				[{ action: "spawn", plan: { ...basePlan, model: "claude-sonnet-5" } }],
				{ stateDir: dir, createTriggerIssue, startRun },
			);
			expect(startRun).toHaveBeenCalledWith({
				issueId: "ISSUE-M",
				projectName: "sub",
				leadId: "sub-lead",
				model: "claude-sonnet-5",
			});

			startRun.mockClear();
			await executeLearningPlan(
				[{ action: "spawn", plan: { ...basePlan, collectionId: "c2" } }],
				{ stateDir: dir, createTriggerIssue, startRun },
			);
			const args = startRun.mock.calls[0][0] as Record<string, unknown>;
			expect("model" in args).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
