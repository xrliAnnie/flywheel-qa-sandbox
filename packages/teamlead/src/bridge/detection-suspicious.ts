/**
 * FLY-1048 (Task A5): the fail-suspicious output contract.
 *
 * "Never silent": whenever the mechanical detection layer cannot conclude
 * a/b/c (and the LLM judge is unavailable / disabled / fail-closed), the
 * uncertainty is reported QUIETLY to the owner Lead — a lead_event plus a
 * no-mention issue-thread note — instead of being suppressed.
 *
 * This file holds the pure contract (report shape, quote-prefix wrapping,
 * dedup event ids). Delivery wiring (lead_event + thread legs) is the A5
 * delivery half; the A4 watchdog veto only *produces* reports.
 */

import { SUSPICIOUS_QUOTE_PREFIX } from "./error-signatures.js";

export interface SuspiciousReport {
	targetKind: "runner" | "lead";
	/** execId (runner) or `<project>:<leadId>` state key (lead). */
	targetKey: string;
	/** Why the mechanical layer could not conclude (enum-ish + one sentence). */
	reason: string;
	/**
	 * ≤15 trailing non-empty pane lines (runner evidence.tail precedent).
	 * Lead-face ONLY: rendered into the owner Lead's inbox event, NEVER into
	 * the issue thread and NEVER to the founder (privacy, LeadWatchdog bodyFor
	 * precedent). Deliverers must quote it with `▏` (see quotePaneTail).
	 */
	paneTail: string;
	/** Stable episode key for dedup: one report per (targetKey, fingerprint). */
	episodeFingerprint: string;
}

/** Max pane lines carried in a suspicious report (evidence.tail precedent). */
export const SUSPICIOUS_TAIL_LINES = 15;

/** Trailing non-empty lines, bounded (mirrors stuck-candidate extractTail). */
export function buildPaneTail(
	text: string,
	lines = SUSPICIOUS_TAIL_LINES,
): string {
	return text
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.slice(-lines)
		.join("\n");
}

/**
 * Echo-poisoning guard (Codex R1 #2): pane lines delivered into a Lead pane
 * are re-captured by the LeadWatchdog on its next poll. Wrapping every line
 * with the `▏` quote prefix makes `scanErrorSignatures` (and the A3 signature
 * path) skip them, so a delivered report can never re-trigger
 * pane_error_stalled / a second detection_suspicious loop.
 */
export function quotePaneTail(tail: string): string {
	return tail
		.split("\n")
		.map((l) => `${SUSPICIOUS_QUOTE_PREFIX} ${l}`)
		.join("\n");
}

/** Durable dedup id (session_events UNIQUE event_id convention). */
export function suspiciousEventId(report: SuspiciousReport): string {
	return `detection-suspicious-${report.episodeFingerprint}`;
}
