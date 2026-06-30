import { describe, expect, it } from "vitest";
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
});
