import type { FounderUxGateConfig, FounderUxGateMode } from "./types.js";
import { FOUNDER_UX_GATE_DEFAULT_MODE } from "./types.js";

/**
 * FLY-869: default exempt-label set applied when a project's `founder_ux_gate`
 * block is present but omits `exempt_labels` (or the block is absent
 * entirely). A Lead applies this label to explicitly opt a trivial / purely
 * mechanical issue OUT of the now-default-on brainstorm gate.
 */
export const DEFAULT_FOUNDER_UX_EXEMPT_LABELS: readonly string[] = [
	"brainstorm-exempt",
];

/** The fully-resolved (never-absent) founder-UX gate configuration. */
export interface EffectiveFounderUxGateConfig {
	mode: FounderUxGateMode;
	exempt_labels: string[];
}

/**
 * FLY-869 — the ONE resolution choke point for `founder_ux_gate`.
 *
 * FLY-598 shipped this gate opt-IN (`FOUNDER_UX_GATE_DEFAULT_MODE = "off"`):
 * every runtime consumer treated an ABSENT `founder_ux_gate` key as "feature
 * off". FLY-869 flips the default to opt-OUT — "gate every substantial issue
 * before implement, not just ones a Lead remembered to label
 * founder-facing-ux" — so an ABSENT config block must now resolve to
 * `enforce` (+ the default exempt-label list) instead of `off`.
 *
 * Every runtime consumer that used to read `config?.founder_ux_gate?.mode`
 * directly (DirectEventSink's per-run mode snapshot, Blueprint's prompt
 * injection gate, runs-route's trigger call site, claude-lead.sh's rule-file
 * append) MUST instead resolve the raw block through this function first, so
 * "absent" and an EXPLICIT `mode: "off"` remain distinguishable at exactly
 * one place. Explicit config (any shape, including explicit `mode: "off"`)
 * always passes through untouched — this is the project-level kill-switch
 * and stays byte-compatible with FLY-598.
 */
export function resolveEffectiveFounderUxConfig(
	raw?: FounderUxGateConfig,
): EffectiveFounderUxGateConfig {
	if (raw == null) {
		return {
			mode: FOUNDER_UX_GATE_DEFAULT_MODE,
			exempt_labels: [...DEFAULT_FOUNDER_UX_EXEMPT_LABELS],
		};
	}
	return {
		mode: raw.mode,
		exempt_labels: raw.exempt_labels
			? [...raw.exempt_labels]
			: [...DEFAULT_FOUNDER_UX_EXEMPT_LABELS],
	};
}

/**
 * FLY-900 — fleet-wide kill-switch for the founder-UX implement-before-signoff
 * gate (FLY-598 / FLY-869). Annie declared the gate unnecessary AND it is
 * currently mis-configured (no `FLYWHEEL_FOUNDER_USER_ID` → the sign-off write
 * fail-closes 503, permanently blocking every founder-facing issue's implement).
 *
 * This is the SINGLE source of the flag's semantics. It stacks OVER the
 * per-project `founder_ux_gate.mode` config (governance gate) as a fleet-wide
 * override, exactly like `three_stage_killswitch` (`FLYWHEEL_THREE_STAGE`) — but
 * with the OPPOSITE polarity: default OFF (gate disabled), only `"1"` re-enables
 * the original enforce behavior (opt_in idiom, `resolve.ts:107`). We deliberately
 * accept only `"1"` (not `"true"`) so the registry's displayed effective value is
 * byte-identical to the real read — restart writes `=1` in `.env`.
 *
 * Consumed at three enforcement points (Blueprint prompt injection / status-route
 * poll / stage-guard call site) plus `claude-lead.sh`'s rule-file append; every
 * one short-circuits to "gate disabled" when this returns false. The pure
 * resolver above is untouched (byte-compatible), so its unit tests never churn.
 *
 * Requires a Bridge restart to take effect (env is captured at boot).
 */
export function isFounderUxGateEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED === "1";
}
