import { describe, expect, it } from "vitest";
import { parseCodexRateLimitDetail } from "../rate-limit-detail.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");
const resetsAt = (offsetHours: number) =>
	Math.floor(NOW / 1000) + offsetHours * 3600;

describe("FLY-2688 — Codex rate limit detail parser", () => {
	it("classifies windows by windowDurationMins and carries plan/credits/reset-credits", () => {
		const detail = parseCodexRateLimitDetail(
			{
				rateLimits: {
					limitId: "codex",
					planType: "pro",
					primary: {
						usedPercent: 95,
						windowDurationMins: 300,
						resetsAt: resetsAt(1),
					},
					secondary: {
						usedPercent: 40,
						windowDurationMins: 10080,
						resetsAt: resetsAt(24),
					},
					credits: { hasCredits: false, unlimited: false, balance: "0" },
					rateLimitReachedType: null,
				},
				rateLimitResetCredits: null,
			},
			"codex",
			NOW,
		);

		expect(detail).not.toBeNull();
		expect(detail?.planType).toBe("pro");
		expect(detail?.fiveH).toEqual({
			usedPercent: 95,
			windowMinutes: 300,
			resetAt: "2026-09-21T01:00:00.000Z",
		});
		expect(detail?.weekly).toEqual({
			usedPercent: 40,
			windowMinutes: 10080,
			resetAt: "2026-09-22T00:00:00.000Z",
		});
		expect(detail?.credits).toEqual({
			known: true,
			hasCredits: false,
			unlimited: false,
			balance: "0",
		});
		expect(detail?.resetCredits).toEqual({ known: true, value: null });
		expect(detail?.unclassifiedWindows).toBe(0);
	});

	it("reads the weekly-only real sample where primary itself is the 7d window", () => {
		const detail = parseCodexRateLimitDetail(
			{
				rateLimitsByLimitId: {
					codex: {
						limitId: "codex",
						primary: {
							usedPercent: 26,
							windowDurationMins: 10080,
							resetsAt: resetsAt(48),
						},
						secondary: null,
						credits: { hasCredits: false, unlimited: false, balance: "0" },
					},
				},
			},
			"codex",
			NOW,
		);

		expect(detail?.weekly?.usedPercent).toBe(26);
		expect(detail?.fiveH).toBeNull();
	});

	it("never guesses a window whose duration is missing", () => {
		const detail = parseCodexRateLimitDetail(
			{
				rateLimits: {
					primary: { usedPercent: 12, resetsAt: resetsAt(2) },
					secondary: null,
				},
			},
			"codex",
			NOW,
		);

		expect(detail?.fiveH).toBeNull();
		expect(detail?.weekly).toBeNull();
		expect(detail?.unclassifiedWindows).toBe(1);
	});

	it("marks credits and reset credits unknown when the RPC omits them", () => {
		const detail = parseCodexRateLimitDetail(
			{
				rateLimits: {
					primary: {
						usedPercent: 0,
						windowDurationMins: 10080,
						resetsAt: resetsAt(3),
					},
					secondary: null,
				},
			},
			"codex",
			NOW,
		);

		expect(detail?.credits).toEqual({
			known: false,
			hasCredits: null,
			unlimited: null,
			balance: null,
		});
		expect(detail?.resetCredits).toEqual({ known: false, value: null });
	});

	it("rejects malformed payloads instead of half-trusting them", () => {
		const bad = [
			null,
			{},
			{ rateLimits: { limitId: "spark", primary: null, secondary: null } },
			{
				rateLimits: {
					primary: { usedPercent: 120, windowDurationMins: 300 },
					secondary: null,
				},
			},
			{
				rateLimits: {
					primary: {
						usedPercent: 10,
						windowDurationMins: 300,
						resetsAt: Math.floor(NOW / 1000) + 400 * 86400,
					},
					secondary: null,
				},
			},
			{
				rateLimits: {
					primary: { usedPercent: 10, windowDurationMins: 10080 },
					secondary: { usedPercent: 20, windowDurationMins: 10080 },
				},
			},
		];
		for (const value of bad) {
			expect(parseCodexRateLimitDetail(value, "codex", NOW)).toBeNull();
		}
	});
});
