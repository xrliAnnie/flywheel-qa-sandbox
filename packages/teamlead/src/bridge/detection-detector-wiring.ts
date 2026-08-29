/**
 * FLY-1048 PR-C (C4): pure mapping from the OBSERVATION layers into the
 * unified escalation flow's inputs.
 *
 * Three sources feed `notifyLeadFirst` when FLYWHEEL_DETECTION_ESCALATION=1
 * (env unset = A6/A7 stay observe-only, current behavior byte-for-byte):
 *   - A6 gap-scan SuspicionRecords (漏①/漏②/consumed-ack, PRD §3.3/§3.3b);
 *   - A7 focused-frame c_candidates + PR-B judge-confirmed c (case-c,
 *     kind `detection_stuck_confirmed`);
 *   - FN4: the lead_events delivery reconcile — EVIDENCE-HONEST scope (plan
 *     C4 / Codex design R1 #6): only delivery attempts that exist today
 *     (attempts exhausted / undelivered overdue). The 574 draft-intent case
 *     has no durable record to reconcile and stays a named follow-up.
 *
 * Everything here is pure (no I/O); the plugin injects store reads and owns
 * the env gate. Reasons are one-line and NEVER carry pane text (the A5
 * fail-suspicious leg owns quoted tails).
 */

import { createHash } from "node:crypto";
import type { DetectionEscalationInput } from "./detection-escalation.js";
import type { SuspicionRecord } from "./detection-gap-scan.js";
import type { ErrorSignatureHit } from "./error-signatures.js";
import { fingerprintOutput, sigFingerprint } from "./stuck-candidate.js";

/** Session fields the builders need (a Pick of StateStore's Session). */
export interface EscalationSessionContext {
	execution_id: string;
	issue_id: string;
	issue_identifier?: string;
	project_name: string;
}

// ── A6 gap records → escalation inputs ─────────────────────────────────────

/** PRD §3.3/§3.3b kind names for the three notifiable gap suspicions. */
export const GAP_ESCALATION_KINDS = {
	gap1_parked_unreported: "runner_parked_unreported",
	gap2_ask_unanswered: "lead_ask_unanswered",
	delivery_unconsumed: "delivery_unconsumed",
} as const;

const GAP_NEXT_STEPS: Record<keyof typeof GAP_ESCALATION_KINDS, string> = {
	gap1_parked_unreported:
		"确认 runner 是否真在等人,补上报或唤醒(漏①,§4.5 第一响应人)",
	gap2_ask_unanswered: "回答 runner 的提问或指派人跟进(漏②)",
	delivery_unconsumed:
		"检查 runner 是否活着、是否真收到了指令(consumed-ack 超时,§3.3b)",
};

/**
 * Restart-durable per-condition fingerprint (Codex code R1 #9): keyed by
 * (kind, target) ONLY — the in-process registry's firstSeenMs resets on a
 * Bridge restart, and folding it in would mint a fresh episode (duplicate
 * notify + a brand-new founder-grace clock) for the same persistent
 * condition. Recurrence after a genuine clear re-arms through the store's
 * RESOLVED-revive boundary (upsert with a newer firstDetectedAtMs than the
 * resolution moment), never through a new fingerprint.
 */
export function gapSuspicionFingerprint(record: SuspicionRecord): string {
	const digest = createHash("sha256")
		.update(`${record.kind}|${record.targetKey}`)
		.digest("hex")
		.slice(0, 16);
	return `gap:${digest}`;
}

/**
 * Build the unified-flow input for one gap suspicion. Returns null for
 * `pane_progress_suspect` — that kind only queues focused frames (A7) and
 * must never notify anyone directly.
 */
export function buildGapEscalationInput(
	record: SuspicionRecord,
	session: EscalationSessionContext,
): DetectionEscalationInput | null {
	if (record.kind === "pane_progress_suspect") return null;
	return {
		targetKey: record.targetKey,
		kind: GAP_ESCALATION_KINDS[record.kind],
		episodeFingerprint: gapSuspicionFingerprint(record),
		executionId: session.execution_id,
		issueId: session.issue_id,
		issueIdentifier: session.issue_identifier,
		projectName: session.project_name,
		firstDetectedAtMs: record.firstSeenMs,
		// The gap layer never captures panes, so its evidence line is pane-free
		// by construction — safe to surface verbatim.
		reason: record.evidence,
		nextStep: GAP_NEXT_STEPS[record.kind],
	};
}

// ── A7/PR-B case-c → escalation input ───────────────────────────────────────

/** The unified flow's case-c kind (plan C4; C4a keys interop on it). */
export const CASE_C_ESCALATION_KIND = "detection_stuck_confirmed";

/**
 * Fallback case-c fingerprint when the OLD detector has no live episode for
 * the target — chosen to match the key the old flow WOULD compute for the
 * same pane, so the C4a mutual exclusion still keys correctly:
 *   - a changing pane looping the same signature → the A3 `sig:` family;
 *   - a static pane (with or without a signature residue) → the legacy
 *     full-output fingerprint.
 * The plugin prefers the live episode's own fingerprint over this.
 */
export function fallbackCaseCFingerprint(
	deltas: {
		silenceDelta: boolean;
		repeatedErrorSig: ErrorSignatureHit | null;
	},
	latestFrame: string,
): string {
	if (deltas.repeatedErrorSig && !deltas.silenceDelta) {
		return sigFingerprint(deltas.repeatedErrorSig.signature);
	}
	return fingerprintOutput(latestFrame);
}

/** Build the confirmed-c input (reason composed by the caller, pane-free). */
export function buildCaseCEscalationInput(
	session: EscalationSessionContext,
	episodeFingerprint: string,
	opts: { reason: string; firstDetectedAtMs: number },
): DetectionEscalationInput {
	return {
		targetKey: session.execution_id,
		kind: CASE_C_ESCALATION_KIND,
		episodeFingerprint,
		executionId: session.execution_id,
		issueId: session.issue_id,
		issueIdentifier: session.issue_identifier,
		projectName: session.project_name,
		firstDetectedAtMs: opts.firstDetectedAtMs,
		reason: opts.reason.replace(/\s*\n\s*/g, " "),
		nextStep:
			"capture terminal 判定,自愈或处置(runner_terminal_capture → detection-ack / stuck-disposition)",
	};
}

// ── FN4: lead_events delivery reconcile ─────────────────────────────────────

export const DELIVERY_FAILURE_KIND = "delivery_failed_reconcile";

/**
 * A failing DETECTION event must never feed itself back into detection —
 * its own escalation lifecycle (guardrail retries + the ~30min founder page)
 * already covers the broken-transport case.
 */
export const FN4_EXCLUDED_EVENT_TYPES = new Set([
	"detection_escalation",
	"detection_suspicious",
]);

/** One undelivered lead_events row, as read by the store's reconcile query. */
export interface DeliveryFailureCandidate {
	seq: number;
	leadId: string;
	eventType: string;
	/** The execution the event was about; unroutable rows are skipped. */
	sessionKey?: string;
	deliveryAttempts: number;
	/** Parsed created_at; null = unparseable → only the attempts leg fires. */
	createdAtMs: number | null;
}

export interface DeliveryFailureFinding {
	seq: number;
	leadId: string;
	eventType: string;
	sessionKey: string;
	reason: "attempts_exhausted" | "undelivered_overdue";
	ageMs: number | null;
}

/**
 * FN4 judgement matrix. Both triggers are ANDed with "still undelivered"
 * (the store query's contract); a row without a sessionKey has no issue
 * thread to escalate into and is skipped (the caller logs it).
 */
export function evaluateDeliveryFailures(
	candidates: DeliveryFailureCandidate[],
	nowMs: number,
	opts: { maxAttempts: number; overdueMs: number },
): DeliveryFailureFinding[] {
	const out: DeliveryFailureFinding[] = [];
	for (const c of candidates) {
		if (!c.sessionKey) continue;
		if (FN4_EXCLUDED_EVENT_TYPES.has(c.eventType)) continue;
		const ageMs = c.createdAtMs === null ? null : nowMs - c.createdAtMs;
		const reason: DeliveryFailureFinding["reason"] | null =
			c.deliveryAttempts >= opts.maxAttempts
				? "attempts_exhausted"
				: ageMs !== null && ageMs >= opts.overdueMs
					? "undelivered_overdue"
					: null;
		if (!reason) continue;
		out.push({
			seq: c.seq,
			leadId: c.leadId,
			eventType: c.eventType,
			sessionKey: c.sessionKey,
			reason,
			ageMs,
		});
	}
	return out;
}

/** Stable per-failed-event fingerprint — one episode per (lead, seq). */
export function deliveryFailureFingerprint(
	finding: Pick<DeliveryFailureFinding, "leadId" | "seq">,
): string {
	return `fn4:${finding.leadId}:${finding.seq}`;
}

/** Parse an FN4 fingerprint back to its evidence key (the clear pass). */
export function parseDeliveryFailureFingerprint(
	fingerprint: string,
): { leadId: string; seq: number } | null {
	const match = /^fn4:(.+):(\d+)$/.exec(fingerprint);
	if (!match) return null;
	return { leadId: match[1] as string, seq: Number(match[2]) };
}

export function buildDeliveryFailureInput(
	finding: DeliveryFailureFinding,
	session: EscalationSessionContext,
	nowMs: number,
): DetectionEscalationInput {
	const ageMin =
		finding.ageMs === null ? "?" : String(Math.round(finding.ageMs / 60_000));
	return {
		targetKey: finding.sessionKey,
		kind: DELIVERY_FAILURE_KIND,
		episodeFingerprint: deliveryFailureFingerprint(finding),
		executionId: session.execution_id,
		issueId: session.issue_id,
		issueIdentifier: session.issue_identifier,
		projectName: session.project_name,
		firstDetectedAtMs: nowMs,
		reason:
			finding.reason === "attempts_exhausted"
				? `发给 ${finding.leadId} 的 ${finding.eventType} 事件投递重试已耗尽(seq ${finding.seq})`
				: `发给 ${finding.leadId} 的 ${finding.eventType} 事件 ${ageMin} 分钟仍未送达(seq ${finding.seq})`,
		nextStep: "检查该 Lead 的投递通道(runtime/inbox),必要时手动转达(FN4)",
	};
}
