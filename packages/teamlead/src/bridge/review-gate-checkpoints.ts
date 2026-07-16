/**
 * FLY-1257 defect ④ — the canonical definition of a REVIEW gate.
 *
 * `review_design` / `review_code` are the FLY-1224 cross-family review lane:
 * the AUTHORING runner opens them but NEVER answers them — `request-review`
 * BINDS them and the (different-family) reviewer answers them. So every
 * "the runner is gone, this gate can never be answered → retire it" heuristic
 * is FALSE for this family: retiring one expires it before `request-review`
 * can bind it, and a blocked/completed session can then never re-request review.
 *
 * Defect ④ is exactly the failure to protect this family UNIFORMLY across every
 * gate-retirement path (GatePoller eviction, CommDB.finalizeSession, and the
 * zombie-gate-hygiene Z1 sweep). Those paths MUST all consult this single set —
 * a second, drifting copy of it is the bug this ticket is closing. Keep this the
 * one source of truth; add a new review checkpoint here and every path inherits
 * the protection.
 */
export const REVIEW_GATE_CHECKPOINTS: ReadonlySet<string> = new Set([
	"review_design",
	"review_code",
]);

export function isReviewGateCheckpoint(
	checkpoint: string | null | undefined,
): boolean {
	return checkpoint != null && REVIEW_GATE_CHECKPOINTS.has(checkpoint);
}
