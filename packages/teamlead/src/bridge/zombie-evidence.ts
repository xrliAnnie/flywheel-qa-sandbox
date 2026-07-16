/**
 * FLY-1282: zombie-declaration evidence — the single codec between the
 * `last_error` marker written at declaration time and the recurring backfill
 * that must rebuild alert evidence from it after a hard crash.
 *
 * The discriminated union (Codex R5 #2) makes malformed history honest by
 * construction: only `verified` evidence can produce a `liveness_probe`
 * payload; an `unparseable` marker yields an explicitly degraded alert with
 * NO fabricated target/probed_at/consecutive_probes.
 */

/** Result of the pane-liveness probe chain for a declared zombie. */
export interface ZombieLiveness {
	verdict: "dead";
	/** tmux window target that was probed (e.g. "runner-flywheel:@829"). */
	target: string;
	/** ISO timestamp of the FRESH (re-proof) probe. */
	probedAt: string;
}

export type ZombieEvidence =
	| { kind: "verified"; liveness: ZombieLiveness; streak: number }
	| { kind: "unparseable"; rawLastError: string };

export const ZOMBIE_LAST_ERROR_PREFIX = "zombie: ";

/**
 * Serialize declaration evidence into the session's `last_error`. This string
 * is BOTH the founder/Lead-visible failure reason and the durable marker the
 * backfill scans for — `parseZombieLastError` must round-trip it exactly.
 */
export function formatZombieLastError(
	target: string,
	streak: number,
	probedAt: string,
): string {
	return `${ZOMBIE_LAST_ERROR_PREFIX}tmux window ${target} dead (pane probe absent x${streak}, server up, at ${probedAt})`;
}

const PARSE_RE =
	/^zombie: tmux window (.+) dead \(pane probe absent x(\d+), server up, at ([^)]+)\)$/;

/** True when a `last_error` value marks a zombie declaration (any vintage). */
export function isZombieLastError(
	lastError: string | undefined | null,
): boolean {
	return !!lastError?.startsWith(ZOMBIE_LAST_ERROR_PREFIX);
}

/**
 * Rebuild evidence from a stored marker. Malformed / legacy variants degrade
 * to `unparseable` — the caller must NOT invent probe facts for those.
 */
export function parseZombieLastError(lastError: string): ZombieEvidence {
	const m = PARSE_RE.exec(lastError);
	const target = m?.[1];
	const probedAt = m?.[3];
	if (!m || !target || !probedAt) {
		return { kind: "unparseable", rawLastError: lastError };
	}
	const streak = Number.parseInt(m[2] ?? "", 10);
	if (!Number.isFinite(streak)) {
		return { kind: "unparseable", rawLastError: lastError };
	}
	return {
		kind: "verified",
		liveness: { verdict: "dead", target, probedAt },
		streak,
	};
}
