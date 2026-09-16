import type { BetaCandidate } from "flywheel-release-contract";

/** Same bounded freshness as notice revalidation; never reuse a morning verdict at claim. */
export const CUSTOMER_RELEASE_VERDICT_MAX_AGE_MS = 30_000;

export interface PersistedCustomerReadiness {
	verdictId: string;
	sourceCommit: string;
	baseVersion: string;
	localDeployedSha: string | null;
	state: string;
	evaluatedAt: string;
}

export function preparationRejection(
	candidate: BetaCandidate,
	verdict: PersistedCustomerReadiness | undefined,
	expectedVerdictId: string,
	now: number,
): string | null {
	if (!verdict || verdict.verdictId !== expectedVerdictId)
		return "readiness_missing_or_superseded";
	if (
		verdict.sourceCommit !== candidate.sourceCommit ||
		verdict.baseVersion !== candidate.baseVersion ||
		verdict.localDeployedSha !== candidate.sourceCommit
	)
		return "readiness_subject_mismatch";
	const at = Date.parse(verdict.evaluatedAt);
	if (
		!Number.isFinite(at) ||
		at > now ||
		now - at > CUSTOMER_RELEASE_VERDICT_MAX_AGE_MS
	)
		return "readiness_stale";
	if (verdict.state !== "green")
		return verdict.state === "hold" ? "readiness_hold" : "readiness_unknown";
	return null;
}
