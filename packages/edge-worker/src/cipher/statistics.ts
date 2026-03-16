/**
 * CIPHER statistics — Beta-Binomial smoothing, Wilson lower bound, maturity classification.
 * Pure functions, no I/O.
 */

import type { PatternStatistics } from "./types.js";

const Z_90 = 1.645;

/** Bayesian posterior mean with Beta-Binomial smoothing. */
export function posteriorMean(
	approves: number,
	total: number,
	globalApproveRate: number,
	priorStrength: number = 10,
): number {
	const alpha = globalApproveRate * priorStrength;
	const beta = (1 - globalApproveRate) * priorStrength;
	return (approves + alpha) / (total + alpha + beta);
}

/** Wilson score lower bound at 90% confidence. */
export function wilsonLowerBound(approves: number, total: number): number {
	if (total === 0) return 0;
	const p = approves / total;
	const z2 = Z_90 * Z_90;
	const denominator = 1 + z2 / total;
	const center = p + z2 / (2 * total);
	const spread =
		Z_90 * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
	return Math.max(0, (center - spread) / denominator);
}

/** Classify maturity level based on sample count. */
export function maturityLevel(
	total: number,
): PatternStatistics["maturityLevel"] {
	if (total < 10) return "exploratory";
	if (total < 20) return "tentative";
	if (total < 50) return "established";
	return "trusted";
}

/** Map CEO action to 3-class outcome. */
export function classifyOutcome(
	ceoAction: "approve" | "reject" | "defer",
	timeToDecisionSeconds?: number,
): "fast_approve" | "approve_after_review" | "reject_or_block" {
	if (ceoAction === "reject" || ceoAction === "defer")
		return "reject_or_block";
	if (timeToDecisionSeconds !== undefined && timeToDecisionSeconds <= 300)
		return "fast_approve";
	return "approve_after_review";
}

/** Determine if a pattern is worth injecting into the prompt. */
export function shouldInjectPattern(
	stats: PatternStatistics,
	globalApproveRate: number,
): boolean {
	if (stats.maturityLevel === "exploratory") return false;
	const deviation = Math.abs(stats.wilsonLower - globalApproveRate);
	return deviation > 0.15;
}
