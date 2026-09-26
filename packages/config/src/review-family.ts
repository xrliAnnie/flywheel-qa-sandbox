/**
 * FLY-1188 §7.3 — family-aware review authority (the reviewer-inversion
 * invariant: THE REVIEWER MUST COME FROM A DIFFERENT AGENT FAMILY THAN THE
 * AUTHOR).
 *
 * Single shared rule consumed by every review-gate check — the Bridge's
 * `StateStore.isCodexCodeReviewApproved` (feeding codex-gate / auto-QA /
 * reconcile) AND the CLI mirror `flywheel-comm verify-approval` — so the
 * server gate and the runner-side merge check can never drift.
 */

/**
 * Map a session's executor backend (`sessions.adapter_type`, FLY-493) to its
 * agent FAMILY for the reviewer-inversion check. NULL/absent = the legacy
 * claude path (adapter_type predates FLY-493 or the default claude-tmux).
 */
export function adapterTypeToFamily(
	adapterType: string | null | undefined,
): string {
	if (!adapterType || adapterType === "claude-tmux") return "claude";
	if (adapterType === "codex-tmux") return "codex";
	// antigravity-tmux / kimi-tmux / future backends: each is its own family.
	return adapterType.replace(/-tmux$/, "");
}

/**
 * FLY-1244: admission-time reviewer inversion for a template execution.
 * Both values must already be resolved by the server from the selected
 * adapters/models; a manifest's vendor preference is never review authority.
 */
export function manifestReviewFamilyOk(
	authorResolvedFamily: string | null | undefined,
	reviewerResolvedFamily: string | null | undefined,
): boolean {
	return Boolean(
		authorResolvedFamily &&
			reviewerResolvedFamily &&
			authorResolvedFamily !== reviewerResolvedFamily,
	);
}

export interface CrossFamilyReviewInput {
	/** codex_review_record.status ("approved" | "skipped" | "pending" | absent). */
	status: string | null | undefined;
	/** codex_review_record.author_family (NULL on pre-FLY-1188 rows). */
	authorFamily: string | null | undefined;
	/** codex_review_record.reviewer_family (NULL on pre-FLY-1188 rows). */
	reviewerFamily: string | null | undefined;
	/** sessions.adapter_type of the AUTHOR session (NULL = legacy claude). */
	sessionAdapterType: string | null | undefined;
}

/**
 * Is this review record a valid CROSS-FAMILY review satisfaction?
 *
 * - `skipped` → true regardless of families (a sanctioned codex-skip is a
 *   governance-level bypass, not a review).
 * - `approved` with BOTH families stamped → families must differ.
 * - `approved` with families missing (legacy pre-FLY-1188 row): valid ONLY
 *   for a claude-family author (adapter_type NULL/claude-tmux) — those rows
 *   could only have come from the historical claude-author→codex-reviewer
 *   lane. Any non-claude author with an unstamped record FAILS CLOSED: a
 *   codex author must never satisfy its gate with a record that cannot
 *   prove a different-family reviewer.
 * - anything else → false.
 */
export function crossFamilyReviewSatisfied(
	input: CrossFamilyReviewInput,
): boolean {
	if (input.status === "skipped") return true;
	if (input.status !== "approved") return false;
	if (input.authorFamily && input.reviewerFamily) {
		return input.authorFamily !== input.reviewerFamily;
	}
	// legacy record without family stamps
	return adapterTypeToFamily(input.sessionAdapterType) === "claude";
}
