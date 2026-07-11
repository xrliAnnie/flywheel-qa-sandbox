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

import { createHash } from "node:crypto";
import { SUSPICIOUS_QUOTE_PREFIX } from "./error-signatures.js";
import type { HookPayload } from "./hook-payload.js";

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
	/**
	 * FLY-1048 PR-B (B3): the multi-frame window behind this report, so the
	 * judge can be consulted before delivery. IN-PROCESS ONLY — the deliverer
	 * builds its payload from explicit fields and never serializes frames.
	 */
	frames?: Array<{ text: string; capturedAtMs: number }>;
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

/**
 * Durable dedup id (session_events UNIQUE event_id convention). Keyed on BOTH
 * targetKey and fingerprint — fingerprints are content hashes, so two targets
 * frozen on identical pane content would otherwise cross-dedup and one report
 * would be silently lost.
 */
export function suspiciousEventId(report: SuspiciousReport): string {
	const key = createHash("sha256")
		.update(`${report.targetKey}|${report.episodeFingerprint}`)
		.digest("hex")
		.slice(0, 16);
	return `detection-suspicious-${key}`;
}

/**
 * Issue-thread quiet note (no mention). REASON ONLY — the thread can be seen
 * by the founder, so raw pane content never travels this leg (privacy,
 * LeadWatchdog bodyFor precedent).
 */
export function formatSuspiciousThreadNote(report: SuspiciousReport): string {
	const what = report.targetKind === "runner" ? "Runner" : "Lead";
	return (
		`🔍 Watchdog is unsure about this ${what} (${report.targetKey}): ${report.reason}. ` +
		"Quiet FYI — the owner Lead received the details; no action required unless it repeats."
	);
}

/** Resolved owner-Lead routing for a report. */
export interface SuspiciousOwner {
	leadId: string;
	projectName: string;
	/** Runner targets: the execution id (drives issue-thread resolution). */
	executionId?: string;
	issueId?: string;
}

export interface SuspiciousDeliveryStore {
	insertEvent(event: {
		event_id: string;
		execution_id: string;
		issue_id: string;
		project_name: string;
		event_type: string;
		severity?: string;
		payload?: unknown;
		source: string;
	}): boolean;
	appendLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): number;
	markLeadEventDelivered(seq: number): void;
	recordDeliveryFailure(seq: number, error: string): void;
}

export interface SuspiciousDeliveryDeps {
	store: SuspiciousDeliveryStore;
	runtimeRegistry: {
		getForLead(leadId: string):
			| {
					deliver(env: {
						seq: number;
						event: HookPayload;
						sessionKey: string;
						leadId: string;
						timestamp: string;
					}): Promise<{ delivered: boolean; error?: string }>;
			  }
			| null
			| undefined;
	};
	/** Owner-Lead resolution (lead targets: parse the state key; runner
	 * targets: session → label-derived lead). null → no_owner (logged). */
	resolveOwner: (report: SuspiciousReport) => SuspiciousOwner | null;
	/**
	 * Optional quiet issue-thread leg. Caller pre-guards thread binding (A5 /
	 * Codex R1 #3: never call the thread helper with an undefined thread) and
	 * uses `formatSuspiciousThreadNote` — reason only, never the pane.
	 */
	emitThreadNote?: (
		report: SuspiciousReport,
		owner: SuspiciousOwner,
	) => Promise<void>;
	logger?: (msg: string) => void;
	now?: () => number;
}

export type SuspiciousDeliveryOutcome = "delivered" | "duplicate" | "no_owner";

/**
 * Deliver a fail-suspicious report to its owner Lead: durable once-per-episode
 * dedup (session_events UNIQUE), then a guardrail lead_event (failed delivery
 * is retried by the HeartbeatService redelivery loop), then the optional quiet
 * thread note. NEVER throws — "never silent" must not become "sometimes
 * crashes the watchdog tick".
 */
export async function deliverSuspiciousReport(
	deps: SuspiciousDeliveryDeps,
	report: SuspiciousReport,
): Promise<SuspiciousDeliveryOutcome> {
	const logger =
		deps.logger ?? ((m: string) => console.log(`[detection-suspicious] ${m}`));
	const owner = deps.resolveOwner(report);
	if (!owner) {
		logger(
			`no owner lead resolvable for ${report.targetKind} ${report.targetKey} — report NOT delivered: ${report.reason}`,
		);
		return "no_owner";
	}
	const eventId = suspiciousEventId(report);
	const executionId = owner.executionId ?? report.targetKey;

	// Durable once-per-(target, episode) dedup.
	const fresh = deps.store.insertEvent({
		event_id: eventId,
		execution_id: executionId,
		issue_id: owner.issueId ?? "unknown",
		project_name: owner.projectName,
		event_type: "detection_suspicious",
		severity: "info",
		payload: {
			target_kind: report.targetKind,
			target_key: report.targetKey,
			reason: report.reason,
			episode_fingerprint: report.episodeFingerprint,
		},
		source: "detection-suspicious",
	});
	if (!fresh) return "duplicate";

	const payload: HookPayload = {
		event_type: "detection_suspicious",
		execution_id: executionId,
		issue_id: owner.issueId ?? "unknown",
		project_name: owner.projectName,
		status: "detection_suspicious",
		detection_target_kind: report.targetKind,
		detection_target_key: report.targetKey,
		suspicious_reason: report.reason,
		suspicious_pane_tail: quotePaneTail(report.paneTail),
		episode_fingerprint: report.episodeFingerprint,
	};
	const seq = deps.store.appendLeadEvent(
		owner.leadId,
		eventId,
		"detection_suspicious",
		JSON.stringify(payload),
		executionId,
	);
	try {
		const runtime = deps.runtimeRegistry.getForLead(owner.leadId);
		if (runtime) {
			const result = await runtime.deliver({
				seq,
				event: payload,
				sessionKey: executionId,
				leadId: owner.leadId,
				timestamp: new Date(deps.now?.() ?? Date.now()).toISOString(),
			});
			if (result.delivered) deps.store.markLeadEventDelivered(seq);
			else
				deps.store.recordDeliveryFailure(
					seq,
					result.error ?? "deliver returned false",
				);
		}
	} catch (err) {
		try {
			deps.store.recordDeliveryFailure(seq, (err as Error).message);
		} catch {
			/* best-effort */
		}
	}

	if (deps.emitThreadNote) {
		try {
			await deps.emitThreadNote(report, owner);
		} catch (err) {
			logger(`thread-note leg failed (non-fatal): ${(err as Error).message}`);
		}
	}
	return "delivered";
}
