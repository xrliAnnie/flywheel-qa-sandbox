import { describe, expect, it } from "vitest";
import {
	classifyAnthropicMail,
	decideCharge,
	hasPlanLine,
	parseGogDate,
	parseReceiptBody,
} from "../charge-receipt-parse.js";

/**
 * Shaped like the real Stripe receipt text (FLY-2897 research §2.2): five long
 * lines, the charge facts inline. Receipt number and links are made up.
 */
function receiptBody(input: {
	amount: string;
	paid: string;
	period: string;
	extra?: string;
}): string {
	return [
		"",
		"",
		"",
		"",
		`Receipt from Anthropic, PBC ${input.amount} Paid ${input.paid} (invoice illustration [https://example.invalid/i] Download invoice (https://example.invalid/d) Download receipt (https://example.invalid/r) Receipt`,
		"",
		`Receipt #1000-2000-3000 ${input.period} Max plan - 20x Qty 1 $200.00 ${input.extra ?? ""}Total ${input.amount} Amount paid ${input.amount} Questions? Visit our support site (https://example.invalid/s)`,
	].join("\n");
}

describe("FLY-2897 parseReceiptBody", () => {
	it("reads the period, paid day and amount paid of a real-shaped receipt", () => {
		expect(
			parseReceiptBody(
				receiptBody({
					amount: "$200.00",
					paid: "September 4, 2026",
					period: "Sep 4–Oct 4, 2026",
				}),
			),
		).toEqual({
			periodStart: "2026-09-04",
			periodEnd: "2026-10-04",
			paidOn: "2026-09-04",
			amountCents: 20000,
		});
	});

	it("ignores the day-month-year proration date and the unit prices", () => {
		expect(
			parseReceiptBody(
				receiptBody({
					amount: "$100.01",
					paid: "September 16, 2026",
					period: "Sep 16–Oct 16, 2026",
					extra:
						"Unused time on Max plan - 5x after 17 Sep 2026 Qty 1 -$99.99 ",
				}),
			),
		).toEqual({
			periodStart: "2026-09-16",
			periodEnd: "2026-10-16",
			paidOn: "2026-09-16",
			amountCents: 10001,
		});
	});

	it("handles a cross-year period with and without the start year", () => {
		for (const period of [
			"Dec 20, 2026–Jan 20, 2027",
			"Dec 20–Jan 20, 2027",
			"December 20, 2026 – January 20, 2027",
		]) {
			expect(
				parseReceiptBody(
					receiptBody({
						amount: "$200.00",
						paid: "December 20, 2026",
						period,
					}),
				),
			).toMatchObject({ periodStart: "2026-12-20", periodEnd: "2027-01-20" });
		}
	});

	it("accepts spaced, em and ASCII dashes", () => {
		for (const period of [
			"Sep 4 – Oct 4, 2026",
			"Sep 4—Oct 4, 2026",
			"Sep 4 - Oct 4, 2026",
			"Sept. 4–Oct. 4, 2026",
		]) {
			expect(
				parseReceiptBody(
					receiptBody({ amount: "$200.00", paid: "September 4, 2026", period }),
				),
			).toMatchObject({ periodStart: "2026-09-04", periodEnd: "2026-10-04" });
		}
	});

	it("reads an HTML-only body with entities", () => {
		const html =
			"<html><body><table><tr><td>Receipt from Anthropic, PBC</td><td>$200.00</td></tr>" +
			"<tr><td>Paid&nbsp;September&nbsp;20,&nbsp;2026</td></tr>" +
			"<tr><td>Sep&nbsp;20&ndash;Oct&nbsp;20, 2026</td></tr>" +
			"<tr><td>Amount paid</td><td>$200.00</td></tr></table></body></html>";
		expect(parseReceiptBody(html)).toEqual({
			periodStart: "2026-09-20",
			periodEnd: "2026-10-20",
			paidOn: "2026-09-20",
			amountCents: 20000,
		});
		expect(
			parseReceiptBody(
				"<div>Sep 20&#8211;Oct 20, 2026</div><div>Amount paid &#36;200.00</div>",
			),
		).toMatchObject({ periodEnd: "2026-10-20", amountCents: 20000 });
	});

	it("keeps the period when the paid day or amount is missing", () => {
		expect(
			parseReceiptBody("Receipt #1 Sep 4–Oct 4, 2026 Max plan - 20x Total"),
		).toEqual({
			periodStart: "2026-09-04",
			periodEnd: "2026-10-04",
			paidOn: null,
			amountCents: null,
		});
	});

	it("reads grouped and negative amounts in cents", () => {
		expect(
			parseReceiptBody("Sep 4–Oct 4, 2026 Amount paid $1,200.50"),
		).toMatchObject({ amountCents: 120050 });
		expect(
			parseReceiptBody("Sep 4–Oct 4, 2026 Amount paid -$5.00"),
		).toMatchObject({ amountCents: -500 });
	});

	it("refuses to guess an impossible or reversed period", () => {
		for (const body of [
			"no period at all Amount paid $200.00",
			"Feb 30–Mar 30, 2026",
			"Oct 16, 2026–Sep 16, 2026",
			"Sep 16, 2024–Oct 16, 2026",
			"Sep 16–Sep 16, 2026",
		]) {
			expect(parseReceiptBody(body)).toBeNull();
		}
	});

	it("rejects an impossible paid day without dropping the period", () => {
		expect(
			parseReceiptBody("Paid February 30, 2026 Sep 4–Oct 4, 2026"),
		).toMatchObject({ paidOn: null, periodEnd: "2026-10-04" });
	});

	it("only reads the first 200 000 characters", () => {
		expect(
			parseReceiptBody(`${"x".repeat(200_000)} Sep 4–Oct 4, 2026`),
		).toBeNull();
	});
});

describe("FLY-2897 hasPlanLine", () => {
	it("recognises a subscription plan line", () => {
		expect(
			hasPlanLine(
				receiptBody({
					amount: "$200.00",
					paid: "September 4, 2026",
					period: "Sep 4–Oct 4, 2026",
				}),
			),
		).toBe(true);
		expect(hasPlanLine("Claude Pro plan Qty 1 $20.00")).toBe(true);
		expect(hasPlanLine("<td>Max 20x</td>")).toBe(true);
	});

	it("does not see one in a non-subscription receipt", () => {
		expect(
			hasPlanLine(
				"Receipt from Anthropic, PBC $50.00 Paid September 10, 2026 Receipt #1 Extra usage credits Qty 1 $50.00 Total $50.00 Amount paid $50.00",
			),
		).toBe(false);
		expect(hasPlanLine("API credits Qty 1 $25.00")).toBe(false);
	});
});

describe("FLY-2897 classifyAnthropicMail", () => {
	const RECEIPT_FROM =
		'"Anthropic, PBC" <invoice+statements@mail.anthropic.com>';
	const NOTICE_FROM = "Anthropic <no-reply-a1b2c3@mail.anthropic.com>";

	it("classifies the exact receipt sender and subject", () => {
		expect(
			classifyAnthropicMail({
				from: RECEIPT_FROM,
				subject: "Your receipt from Anthropic, PBC #2119-8318-2194",
			}),
		).toBe("receipt");
		expect(
			classifyAnthropicMail({
				from: "invoice+statements@mail.anthropic.com",
				subject: "Your receipt from Anthropic, PBC #2119-8318-2194",
			}),
		).toBe("receipt");
		expect(
			classifyAnthropicMail({
				from: "Anthropic <Invoice+Statements@Mail.Anthropic.com>",
				subject: "Your receipt from Anthropic, PBC #2119-8318-2194",
			}),
		).toBe("receipt");
	});

	it("drops look-alike senders and display-name spoofs", () => {
		for (const from of [
			"<invoice+statements@mail.anthropic.com.evil.example>",
			"<invoice+statements@anthropic.com>",
			"<invoice@mail.anthropic.com>",
			'"invoice+statements@mail.anthropic.com" <attacker@evil.example>',
			'"x <invoice+statements@mail.anthropic.com>" <attacker@evil.example>',
			"<invoice+statements@mail.anthropic.com> <attacker@evil.example>",
			"<invoice+statements@mail.anthropic.com> trailing",
			"Anthropic <invoice+statements@mail.anthropic.com",
			"invoice+statements@mail.anthropic.com attacker@evil.example",
			"",
		]) {
			expect(
				classifyAnthropicMail({
					from,
					subject: "Your receipt from Anthropic, PBC #2119-8318-2194",
				}),
			).toBeNull();
		}
	});

	it("drops other subjects from the receipt sender", () => {
		for (const subject of [
			"Your invoice from Anthropic, PBC #2119-8318-2194",
			"Re: Your receipt from Anthropic, PBC #2119-8318-2194",
			"Your receipt from Anthropic, PBC",
			"Your receipt from Anthropic, PBC #abc",
		]) {
			expect(classifyAnthropicMail({ from: RECEIPT_FROM, subject })).toBeNull();
		}
	});

	it("classifies cancellation and resubscription notices", () => {
		expect(
			classifyAnthropicMail({
				from: NOTICE_FROM,
				subject: "Your Claude Max subscription was canceled",
			}),
		).toBe("cancel");
		expect(
			classifyAnthropicMail({
				from: "Anthropic <no-reply@mail.anthropic.com>",
				subject: "Your Claude Pro subscription was canceled",
			}),
		).toBe("cancel");
		for (const subject of [
			"Your Max subscription is confirmed",
			"Welcome to the Max plan",
			"Welcome back to Claude Max",
		]) {
			expect(classifyAnthropicMail({ from: NOTICE_FROM, subject })).toBe(
				"resume",
			);
		}
	});

	it("drops notices from the wrong sender or with a prefixed subject", () => {
		expect(
			classifyAnthropicMail({
				from: RECEIPT_FROM,
				subject: "Your Claude Max subscription was canceled",
			}),
		).toBeNull();
		expect(
			classifyAnthropicMail({
				from: "Anthropic <no-reply-x@evil.example>",
				subject: "Your Claude Max subscription was canceled",
			}),
		).toBeNull();
		expect(
			classifyAnthropicMail({
				from: NOTICE_FROM,
				subject: "Fwd: Your Claude Max subscription was canceled",
			}),
		).toBeNull();
	});
});

describe("FLY-2897 parseGogDate", () => {
	it("reads gog's UTC minute string as an ISO instant", () => {
		expect(parseGogDate("2026-09-17 00:05")).toBe("2026-09-17T00:05:00.000Z");
	});

	it("rejects anything else", () => {
		for (const value of [
			"",
			"2026-02-30 00:05",
			"2026-09-17T00:05",
			"Thu, 17 Sep 2026 00:05:00 +0000",
			"2026-09-17 24:00",
			undefined,
			12,
		]) {
			expect(parseGogDate(value)).toBeNull();
		}
	});
});

describe("FLY-2897 decideCharge", () => {
	const period = (start: string, end: string, amountCents: number | null) => ({
		periodStart: start,
		periodEnd: end,
		paidOn: start,
		amountCents,
	});

	it("says no_receipt when there is none", () => {
		expect(decideCharge({ receipts: [], events: [] })).toEqual({
			status: "no_receipt",
		});
	});

	it("does not fall back to an older receipt when the latest is unreadable", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-08-05T00:07:00.000Z",
						parsed: period("2026-08-04", "2026-09-04", 20000),
					},
					{ at: "2026-09-05T00:06:00.000Z", parsed: null },
				],
				events: [],
			}),
		).toEqual({ status: "parse_failed" });
	});

	it("sums the same-period receipts of an upgrade day (business 09-16)", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-09-17T00:05:00.000Z",
						parsed: period("2026-09-16", "2026-10-16", 10001),
					},
					{
						at: "2026-09-17T00:02:00.000Z",
						parsed: period("2026-09-16", "2026-10-16", 10000),
					},
					{
						at: "2026-08-15T00:20:00.000Z",
						parsed: period("2026-08-14", "2026-09-14", 20000),
					},
				],
				events: [
					{ at: "2026-09-17T00:02:00.000Z", kind: "resume" },
					{ at: "2026-09-08T19:09:00.000Z", kind: "cancel" },
				],
			}),
		).toEqual({
			status: "ok",
			facts: {
				periodStart: "2026-09-16",
				periodEnd: "2026-10-16",
				paidOn: "2026-09-16",
				amountCents: 20001,
				receiptCount: 2,
				receiptAt: "2026-09-17T00:05:00.000Z",
				canceledAt: null,
				resumedAt: null,
			},
		});
	});

	it("merges by period end only, since a proration receipt may start later", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-09-17T00:05:00.000Z",
						parsed: {
							periodStart: "2026-09-17",
							periodEnd: "2026-10-16",
							paidOn: "2026-09-16",
							amountCents: 10001,
						},
					},
					{
						at: "2026-09-17T00:02:00.000Z",
						parsed: period("2026-09-16", "2026-10-16", 10000),
					},
				],
				events: [],
			}),
		).toMatchObject({
			status: "ok",
			facts: {
				periodStart: "2026-09-17",
				periodEnd: "2026-10-16",
				amountCents: 20001,
				receiptCount: 2,
			},
		});
	});

	it("breaks a same-minute tie by the later period end", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-09-17T00:05:00.000Z",
						parsed: period("2026-08-16", "2026-09-16", 100),
					},
					{
						at: "2026-09-17T00:05:00.000Z",
						parsed: period("2026-09-16", "2026-10-16", 20000),
					},
				],
				events: [],
			}),
		).toMatchObject({
			status: "ok",
			facts: { periodEnd: "2026-10-16", amountCents: 20000, receiptCount: 1 },
		});
	});

	it("drops the amount when any same-period receipt lacks one", () => {
		const decision = decideCharge({
			receipts: [
				{
					at: "2026-09-17T00:05:00.000Z",
					parsed: period("2026-09-16", "2026-10-16", null),
				},
				{
					at: "2026-09-17T00:02:00.000Z",
					parsed: period("2026-09-16", "2026-10-16", 10000),
				},
			],
			events: [],
		});
		expect(decision).toMatchObject({
			status: "ok",
			facts: { amountCents: null, receiptCount: 2 },
		});
	});

	it("keeps personal's anchor through a cancel-and-resume inside the period", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-09-05T00:06:00.000Z",
						parsed: period("2026-09-04", "2026-10-04", 20000),
					},
					{
						at: "2026-08-05T00:07:00.000Z",
						parsed: period("2026-08-04", "2026-09-04", 20000),
					},
				],
				events: [
					{ at: "2026-08-04T02:55:00.000Z", kind: "resume" },
					{ at: "2026-07-31T15:40:00.000Z", kind: "cancel" },
				],
			}),
		).toMatchObject({
			status: "ok",
			facts: { periodEnd: "2026-10-04", canceledAt: null },
		});
	});

	it("marks a cancellation that arrives after the latest receipt", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-09-17T00:05:00.000Z",
						parsed: period("2026-09-16", "2026-10-16", 20000),
					},
				],
				events: [{ at: "2026-09-20T18:00:00.000Z", kind: "cancel" }],
			}),
		).toMatchObject({
			status: "canceled",
			facts: {
				periodEnd: "2026-10-16",
				canceledAt: "2026-09-20T18:00:00.000Z",
			},
		});
	});

	it("clears the cancellation once a later resubscription arrives", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-09-17T00:05:00.000Z",
						parsed: period("2026-09-16", "2026-10-16", 20000),
					},
				],
				events: [
					{ at: "2026-09-20T18:00:00.000Z", kind: "cancel" },
					{ at: "2026-09-22T18:00:00.000Z", kind: "resume" },
				],
			}),
		).toMatchObject({
			status: "ok",
			facts: { canceledAt: null, resumedAt: "2026-09-22T18:00:00.000Z" },
		});
	});

	it("does not let a resubscription before the cancellation clear it", () => {
		expect(
			decideCharge({
				receipts: [
					{
						at: "2026-09-17T00:05:00.000Z",
						parsed: period("2026-09-16", "2026-10-16", 20000),
					},
				],
				events: [
					{ at: "2026-09-18T18:00:00.000Z", kind: "resume" },
					{ at: "2026-09-20T18:00:00.000Z", kind: "cancel" },
					{ at: "2026-09-19T18:00:00.000Z", kind: "cancel" },
				],
			}),
		).toMatchObject({
			status: "canceled",
			facts: { canceledAt: "2026-09-20T18:00:00.000Z" },
		});
	});
});
