/**
 * FLY-598 / FLY-869: founder-facing UX gate — Layer A (run-start trigger snapshot).
 *
 * Decides the `founder_facing_ux` flag persisted on a session at run start.
 *
 * FLY-869 flips this from an OPT-IN trigger (only issues labeled
 * `founder-facing-ux` were in scope) to a DEFAULT-ON trigger: every issue is
 * in scope UNLESS it carries one of the project's configured exempt labels
 * (default `["brainstorm-exempt"]` — see `resolveEffectiveFounderUxConfig` in
 * `flywheel-config`). This is still model-driven, loose guidance for WHICH
 * label a Lead applies (no hardcoded issue-content classifier) — only the
 * default polarity changed. A Runner can additionally self-declare later
 * (Layer A backup, `declare-founder-ux`).
 *
 * Fail-closed (Codex R1 MEDIUM, FLY-598): if the issue's labels could not be
 * READ at run start, we cannot prove the issue is exempt, so we treat it AS
 * in scope regardless of `exemptLabels`. This only has teeth when the gate is
 * enabled (mode != off); with an explicit `off` mode the flag is inert.
 */

/**
 * FLY-598: the label that recorded the Lead's founder-facing-UX judgment
 * under the old opt-in trigger. Kept as a legacy always-in-scope alias
 * post-FLY-869 — applying it can never EXEMPT an issue (it is not, and must
 * never be, one of the exempt labels), so it is harmless to leave in place.
 */
export const FOUNDER_FACING_UX_LABEL = "founder-facing-ux";

/**
 * FLY-869: the label a Lead applies to explicitly OPT a trivial / purely
 * mechanical issue OUT of the now-default-on brainstorm gate. Mirrors
 * `DEFAULT_FOUNDER_UX_EXEMPT_LABELS` in `flywheel-config`.
 */
export const BRAINSTORM_EXEMPT_LABEL = "brainstorm-exempt";

/**
 * FLY-869 (Lead 2ee06754): a QA issue — a separate `QA · <ident>` verification
 * issue (auto-created by auto-qa-effects, or hand-created with the same title
 * convention) — is AUTO-exempt from the brainstorm gate, no manual label needed.
 * A QA issue verifies an ALREADY-approved change; it has no founder-facing UX to
 * align on, and gating it would wedge the auto-QA loop. Mirrors the `QA ·` title
 * convention used by `isQaIssueSession` (auto-qa-coordinator). (The three-stage
 * phase-split of QA issues is a SEPARATE concern — FLY-874, not this gate.)
 */
export function isQaIssueTitle(title: string | undefined): boolean {
	return /^\s*QA\s*·/.test(title ?? "");
}

/**
 * @param normalizedLabels lower-cased issue labels (empty when none / unreadable)
 * @param labelsFetchFailed true when the label fetch itself failed (≠ "no labels")
 * @param exemptLabels lower-cased labels that exempt an issue from the gate —
 *   project-configurable via `founder_ux_gate.exempt_labels`, resolved by
 *   `resolveEffectiveFounderUxConfig` (default `["brainstorm-exempt"]`).
 * @param isQaIssue FLY-869 (Lead 2ee06754): the issue is a `QA ·` verification
 *   issue → auto-exempt (no manual label). Checked BEFORE the fail-closed branch:
 *   the title is available at run-start independent of the Linear label fetch, so a
 *   QA issue is never fail-closed INTO the gate on a label-read outage.
 */
export function resolveFounderFacingUx(
	normalizedLabels: readonly string[],
	labelsFetchFailed: boolean,
	exemptLabels: readonly string[],
	isQaIssue = false,
): boolean {
	// A QA issue is auto-exempt regardless of labels / a label-read failure.
	if (isQaIssue) return false;
	// Fail-closed dominates: an unreadable label set can never prove exemption.
	if (labelsFetchFailed) return true;
	const isExempt = normalizedLabels.some((label) =>
		exemptLabels.includes(label),
	);
	return !isExempt;
}
