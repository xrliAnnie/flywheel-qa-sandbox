import { describe, expect, it } from "vitest";
import { retirementMs } from "../account-heal/account-retirement.js";

describe("retirement instant validation", () => {
	it.each([
		null,
		12,
		{},
		[],
		"",
		"2026-09-14",
		"2026-09-14T00:00:00",
		"2026-09-14T00:00:00-0700",
		"2026-02-29T00:00:00Z",
		"2026-04-31T00:00:00Z",
		"2026-09-14T24:00:00Z",
		"2026-09-14T00:60:00Z",
		"2026-09-14T00:00:60Z",
		"2026-09-14T00:00:00+24:00",
		"2026-09-14T00:00:00+00:60",
	])("rejects malformed input %j", (value) => {
		expect(retirementMs(value)).toBeNaN();
	});
	it.each([
		"2024-02-29T12:00:00Z",
		"2026-09-14T00:00:00-07:00",
		"2026-11-02T00:00:00-08:00",
		"2026-09-14T00:00:00.123+05:30",
	])("accepts explicit instants %s", (value) => {
		expect(retirementMs(value)).toBe(Date.parse(value));
	});
	it("keeps omitted retirement unlimited", () => {
		expect(retirementMs(undefined)).toBe(Number.POSITIVE_INFINITY);
	});
});
