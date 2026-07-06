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
