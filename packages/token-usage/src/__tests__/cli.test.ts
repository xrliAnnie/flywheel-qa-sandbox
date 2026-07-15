import { describe, expect, it, vi } from "vitest";
import {
	deriveAggregateWindow,
	deriveComparison,
	parseIsoDayStrict,
	resolveReportParams,
} from "../cli.js";

describe("parseIsoDayStrict", () => {
	it("accepts a valid civil date", () => {
		expect(parseIsoDayStrict("2026-07-01")).toBe("2026-07-01");
	});
	it("rejects dates JS Date would silently normalize", () => {
		expect(parseIsoDayStrict("2026-02-31")).toBeNull();
		expect(parseIsoDayStrict("2026-13-01")).toBeNull();
		expect(parseIsoDayStrict("2026-00-10")).toBeNull();
	});
	it("rejects non-strict / malformed input", () => {
		expect(parseIsoDayStrict("2026-6-1")).toBeNull();
		expect(parseIsoDayStrict("2026/07/01")).toBeNull();
		expect(parseIsoDayStrict("garbage")).toBeNull();
		expect(parseIsoDayStrict("")).toBeNull();
		expect(parseIsoDayStrict(undefined)).toBeNull();
	});
});

describe("deriveComparison", () => {
	const reportDay = "2026-06-30";

	it("defaults to week-over-week when defaultWeekOverWeek is set", () => {
		const cmp = deriveComparison(
			reportDay,
			{},
			{},
			{ defaultWeekOverWeek: true },
		);
		expect(cmp).toEqual({
			before: { since: "2026-06-17", until: "2026-06-23", label: "前一周" },
			after: { since: "2026-06-24", until: "2026-06-30", label: "本周" },
		});
	});

	it("returns undefined when no default and no flags/env (ad-hoc report)", () => {
		expect(
			deriveComparison(reportDay, {}, {}, { defaultWeekOverWeek: false }),
		).toBeUndefined();
	});

	it("uses an explicit --before/--after over everything", () => {
		const cmp = deriveComparison(
			reportDay,
			{ before: "2026-06-01..2026-06-07", after: "2026-06-08..2026-06-14" },
			{ TOKEN_USAGE_ROLLOUT_DATE: "2026-06-20" },
			{ defaultWeekOverWeek: true },
		);
		expect(cmp?.before.since).toBe("2026-06-01");
		expect(cmp?.after.until).toBe("2026-06-14");
	});

	it("uses --rollout-date + --window (anchor mode)", () => {
		const cmp = deriveComparison(
			reportDay,
			{ "rollout-date": "2026-06-20", window: "7" },
			{},
			{ defaultWeekOverWeek: true },
		);
		expect(cmp).toEqual({
			before: { since: "2026-06-13", until: "2026-06-19", label: "改动前" },
			after: { since: "2026-06-20", until: "2026-06-30", label: "改动后" },
		});
	});

	it("prefers the --rollout-date flag over the env var", () => {
		const cmp = deriveComparison(
			reportDay,
			{ "rollout-date": "2026-06-20" },
			{ TOKEN_USAGE_ROLLOUT_DATE: "2026-06-10" },
			{ defaultWeekOverWeek: true },
		);
		expect(cmp?.after.since).toBe("2026-06-20");
	});

	it("reads the rollout date from env when no flag", () => {
		const cmp = deriveComparison(
			reportDay,
			{},
			{ TOKEN_USAGE_ROLLOUT_DATE: "2026-06-25" },
			{ defaultWeekOverWeek: false },
		);
		expect(cmp?.after.since).toBe("2026-06-25");
	});

	it("falls back to week-over-week on an invalid rollout date (with warn)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cmp = deriveComparison(
			reportDay,
			{ "rollout-date": "2026-02-31" },
			{},
			{ defaultWeekOverWeek: true },
		);
		expect(cmp?.before.label).toBe("前一周");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("falls back to week-over-week when the rollout date is after the report day", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cmp = deriveComparison(
			reportDay,
			{ "rollout-date": "2026-07-05" },
			{},
			{ defaultWeekOverWeek: true },
		);
		expect(cmp?.before.label).toBe("前一周");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("clamps an invalid --window to the default 7 (with warn)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cmp = deriveComparison(
			reportDay,
			{ "rollout-date": "2026-06-20", window: "0" },
			{},
			{ defaultWeekOverWeek: true },
		);
		// window=7 → before.since = rollout-7 = 2026-06-13
		expect(cmp?.before.since).toBe("2026-06-13");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("deriveAggregateWindow", () => {
	const today = "2026-07-01";
	const reportDay = "2026-06-30";

	it("covers the week-over-week before.since (no off-by-one) — since=06-17", () => {
		const cmp = deriveComparison(
			reportDay,
			{},
			{},
			{ defaultWeekOverWeek: true },
		);
		const w = deriveAggregateWindow(today, reportDay, cmp, {}, {});
		// before.since is 2026-06-17; the aggregate lower bound must reach it.
		expect(w.since).toBe("2026-06-17");
		expect(w.until).toBe(today);
	});

	it("defaults to a 14-day floor anchored on reportDay when no comparison", () => {
		const w = deriveAggregateWindow(today, reportDay, undefined, {}, {});
		// shiftDay(reportDay, -(14-1)) = 2026-06-17
		expect(w.since).toBe("2026-06-17");
	});

	it("honors --backfill-days for a wider floor", () => {
		const w = deriveAggregateWindow(
			today,
			reportDay,
			undefined,
			{ "backfill-days": "28" },
			{},
		);
		expect(w.since).toBe("2026-06-03"); // reportDay-27
	});

	it("clamps an invalid --backfill-days to 14 (with warn)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const w = deriveAggregateWindow(
			today,
			reportDay,
			undefined,
			{ "backfill-days": "0" },
			{},
		);
		expect(w.since).toBe("2026-06-17");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("extends to a far anchor's before.since when the rollout date is old", () => {
		const cmp = deriveComparison(
			reportDay,
			{ "rollout-date": "2026-05-20", window: "7" },
			{},
			{ defaultWeekOverWeek: true },
		);
		const w = deriveAggregateWindow(today, reportDay, cmp, {}, {});
		expect(w.since).toBe("2026-05-13"); // rollout-7
	});
});

describe("resolveReportParams (daily orchestration seam)", () => {
	const today = "2026-07-01";

	it("daily produces yesterday reportDay + a week-over-week comparison + covering aggregate window", () => {
		const p = resolveReportParams("daily", {}, {}, today);
		expect(p.reportDay).toBe("2026-06-30");
		expect(p.comparison).toBeDefined();
		expect(p.comparison?.before.since).toBe("2026-06-17");
		// aggregate window must cover the comparison before.since
		expect(p.aggregateSince).toBe("2026-06-17");
		expect(p.aggregateUntil).toBe(today);
	});

	it("ad-hoc report defaults to no comparison but still aggregates a 14-day floor", () => {
		const p = resolveReportParams("report", {}, {}, today);
		expect(p.reportDay).toBe(today);
		expect(p.comparison).toBeUndefined();
		// reportDay=today → 14-day floor = today-13
		expect(p.aggregateSince).toBe("2026-06-18");
	});

	it("respects an explicit --since for aggregation", () => {
		const p = resolveReportParams("daily", { since: "2026-06-01" }, {}, today);
		expect(p.aggregateSince).toBe("2026-06-01");
	});

	// FLY-929 B1: `report-day` shares daily semantics — it is the shell seam
	// that hands the CLI-authoritative report day to publish-report
	// --expected-date (the Bridge never recomputes dates).
	it("report-day resolves to yesterday (daily semantics)", () => {
		const p = resolveReportParams("report-day", {}, {}, today);
		expect(p.reportDay).toBe("2026-06-30");
	});

	it("report-day honors an explicit --date override", () => {
		const p = resolveReportParams(
			"report-day",
			{ date: "2026-06-15" },
			{},
			today,
		);
		expect(p.reportDay).toBe("2026-06-15");
	});
});
