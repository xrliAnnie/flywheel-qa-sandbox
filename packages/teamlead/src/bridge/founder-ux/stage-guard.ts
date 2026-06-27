/**
 * FLY-598: founder-facing UX gate — Layer B server-side stage guard.
 *
 * Evaluated in event-route's `stage_changed` handler BEFORE patchSessionMetadata,
 * on the transition INTO `implement`. Pure decision logic (no I/O beyond the
 * injected store reads) so it is exhaustively unit-testable.
 *
 * Note (Codex R1-#3): the Bridge guard alone cannot HARD-stop a separate Runner
 * process — `flywheel-comm stage set` is fail-open. The real hard stop is the
 * Runner's `await-founder-ux-gate` (Layer A). This guard is the audit/backstop;
 * its `FOUNDER_UX_SIGNOFF_REQUIRED` code is what makes `stage set implement`
 * (and only that stage) fail-closed on the CLI side.
 */

import type { FounderUxGateMode } from "flywheel-config";
import type { StateStore } from "../../StateStore.js";
import { signoffSatisfies } from "./signoff.js";

/** The exact response code `stage set implement` keys its fail-closed exit on. */
export const FOUNDER_UX_SIGNOFF_REQUIRED = "FOUNDER_UX_SIGNOFF_REQUIRED";

export type FounderUxGuardDecision =
	| { decision: "pass" } // not applicable / verified — record metadata normally
	| { decision: "audit"; reason: string } // audit_only: log, but do NOT block
	| { decision: "block"; code: string; reason: string }; // enforce: reject

/**
 * Decide whether a `stage_changed → implement` transition is allowed.
 *
 * pass  → not a founder-facing run, gate off, non-implement stage, OR a verified
 *         sign-off bound to the current uxHash exists.
 * audit → founder-facing run lacking a valid sign-off, mode=audit_only (let it
 *         through but the caller should audit + notify).
 * block → founder-facing run lacking a valid sign-off, mode=enforce. Also covers
 *         enforce + a founder-facing implement that carries NO uxHash (fail-closed).
 */
export function evaluateFounderUxStageGuard(
	store: StateStore,
	mode: FounderUxGateMode,
	input: {
		executionId: string;
		incomingStage: string;
		/** uxHash from the stage event payload (undefined if the CLI sent none). */
		uxHash?: string;
	},
): FounderUxGuardDecision {
	// Only the entry into implement is gated; everything else passes untouched.
	if (input.incomingStage !== "implement") return { decision: "pass" };
	// Feature fully off → byte-compatible no-op.
	if (mode === "off") return { decision: "pass" };

	const session = store.getSession(input.executionId);
	// Not a founder-facing run → the gate does not apply.
	if (!session?.founder_facing_ux) return { decision: "pass" };

	// Founder-facing: require a verified sign-off bound to the CURRENT uxHash.
	const satisfied =
		!!input.uxHash && signoffSatisfies(store, input.executionId, input.uxHash);
	if (satisfied) return { decision: "pass" };

	const reason = !input.uxHash
		? "founder-facing UX run entered implement without a ux_hash (cannot verify a current-brief sign-off)"
		: "founder-facing UX run has no verified Annie sign-off for the current ux-brief";

	if (mode === "audit_only") return { decision: "audit", reason };
	return { decision: "block", code: FOUNDER_UX_SIGNOFF_REQUIRED, reason };
}
