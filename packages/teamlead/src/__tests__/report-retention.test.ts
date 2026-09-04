import { describe, expect, it } from "vitest";
import {
	isReportExpired,
	REPORT_RETENTION_MS,
} from "../bridge/report-retention.js";

describe("report retention boundary", () => {
	it.each([
		[REPORT_RETENTION_MS - 1, false],
		[REPORT_RETENTION_MS, true],
		[REPORT_RETENTION_MS + 1, true],
	])("treats age %d as expired=%s", (age, expected) => {
		const now = Date.parse("2026-09-03T16:00:00.000Z");
		expect(isReportExpired(now, now - age)).toBe(expected);
	});
});
