/**
 * FLY-793: the three-stage pipeline phase table.
 *
 * A three-stage run is ONE Linear issue / ONE RPCI flow with three internal
 * phase-sessions handed off on one branch B: Design → Implement → QA, each with
 * its own vendor + model. This module owns the phase sequence; the live dispatch
 * specs come from the same hot models.json snapshot as the difficulty tiers.
 *
 * Dispatch per phase (Annie's directive, 2026-07-13 — FLY-1224):
 *   design    → claude claude-fable-5       — brainstorm / research / design
 *   implement → codex  gpt-5.6-sol (xhigh)  — code (Annie's standard Codex config)
 *   qa        → claude claude-opus-5        — verification (QA is a write-capable
 *                                             phase too; the model choice is
 *                                             independent of that)
 *
 * NO phase runs on Sonnet. The motivating incident: the QA↔implement rework
 * loop stalled with QA stuck on Sonnet — Annie's zero-Sonnet policy for phase
 * sessions is enforced by an explicit invariant test.
 *
 * CROSS-FAMILY REVIEW RULE (Annie's directive, 2026-07-13 — FLY-1224, both
 * directions fixed BY DESIGN): the author's vendor family must never review its
 * own work. Claude author → Codex reviews (legacy lane); Codex author → CLAUDE
 * reviews (FLY-1188 request-review lane: Opus reviewer at effort xhigh). The
 * gate-level enforcement is `crossFamilyReviewSatisfied` (review-family.ts) on
 * BOTH `isCodexCodeReviewApproved` and `verify-approval`; same-family stamped
 * records are rejected. If a future table change makes the design phase a codex
 * author, its design review automatically flips to the Claude lane — no new
 * decision needed.
 *
 * KILL-SWITCHES (two symmetric env toggles, see `resolvePhaseDispatch`):
 *   - `FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0` falls the implement phase back to
 *     (claude, heavy) — the escape hatch when the codex account quota is out.
 *   - `FLYWHEEL_THREE_STAGE_CODEX_DESIGN=1` flips the design phase FROM Fable TO
 *     codex (gpt-5.6-sol, xhigh) when a run has no per-dispatch design override
 *     (FLY-1245 / FLY-1259). Opposite activating value (=1 vs =0) because design
 *     defaults to claude while implement defaults to codex.
 * Env is read at process start: edit `~/.flywheel/.env`, then
 * `restart-services.sh --reason env-change`.
 *
 * REVERT (7/7, after the Fable window): flip the `pipeline.three_stage` toggle
 * OFF — a task then runs as a single session exactly as before. The table here
 * is deliberately NOT the revert lever.
 *
 * The FLY-767 "prefer-Fable / strong-over-weak" stance is an ISSUE-LEVEL model
 * routing concern (Lead difficulty-sort / dispatch `model` param), separate from
 * this per-phase table — it is not applied here so Annie's explicit
 * per-phase model is not silently overridden.
 */

import {
	BUILTIN_PHASE_DISPATCH,
	type ModelPhaseDispatchSpec,
	type ModelRuntimeVendor,
} from "./model-builtins.js";
import { getModelConfigSnapshot } from "./model-config.js";
import { type ModelTier, modelDisplayName } from "./model-tiers.js";
import {
	NODE_TYPE_REGISTRY,
	type WorkflowNodeTypeId,
} from "./node-type-registry.js";

export type ThreeStagePhase = "design" | "implement" | "qa";

/** Ordered phase sequence of a three-stage run (Design → Implement → QA). */
export const THREE_STAGE_PHASE_SEQUENCE: readonly ThreeStagePhase[] = [
	...Object.values(NODE_TYPE_REGISTRY)
		.filter((entry) => entry.isPhaseRole)
		.map((entry) => entry.id as ThreeStagePhase),
];

/**
 * Is `role` one of the three-stage phase roles (design/implement/qa)? The single
 * source of truth for "is this a phase session" — used by the PhaseOrchestrator
 * gate and by the completion sinks' role-preservation guard.
 */
export function isThreeStagePhaseRole(
	role: string | null | undefined,
): role is ThreeStagePhase {
	return (
		role != null &&
		NODE_TYPE_REGISTRY[role as WorkflowNodeTypeId]?.isPhaseRole === true
	);
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
	if (
		existingRole != null &&
		NODE_TYPE_REGISTRY[existingRole as WorkflowNodeTypeId]
			?.preserveCompletionRole === true
	) {
		return existingRole;
	}
	return incomingRole ?? "main";
}

/**
 * FLY-1224: LAST-RESORT display-fallback tier per phase. NOT the dispatch
 * source anymore — dispatch (vendor + model + effort) comes from
 * `DEFAULT_PHASE_DISPATCH` below. This table only backs `modelDisplayName`'s
 * `fallbackTier` parameter for a model the display layer doesn't recognize
 * (unknown family, no dispatch-table hit). Values are frozen for byte-compat
 * with pre-1224 display fallbacks.
 */
export const DEFAULT_PHASE_TIER: Readonly<Record<ThreeStagePhase, ModelTier>> =
	{
		design: "heavy",
		implement: "heavy",
		qa: "medium",
	};

/**
 * FLY-1224: three-stage phases only ever dispatch on a TRANSPORTED vendor —
 * a phase session must receive park/wake mailboxes and walk the gate flow.
 * No-transport backends (antigravity/kimi) are excluded at the TYPE level so
 * they can never enter the phase table.
 */
export type PhaseDispatchVendor = ModelRuntimeVendor;

/** Transitional public choices for a three-stage run's design author. */
export type DesignBackend = PhaseDispatchVendor;
export const DESIGN_BACKENDS = [
	"codex",
	"claude",
] as const satisfies readonly DesignBackend[];

export function isDesignBackend(value: unknown): value is DesignBackend {
	return DESIGN_BACKENDS.includes(value as DesignBackend);
}

/** Admission-time override shape aligned with future per-node dispatch specs. */
export interface PhaseDispatchOverride {
	vendor: PhaseDispatchVendor;
}

export type PhaseDispatchSpec = ModelPhaseDispatchSpec;

/** Built-in Codex fail-safe when the hot phase table has no Codex row. */
const CODEX_STANDARD_DISPATCH = BUILTIN_PHASE_DISPATCH.implement;

/**
 * Fail-safe for a missing/malformed models.json. Runtime decisions consume the
 * validated snapshot phases and may change on the next decision without restart.
 */
export const DEFAULT_PHASE_DISPATCH: Readonly<
	Record<ThreeStagePhase, PhaseDispatchSpec>
> = BUILTIN_PHASE_DISPATCH;

/**
 * FLY-1224 / FLY-1245 / FLY-1259: the dispatch spec for a three-stage phase,
 * admission override and kill-switch aware. A design-only per-dispatch override
 * wins over the global fallback. Without one, TWO env toggles let ops swap a
 * phase's vendor with a `~/.flywheel/.env` edit + Bridge restart, no code change.
 * They point in OPPOSITE directions because the two phases DEFAULT to opposite
 * vendors:
 *
 *   - implement defaults to CODEX → `FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0`
 *     falls it BACK to the legacy (claude, heavy) row — the escape hatch when
 *     the codex account quota is exhausted (a default-on kill-switch).
 *   - design defaults to CLAUDE/Fable → `FLYWHEEL_THREE_STAGE_CODEX_DESIGN=1`
 *     opts it INTO codex (gpt-5.6-sol, xhigh) — for when Fable's quota is the
 *     bottleneck (an opt-in). Naming is aligned (FLYWHEEL_THREE_STAGE_CODEX_
 *     <PHASE>); only the activating value differs (=0 vs =1), dictated by each
 *     phase's default vendor.
 *
 * When design flips to codex it becomes a codex AUTHOR, so its design review
 * auto-routes to the Claude reviewer via the FLY-1188 §7.1 request-review lane
 * (event-route.ts codex-tmux author detection → the request-review coordinator's
 * hard-coded cross-family Claude reviewer) — no new decision, exactly as the
 * file-header CROSS-FAMILY note promises.
 *
 * Env is injectable for tests; defaults to process.env. The env is read at call
 * time, but process.env itself only loads at Bridge start — a `~/.flywheel/.env`
 * edit needs `restart-services.sh --reason env-change` (§7 runbook in the FLY-1224
 * plan).
 */
export function resolvePhaseDispatch(
	phase: ThreeStagePhase,
	env: Record<string, string | undefined> = process.env,
	override?: PhaseDispatchOverride,
): PhaseDispatchSpec {
	// One immutable generation per routing decision. The next decision hot-reads
	// an atomically replaced models.json; every override below stays within this
	// generation.
	const snapshot = getModelConfigSnapshot();
	const configured = snapshot.phases;
	const claudeDesign =
		configured.design.vendor === "claude"
			? configured.design
			: DEFAULT_PHASE_DISPATCH.design;
	const codexStandard =
		configured.implement.vendor === "codex"
			? configured.implement
			: CODEX_STANDARD_DISPATCH;
	if (phase === "design" && override?.vendor === "codex") {
		return codexStandard;
	}
	if (phase === "design" && override?.vendor === "claude") {
		return claudeDesign;
	}
	if (
		phase === "implement" &&
		env.FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT === "0"
	) {
		return claudeDesign;
	}
	if (phase === "design" && env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN === "1") {
		return codexStandard;
	}
	return configured[phase];
}

/**
 * Canonical model id to dispatch for a three-stage phase. Kept for existing
 * callers' signature; FLY-1224 re-bases it on the dispatch table (implement
 * now resolves to the codex model — every dispatch site passes the full
 * vendor/model/effort triple via `resolvePhaseDispatch`).
 */
export function resolvePhaseModel(phase: ThreeStagePhase): string {
	return resolvePhaseDispatch(phase).model;
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
> = Object.fromEntries(
	THREE_STAGE_PHASE_SEQUENCE.map((phase) => {
		const [emoji, ...word] = Array.from(NODE_TYPE_REGISTRY[phase].badge);
		return [phase, { emoji: emoji ?? "", word: word.join("") }];
	}),
) as Record<ThreeStagePhase, { emoji: string; word: string }>;

/** Composed `emoji+word` badge per phase (`🎨设计`). Derived from the parts. */
export const PHASE_THREAD_BADGE: Readonly<Record<ThreeStagePhase, string>> =
	Object.fromEntries(
		THREE_STAGE_PHASE_SEQUENCE.map((phase) => [
			phase,
			NODE_TYPE_REGISTRY[phase].badge,
		]),
	) as Record<ThreeStagePhase, string>;

/**
 * FLY-892 (Step 6): the stage-level thread-title badge for a phase role (🎨设计 /
 * 🔨实现 / 🧪QA), or `""` for a non-phase (main) role. On a three-stage issue
 * this REPLACES the FLY-560 fine-grained stage prefix (Annie definition ③): the
 * title carries only the current phase, so a whole pipeline renames ~twice.
 */
export function phaseThreadBadge(role: string | null | undefined): string {
	return isThreeStagePhaseRole(role) ? NODE_TYPE_REGISTRY[role].badge : "";
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
 * is absent (pending row / account default) it falls back to the phase's
 * PLANNED DISPATCH model (`resolvePhaseDispatch`, kill-switch aware) — a
 * pending implement row shows GPT-5.6 because that is what it will run on
 * (FLY-1224 R1 #3: never show Fable for a row that dispatches codex). The
 * legacy `DEFAULT_PHASE_TIER` only backs a dispatch model the display layer
 * doesn't recognize. A non-phase / main role → `""` so a Lead `/send` and
 * every non-three-stage message are byte-unchanged. Trailing space included so
 * callers just prepend.
 */
export function phaseMessageTag(
	role: string | null | undefined,
	runnerModel: string | null | undefined,
	designBackend: DesignBackend | null | undefined,
): string {
	if (!isThreeStagePhaseRole(role)) return "";
	const name = PHASE_MESSAGE_NAME[role];
	const override =
		role === "design" && designBackend ? { vendor: designBackend } : undefined;
	const model =
		modelDisplayName(runnerModel) ??
		modelDisplayName(
			resolvePhaseDispatch(role, process.env, override).model,
			DEFAULT_PHASE_TIER[role],
		);
	return model ? `[${name}·${model}] ` : `[${name}] `;
}
