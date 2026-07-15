import { describe, expect, it } from "vitest";
import { buildReportModel } from "../report/build-report.js";
import type { DailyRow } from "../types.js";

function r(p: Partial<DailyRow>): DailyRow {
	const tokens = p.totalTokens ?? 0;
	return {
		day: "2026-06-26",
		scope: "total",
		dimKey: "",
		project: null,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: tokens,
		freshTokens: tokens,
		costMicroUsd: 0,
		isCompleted: null,
		...p,
	};
}

const rows: DailyRow[] = [
	// report day 06-26
	r({
		scope: "total",
		totalTokens: 1000,
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 900,
		cacheWriteTokens: 70,
	}),
	r({
		scope: "project",
		dimKey: "flywheel",
		project: "flywheel",
		totalTokens: 600,
	}),
	r({ scope: "project", dimKey: "sub", project: "sub", totalTokens: 100 }),
	r({
		scope: "lead",
		dimKey: "flywheel-eng-lead",
		project: "flywheel",
		totalTokens: 200,
	}),
	r({ scope: "lead", dimKey: "sub-lead", project: "sub", totalTokens: 50 }),
	r({ scope: "issue", dimKey: "FLY-1", project: "flywheel", totalTokens: 120 }), // completed
	r({ scope: "issue", dimKey: "FLY-2", project: "flywheel", totalTokens: 300 }), // in-progress
	r({ scope: "model", dimKey: "claude-opus-4-8", totalTokens: 950 }),
	r({ scope: "model", dimKey: "claude-fable-5", totalTokens: 50 }),
	// prior day 06-25 (for trend + before window)
	r({ day: "2026-06-25", scope: "total", totalTokens: 800 }),
	r({
		day: "2026-06-25",
		scope: "project",
		dimKey: "flywheel",
		project: "flywheel",
		totalTokens: 500,
	}),
	r({
		day: "2026-06-25",
		scope: "lead",
		dimKey: "flywheel-eng-lead",
		project: "flywheel",
		totalTokens: 100,
	}),
	r({
		day: "2026-06-25",
		scope: "model",
		dimKey: "claude-opus-4-8",
		totalTokens: 800,
	}),
];

const completed = new Set(["FLY-1"]);
const isCompleted = (id: string) => completed.has(id);

describe("buildReportModel", () => {
	const m = buildReportModel(rows, {
		reportDay: "2026-06-26",
		timezone: "America/Los_Angeles",
		isCompleted,
		trendSince: "2026-06-25",
	});

	it("project total = runner+main + owned leads (1:1 fold, no double-count)", () => {
		const fly = m.projects.find((p) => p.name === "flywheel");
		expect(fly?.runnerMainTokens).toBe(600);
		expect(fly?.tokens).toBe(800); // 600 + lead 200
	});

	it("nests only the project's own leads", () => {
		const fly = m.projects.find((p) => p.name === "flywheel");
		expect(fly?.leads.map((l) => l.name)).toEqual(["flywheel-eng-lead"]);
	});

	it("shows only completed issues; counts in-progress separately (per-day, option i)", () => {
		const fly = m.projects.find((p) => p.name === "flywheel");
		expect(fly?.issues.map((i) => i.id)).toEqual(["FLY-1"]);
		expect(fly?.inprogCount).toBe(1);
		expect(fly?.inprogTokens).toBe(300);
	});

	it("ranks projects by total desc", () => {
		expect(m.projects.map((p) => p.name)).toEqual(["flywheel", "sub"]);
	});

	it("pads known projects with no usage as 0-entries (FLY-713)", () => {
		const padded = buildReportModel(rows, {
			reportDay: "2026-06-26",
			timezone: "America/Los_Angeles",
			isCompleted: () => false,
			knownProjects: [
				"flywheel",
				"sub",
				"joycon-typeless",
				"tidal-echo",
				"polaris",
			],
			displayOnlyProjects: ["polaris"],
		});
		const names = padded.projects.map((p) => p.name);
		expect(names).toContain("joycon-typeless");
		expect(names).toContain("tidal-echo");
		expect(names).toContain("polaris");
		// Active projects keep their data; padded ones are 0 and appended after.
		expect(padded.projects[0].name).toBe("flywheel");
		const joycon = padded.projects.find((p) => p.name === "joycon-typeless");
		expect(joycon).toMatchObject({ tokens: 0, cost: 0, leads: [], issues: [] });
		// Registered-but-0 projects are not flagged; display-only ones are.
		expect(joycon?.unregistered).toBeFalsy();
		const polaris = padded.projects.find((p) => p.name === "polaris");
		expect(polaris?.unregistered).toBe(true);
		// A padded project is excluded from the per-project trend (no line for 0 data).
		expect(padded.trendByProject.map((t) => t.project)).not.toContain(
			"joycon-typeless",
		);
	});

	it("exposes a flat fleet Leads ranking", () => {
		expect(m.leadsAll.map((l) => l.name)).toEqual([
			"flywheel-eng-lead",
			"sub-lead",
		]);
	});

	it("captures the total split (cache-read dominance visible)", () => {
		expect(m.total).toMatchObject({
			tokens: 1000,
			cacheRead: 900,
			input: 10,
			output: 20,
			cacheWrite: 70,
		});
	});

	it("builds total trend across the window (tokens + cost)", () => {
		expect(m.trendTotal).toEqual([
			{ day: "2026-06-25", tokens: 800, cost: 0 },
			{ day: "2026-06-26", tokens: 1000, cost: 0 },
		]);
	});

	it("builds per-project trend = project + its leads per day", () => {
		const fly = m.trendByProject.find((t) => t.project === "flywheel");
		// 06-25: 500 + 100 = 600 ; 06-26: 600 + 200 = 800
		expect(fly?.points).toEqual([
			{ day: "2026-06-25", tokens: 600, cost: 0 },
			{ day: "2026-06-26", tokens: 800, cost: 0 },
		]);
	});

	it("computes before/after comparison windows when requested", () => {
		const cmp = buildReportModel(rows, {
			reportDay: "2026-06-26",
			timezone: "UTC",
			isCompleted,
			before: { since: "2026-06-25", until: "2026-06-25", label: "before" },
			after: { since: "2026-06-26", until: "2026-06-26", label: "after" },
		}).comparison;
		expect(cmp?.before.avgTokens).toBe(800);
		expect(cmp?.after.avgTokens).toBe(1000);
		expect(cmp?.after.byModel["claude-opus-4-8"]).toBe(950);
	});
});
