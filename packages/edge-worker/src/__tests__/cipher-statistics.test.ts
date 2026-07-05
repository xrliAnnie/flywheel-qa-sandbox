import { describe, expect, it } from "vitest";
import {
	classifyOutcome,
	maturityLevel,
	posteriorMean,
	shouldInjectPattern,
	wilsonLowerBound,
} from "../cipher/statistics.js";
import type { PatternStatistics } from "../cipher/types.js";

describe("posteriorMean", () => {
	it("returns prior mean when no data", () => {
		const result = posteriorMean(0, 0, 0.8, 10);
		expect(result).toBeCloseTo(0.8, 2);
	});

	it("pulls toward data as sample grows", () => {
		const withData = posteriorMean(50, 100, 0.8, 10);
		// 50% observed, prior 80% — posterior should be between 50% and 80%
		expect(withData).toBeGreaterThan(0.5);
		expect(withData).toBeLessThan(0.8);
	});

	it("converges to observed rate with large sample", () => {
		const result = posteriorMean(500, 1000, 0.8, 10);
		expect(result).toBeCloseTo(0.5, 1);
	});
});

describe("wilsonLowerBound", () => {
	it("returns 0 for no observations", () => {
		expect(wilsonLowerBound(0, 0)).toBe(0);
	});

	it("returns a conservative lower bound", () => {
		const result = wilsonLowerBound(8, 10);
		// 80% success, but lower bound should be < 0.8
		expect(result).toBeLessThan(0.8);
		expect(result).toBeGreaterThan(0.4);
	});

	it("never goes below 0", () => {
		expect(wilsonLowerBound(0, 10)).toBeGreaterThanOrEqual(0);
	});

	it("increases with more data at same rate", () => {
		const small = wilsonLowerBound(8, 10);
		const large = wilsonLowerBound(80, 100);
		expect(large).toBeGreaterThan(small);
	});
});

describe("maturityLevel", () => {
	it("classifies sample counts correctly", () => {
		expect(maturityLevel(0)).toBe("exploratory");
		expect(maturityLevel(5)).toBe("exploratory");
		expect(maturityLevel(10)).toBe("tentative");
		expect(maturityLevel(15)).toBe("tentative");
		expect(maturityLevel(20)).toBe("established");
		expect(maturityLevel(49)).toBe("established");
		expect(maturityLevel(50)).toBe("trusted");
		expect(maturityLevel(100)).toBe("trusted");
	});
});

describe("classifyOutcome", () => {
	it("classifies reject as reject_or_block", () => {
		expect(classifyOutcome("reject")).toBe("reject_or_block");
	});

	it("classifies defer as reject_or_block", () => {
		expect(classifyOutcome("defer")).toBe("reject_or_block");
	});

	it("classifies quick approve as fast_approve", () => {
		expect(classifyOutcome("approve", 60)).toBe("fast_approve");
		expect(classifyOutcome("approve", 300)).toBe("fast_approve");
	});

	it("classifies slow approve as approve_after_review", () => {
		expect(classifyOutcome("approve", 600)).toBe("approve_after_review");
	});

	it("classifies approve without time as approve_after_review", () => {
		expect(classifyOutcome("approve")).toBe("approve_after_review");
	});
});

describe("shouldInjectPattern", () => {
	it("returns false for exploratory maturity", () => {
		const stats: PatternStatistics = {
			approveCount: 5,
			totalCount: 8,
			posteriorMean: 0.7,
			wilsonLower: 0.35,
			maturityLevel: "exploratory",
		};
		expect(shouldInjectPattern(stats, 0.5)).toBe(false);
	});

	it("returns false when deviation is too small", () => {
		const stats: PatternStatistics = {
			approveCount: 15,
			totalCount: 20,
			posteriorMean: 0.72,
			wilsonLower: 0.55,
			maturityLevel: "tentative",
		};
		// deviation = |0.55 - 0.5| = 0.05 < 0.15
		expect(shouldInjectPattern(stats, 0.5)).toBe(false);
	});

	it("returns true for significant deviation above global rate", () => {
		const stats: PatternStatistics = {
			approveCount: 18,
			totalCount: 20,
			posteriorMean: 0.88,
			wilsonLower: 0.72,
			maturityLevel: "established",
		};
		// deviation = |0.72 - 0.5| = 0.22 > 0.15
		expect(shouldInjectPattern(stats, 0.5)).toBe(true);
	});

	it("returns true for significant deviation below global rate", () => {
		const stats: PatternStatistics = {
			approveCount: 3,
			totalCount: 20,
			posteriorMean: 0.2,
			wilsonLower: 0.05,
			maturityLevel: "established",
		};
		// deviation = |0.05 - 0.8| = 0.75 > 0.15
		expect(shouldInjectPattern(stats, 0.8)).toBe(true);
	});
});
