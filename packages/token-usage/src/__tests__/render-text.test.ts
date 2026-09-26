import { describe, expect, it } from "vitest";
import { buildReportModel } from "../report/build-report.js";
import { renderReportText } from "../report/render-text.js";
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
	r({
		scope: "total",
		totalTokens: 1_000,
		inputTokens: 100,
		costMicroUsd: 6_518_000_000,
	}),
	r({
		scope: "project",
		dimKey: "flywheel",
		project: "flywheel",
		totalTokens: 1_000,
		costMicroUsd: 1_142_000_000,
	}),
	r({
		scope: "lead",
		dimKey: "flywheel-eng-lead",
		project: "flywheel",
		totalTokens: 400,
		costMicroUsd: 420_000, // $0.42 nested lead
	}),
	r({
		scope: "issue",
		dimKey: "FLY-604",
		project: "flywheel",
		totalTokens: 33,
		costMicroUsd: 770_000, // $0.77 nested completed issue
	}),
	r({
		scope: "model",
		dimKey: "claude-opus-4-8",
		totalTokens: 900,
		costMicroUsd: 6_500_000_000,
	}),
];

const m = buildReportModel(rows, {
	reportDay: "2026-06-26",
	timezone: "UTC",
	isCompleted: (id) => id === "FLY-604",
});

describe("renderReportText", () => {
	const text = renderReportText(m);

	it("reframes the headline USD as a cost estimate", () => {
		expect(text).toContain("成本估算");
		expect(text).not.toContain("重量");
	});

	it("labels the Claude-Code-only scope (Codex deferred)", () => {
		expect(text).toContain("仅 Claude Code");
		expect(text).toContain("FLY-714");
	});

	it("shows $ on the nested lead row (FLY-713 text gap fix)", () => {
		const line = text.split("\n").find((l) => l.includes("flywheel-eng-lead"));
		expect(line).toBeDefined();
		expect(line).toContain("lead");
		expect(line).toContain("$0.42");
	});

	it("shows $ on the nested completed-issue row", () => {
		const line = text.split("\n").find((l) => l.includes("FLY-604"));
		expect(line).toBeDefined();
		expect(line).toContain("done");
		expect(line).toContain("$0.77");
	});

	it("shows $ on the by-model row", () => {
		const line = text.split("\n").find((l) => l.includes("claude-opus-4-8"));
		expect(line).toContain("$6,500");
	});
});
