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
			priority: "normal",
			reason: "monitoring lost — Runner alive, Lead should watch via tmux",
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
