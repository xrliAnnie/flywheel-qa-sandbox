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

import {
	MODEL_TIERS,
	type ModelTier,
	modelDisplayName,
} from "./model-tiers.js";

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

/**
 * FLY-892 (Codex R3 #4): the SINGLE source of truth for the three-stage phase
 * thread-title badge — emoji + short word. FLY-793 lived in ChatThreadCreator;
 * FLY-892 moves it to `packages/config` so both the ChatThreadCreator title
 * stamp AND `stage-utils` strip/recognition read one vocabulary (stage-utils
 * cannot import ChatThreadCreator without a cycle). Annie's locked glyphs
 * (2026-07-05 mockup review, definition ③): 🎨设计 / 🔨实现 / 🧪QA.
 */
export const PHASE_THREAD_BADGE_PARTS: Readonly<
	Record<ThreeStagePhase, { emoji: string; word: string }>
> = {
	design: { emoji: "🎨", word: "设计" },
	implement: { emoji: "🔨", word: "实现" },
	qa: { emoji: "🧪", word: "QA" },
};

/** Composed `emoji+word` badge per phase (`🎨设计`). Derived from the parts. */
export const PHASE_THREAD_BADGE: Readonly<Record<ThreeStagePhase, string>> = {
	design: `${PHASE_THREAD_BADGE_PARTS.design.emoji}${PHASE_THREAD_BADGE_PARTS.design.word}`,
	implement: `${PHASE_THREAD_BADGE_PARTS.implement.emoji}${PHASE_THREAD_BADGE_PARTS.implement.word}`,
	qa: `${PHASE_THREAD_BADGE_PARTS.qa.emoji}${PHASE_THREAD_BADGE_PARTS.qa.word}`,
};

/**
 * FLY-892 (Step 6): the stage-level thread-title badge for a phase role (🎨设计 /
 * 🔨实现 / 🧪QA), or `""` for a non-phase (main) role. On a three-stage issue
 * this REPLACES the FLY-560 fine-grained stage prefix (Annie definition ③): the
 * title carries only the current phase, so a whole pipeline renames ~twice.
 */
export function phaseThreadBadge(role: string | null | undefined): string {
	return isThreeStagePhaseRole(role) ? PHASE_THREAD_BADGE[role] : "";
}

/** Human phase name shown inside a message tag (`[设计·Fable]`). */
const PHASE_MESSAGE_NAME: Readonly<Record<ThreeStagePhase, string>> = {
	design: "设计",
	implement: "实现",
	qa: "QA",
};

/**
 * FLY-892 (Step 3, founder-approved ①): the message-level phase+model tag a
 * three-stage phase session prepends to its founder-facing thread messages, e.g.
 * `[设计·Fable] `. The model name is the session's own `runner_model`; when that
 * is absent (account default) it falls back to the phase's planned tier model
 * (`DEFAULT_PHASE_TIER`). A non-phase / main role → `""` so a Lead `/send` and
 * every non-three-stage message are byte-unchanged. Trailing space included so
 * callers just prepend.
 */
export function phaseMessageTag(
	role: string | null | undefined,
	runnerModel?: string | null,
): string {
	if (!isThreeStagePhaseRole(role)) return "";
	const name = PHASE_MESSAGE_NAME[role];
	const model = modelDisplayName(runnerModel, DEFAULT_PHASE_TIER[role]);
	return model ? `[${name}·${model}] ` : `[${name}] `;
}
