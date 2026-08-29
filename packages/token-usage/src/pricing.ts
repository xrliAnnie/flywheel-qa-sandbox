/**
 * FLY-713: cost estimation for the token-usage report.
 *
 * `$` = token usage × each model's public per-1M-token USD rate. This is a real
 * cost ESTIMATE (what the usage would cost at public API rates) — Annie is on a
 * subscription, so it is a reference cost, not a literal invoice. Cost is stored
 * as integer micro-USD to avoid float drift (1 token at rate R USD/1M = R micro-USD).
 *
 * The default rate table is a snapshot; it is overridable per-deploy via
 * `loadPricingConfig()` (a JSON file at `~/.flywheel/token-pricing.json` or
 * `TOKEN_USAGE_PRICING_FILE`).
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelRate {
	/** USD per 1M tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Known models in this fleet → public per-1M-token USD rates. Unknown models →
 * 0 cost + a warning (never silently priced).
 *
 * source: claude-api catalog (cached 2026-06-24).
 * cache rates derived from input: cacheRead = 0.1×input (cache hit),
 * cacheWrite = 1.25×input (5-min TTL, the `cache_creation_input_tokens` tier).
 */
export const MODEL_RATES: Record<string, ModelRate> = {
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	// intro through 2026-08-31; standard 3/15 from 2026-09-01 — override via config.
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
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

/**
 * Sonnet 5 standard pricing, effective 2026-09-01 (its introductory 2/10 rate in
 * `MODEL_RATES` runs through 2026-08-31). Kept here so a day's usage is always
 * priced at the rate that applied *on that day* — see `ratesForDay`.
 */
const SONNET5_STANDARD: ModelRate = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 3.75,
};
const SONNET5_STANDARD_FROM = "2026-09-01";

/**
 * Resolve the rate table effective ON a given report day (YYYY-MM-DD). Applies
 * date-effective pricing — currently Sonnet 5's intro→standard transition — so a
 * day's usage is priced at the rate that applied then, with no silent misprice
 * once the intro window ends.
 *
 * `pinned` is the set of models the caller has explicitly overridden via config
 * (from `loadPricingConfigWithMeta`). A pinned model's rate is authoritative and
 * used unchanged for every day — the built-in date rule never touches it (even if
 * the configured value happens to equal the intro default).
 */
export function ratesForDay(
	day: string,
	base: Record<string, ModelRate> = MODEL_RATES,
	pinned?: ReadonlySet<string>,
): Record<string, ModelRate> {
	if (pinned?.has("claude-sonnet-5")) return base; // config wins, no date rule
	if (base["claude-sonnet-5"] && day >= SONNET5_STANDARD_FROM) {
		return { ...base, "claude-sonnet-5": SONNET5_STANDARD };
	}
	return base;
}

const warnedUnknown = new Set<string>();

export interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/**
 * Estimated cost in integer micro-USD. Unknown model → 0 (and warns once per model).
 * micro-USD = tokens * (USD per 1M) since rate is per 1e6 tokens and micro = USD * 1e6.
 * `rates` defaults to the built-in table; pass a `loadPricingConfig()` result to
 * apply a configured override.
 */
export function costMicroUsd(
	model: string,
	t: TokenCounts,
	rates: Record<string, ModelRate> = MODEL_RATES,
): number {
	const r = rates[model];
	if (!r) {
		if (!warnedUnknown.has(model)) {
			warnedUnknown.add(model);
			console.warn(`[token-usage] unknown model "${model}" — estimated at $0`);
		}
		return 0;
	}
	const micro =
		t.inputTokens * r.input +
		t.outputTokens * r.output +
		t.cacheReadTokens * r.cacheRead +
		t.cacheWriteTokens * r.cacheWrite;
	return Math.round(micro);
}

/** Convert integer micro-USD to a USD number (for display only). */
export function microUsdToUsd(micro: number): number {
	return micro / 1e6;
}

/**
 * Format a micro-USD amount as a human-friendly cost estimate string.
 *
 * Adaptive precision so small rows never collapse to "$0":
 *   - non-finite or <= 0           → "$0"
 *   - rounds to >= $100            → whole dollars + thousands separator ($6,518)
 *   - rounds to >= $0.01           → two decimals ($77.30 / $0.42)
 *   - > 0 but rounds below a cent  → "<$0.01"
 *
 * Tiering happens AFTER rounding to cents so e.g. 99.995 → "$100" (not "$100.00")
 * and 99.994 → "$99.99".
 */
export function formatUsd(micro: number): string {
	if (!Number.isFinite(micro) || micro <= 0) return "$0";
	const usd = micro / 1e6;
	const cents = Math.round(usd * 100);
	if (cents <= 0) return "<$0.01";
	const rounded = cents / 100;
	// Round the cent-rounded value (not the raw float) to whole dollars so the tier
	// and the display agree, e.g. 100.495 → cents 100.50 → "$101" (not "$100").
	if (rounded >= 100) return `$${Math.round(rounded).toLocaleString("en-US")}`;
	return `$${rounded.toFixed(2)}`;
}

export interface LoadPricingOptions {
	/** Explicit config file path (overrides env + default). */
	file?: string;
	/** Environment lookup (defaults to process.env). Test seam. */
	env?: NodeJS.ProcessEnv;
	/** Home dir override for the default path. Test seam. */
	homeDir?: string;
}

function isValidRate(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Loaded pricing: the merged rate table + the set of config-overridden model ids. */
export interface LoadedPricing {
	rates: Record<string, ModelRate>;
	/** Model ids the config file explicitly (and validly) set — pinned against date rules. */
	overrides: Set<string>;
}

/**
 * Load the pricing table with metadata: built-in defaults overlaid with an optional
 * JSON config, plus the set of models the config explicitly set.
 *
 * Resolution: `opts.file` → `env.TOKEN_USAGE_PRICING_FILE` → `~/.flywheel/token-pricing.json`.
 * A missing file is normal (returns defaults, empty overrides, no warning). A malformed
 * file, a non-object root, or a model whose rate fields are missing / non-finite /
 * negative is skipped with a stderr warning — never producing NaN/negative persisted
 * cost. The config maps model id → `{ input, output, cacheRead, cacheWrite }` (USD per 1M).
 *
 * `overrides` is passed to `ratesForDay` so a configured model wins over the built-in
 * date-effective rules for every day.
 */
export function loadPricingConfigWithMeta(
	opts: LoadPricingOptions = {},
): LoadedPricing {
	const env = opts.env ?? process.env;
	const home = opts.homeDir ?? os.homedir();
	const file =
		opts.file ??
		env.TOKEN_USAGE_PRICING_FILE ??
		path.join(home, ".flywheel", "token-pricing.json");

	// Start from a deep copy of the defaults so callers never mutate the shared table.
	const rates: Record<string, ModelRate> = {};
	for (const [k, v] of Object.entries(MODEL_RATES)) rates[k] = { ...v };
	const overrides = new Set<string>();

	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { rates, overrides }; // no config file → defaults (expected, not an error)
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.warn(
			`[token-usage] pricing config ${file} is not valid JSON — using default rates`,
		);
		return { rates, overrides };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		console.warn(
			`[token-usage] pricing config ${file} root is not an object — using default rates`,
		);
		return { rates, overrides };
	}

	for (const [model, val] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (!val || typeof val !== "object" || Array.isArray(val)) {
			console.warn(
				`[token-usage] pricing config: model "${model}" is not an object — skipped`,
			);
			continue;
		}
		const r = val as Record<string, unknown>;
		const input = r.input;
		const output = r.output;
		const cacheRead = r.cacheRead;
		const cacheWrite = r.cacheWrite;
		if (
			isValidRate(input) &&
			isValidRate(output) &&
			isValidRate(cacheRead) &&
			isValidRate(cacheWrite)
		) {
			rates[model] = { input, output, cacheRead, cacheWrite };
			overrides.add(model);
		} else {
			console.warn(
				`[token-usage] pricing config: model "${model}" has missing / non-finite / negative rate fields — skipped`,
			);
		}
	}
	return { rates, overrides };
}

/**
 * Convenience wrapper returning just the merged rate table (drops the override set).
 * Prefer `loadPricingConfigWithMeta` where date-effective pricing must respect config
 * overrides (the aggregator path).
 */
export function loadPricingConfig(
	opts: LoadPricingOptions = {},
): Record<string, ModelRate> {
	return loadPricingConfigWithMeta(opts).rates;
}
