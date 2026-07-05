/**
 * FLY-696 M1/C3 — build the AlertMetadata.accountLimit object from a captured
 * pane, for the switch path to consume.
 *
 * Composes `parseUsageGauge` and attaches the CAS snapshot (observedAccount /
 * observedGeneration) + provider (for server-side cross-provider gating on the
 * dedicated account-switch route). Returns null — meaning "no usable switch
 * metadata, keep the alert needs_human" — when:
 *   - the gauge is missing/ambiguous, or
 *   - the gauge parses but no cap is at 100% (defense in depth), or
 *   - the hit window's reset instant could not be resolved.
 *
 * The §3.3 hard boundary (transient 529 / rate-limit → retry in place, never
 * switch) is enforced by the CALLER's isTransientThrottlePane short-circuit
 * BEFORE this is reached; this builder is a pure, deterministic composition.
 */

import { parseUsageGauge } from "./usage-gauge.js";

export interface AccountLimitMeta {
	provider: "claude" | "codex";
	scope: "5h" | "weekly" | "both";
	/** ISO reset instant of the hit window (weekly dominates when "both"). */
	resetAt: string;
	observedAccount: string;
	observedGeneration: number;
}

export interface BuildAccountLimitInput {
	pane: string;
	now: Date;
	timeZone: string;
	provider: "claude" | "codex";
	observedAccount: string;
	observedGeneration: number;
}

export function buildAccountLimitMetadata(
	input: BuildAccountLimitInput,
): AccountLimitMeta | null {
	const gauge = parseUsageGauge(input.pane, input.now, input.timeZone);
	if (!gauge || gauge.scope === null) return null;

	// weekly + both → the weekly reset is the operative one (weekly dominates).
	const resetAt =
		gauge.scope === "5h" ? gauge.fivehResetAt : gauge.weeklyResetAt;
	if (!resetAt) return null;

	return {
		provider: input.provider,
		scope: gauge.scope,
		resetAt,
		observedAccount: input.observedAccount,
		observedGeneration: input.observedGeneration,
	};
}
