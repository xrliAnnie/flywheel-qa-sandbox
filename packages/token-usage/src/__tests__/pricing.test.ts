import { describe, expect, it } from "vitest";
import { costMicroUsd, microUsdToUsd } from "../pricing.js";

describe("costMicroUsd", () => {
	it("prices 1M opus input tokens at $15 (15e6 micro-USD)", () => {
		const micro = costMicroUsd("claude-opus-4-8", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(micro).toBe(15_000_000);
		expect(microUsdToUsd(micro)).toBe(15);
	});

	it("prices cache-read much cheaper than output (opus)", () => {
		const out = costMicroUsd("claude-opus-4-8", {
			inputTokens: 0,
			outputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		const cr = costMicroUsd("claude-opus-4-8", {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 0,
		});
		expect(out).toBe(75_000_000);
		expect(cr).toBe(1_500_000);
		expect(cr).toBeLessThan(out);
	});

	it("sums all four token kinds", () => {
		const micro = costMicroUsd("claude-fable-5", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
		});
		// fable: 3 + 15 + 0.3 + 3.75 = 22.05 USD = 22_050_000 micro
		expect(micro).toBe(22_050_000);
	});

	it("returns 0 for an unknown model (no silent mispricing)", () => {
		expect(
			costMicroUsd("<synthetic>", {
				inputTokens: 999,
				outputTokens: 999,
				cacheReadTokens: 999,
				cacheWriteTokens: 999,
			}),
		).toBe(0);
	});
});
