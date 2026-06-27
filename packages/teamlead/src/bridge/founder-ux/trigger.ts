/**
 * FLY-598: founder-facing UX gate — Layer A (run-start trigger snapshot).
 *
 * Decides the `founder_facing_ux` flag persisted on a session at run start. The
 * PRIMARY trigger is the Lead's `founder-facing-ux` label (the Lead applies it per
 * loose, model-driven guidance — there is NO hardcoded classifier here). A Runner
 * can additionally self-declare later (Layer A backup, `declare-founder-ux`).
 *
 * Fail-closed (Codex R1 MEDIUM): if the issue's labels could not be READ at run
 * start, we cannot prove the issue is NOT founder-facing, so we treat it AS
 * founder-facing. Reading the primary trigger failing must never be equivalent to
 * "no UX gate". This only has teeth when the gate is enabled (mode != off); with
 * the default off mode the flag is inert, so it is byte-compatible.
 */

/** The label that records the Lead's founder-facing-UX judgment. */
export const FOUNDER_FACING_UX_LABEL = "founder-facing-ux";

/**
 * @param normalizedLabels lower-cased issue labels (empty when none / unreadable)
 * @param labelsFetchFailed true when the label fetch itself failed (≠ "no labels")
 */
export function resolveFounderFacingUx(
	normalizedLabels: readonly string[],
	labelsFetchFailed: boolean,
): boolean {
	return (
		normalizedLabels.includes(FOUNDER_FACING_UX_LABEL) || labelsFetchFailed
	);
}
