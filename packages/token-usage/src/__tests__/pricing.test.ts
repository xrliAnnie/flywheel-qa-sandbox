import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	costMicroUsd,
	formatUsd,
	loadPricingConfig,
	loadPricingConfigWithMeta,
	MODEL_RATES,
	type ModelRate,
	microUsdToUsd,
	ratesForDay,
} from "../pricing.js";

describe("costMicroUsd", () => {
	it("prices 1M opus input tokens at $5 (5e6 micro-USD)", () => {
		const micro = costMicroUsd("claude-opus-4-8", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(micro).toBe(5_000_000);
		expect(microUsdToUsd(micro)).toBe(5);
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
		expect(out).toBe(25_000_000);
		expect(cr).toBe(500_000);
		expect(cr).toBeLessThan(out);
	});

	it("sums all four token kinds (fable)", () => {
		const micro = costMicroUsd("claude-fable-5", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
		});
		// fable: 10 + 50 + 1 + 12.5 = 73.5 USD = 73_500_000 micro
		expect(micro).toBe(73_500_000);
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

	it("honors a custom rates table when provided", () => {
		const custom: Record<string, ModelRate> = {
			"claude-opus-4-8": {
				input: 1,
				output: 1,
				cacheRead: 1,
				cacheWrite: 1,
			},
		};
		const micro = costMicroUsd(
			"claude-opus-4-8",
			{
				inputTokens: 1_000_000,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			custom,
		);
		expect(micro).toBe(1_000_000); // $1, not the default $5
	});
});

describe("ratesForDay (Sonnet 5 intro → standard, date-aware)", () => {
	it("uses the intro rate (2/10) on/before 2026-08-31", () => {
		expect(ratesForDay("2026-06-29")["claude-sonnet-5"]).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		expect(ratesForDay("2026-08-31")["claude-sonnet-5"].input).toBe(2);
	});

	it("switches to the standard rate (3/15) from 2026-09-01", () => {
		expect(ratesForDay("2026-09-01")["claude-sonnet-5"]).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
		expect(ratesForDay("2026-12-25")["claude-sonnet-5"].input).toBe(3);
	});

	it("leaves other models untouched across the boundary", () => {
		expect(ratesForDay("2026-12-01")["claude-opus-4-8"]).toEqual(
			MODEL_RATES["claude-opus-4-8"],
		);
	});

	it("a pinned (config-overridden) sonnet-5 wins on both sides of the boundary", () => {
		const custom: Record<string, ModelRate> = {
			...MODEL_RATES,
			"claude-sonnet-5": { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
		};
		const pinned = new Set(["claude-sonnet-5"]);
		expect(
			ratesForDay("2026-06-29", custom, pinned)["claude-sonnet-5"].input,
		).toBe(9);
		expect(
			ratesForDay("2026-12-01", custom, pinned)["claude-sonnet-5"].input,
		).toBe(9);
	});

	it("a pinned override equal to the intro rate is NOT date-swapped (Codex R3)", () => {
		// Config explicitly sets the intro value; it must stay put after 2026-09-01.
		const custom: Record<string, ModelRate> = {
			...MODEL_RATES,
			"claude-sonnet-5": {
				input: 2,
				output: 10,
				cacheRead: 0.2,
				cacheWrite: 2.5,
			},
		};
		const pinned = new Set(["claude-sonnet-5"]);
		expect(
			ratesForDay("2026-12-01", custom, pinned)["claude-sonnet-5"],
		).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
	});

	it("without a pin, the built-in default still transitions on 2026-09-01", () => {
		// Same intro-valued table but NOT pinned → built-in rule applies.
		expect(ratesForDay("2026-12-01")["claude-sonnet-5"].input).toBe(3);
	});
});

describe("MODEL_RATES default sentinels (claude-api catalog, cached 2026-06-24)", () => {
	// Lock the corrected authoritative rates so a future accidental edit is caught.
	const expected: Record<string, ModelRate> = {
		"claude-opus-4-8": {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		},
		"claude-opus-4-7": {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		},
		"claude-opus-4-6": {
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		},
		// intro through 2026-08-31; standard 3/15 from 2026-09-01.
		"claude-sonnet-5": {
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		},
		"claude-sonnet-4-6": {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		},
		"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		"claude-haiku-4-5-20251001": {
			input: 1,
			output: 5,
			cacheRead: 0.1,
			cacheWrite: 1.25,
		},
	};
	for (const [model, rate] of Object.entries(expected)) {
		it(`${model} = ${rate.input}/${rate.output} in/out + ${rate.cacheRead}/${rate.cacheWrite} cache`, () => {
			expect(MODEL_RATES[model]).toEqual(rate);
		});
	}
	it("cache rates derive from input (0.1× read, 1.25× write)", () => {
		for (const r of Object.values(MODEL_RATES)) {
			expect(r.cacheRead).toBeCloseTo(r.input * 0.1, 6);
			expect(r.cacheWrite).toBeCloseTo(r.input * 1.25, 6);
		}
	});
});

describe("formatUsd", () => {
	it("returns $0 for zero, negative, and non-finite inputs", () => {
		expect(formatUsd(0)).toBe("$0");
		expect(formatUsd(-1_000_000)).toBe("$0");
		expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0");
		expect(formatUsd(Number.NaN)).toBe("$0");
	});

	it("shows <$0.01 only when the amount rounds to zero cents (< half a cent)", () => {
		expect(formatUsd(1)).toBe("<$0.01"); // $0.000001
		expect(formatUsd(4_000)).toBe("<$0.01"); // $0.004 → rounds to $0.00
		expect(formatUsd(4_999)).toBe("<$0.01"); // $0.004999 → rounds to $0.00
	});

	it("rounds a near-cent amount up to a cent rather than <$0.01", () => {
		// 0.005 USD rounds up to one cent; 0.009999 USD also rounds to one cent.
		expect(formatUsd(5_000)).toBe("$0.01");
		expect(formatUsd(9_999)).toBe("$0.01");
	});

	it("shows two decimals just at and above a cent", () => {
		// 0.01 USD = 10_000 micro
		expect(formatUsd(10_000)).toBe("$0.01");
		// 0.42 USD
		expect(formatUsd(420_000)).toBe("$0.42");
		// 77.30 USD
		expect(formatUsd(77_300_000)).toBe("$77.30");
	});

	it("rounds to cents BEFORE tiering at the $100 boundary", () => {
		// 99.994 USD → $99.99 (two-decimal tier)
		expect(formatUsd(99_994_000)).toBe("$99.99");
		// 99.995 USD → rounds to $100.00 → whole-dollar tier → "$100"
		expect(formatUsd(99_995_000)).toBe("$100");
		// exactly $100
		expect(formatUsd(100_000_000)).toBe("$100");
	});

	it("shows whole dollars with a thousands separator above $100", () => {
		expect(formatUsd(1_000_000_000)).toBe("$1,000");
		expect(formatUsd(6_518_000_000)).toBe("$6,518");
	});

	it("rounds the whole-dollar tier from the cent-rounded value, not the raw float (Codex R1)", () => {
		// $100.495 → rounds to $100.50 → whole-dollar tier → "$101" (not "$100").
		expect(formatUsd(100_495_000)).toBe("$101");
		// $100.494 → rounds to $100.49 → still rounds down to "$100".
		expect(formatUsd(100_494_000)).toBe("$100");
	});
});

describe("loadPricingConfig", () => {
	let dir: string;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "token-pricing-"));
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		warn.mockRestore();
	});

	it("returns the defaults when no config file exists", () => {
		const rates = loadPricingConfig({ homeDir: dir, env: {} });
		expect(rates["claude-opus-4-8"]).toEqual(MODEL_RATES["claude-opus-4-8"]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not mutate the shared default table", () => {
		const file = path.join(dir, "p.json");
		writeFileSync(
			file,
			JSON.stringify({
				"claude-opus-4-8": {
					input: 99,
					output: 99,
					cacheRead: 99,
					cacheWrite: 99,
				},
			}),
		);
		loadPricingConfig({ file });
		// Default table is untouched.
		expect(MODEL_RATES["claude-opus-4-8"].input).toBe(5);
	});

	it("overrides and adds models from a valid file", () => {
		const file = path.join(dir, "p.json");
		writeFileSync(
			file,
			JSON.stringify({
				"claude-opus-4-8": {
					input: 7,
					output: 35,
					cacheRead: 0.7,
					cacheWrite: 8.75,
				},
				"some-new-model": {
					input: 2,
					output: 8,
					cacheRead: 0.2,
					cacheWrite: 2.5,
				},
			}),
		);
		const rates = loadPricingConfig({ file });
		expect(rates["claude-opus-4-8"].input).toBe(7);
		expect(rates["some-new-model"]).toEqual({
			input: 2,
			output: 8,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		// Untouched defaults remain.
		expect(rates["claude-fable-5"].input).toBe(10);
	});

	it("resolves the file path from TOKEN_USAGE_PRICING_FILE", () => {
		const file = path.join(dir, "envpath.json");
		writeFileSync(
			file,
			JSON.stringify({
				"claude-haiku-4-5-20251001": {
					input: 9,
					output: 9,
					cacheRead: 9,
					cacheWrite: 9,
				},
			}),
		);
		const rates = loadPricingConfig({
			env: { TOKEN_USAGE_PRICING_FILE: file },
		});
		expect(rates["claude-haiku-4-5-20251001"].input).toBe(9);
	});

	it("falls back to defaults on malformed JSON (warns, never crashes)", () => {
		const file = path.join(dir, "bad.json");
		writeFileSync(file, "{ not valid json ");
		const rates = loadPricingConfig({ file });
		expect(rates["claude-opus-4-8"]).toEqual(MODEL_RATES["claude-opus-4-8"]);
		expect(warn).toHaveBeenCalled();
	});

	it("falls back to defaults when the root is not an object", () => {
		const file = path.join(dir, "arr.json");
		writeFileSync(file, JSON.stringify([1, 2, 3]));
		const rates = loadPricingConfig({ file });
		expect(rates["claude-opus-4-8"]).toEqual(MODEL_RATES["claude-opus-4-8"]);
		expect(warn).toHaveBeenCalled();
	});

	it("skips a model with a negative finite rate (never persists negative cost)", () => {
		const file = path.join(dir, "neg.json");
		writeFileSync(
			file,
			JSON.stringify({
				"claude-opus-4-8": {
					input: -5,
					output: 25,
					cacheRead: 0.5,
					cacheWrite: 6.25,
				},
			}),
		);
		const rates = loadPricingConfig({ file });
		expect(rates["claude-opus-4-8"]).toEqual(MODEL_RATES["claude-opus-4-8"]); // unchanged
		expect(warn).toHaveBeenCalled();
	});

	it("skips a model with a missing or non-numeric field (no NaN)", () => {
		const file = path.join(dir, "partial.json");
		writeFileSync(
			file,
			JSON.stringify({
				"claude-opus-4-8": { input: 5, output: 25 }, // missing cache fields
				"claude-fable-5": {
					input: "lots",
					output: 50,
					cacheRead: 1,
					cacheWrite: 12.5,
				},
			}),
		);
		const rates = loadPricingConfig({ file });
		expect(rates["claude-opus-4-8"]).toEqual(MODEL_RATES["claude-opus-4-8"]);
		expect(rates["claude-fable-5"]).toEqual(MODEL_RATES["claude-fable-5"]);
		// And no field is NaN anywhere.
		for (const r of Object.values(rates)) {
			for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
		}
	});

	it("skips a model whose value is not an object", () => {
		const file = path.join(dir, "scalar.json");
		writeFileSync(file, JSON.stringify({ "claude-opus-4-8": 5 }));
		const rates = loadPricingConfig({ file });
		expect(rates["claude-opus-4-8"]).toEqual(MODEL_RATES["claude-opus-4-8"]);
		expect(warn).toHaveBeenCalled();
	});

	it("reports which models the config validly overrode (loadPricingConfigWithMeta)", () => {
		const file = path.join(dir, "meta.json");
		writeFileSync(
			file,
			JSON.stringify({
				"claude-sonnet-5": {
					input: 5,
					output: 5,
					cacheRead: 5,
					cacheWrite: 5,
				},
				"claude-opus-4-8": { input: -1 }, // invalid → not counted
			}),
		);
		const { rates, overrides } = loadPricingConfigWithMeta({ file });
		expect(overrides.has("claude-sonnet-5")).toBe(true);
		expect(overrides.has("claude-opus-4-8")).toBe(false); // invalid, skipped
		expect(rates["claude-sonnet-5"].input).toBe(5);
	});

	it("has an empty override set when no config file exists", () => {
		const { overrides } = loadPricingConfigWithMeta({ homeDir: dir, env: {} });
		expect(overrides.size).toBe(0);
	});
});
