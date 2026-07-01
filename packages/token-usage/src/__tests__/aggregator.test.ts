import { describe, expect, it } from "vitest";
import { aggregateDaily } from "../aggregator.js";
import { resolveLeadProject } from "../lead-project.js";
import type { DailyRow, UsageRecord } from "../types.js";

let n = 0;
function rec(p: Partial<UsageRecord>): UsageRecord {
	n += 1;
	return {
		requestId: `r${n}`,
		cwd: "",
		gitBranch: null,
		model: "claude-opus-4-8",
		day: "2026-06-26",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		kind: "runner",
		project: null,
		issue: null,
		leadWho: null,
		...p,
	};
}

const find = (rows: DailyRow[], scope: string, dimKey: string) =>
	rows.find((r) => r.scope === scope && r.dimKey === dimKey);

describe("resolveLeadProject", () => {
	it("uses the explicit 1:1 map", () => {
		expect(resolveLeadProject("flywheel-eng-lead")).toBe("flywheel");
		expect(resolveLeadProject("sub-lead")).toBe("sub");
		expect(resolveLeadProject("product-lead")).toBe("geoforge3d");
	});
	it("falls back to a known-project name prefix", () => {
		expect(resolveLeadProject("tidal-echo-something-lead")).toBe("tidal-echo");
	});
	it("falls back to the bucket for unknown leads", () => {
		expect(resolveLeadProject("totally-unknown")).toBe("(其它)");
	});
});

describe("aggregateDaily", () => {
	const records: UsageRecord[] = [
		rec({
			kind: "runner",
			project: "flywheel",
			issue: "FLY-1",
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 100,
			cacheWriteTokens: 30,
		}),
		rec({
			kind: "lead",
			leadWho: "flywheel-eng-lead",
			inputTokens: 5,
			outputTokens: 5,
			cacheReadTokens: 50,
			cacheWriteTokens: 0,
			model: "claude-fable-5",
		}),
		rec({
			kind: "runner",
			project: "sub",
			issue: "LEARN-1",
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 10,
			cacheWriteTokens: 0,
		}),
		rec({
			kind: "sandbox",
			inputTokens: 7,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			model: "claude-haiku-4-5-20251001",
		}),
	];
	const rows = aggregateDaily(records);

	it("total reconciles to the sum of all records (incl sandbox)", () => {
		const total = find(rows, "total", "");
		// total tokens = (10+20+100+30) + (5+5+50+0) + (1+1+10+0) + (7) = 160 + 60 + 12 + 7 = 239
		expect(total?.totalTokens).toBe(239);
	});

	it("project scope = runner+main only (Leads NOT folded in)", () => {
		const fly = find(rows, "project", "flywheel");
		expect(fly?.totalTokens).toBe(160); // only the FLY-1 runner, not the lead
		expect(fly?.project).toBe("flywheel");
		const sub = find(rows, "project", "sub");
		expect(sub?.totalTokens).toBe(12);
	});

	it("lead scope attributes the lead to its owning project", () => {
		const lead = find(rows, "lead", "flywheel-eng-lead");
		expect(lead?.totalTokens).toBe(60);
		expect(lead?.project).toBe("flywheel");
	});

	it("issue scope holds all issues with project attribution", () => {
		expect(find(rows, "issue", "FLY-1")?.project).toBe("flywheel");
		expect(find(rows, "issue", "LEARN-1")?.project).toBe("sub");
	});

	it("computes fresh tokens (excludes cache-read)", () => {
		const fly = find(rows, "project", "flywheel");
		// fresh = input + output + cacheWrite = 10 + 20 + 30 = 60
		expect(fly?.freshTokens).toBe(60);
	});

	it("computes cost per group from per-record model rates", () => {
		// FLY-1 opus (5/25/0.5/6.25): 10*5 + 20*25 + 100*0.5 + 30*6.25 = 50+500+50+187.5 = 787.5 -> round 788
		const fly = find(rows, "project", "flywheel");
		expect(fly?.costMicroUsd).toBe(788);
	});

	it("threads a custom rates table into the stored cost (FLY-713 config seam)", () => {
		const custom = aggregateDaily(
			[
				rec({
					kind: "runner",
					project: "flywheel",
					issue: "FLY-1",
					inputTokens: 1_000_000,
					model: "claude-opus-4-8",
				}),
			],
			{
				rates: {
					"claude-opus-4-8": {
						input: 1,
						output: 1,
						cacheRead: 1,
						cacheWrite: 1,
					},
				},
			},
		);
		// 1M input × $1/MTok = $1 = 1_000_000 micro (not the default $5).
		expect(find(custom, "project", "flywheel")?.costMicroUsd).toBe(1_000_000);
	});

	it("emits per-model rows excluding synthetic", () => {
		expect(find(rows, "model", "claude-opus-4-8")).toBeDefined();
		expect(find(rows, "model", "claude-fable-5")).toBeDefined();
		expect(find(rows, "model", "<synthetic>")).toBeUndefined();
	});

	it("surfaces sandbox + other usage as explicit buckets (never silently dropped)", () => {
		const withOther = aggregateDaily([
			rec({
				kind: "runner",
				project: "flywheel",
				issue: "FLY-1",
				inputTokens: 100,
			}),
			rec({ kind: "sandbox", inputTokens: 50 }),
			rec({ kind: "other", inputTokens: 25 }),
		]);
		expect(find(withOther, "project", "(sandbox)")?.totalTokens).toBe(50);
		expect(find(withOther, "project", "(unattributed)")?.totalTokens).toBe(25);
		// reconciles: total = 175
		expect(find(withOther, "total", "")?.totalTokens).toBe(175);
	});

	it("separates rows by day", () => {
		const multi = aggregateDaily([
			rec({
				kind: "runner",
				project: "flywheel",
				issue: "FLY-1",
				day: "2026-06-25",
				inputTokens: 1,
			}),
			rec({
				kind: "runner",
				project: "flywheel",
				issue: "FLY-1",
				day: "2026-06-26",
				inputTokens: 2,
			}),
		]);
		expect(
			multi
				.filter((r) => r.scope === "total")
				.map((r) => r.day)
				.sort(),
		).toEqual(["2026-06-25", "2026-06-26"]);
	});
});
