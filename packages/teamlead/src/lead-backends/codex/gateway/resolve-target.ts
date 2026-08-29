/**
 * FLY-245 §5.4 / R1#7 — exactly-one target resolution, shared by the ship
 * (Phase C2) and runner-lifecycle (Phase D) paths.
 *
 * A model supplies only an issue/intent, but one issue can have multiple roles,
 * retries, or parked sessions. StateStore explicitly warns that
 * "latest-by-activity" is unstable and provides an all-candidates API. The
 * gateway must therefore resolve within the Lead's scope + the action's eligible
 * statuses and require EXACTLY ONE candidate; zero or multiple is fail-closed and
 * the candidate list is surfaced so the founder can re-issue an explicit request.
 * This prevents a confused-deputy selection of the wrong execution.
 */

export interface ResolveExactlyOneInput<T> {
	/** Already-scoped, already-status-filtered candidates (caller queries StateStore). */
	candidates: readonly T[];
	/** Human-readable one-liner per candidate (issue / execId / role / status). */
	describe: (c: T) => string;
	/** Context for the error message (e.g. "terminate FLY-12"). */
	intent: string;
}

export class AmbiguousTargetError extends Error {
	constructor(
		message: string,
		readonly candidateDescriptions: string[],
	) {
		super(message);
		this.name = "AmbiguousTargetError";
	}
}

/**
 * Return the single candidate, or throw (fail-closed) on zero or multiple.
 * On multiple, the error carries every candidate description so the caller can
 * present them for an explicit re-request.
 */
export function resolveExactlyOne<T>(input: ResolveExactlyOneInput<T>): T {
	const { candidates, describe, intent } = input;
	if (candidates.length === 0) {
		throw new AmbiguousTargetError(
			`No eligible target for "${intent}" — fail-closed`,
			[],
		);
	}
	if (candidates.length > 1) {
		const descs = candidates.map(describe);
		throw new AmbiguousTargetError(
			`Ambiguous target for "${intent}": ${candidates.length} candidates — refusing to guess. Re-issue an explicit request.`,
			descs,
		);
	}
	const only = candidates[0];
	if (only === undefined) {
		// Unreachable (length === 1), but noUncheckedIndexedAccess demands proof —
		// and an undefined target must NEVER escape a fail-closed resolver.
		throw new AmbiguousTargetError(
			`No eligible target for "${intent}" — fail-closed`,
			[],
		);
	}
	return only;
}
