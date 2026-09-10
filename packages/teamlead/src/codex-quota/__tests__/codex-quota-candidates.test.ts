import { describe, expect, it } from "vitest";
import {
	type CodexQuotaObservation,
	parseCodexRateLimits,
	selectCodexQuotaCandidate,
} from "../candidate-selector.js";

const now = 1_800_000_000_000;
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
				{ now },
			).candidate?.profile,
		).toBe("business");
		expect(
			selectCodexQuotaCandidate(
				[obs("school", 100, 50), obs("business", 100, 20)],
				{ now },
			).candidate?.profile,
		).toBe("business");
		expect(
			selectCodexQuotaCandidate([obs("school", 100), obs("business", 100)], {
				now,
			}).candidate?.profile,
		).toBe("business");
	});
	it("excludes retired, refresh-invalid, unshared, expired and limited candidates", () => {
		const candidates = [
			obs("personal1", 100),
			{ ...obs("business", 100), authHealth: "refresh_invalid" as const },
			{ ...obs("school", 100), authHealth: "in_use_unshared" as const },
			obs("personal", 100, 100),
		];
		expect(
			selectCodexQuotaCandidate(candidates, { now }).candidate,
		).toBeUndefined();
		expect(
			selectCodexQuotaCandidate(
				["school", "personal", "business"].map((p) => obs(p, -1)),
				{ now },
			).kind,
		).toBe("observation_unavailable");
	});
	it("only declares the whole three-profile pool exhausted on fresh evidence", () => {
		expect(
			selectCodexQuotaCandidate(
				["school", "personal", "business"].map((p) => obs(p, 100, 100)),
				{ now },
			).kind,
		).toBe("pool_exhausted");
		expect(
			selectCodexQuotaCandidate([obs("school", 100, 100)], { now }).kind,
		).not.toBe("pool_exhausted");
	});
	it("uses unknown candidates only after known available and never guesses from last_refresh", () => {
		const unknown = {
			...obs("school", 100),
			windows: [],
			lastRefresh: "2026-01-01",
		};
		expect(
			selectCodexQuotaCandidate([unknown, obs("business", 500)], { now })
				.candidate?.profile,
		).toBe("business");
		expect(
			selectCodexQuotaCandidate([unknown], { now }).candidate?.profile,
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
