import { describe, expect, it } from "vitest";
import { normalizeExternalInstant } from "../quota-external-instant.js";

describe("FLY-2864 — external provider instants", () => {
	it("normalizes the zone-qualified shapes the providers actually return", () => {
		expect(normalizeExternalInstant("2026-10-22T16:00:00+00:00")).toBe(
			"2026-10-22T16:00:00.000Z",
		);
		expect(normalizeExternalInstant("2026-10-23T03:59:39Z")).toBe(
			"2026-10-23T03:59:39.000Z",
		);
		expect(normalizeExternalInstant("2026-10-23T09:59:39.967771+06:00")).toBe(
			"2026-10-23T03:59:39.967Z",
		);
		expect(normalizeExternalInstant("2026-10-22T09:00:00-07:00")).toBe(
			"2026-10-22T16:00:00.000Z",
		);
		expect(normalizeExternalInstant("2026-10-22T16:00:00.000Z")).toBe(
			"2026-10-22T16:00:00.000Z",
		);
	});

	it("rejects zoneless, impossible-calendar and non-string values", () => {
		for (const value of [
			"2026-10-22T16:00:00",
			"2026-10-22",
			"2026-02-30T00:00:00Z",
			"2026-13-01T00:00:00Z",
			"2026-10-22T24:00:00Z",
			"2026-10-22T16:00:00+24:00",
			"2026-10-22 16:00:00Z",
			"not-a-date",
			"",
			1_792_000_000,
			null,
			undefined,
			{},
		]) {
			expect(normalizeExternalInstant(value)).toBeNull();
		}
		expect(normalizeExternalInstant("2028-02-29T00:00:00Z")).toBe(
			"2028-02-29T00:00:00.000Z",
		);
	});
});
