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
