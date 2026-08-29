/**
 * FLY-598: founder-facing UX gate — sign-off record (StateStore-backed authority).
 *
 * The sign-off is the AUTHORITY artifact: it lives in StateStore (NOT a
 * Runner-owned worktree file, Codex R1-#1) and is written ONLY by the Bridge
 * after server-side founder-identity verification (see verify.ts). It is bound
 * to a canonical UX-brief `uxHash` so a stale sign-off for a previous brief
 * never satisfies the gate for a materially-changed UX (Codex R2-#2, FLY-598 ④).
 */

import type { StateStore } from "../../StateStore.js";

export interface FounderUxSignoff {
	/** sha256 of the canonical UX-brief this sign-off approves. */
	uxHash: string;
	/** Discord message id of Annie's natural-language approval (server-verified). */
	annieMsgId: string;
	/** Excerpt of the server-fetched message content (audit, never CLI-supplied). */
	fetchedExcerpt: string;
	/** ISO timestamp the sign-off was recorded. */
	ts: string;
	/** Opaque audit id (founder_ux_audit row). */
	auditId?: string;
}

/** Read + parse the sign-off record for a session, or null if none/malformed. */
export function readSignoff(
	store: StateStore,
	executionId: string,
): FounderUxSignoff | null {
	const raw = store.getSession(executionId)?.founder_ux_signoff_json;
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as FounderUxSignoff;
		if (typeof parsed.uxHash !== "string" || parsed.uxHash.length === 0) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * The gate's core predicate (status route + stage guard both call this): a
 * verified sign-off EXISTS and is bound to EXACTLY this uxHash. An empty/missing
 * uxHash never satisfies (fail-closed). A sign-off for a different (e.g. older)
 * brief returns false → re-sign required.
 */
export function signoffSatisfies(
	store: StateStore,
	executionId: string,
	uxHash: string,
): boolean {
	if (!uxHash || uxHash.length === 0) return false;
	const signoff = readSignoff(store, executionId);
	return signoff !== null && signoff.uxHash === uxHash;
}

/** Persist the verified sign-off (Bridge-only). Also marks the run founder-facing
 * (a sign-off implies it). */
export function writeSignoff(
	store: StateStore,
	executionId: string,
	record: FounderUxSignoff,
): void {
	store.patchSessionMetadata(executionId, {
		founder_facing_ux: 1,
		founder_ux_signoff_json: JSON.stringify(record),
	});
}
