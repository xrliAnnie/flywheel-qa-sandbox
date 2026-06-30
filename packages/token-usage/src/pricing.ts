/**
 * Pricing = a RELATIVE "weight" only, NOT a real bill (Annie is on a subscription).
 * Public per-1M-token USD rates; cost is stored as integer micro-USD to avoid float drift
 * (1 token at rate R USD/1M = R micro-USD).
 */

export interface ModelRate {
	/** USD per 1M tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Known models in this fleet. Unknown models → 0 weight + a warning (never silently priced). */
export const MODEL_RATES: Record<string, ModelRate> = {
	"claude-opus-4-8": {
		input: 15,
		output: 75,
		cacheRead: 1.5,
		cacheWrite: 18.75,
	},
	"claude-opus-4-7": {
		input: 15,
		output: 75,
		cacheRead: 1.5,
		cacheWrite: 18.75,
	},
	"claude-sonnet-4-6": {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"claude-fable-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-haiku-4-5-20251001": {
		input: 1,
		output: 5,
		cacheRead: 0.1,
		cacheWrite: 1.25,
	},
};

const warnedUnknown = new Set<string>();

export interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/**
 * Cost weight in integer micro-USD. Unknown model → 0 (and warns once per model).
 * micro-USD = tokens * (USD per 1M) since rate is per 1e6 tokens and micro = USD * 1e6.
 */
export function costMicroUsd(model: string, t: TokenCounts): number {
	const r = MODEL_RATES[model];
	if (!r) {
		if (!warnedUnknown.has(model)) {
			warnedUnknown.add(model);
			console.warn(
				`[token-usage] unknown model "${model}" — priced at 0 weight`,
			);
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
