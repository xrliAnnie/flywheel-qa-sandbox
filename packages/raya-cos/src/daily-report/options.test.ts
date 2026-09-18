import { describe, expect, it } from "vitest";
import {
	DEFAULT_DAILY_REPORT_OPTIONS,
	parseDailyReportOptionsJson,
} from "./options.js";

describe("parseDailyReportOptionsJson", () => {
	it("uses the approved defaults when the env value is absent", () => {
		expect(parseDailyReportOptionsJson(undefined)).toEqual({
			turnTimeoutMs: 600_000,
			ingestTimeoutMs: 120_000,
			retryDelayMs: 1_800_000,
			maxAttempts: 3,
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
		});
		expect(DEFAULT_DAILY_REPORT_OPTIONS).toEqual(
			parseDailyReportOptionsJson(undefined),
		);
	});

	it("overrides a subset without mutating defaults", () => {
		expect(
			parseDailyReportOptionsJson(
				JSON.stringify({ maxAttempts: 5, maxSummaryBytes: 131_072 }),
			),
		).toEqual({
			...DEFAULT_DAILY_REPORT_OPTIONS,
			maxAttempts: 5,
			maxSummaryBytes: 131_072,
		});
		expect(DEFAULT_DAILY_REPORT_OPTIONS.maxAttempts).toBe(3);
	});

	it.each([
		["turnTimeoutMs", 60_000, 1_800_000],
		["ingestTimeoutMs", 30_000, 600_000],
		["retryDelayMs", 60_000, 21_600_000],
		["maxAttempts", 1, 5],
		["maxSummaryBytes", 4_096, 1_048_576],
		["maxTotalBytes", 65_536, 4_194_304],
	])("accepts inclusive %s bounds", (key, minimum, maximum) => {
		expect(
			parseDailyReportOptionsJson(JSON.stringify({ [key]: minimum })),
		).toMatchObject({ [key]: minimum });
		expect(
			parseDailyReportOptionsJson(JSON.stringify({ [key]: maximum })),
		).toMatchObject({ [key]: maximum });
	});

	it.each([
		undefined,
		null,
		[],
		"value",
		{ unknown: 1 },
		{ maxAttempts: 2.5 },
		{ maxAttempts: 0 },
		{ turnTimeoutMs: 1_800_001 },
		{ ingestTimeoutMs: 29_999 },
		{ retryDelayMs: 21_600_001 },
		{ maxSummaryBytes: 4_095 },
		{ maxTotalBytes: 65_535 },
	])("rejects an invalid explicit value %#", (value) => {
		const encoded = value === undefined ? "not-json" : JSON.stringify(value);
		expect(() => parseDailyReportOptionsJson(encoded)).toThrow(/daily report/i);
	});

	it.each(["", "   "])("rejects an explicitly empty env value %#", (value) => {
		expect(() => parseDailyReportOptionsJson(value)).toThrow(/daily report/i);
	});
});
