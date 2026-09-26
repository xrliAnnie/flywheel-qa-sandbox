import type { FlywheelConfig } from "flywheel-config";
import { describe, expect, it } from "vitest";
import type { ProjectConfigEntry } from "../bridge/feature-flag-config-source.js";
import { buildConsoleSnapshot } from "../bridge/fleet-console-model.js";
import {
	buildCronModelViews,
	buildProjectRunnerDefaults,
} from "../bridge/project-runner-model-source.js";
import type { ProjectEntry } from "../ProjectConfig.js";

// FLY-709 ② (b): the per-project runner DEFAULT model (roles.runner in
// config.yaml) is surfaced read-only. Only DISPLAY — no writer.

function cfg(runner?: {
	backend?: string;
	model?: string;
	effort?: string;
}): FlywheelConfig {
	return { roles: runner ? { runner } : {} } as unknown as FlywheelConfig;
}

const PROJECTS: ProjectEntry[] = [
	{ projectName: "flywheel", projectRoot: "/tmp/fw", leads: [] },
	{ projectName: "geo", projectRoot: "/tmp/geo", leads: [] },
] as unknown as ProjectEntry[];

describe("buildProjectRunnerDefaults", () => {
	it("reads roles.runner model/effort/backend when set", () => {
		const configs = new Map<string, ProjectConfigEntry>([
			[
				"flywheel",
				{
					config: cfg({
						backend: "codex-tmux",
						model: "claude-opus-4-8",
						effort: "high",
					}),
				},
			],
			["geo", { config: cfg() }],
		]);
		const rows = buildProjectRunnerDefaults(PROJECTS, configs);
		expect(rows).toEqual([
			{
				projectName: "flywheel",
				model: "claude-opus-4-8",
				effort: "high",
				backend: "codex-tmux",
			},
			{ projectName: "geo", model: null, effort: null, backend: null },
		]);
	});

	it("no config / no roles.runner → account default (null), not an error", () => {
		const configs = new Map<string, ProjectConfigEntry>([
			["flywheel", {}], // ENOENT → absent/default
			["geo", { config: cfg(undefined) }], // config present, no roles.runner
		]);
		const rows = buildProjectRunnerDefaults(PROJECTS, configs);
		expect(rows[0]).toEqual({
			projectName: "flywheel",
			model: null,
			effort: null,
			backend: null,
		});
		expect(rows[1]?.model).toBeNull();
		expect(rows[0]?.error).toBeUndefined();
	});

	it("surfaces a malformed config as error data (never silently defaulted)", () => {
		const configs = new Map<string, ProjectConfigEntry>([
			["flywheel", { error: "bad yaml at line 3" }],
			["geo", { config: cfg({ backend: "claude-tmux" }) }],
		]);
		const rows = buildProjectRunnerDefaults(PROJECTS, configs);
		expect(rows[0]).toEqual({
			projectName: "flywheel",
			model: null,
			effort: null,
			backend: null,
			error: "bad yaml at line 3",
		});
		expect(rows[1]?.backend).toBe("claude-tmux");
	});

	it("preserves project order and always includes every project", () => {
		const rows = buildProjectRunnerDefaults(PROJECTS, new Map());
		expect(rows.map((r) => r.projectName)).toEqual(["flywheel", "geo"]);
	});
});

describe("buildConsoleSnapshot — projectRunnerDefaults", () => {
	it("attaches when rows exist; omitted when empty (byte-compat)", () => {
		const withRows = buildConsoleSnapshot(PROJECTS, undefined, {
			projectRunnerDefaults: [
				{
					projectName: "flywheel",
					model: "fable",
					effort: null,
					backend: null,
				},
			],
		});
		expect(withRows.projectRunnerDefaults?.length).toBe(1);

		const empty = buildConsoleSnapshot(PROJECTS, undefined, {
			projectRunnerDefaults: [],
		});
		expect(empty.projectRunnerDefaults).toBeUndefined();

		const none = buildConsoleSnapshot(PROJECTS);
		expect(none.projectRunnerDefaults).toBeUndefined();
	});
});

// FLY-709 P4.4: cron (recurring xiaohongshu trigger issue) model rows — from
// the SAME cached config map; only projects with enabled collections appear.
describe("buildCronModelViews", () => {
	it("lists collections with their configured model (null = default)", () => {
		const configs = new Map([
			[
				"flywheel",
				{
					config: {
						xiaohongshu_learning: {
							enabled: true,
							collections: [
								{
									collection_id: "c1",
									label: "AI-视频",
									lead_id: "sub-lead",
									department_label: "Sub",
									target_linear_project: "Sub",
									model: "haiku",
								},
								{
									collection_id: "c2",
									label: "灵感",
									lead_id: "sub-lead",
									department_label: "Sub",
									target_linear_project: "Sub",
								},
							],
						},
					} as never,
				},
			],
		]);
		const rows = buildCronModelViews(PROJECTS, configs);
		expect(rows).toEqual([
			{
				projectName: "flywheel",
				collectionId: "c1",
				label: "AI-视频",
				leadId: "sub-lead",
				model: "haiku",
			},
			{
				projectName: "flywheel",
				collectionId: "c2",
				label: "灵感",
				leadId: "sub-lead",
				model: null,
			},
		]);
	});

	it("omits disabled/absent xiaohongshu configs entirely", () => {
		const configs = new Map([
			[
				"flywheel",
				{
					config: {
						xiaohongshu_learning: {
							enabled: false,
							collections: [
								{
									collection_id: "c1",
									label: "x",
									lead_id: "l",
									department_label: "D",
									target_linear_project: "P",
								},
							],
						},
					} as never,
				},
			],
		]);
		expect(buildCronModelViews(PROJECTS, configs)).toEqual([]);
		expect(buildCronModelViews(PROJECTS, new Map())).toEqual([]);
	});
});
