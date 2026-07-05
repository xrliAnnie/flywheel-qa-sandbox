/**
 * CIPHER pattern key generation + hierarchical fallback.
 * Pure functions, no I/O.
 *
 * Pattern keys encode pre-decision dimensions only. Post-decision fields
 * (systemRoute, confidenceBand, decisionSource) are stored in
 * decision_snapshots for analysis but NOT used as lookup keys.
 */

import type { PatternDimensions } from "./types.js";

/**
 * Generate pattern keys from pre-decision dimensions.
 * 9 singles + 5 curated pairs + 1 triple = 15 keys.
 *
 * Key format: `dimA:valA` (single) | `dimA+dimB:valA+valB` (pair)
 * Lookup order: triple → pairs → singles → global.
 */
export function generatePatternKeys(d: PatternDimensions): string[] {
	const keys: string[] = [];

	// 9 single-dimension keys
	keys.push(`label:${d.primaryLabel}`);
	keys.push(`size:${d.sizeBucket}`);
	keys.push(`area:${d.areaTouched}`);
	keys.push(`exit:${d.exitStatus}`);
	keys.push(`failures:${d.hasPriorFailures}`);
	keys.push(`commits:${d.commitVolume}`);
	keys.push(`diff:${d.diffScale}`);
	keys.push(`tests:${d.hasTests}`);
	keys.push(`auth:${d.touchesAuth}`);

	// 5 curated pair keys (domain-relevant combinations)
	keys.push(`label+size:${d.primaryLabel}+${d.sizeBucket}`);
	keys.push(`area+size:${d.areaTouched}+${d.sizeBucket}`);
	keys.push(`label+area:${d.primaryLabel}+${d.areaTouched}`);
	keys.push(`exit+failures:${d.exitStatus}+${d.hasPriorFailures}`);
	keys.push(`auth+size:${d.touchesAuth}+${d.sizeBucket}`);

	// 1 triple key
	keys.push(
		`label+area+size:${d.primaryLabel}+${d.areaTouched}+${d.sizeBucket}`,
	);

	return keys;
}

/**
 * Hierarchical fallback: from most specific to most general.
 * Returns keys grouped by specificity level.
 *
 * Specificity is determined by counting dimension segments (the part
 * before ':'), NOT by splitting the entire key string on '+'.
 * Example: `label+size:bug+small` → 2 dimensions (pair), not 3 segments.
 */
export function getFallbackOrder(keys: string[]): string[][] {
	const triples: string[] = [];
	const pairs: string[] = [];
	const singles: string[] = [];

	for (const key of keys) {
		const dimPart = key.split(":")[0]!;
		const dimCount = dimPart.split("+").length;
		if (dimCount >= 3) triples.push(key);
		else if (dimCount === 2) pairs.push(key);
		else singles.push(key);
	}

	return [triples, pairs, singles];
}
