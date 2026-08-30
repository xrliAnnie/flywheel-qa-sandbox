import { describe, expect, it } from "vitest";
import { parseReviewQuotaResetAt } from "../review-quota-retry.js";

describe("parseReviewQuotaResetAt", () => {
	it("parses the observed headless-Claude session-limit envelope", () => {
		const raw = JSON.stringify({
			api_error_status: 429,
			result:
				"You've hit your session limit · resets 5:10pm (America/Los_Angeles)",
			type: "result",
		});

		expect(
			parseReviewQuotaResetAt(raw, Date.parse("2026-08-30T18:00:00.000Z")),
		).toBe(Date.parse("2026-08-31T00:10:00.000Z"));
	});

	it("parses the observed weekly month-day reset envelope", () => {
		const raw = JSON.stringify({
			api_error_status: 429,
			result:
				"You've hit your weekly limit · resets Aug 26 at 7pm (America/Los_Angeles)",
			type: "result",
		});

		expect(
			parseReviewQuotaResetAt(raw, Date.parse("2026-08-24T18:00:00.000Z")),
		).toBe(Date.parse("2026-08-27T02:00:00.000Z"));
	});

	it.each([
		[
			"midnight without minutes",
			"You've hit your session limit · resets 12am (America/Los_Angeles)",
			"2026-08-30T18:00:00.000Z",
			"2026-08-31T07:00:00.000Z",
		],
		[
			"whole-hour afternoon",
			"You've hit your session limit · resets 3pm (America/Los_Angeles)",
			"2026-08-30T18:00:00.000Z",
			"2026-08-30T22:00:00.000Z",
		],
		[
			"progress-saved suffix",
			"You've hit your session limit · resets 8:20pm (America/Los_Angeles) · progress saved",
			"2026-08-30T18:00:00.000Z",
			"2026-08-31T03:20:00.000Z",
		],
	] as const)("parses observed %s syntax", (_label, result, now, expected) => {
		const raw = JSON.stringify({ api_error_status: 429, result });
		expect(parseReviewQuotaResetAt(raw, Date.parse(now))).toBe(
			Date.parse(expected),
		);
	});

	it.each([
		[
			"ordinary API rate limit",
			JSON.stringify({
				api_error_status: 429,
				result: "Rate limit exceeded; retry later",
			}),
		],
		[
			"cap marker without API 429 evidence",
			JSON.stringify({
				result:
					"You've hit your session limit · resets 5:10pm (America/Los_Angeles)",
			}),
		],
		[
			"negative usage-limit phrase",
			JSON.stringify({
				api_error_status: 429,
				result:
					"This is not your usage limit · resets 5:10pm (America/Los_Angeles)",
			}),
		],
		[
			"invalid timezone",
			JSON.stringify({
				api_error_status: 429,
				result: "You've hit your session limit · resets 5:10pm (Mars/Olympus)",
			}),
		],
		[
			"weekly reset beyond the bounded horizon",
			JSON.stringify({
				api_error_status: 429,
				result:
					"You've hit your weekly limit · resets Sep 30 at 7pm (America/Los_Angeles)",
			}),
		],
	] as const)("rejects %s", (_label, raw) => {
		expect(
			parseReviewQuotaResetAt(raw, Date.parse("2026-08-24T18:00:00.000Z")),
		).toBeNull();
	});
});
