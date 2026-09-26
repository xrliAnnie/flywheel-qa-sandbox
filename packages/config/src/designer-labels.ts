/**
 * FLY-1059: the "UI / design-flavored" label set — the single source of truth
 * for whether a three-stage Design phase should run the mockup-first Designer
 * workflow (concept images A/B/C → founder design gate → high-fidelity) instead
 * of the generic brainstorm→plan text-design prompt.
 *
 * WHY a label heuristic (not a new agent-per-phase): the three-stage pipeline
 * (FLY-793) runs the SAME label-matched agent role for all three phases; per-phase
 * behavior comes only from the phase prompt Blueprint injects. FLY-1020 locked the
 * node set as fixed (Design/Implement/QA, no new nodes), so the Designer is the
 * existing Design node upgraded for UI/design work — gated by this label set so a
 * backend-only issue's Design phase stays the generic text design (byte-compat).
 *
 * SEPARATE from agent routing: `designer`/`mockup` route the WHOLE issue to the
 * standalone `designer-executor` agent (config.yaml). This set is broader — it is
 * only consulted inside the Design phase to pick the mockup-first prompt, and it
 * intentionally includes labels owned by OTHER agents (`ui`/`frontend` → engineer,
 * `design`/`ux` → product-designer) because those issues' Design phases still
 * benefit from a visual mockup pass.
 */

/** Visual / UI-flavored labels (lowercase). */
export const UI_DESIGN_LABELS: readonly string[] = [
	"ui",
	"ux",
	"web",
	"frontend",
	"fe",
	"dashboard",
	"design",
	"designer",
	"mockup",
	"visual",
];

const UI_DESIGN_LABEL_SET: ReadonlySet<string> = new Set(UI_DESIGN_LABELS);

/**
 * Does any of `labels` mark this issue as UI/design-flavored (→ mockup-first
 * Design phase)? `labels` are expected pre-lowercased at the Bridge boundary
 * (runs-route), but this defensively lowercases each so a caller that forgets
 * (e.g. a raw hydrated label) still matches. Empty / undefined → false
 * (fail-closed: no signal → generic design phase, byte-compatible).
 */
export function isUiDesignFlavored(
	labels: readonly string[] | undefined,
): boolean {
	if (!labels?.length) return false;
	return labels.some((l) => UI_DESIGN_LABEL_SET.has(l.toLowerCase()));
}
