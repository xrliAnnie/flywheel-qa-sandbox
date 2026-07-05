/**
 * FLY-793: the three-stage pipeline phase table.
 *
 * A three-stage run is ONE Linear issue / ONE RPCI flow with three internal
 * phase-sessions handed off on one branch B: Design → Implement → QA, each with
 * its own model. This module is the single source of truth for the phase
 * sequence and each phase's model.
 *
 * Model per phase (Annie's table):
 *   design    → heavy  (Fable)  — brainstorm / research / design reasoning
 *   implement → medium (Opus)   — code
 *   qa        → light  (Sonnet) — verification (QA is a write-capable phase too;
 *                                  the model choice is independent of that)
 *
 * REVERT (7/7, after the Fable window): flip the `pipeline.three_stage` toggle
 * OFF — a task then runs as a single session exactly as before. The table here
 * is deliberately NOT the revert lever, so it stays a fixed, obvious mapping.
 *
 * The FLY-767 "prefer-Fable / strong-over-weak" stance is an ISSUE-LEVEL model
 * routing concern (Lead difficulty-sort / dispatch `model` param), separate from
 * this fixed per-phase table — it is not applied here so Annie's explicit
 * implement=Opus phase model is not silently overridden.
 */

import { MODEL_TIERS, type ModelTier } from "./model-tiers.js";

export type ThreeStagePhase = "design" | "implement" | "qa";

/** Ordered phase sequence of a three-stage run (Design → Implement → QA). */
export const THREE_STAGE_PHASE_SEQUENCE: readonly ThreeStagePhase[] = [
	"design",
	"implement",
	"qa",
];

const THREE_STAGE_PHASE_SET: ReadonlySet<string> = new Set(
	THREE_STAGE_PHASE_SEQUENCE,
);

/**
 * Is `role` one of the three-stage phase roles (design/implement/qa)? The single
 * source of truth for "is this a phase session" — used by the PhaseOrchestrator
 * gate and by the completion sinks' role-preservation guard.
 */
export function isThreeStagePhaseRole(
	role: string | null | undefined,
): role is ThreeStagePhase {
	return role != null && THREE_STAGE_PHASE_SET.has(role);
}

/**
 * FLY-793 (824 R2 E2E fix): resolve the `session_role` to persist on a
 * completion / failure signal WITHOUT clobbering a dispatched phase role.
 *
 * `session_role` is set ONCE at dispatch and is immutable for the session's
 * lifetime. The `flywheel-comm complete` CLI defaults its payload role to
 * `"main"` when the runner didn't pass `--session-role` (phase runners don't
 * know which phase they are), so writing that payload role straight back would
 * overwrite the dispatched phase role (design/implement/qa) → `onPhaseComplete`
 * sees `"main"` → `isThreeStagePhaseRole("main") === false` → the Design→Implement
 * / Implement→QA handoff silently never fires (824 Track-1 root cause).
 *
 * This is the server-side robust fix: preserve an existing phase role regardless
 * of what the signal carries; only fall back to the incoming role when the
 * session has no phase role yet. Byte-compat for non-three-stage sessions: an
 * existing role of `"main"` is not a phase role, so the incoming role (also
 * `"main"`) is used — identical to the prior `incoming ?? "main"` behavior.
 */
export function resolveCompletionSessionRole(
	existingRole: string | null | undefined,
	incomingRole: string | null | undefined,
): string {
	if (isThreeStagePhaseRole(existingRole)) return existingRole;
	return incomingRole ?? "main";
}

/** Default model tier per phase (see file header). */
export const DEFAULT_PHASE_TIER: Readonly<Record<ThreeStagePhase, ModelTier>> =
	{
		design: "heavy",
		implement: "medium",
		qa: "light",
	};

/**
 * Canonical model id (e.g. `claude-fable-5`) to dispatch for a three-stage
 * phase. Draws from the shared MODEL_TIERS registry so ids stay aligned with
 * the rest of the fleet (pricing / token-usage / short codes).
 */
export function resolvePhaseModel(phase: ThreeStagePhase): string {
	return MODEL_TIERS[DEFAULT_PHASE_TIER[phase]].id;
}

/**
 * The phase that follows `phase` in the sequence, or `null` if `phase` is the
 * last (QA) or unknown. Used by the PhaseOrchestrator to pick the next
 * phase-session to dispatch at a phase boundary.
 */
export function nextPhase(phase: ThreeStagePhase): ThreeStagePhase | null {
	const i = THREE_STAGE_PHASE_SEQUENCE.indexOf(phase);
	if (i < 0 || i === THREE_STAGE_PHASE_SEQUENCE.length - 1) return null;
	return THREE_STAGE_PHASE_SEQUENCE[i + 1]!;
}
