import { describe, expect, it } from "vitest";
import { computeSubmissionExpiry } from "../workflow-submission-expiry.js";

describe("workflow submission expiry", () => {
	it("reserves the configured window and clamps it to the absolute deadline", () => {
		const now = Date.parse("2026-07-27T12:00:00.000Z");
		expect(computeSubmissionExpiry(now, 180, now + 24 * 60 * 60_000)).toBe(
			Date.parse("2026-07-27T15:00:00.000Z"),
		);
		expect(computeSubmissionExpiry(now, 2_000, now + 24 * 60 * 60_000)).toBe(
			Date.parse("2026-07-28T12:00:00.000Z"),
		);
	});

	it.each([0, -1, 1.5, Number.NaN])(
		"rejects an invalid configured window (%s)",
		(windowMinutes) => {
			expect(() =>
				computeSubmissionExpiry(Date.now(), windowMinutes, Date.now() + 1),
			).toThrow(/positive integer/);
		},
	);
});
