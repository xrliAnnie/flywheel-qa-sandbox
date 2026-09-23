import { describe, expect, it } from "vitest";
import {
	type CodexQuotaObservation,
	parseCodexRateLimits,
	selectCodexQuotaCandidate,
} from "../candidate-selector.js";

const now = 1_800_000_000_000;
const pool = [
	"business",
	"personal",
	"personal1",
	"personal2",
	"school",
	"shopping",
];
const obs = (
	profile: string,
	reset: number,
	used = 40,
): CodexQuotaObservation => ({
	profile,
	accountKey: profile,
	observedAt: now,
	identityVerified: true,
	authHealth: "valid",
	windows: [{ usedPercent: used, resetsAt: now + reset }],
	scopeKnown: true,
});
describe("Codex candidate selection", () => {
	it("sorts future reset before remaining, then stable profile", () => {
		expect(
			selectCodexQuotaCandidate(
				[obs("school", 200, 1), obs("business", 100, 90)],
				{ now, pool: ["business", "school"] },
			).candidate?.profile,
		).toBe("business");
		expect(
			selectCodexQuotaCandidate(
				[obs("school", 100, 50), obs("business", 100, 20)],
				{ now, pool: ["business", "school"] },
			).candidate?.profile,
		).toBe("business");
		expect(
			selectCodexQuotaCandidate([obs("school", 100), obs("business", 100)], {
				now,
				pool: ["business", "school"],
			}).candidate?.profile,
		).toBe("business");
	});
	it("replays the same pool snapshot independently of input order", () => {
		const business = obs("business", 500, 10);
		const personal = obs("personal", 100, 80);
		const school = {
			...obs("school", 50, 1),
			windows: [{ usedPercent: 1, resetsAt: null }],
		};
		const replays = [
			[business, personal, school],
			[business, school, personal],
			[personal, business, school],
			[personal, school, business],
			[school, business, personal],
			[school, personal, business],
		];

		for (const replay of replays) {
			for (let run = 0; run < 3; run += 1) {
				expect(
					selectCodexQuotaCandidate(replay, {
						now,
						pool: ["business", "personal", "school"],
					}).candidate?.profile,
				).toBe("personal");
			}
		}
	});
	it("ignores pool-external, refresh-invalid, unshared, expired and limited candidates", () => {
		const candidates = [
			obs("personal1", 100),
			{ ...obs("business", 100), authHealth: "refresh_invalid" as const },
			{ ...obs("school", 100), authHealth: "in_use_unshared" as const },
			obs("personal", 100, 100),
		];
		expect(
			selectCodexQuotaCandidate(candidates, {
				now,
				pool: ["business", "personal", "school"],
			}).candidate,
		).toBeUndefined();
		expect(
			selectCodexQuotaCandidate(
				["school", "personal", "business"].map((p) => obs(p, -1)),
				{ now, pool: ["business", "personal", "school"] },
			).kind,
		).toBe("observation_unavailable");
	});
	it("only declares the whole six-profile pool exhausted on fresh evidence", () => {
		expect(
			selectCodexQuotaCandidate(
				pool.map((p) => obs(p, 100, 100)),
				{ now, pool },
			).kind,
		).toBe("pool_exhausted");
		expect(
			selectCodexQuotaCandidate([obs("school", 100, 100)], { now, pool }).kind,
		).not.toBe("pool_exhausted");
		expect(
			selectCodexQuotaCandidate(
				pool.slice(0, -1).map((p) => obs(p, 100, 100)),
				{ now, pool },
			).kind,
		).not.toBe("pool_exhausted");
	});
	it("selects a newly enumerated account and treats an empty pool as unusable", () => {
		expect(
			selectCodexQuotaCandidate([obs("personal1", 100)], { now, pool })
				.candidate?.profile,
		).toBe("personal1");
		expect(selectCodexQuotaCandidate([], { now, pool: [] })).toEqual({
			kind: "no_usable_credentials",
		});
		expect(() =>
			selectCodexQuotaCandidate([], { now, pool: ["shopping", "shopping"] }),
		).toThrow("invalid_codex_quota_pool");
	});
	it("uses unknown candidates only after known available and never guesses from last_refresh", () => {
		const unknown = {
			...obs("school", 100),
			windows: [],
			lastRefresh: "2026-01-01",
		};
		expect(
			selectCodexQuotaCandidate([unknown, obs("business", 500)], {
				now,
				pool: ["business", "school"],
			}).candidate?.profile,
		).toBe("business");
		expect(
			selectCodexQuotaCandidate([unknown], { now, pool: ["school"] }).candidate
				?.profile,
		).toBe("school");
	});
	it("converts protocol seconds exactly once and rejects wrong buckets and malformed windows", () => {
		const bucket = {
			primary: { usedPercent: 50, resetsAt: now / 1000 + 60 },
			secondary: null,
		};
		expect(
			parseCodexRateLimits(
				{ rateLimitsByLimitId: { codex: bucket, spark: {} } },
				"codex",
				now,
			).windows[0]?.resetsAt,
		).toBe(now + 60_000);
		expect(
			parseCodexRateLimits(
				{ rateLimitsByLimitId: { spark: bucket } },
				"codex",
				now,
			).scopeKnown,
		).toBe(false);
		expect(
			parseCodexRateLimits(
				{ rateLimits: { primary: { usedPercent: 1.5, resetsAt: now } } },
				"codex",
				now,
			).scopeKnown,
		).toBe(false);
	});
});
