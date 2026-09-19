import type { HookPayload } from "./hook-payload.js";

/**
 * FLY-47 / FLY-163: EventFilter classifies events for priority hints to Lead
 * (high = MUST Chat, normal = optional FYI). After FLY-163 (forum removed),
 * the filter only annotates priority + reason; ALL events are delivered to
 * Lead unconditionally.
 */

export interface FilterResult {
	priority: "high" | "normal" | "low";
	reason: string;
}

interface FilterRule {
	match: (eventType: string, payload: Partial<HookPayload>) => boolean;
	result: FilterResult;
}

const FILTER_RULES: FilterRule[] = [
	// === HIGH — status-changing events Lead MUST notify Annie about ===
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "needs_review" || p.status === "awaiting_review"),
		result: {
			priority: "high",
			reason: "PR ready for review — Lead notifies Annie in Chat",
		},
	},
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "blocked" || p.status === "blocked"),
		result: {
			priority: "high",
			reason: "blocked — Lead escalates to Annie in Chat",
		},
	},
	{
		match: (et) => et === "session_failed",
		result: {
			priority: "high",
			reason: "session failed — Lead escalates to Annie in Chat",
		},
	},
	// FLY-163: collapsed two session_started rules (forum vs no-forum) into one
	// chat-only entry. The old payload.thread_id branch is gone.
	{
		match: (et) => et === "session_started",
		result: {
			priority: "high",
			reason: "session started — Lead announces to Annie in Chat",
		},
	},
	// FLY-58: approved_to_ship — Runner still needs to ship
	{
		match: (et, p) =>
			et === "action_executed" && p.status === "approved_to_ship",
		result: {
			priority: "high",
			reason: "approved to ship — Lead notifies Runner via gate unblock",
		},
	},
	// FLY-58: ship complete (completed or legacy approved)
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "approved" ||
				p.status === "approved" ||
				p.status === "completed"),
		result: {
			priority: "high",
			reason: "ship complete — Lead notifies Annie in Chat",
		},
	},
	// Catch-all for session_completed with unrecognized status
	{
		match: (et) => et === "session_completed",
		result: {
			priority: "normal",
			reason: "session completed",
		},
	},

	// === NORMAL — status changes that don't require Chat ===
	{
		match: (et) => et === "action_executed",
		result: {
			priority: "normal",
			reason: "action executed",
		},
	},

	// === HIGH — urgent events requiring Lead Chat notification ===
	{
		match: (et) => et === "session_stuck",
		result: {
			priority: "high",
			reason: "session stuck — notify Annie via Chat",
		},
	},
	{
		// FLY-1282: a running session's tmux window is provably dead (zombie).
		// High-priority LEAD action (check the unpushed-work list, decide
		// rescue). INV-10: ops-detection events route to the Lead queue only —
		// never a raw founder-thread post; founder escalation stays with the
		// Lead-first chain (FLY-1048/1279).
		match: (et) => et === "session_zombie_detected",
		result: {
			priority: "high",
			reason:
				"zombie session — tmux window dead while status=running; check unpushed work",
		},
	},
	// FLY-159: Runner gate timed out (fail-close path only — fail-open never
	// emits this event). Lead must inform Annie via Discord and offer
	// retry/cancel options.
	// FLY-163: Forum gating dropped — chat is the sole surface, so updateForum
	// is no longer modeled on FilterResult.
	{
		match: (et) => et === "gate_timed_out",
		result: {
			priority: "high",
			reason: "gate timed out — Lead notifies Annie via Chat",
		},
	},
	{
		match: (et) => et === "session_orphaned",
		result: {
			priority: "normal",
			reason: "session orphaned",
		},
	},
	{
		match: (et) => et === "session_stale_completed",
		result: {
			priority: "normal",
			reason: "stale completed session — tmux still alive",
		},
	},
	{
		// FLY-172: Bridge lost monitoring of a live Runner (restart). Advisory —
		// reliably delivered (guardrail) but not an Annie-facing emergency, so
		// priority normal (Codex review decision #4).
		match: (et) => et === "session_monitoring_lost",
		result: {
			// FLY-1282 R1 #1: neutral wording — this annotation must not assert
			// liveness (the event now also covers indeterminate/unverified cases).
			// Annotation-only revision: notifier always sets notification_context
			// explicitly, so this string never reaches the Lead as context.
			priority: "normal",
			reason:
				"monitoring lost — Runner liveness unverified; Lead should check via tmux",
		},
	},
	{
		// FLY-623: Bridge re-adopted a live Runner after a restart (readopt-ON happy
		// path). Founder-facing signal is the Display-A "⚠️重连中" title; this Lead
		// notice is a low-priority FYI ("runner alive, monitoring restored"), emitted
		// at most once per reconnecting episode and NOT a retryable guardrail.
		match: (et) => et === "session_monitoring_reestablished",
		result: {
			priority: "low",
			reason: "monitoring re-established via tmux — Runner alive",
		},
	},
	{
		match: (et) => et === "cipher_principle_proposed",
		result: {
			priority: "normal",
			reason: "cipher principle proposed",
		},
	},
];

const DEFAULT_RESULT: FilterResult = {
	priority: "normal",
	reason: "default — no matching rule",
};

export class EventFilter {
	classify(eventType: string, payload: Partial<HookPayload>): FilterResult {
		for (const rule of FILTER_RULES) {
			if (rule.match(eventType, payload)) {
				this.auditLog(eventType, payload, rule.result);
				return rule.result;
			}
		}
		this.auditLog(eventType, payload, DEFAULT_RESULT);
		return DEFAULT_RESULT;
	}

	private auditLog(
		eventType: string,
		payload: Partial<HookPayload>,
		result: FilterResult,
	): void {
		console.log(
			JSON.stringify({
				component: "EventFilter",
				event_type: eventType,
				issue_id: payload.issue_id ?? payload.issue_identifier ?? "",
				priority: result.priority,
				reason: result.reason,
				timestamp: new Date().toISOString(),
			}),
		);
	}
}

export type LeadNotificationEvidence =
	| {
			kind: "stage_recorded";
			proofRef: string;
			actionState: "none" | "pending" | "resolved";
			actionProofRef?: string;
			reviewOwnerRef?: string;
	  }
	| {
			kind: "monitoring_reestablished";
			proofRef: string;
			recoveryConfirmed: true;
			openAlert: boolean;
	  }
	| {
			kind: "session_registered";
			proofRef: string;
	  };

export interface LeadNotificationDecision {
	disposition: "model" | "audit_only";
	reason: string;
	policyVersion: "notification-v1";
	proofRef?: string;
}

const ROUTINE_STAGES = new Set([
	"onboard",
	"brainstorm",
	"research",
	"plan",
	"implement",
	"test",
]);
const OWNED_REVIEW_STAGES = new Set([
	"design_review",
	"code_review",
	"pr_created",
]);

function notificationDecision(
	disposition: LeadNotificationDecision["disposition"],
	reason: string,
	proofRef?: string,
): LeadNotificationDecision {
	return {
		disposition,
		reason,
		policyVersion: "notification-v1",
		...(proofRef ? { proofRef } : {}),
	};
}

function hasPayloadValue(
	payload: Record<string, unknown>,
	key: string,
): boolean {
	const value = payload[key];
	return (
		value !== undefined && value !== null && value !== false && value !== ""
	);
}

/** Source trust is typed evidence supplied by the validated producer. */
export function leadNotificationDecision(
	eventType: string,
	payload: Record<string, unknown>,
	evidence?: LeadNotificationEvidence,
): LeadNotificationDecision {
	if (!evidence) return notificationDecision("model", "proof_missing");
	if (
		payload.status !== undefined &&
		payload.status !== null &&
		payload.status !== "running" &&
		!(
			evidence.kind === "stage_recorded" &&
			OWNED_REVIEW_STAGES.has(String(payload.stage)) &&
			payload.status === "awaiting_review"
		)
	)
		return notificationDecision("model", "status_actionable");
	for (const key of [
		"last_error",
		"error",
		"failure_kind",
		"failureKind",
		"blocked",
		"needs_action",
		"requires_action",
		"action_required",
		"checkpoint",
		"review",
		"ship",
		"messages",
		"founder_message",
	]) {
		if (hasPayloadValue(payload, key))
			return notificationDecision("model", "actionable_payload");
	}

	if (
		eventType === "session_monitoring_reestablished" &&
		evidence.kind === "monitoring_reestablished"
	) {
		return evidence.openAlert
			? notificationDecision("model", "monitoring_alert_open")
			: notificationDecision(
					"audit_only",
					"monitoring_reestablished_confirmed",
					evidence.proofRef,
				);
	}
	if (
		eventType === "session_started" &&
		evidence.kind === "session_registered"
	) {
		return notificationDecision(
			"audit_only",
			"session_started_registered",
			evidence.proofRef,
		);
	}
	if (eventType !== "stage_changed" || evidence.kind !== "stage_recorded")
		return notificationDecision("model", "unsupported_event");

	const stage = typeof payload.stage === "string" ? payload.stage : "";
	const hasInheritedAction = hasPayloadValue(payload, "decision_route");
	if (evidence.actionState === "pending" || hasInheritedAction) {
		if (evidence.actionState !== "resolved" || !evidence.actionProofRef) {
			return notificationDecision("model", "action_pending");
		}
	}
	if (ROUTINE_STAGES.has(stage)) {
		return notificationDecision(
			"audit_only",
			evidence.actionState === "resolved"
				? "routine_stage_inherited_resolved"
				: "routine_stage",
			evidence.actionState === "resolved"
				? evidence.actionProofRef
				: evidence.proofRef,
		);
	}
	if (OWNED_REVIEW_STAGES.has(stage)) {
		if (!evidence.reviewOwnerRef)
			return notificationDecision("model", "review_owner_missing");
		return notificationDecision(
			"audit_only",
			"routine_stage_owned",
			evidence.proofRef,
		);
	}
	return notificationDecision("model", "stage_requires_action");
}

/** Compatibility projection for existing validated producer call sites. */
export function leadEventDeliveryDisposition(
	eventType: string,
	payload: Record<string, unknown>,
	trustedBridge = false,
): "model" | "audit_only" {
	if (!trustedBridge) return "model";
	const evidence: LeadNotificationEvidence =
		eventType === "session_monitoring_reestablished"
			? {
					kind: "monitoring_reestablished",
					proofRef: "legacy:trusted-bridge",
					recoveryConfirmed: true,
					openAlert: false,
				}
			: {
					kind: "stage_recorded",
					proofRef: "legacy:trusted-bridge",
					actionState: "none",
				};
	return leadNotificationDecision(eventType, payload, evidence).disposition;
}
