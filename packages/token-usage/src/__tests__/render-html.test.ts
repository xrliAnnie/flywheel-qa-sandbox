import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReportModel } from "../report/build-report.js";
import { renderReportHtml } from "../report/render-html.js";
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
		totalTokens: 2_740_000_000,
		inputTokens: 5_000_000,
		outputTokens: 12_000_000,
		cacheReadTokens: 2_630_000_000,
		cacheWriteTokens: 88_000_000,
		costMicroUsd: 6_518_000_000,
	}),
	r({
		scope: "project",
		dimKey: "flywheel",
		project: "flywheel",
		totalTokens: 1_330_000_000,
		costMicroUsd: 2_700_000_000,
	}),
	r({
		scope: "project",
		dimKey: "sub",
		project: "sub",
		totalTokens: 1_007_000_000,
	}),
	r({
		scope: "lead",
		dimKey: "flywheel-eng-lead",
		project: "flywheel",
		totalTokens: 403_000_000,
		costMicroUsd: 1_142_000_000,
	}),
	r({
		scope: "issue",
		dimKey: "FLY-604",
		project: "flywheel",
		totalTokens: 33_000_000,
		costMicroUsd: 77_000_000,
	}),
	r({
		scope: "issue",
		dimKey: "FLY-999",
		project: "flywheel",
		totalTokens: 300_000_000,
	}),
	r({
		scope: "model",
		dimKey: "claude-opus-4-8",
		totalTokens: 2_700_000_000,
		costMicroUsd: 6_500_000_000,
	}),
];

const m = buildReportModel(rows, {
	reportDay: "2026-06-26",
	timezone: "America/Los_Angeles",
	isCompleted: (id) => id === "FLY-604",
	before: { since: "2026-06-26", until: "2026-06-26", label: "改动前" },
	after: { since: "2026-06-26", until: "2026-06-26", label: "改动后" },
});

describe("renderReportHtml", () => {
	const html = renderReportHtml(m);

	it("produces a valid self-contained HTML page with <head> and inline CSS", () => {
		expect(html).toMatch(/^<!doctype html>/i);
		expect(html).toContain("<head>");
		expect(html).toContain("<style>");
		expect(html).toContain("</html>");
	});

	it("stays well under the 512KB publish cap for a realistic report", () => {
		expect(Buffer.byteLength(html, "utf8")).toBeLessThan(512 * 1024);
	});

	it("renders the headline total, project, lead, and completed issue", () => {
		expect(html).toContain("2.74B");
		expect(html).toContain("flywheel");
		expect(html).toContain("flywheel-eng-lead");
		expect(html).toContain("FLY-604");
	});

	it("hides in-progress issues from the completed list but notes them", () => {
		expect(html).not.toContain("FLY-999");
		expect(html).toContain("进行中");
	});

	it("shows the cache-read split and the comparison hero", () => {
		expect(html).toContain("cache read");
		expect(html).toContain("改动前");
		expect(html).toContain("改动后");
	});

	it("surfaces a local-fallback warning banner when present", () => {
		const withWarn = renderReportHtml({
			...m,
			storeMode: "local",
			warning: "Supabase unreachable; local-only",
		});
		expect(withWarn).toContain("Supabase unreachable");
	});

	it("renders a prominent red integrity failure banner", () => {
		const broken = buildReportModel(
			[r({ day: "2026-06-25", scope: "total", totalTokens: 100 })],
			{
				reportDay: "2026-06-26",
				timezone: "UTC",
				isCompleted: () => false,
				trendSince: "2026-06-25",
			},
		);
		const out = renderReportHtml(broken);
		expect(out).toContain('class="alert-red"');
		expect(out).toContain("报告数据完整性自检未过");
		expect(out).toContain("缺少 total 汇总行");
		expect(out).toContain("2026-06-25");
		expect(out).toContain("2026-06-26");
	});

	it("reframes USD as a cost estimate (not 'weight')", () => {
		expect(html).toContain("成本估算");
		expect(html).not.toContain("重量");
	});

	it("labels the Claude-Code-only scope (Codex deferred to FLY-714)", () => {
		expect(html).toContain("仅 Claude Code");
		expect(html).toContain("FLY-714");
	});

	it("shows the weekday on the report date (FLY-713 — workday/weekend pattern)", () => {
		// 2026-06-26 is a Friday (周五).
		expect(html).toContain("周五");
	});
});

describe("renderReportHtml Fable family labels", () => {
	it("formats numeric versions and 1M variants without per-version tables", () => {
		const family = buildReportModel(
			[
				r({ scope: "total", totalTokens: 300 }),
				r({
					scope: "model",
					dimKey: "claude-fable-5-1",
					totalTokens: 100,
				}),
				r({
					scope: "model",
					dimKey: "claude-fable-5-10[1m]",
					totalTokens: 200,
				}),
			],
			{
				reportDay: "2026-06-26",
				timezone: "UTC",
				isCompleted: () => false,
			},
		);
		const out = renderReportHtml(family);
		expect(out).toContain("Fable 5.1");
		expect(out).toMatch(/Fable 5\.10 · 1M.*background:#34c759/);
	});
});

describe("renderReportHtml FLY-713 — links + precision", () => {
	const linkRows: DailyRow[] = [
		r({ scope: "total", totalTokens: 1_000, costMicroUsd: 420_000 }),
		r({
			scope: "project",
			dimKey: "flywheel",
			project: "flywheel",
			totalTokens: 1_000,
			costMicroUsd: 420_000,
		}),
		r({
			scope: "issue",
			dimKey: "FLY-42",
			project: "flywheel",
			totalTokens: 500,
			costMicroUsd: 420_000, // $0.42 — a small completed issue
		}),
		r({
			scope: "issue",
			dimKey: "WEIRD ID",
			project: "flywheel",
			totalTokens: 10,
			costMicroUsd: 1_000,
		}),
	];
	const linkModel = buildReportModel(linkRows, {
		reportDay: "2026-06-26",
		timezone: "UTC",
		isCompleted: () => true, // both issues count as completed
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TOKEN_USAGE_LINEAR_WORKSPACE;
	});

	it("renders a completed FLY-XXX as a clickable Linear link", () => {
		const out = renderReportHtml(linkModel);
		expect(out).toContain(
			'<a href="https://linear.app/geoforge3d/issue/FLY-42" target="_blank" rel="noopener">FLY-42</a>',
		);
	});

	it("does NOT link a malformed issue id (plain text only)", () => {
		const out = renderReportHtml(linkModel);
		expect(out).not.toContain("issue/WEIRD");
	});

	it("shows cents for a small issue cost instead of $0", () => {
		const out = renderReportHtml(linkModel);
		expect(out).toContain("$0.42");
	});

	it("honors a valid configured workspace and falls back on an invalid one", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.TOKEN_USAGE_LINEAR_WORKSPACE = "myteam";
		expect(renderReportHtml(linkModel)).toContain(
			"https://linear.app/myteam/issue/FLY-42",
		);
		process.env.TOKEN_USAGE_LINEAR_WORKSPACE = "bad ws!";
		expect(renderReportHtml(linkModel)).toContain(
			"https://linear.app/geoforge3d/issue/FLY-42",
		);
	});
});

// FLY-744 anti-regression: the trend chart, weekday, and before/after comparison hero
// were the features Annie reported "lost". They are NOT lost in the code; lock them in
// so a future "rebuild" can't silently drop them again.
describe("renderReportHtml — FLY-744 trend + comparison sentinels", () => {
	const tr = (day: string, tokens: number, cost: number): DailyRow[] => [
		r({ day, scope: "total", totalTokens: tokens, costMicroUsd: cost }),
		r({
			day,
			scope: "project",
			dimKey: "flywheel",
			project: "flywheel",
			totalTokens: tokens,
			costMicroUsd: cost,
		}),
	];
	const trendRows: DailyRow[] = [
		...tr("2026-06-22", 2_000_000_000, 1_000_000_000),
		...tr("2026-06-23", 1_500_000_000, 800_000_000),
		...tr("2026-06-24", 2_600_000_000, 1_200_000_000),
		...tr("2026-06-25", 1_700_000_000, 900_000_000),
		...tr("2026-06-26", 2_740_000_000, 1_300_000_000),
	];
	const trendModel = buildReportModel(trendRows, {
		reportDay: "2026-06-26",
		timezone: "America/Los_Angeles",
		isCompleted: () => false,
		trendSince: "2026-06-22",
		before: { since: "2026-06-22", until: "2026-06-23", label: "前一周" },
		after: { since: "2026-06-24", until: "2026-06-26", label: "本周" },
	});
	const html = renderReportHtml(trendModel);

	it("renders the fleet trend chart with a peak label and both trend dimensions", () => {
		expect(html).toContain("峰值");
		expect(html).toContain("维度①");
		expect(html).toContain("维度②");
	});

	it("keeps total-trend SVG bar heights linearly proportional to token values", () => {
		const ratioRows: DailyRow[] = [
			...tr("2026-06-24", 100, 10),
			...tr("2026-06-25", 200, 20),
			...tr("2026-06-26", 400, 40),
		];
		const out = renderReportHtml(
			buildReportModel(ratioRows, {
				reportDay: "2026-06-26",
				timezone: "UTC",
				isCompleted: () => false,
				trendSince: "2026-06-24",
			}),
		);
		const heights = new Map<string, number>();
		for (const match of out.matchAll(
			/<rect[^>]*height="([\d.]+)"[^>]*><title>(2026-06-\d{2}):/g,
		)) {
			heights.set(match[2]!, Number(match[1]));
		}
		expect(heights.size).toBe(3);
		expect(heights.get("2026-06-25")! / heights.get("2026-06-24")!).toBeCloseTo(
			2,
			2,
		);
		expect(heights.get("2026-06-26")! / heights.get("2026-06-24")!).toBeCloseTo(
			4,
			2,
		);
	});

	it("scales project bars against the actual maximum even when projects are unsorted", () => {
		const model = buildReportModel(
			[
				r({ scope: "total", totalTokens: 300 }),
				r({
					scope: "project",
					dimKey: "small",
					project: "small",
					totalTokens: 100,
				}),
				r({
					scope: "project",
					dimKey: "large",
					project: "large",
					totalTokens: 200,
				}),
			],
			{
				reportDay: "2026-06-26",
				timezone: "UTC",
				isCompleted: () => false,
			},
		);
		const out = renderReportHtml({
			...model,
			projects: [...model.projects].reverse(),
		});
		const small = out.slice(out.indexOf('<span class="pn">small</span>'));
		const large = out.slice(out.indexOf('<span class="pn">large</span>'));
		expect(small.slice(0, 250)).toContain("width:50%");
		expect(large.slice(0, 250)).toContain("width:100%");
	});

	it("renders weekday glyphs (the 'week display' Annie asked to restore)", () => {
		expect(html).toMatch(/周[日一二三四五六]/);
	});

	it("renders the before/after comparison hero with both window labels", () => {
		expect(html).toContain("改动前后用量对比");
		expect(html).toContain("前一周");
		expect(html).toContain("本周");
	});

	it("renders a comparison hero without NaN when the before window has no data", () => {
		const model2 = buildReportModel(
			tr("2026-06-26", 1_000_000_000, 500_000_000),
			{
				reportDay: "2026-06-26",
				timezone: "UTC",
				isCompleted: () => false,
				before: { since: "2026-06-12", until: "2026-06-18", label: "前一周" },
				after: { since: "2026-06-20", until: "2026-06-26", label: "本周" },
			},
		);
		const out = renderReportHtml(model2);
		expect(out).not.toContain("NaN");
		expect(out).toContain("前一周");
	});
});
