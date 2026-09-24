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
		expect(detail?.resetCredits).toEqual({
			known: true,
			value: null,
			availableCount: 0,
			credits: [],
		});
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
		expect(detail?.resetCredits).toEqual({
			known: false,
			value: null,
			availableCount: null,
			credits: null,
		});
	});

	it("parses reset-credit inventory from the top-level object and keeps truncation visible", () => {
		const detail = parseCodexRateLimitDetail(
			{
				rateLimits: {
					primary: {
						usedPercent: 25,
						windowDurationMins: 10080,
						resetsAt: resetsAt(24),
					},
					secondary: null,
				},
				rateLimitResetCredits: {
					availableCount: 3,
					credits: [
						{
							id: "later",
							status: "available",
							expiresAt: Math.floor(NOW / 1000) + 2 * 86_400,
						},
						{
							id: "earlier",
							status: "available",
							expiresAt: Math.floor(NOW / 1000) + 86_400,
						},
					],
				},
			},
			"codex",
			NOW,
		);

		expect(detail?.resetCredits).toEqual({
			known: true,
			value: "3",
			availableCount: 3,
			credits: [
				{
					id: "earlier",
					status: "available",
					expiresAt: "2026-09-22T00:00:00.000Z",
				},
				{
					id: "later",
					status: "available",
					expiresAt: "2026-09-23T00:00:00.000Z",
				},
			],
		});
	});

	it("keeps availableCount when the upstream object omits credits", () => {
		const detail = parseCodexRateLimitDetail(
			{
				rateLimits: {
					primary: {
						usedPercent: 0,
						windowDurationMins: 10080,
					},
				},
				rateLimitResetCredits: { availableCount: 2 },
			},
			"codex",
			NOW,
		);

		expect(detail?.resetCredits).toEqual({
			known: true,
			value: "2",
			availableCount: 2,
			credits: null,
		});
	});

	it("keeps a card whose optional expiresAt field is omitted", () => {
		const detail = parseCodexRateLimitDetail(
			{
				rateLimits: {
					primary: {
						usedPercent: 0,
						windowDurationMins: 10080,
					},
				},
				rateLimitResetCredits: {
					availableCount: 2,
					credits: [
						{ id: "unknown-expiry", status: "available" },
						{
							id: "known-expiry",
							status: "available",
							expiresAt: Math.floor(NOW / 1000) + 86_400,
						},
					],
				},
			},
			"codex",
			NOW,
		);

		expect(detail?.resetCredits).toEqual({
			known: true,
			value: "2",
			availableCount: 2,
			credits: [
				{
					id: "known-expiry",
					status: "available",
					expiresAt: "2026-09-22T00:00:00.000Z",
				},
				{
					id: "unknown-expiry",
					status: "available",
					expiresAt: null,
				},
			],
		});
	});

	it("distinguishes count-only null details from an explicitly empty list", () => {
		const parse = (credits: unknown) =>
			parseCodexRateLimitDetail(
				{
					rateLimits: {
						primary: {
							usedPercent: 0,
							windowDurationMins: 10080,
						},
					},
					rateLimitResetCredits: { availableCount: 2, credits },
				},
				"codex",
				NOW,
			)?.resetCredits;

		expect(parse(null)).toMatchObject({ availableCount: 2, credits: null });
		expect(parse([])).toMatchObject({ availableCount: 2, credits: [] });
	});

	it("does not treat legacy scalar RPC values or invalid counts as inventory", () => {
		for (const rateLimitResetCredits of [
			"3",
			3,
			{ availableCount: -1, credits: [] },
			{ availableCount: 1.5, credits: [] },
		]) {
			const detail = parseCodexRateLimitDetail(
				{
					rateLimits: {
						primary: {
							usedPercent: 0,
							windowDurationMins: 10080,
						},
					},
					rateLimitResetCredits,
				},
				"codex",
				NOW,
			);
			expect(detail?.resetCredits.known).toBe(false);
		}
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
