import type { HookPayload } from "./hook-payload.js";

/**
 * FLY-47: EventFilter classifies events for two purposes:
 * 1. Priority hints for Lead (high = MUST Chat, normal = optional FYI)
 * 2. Forum gating — decides which events trigger Forum tag updates
 *
 * ALL events are delivered to Lead unconditionally. EventFilter does NOT
 * control delivery — it only annotates and gates Forum updates.
 */

export interface FilterResult {
	priority: "high" | "normal" | "low";
	reason: string;
	/** Whether this event should trigger a Forum tag update */
	updateForum: boolean;
}

interface FilterRule {
	match: (eventType: string, payload: Partial<HookPayload>) => boolean;
	result: FilterResult;
}

const FILTER_RULES: FilterRule[] = [
	// === HIGH + Forum — status-changing events Lead MUST notify Annie about ===
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "needs_review" || p.status === "awaiting_review"),
		result: {
			priority: "high",
			reason: "PR ready for review — Lead notifies Annie in Chat",
			updateForum: true,
		},
	},
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "blocked" || p.status === "blocked"),
		result: {
			priority: "high",
			reason: "blocked — Lead escalates to Annie in Chat",
			updateForum: true,
		},
	},
	{
		match: (et) => et === "session_failed",
		result: {
			priority: "high",
			reason: "session failed — Lead escalates to Annie in Chat",
			updateForum: true,
		},
	},
	{
		match: (et, p) => et === "session_started" && !p.thread_id,
		result: {
			priority: "high",
			reason:
				"session started — Lead announces to Annie in Chat + Bridge creates Forum Post",
			updateForum: true,
		},
	},
	{
		match: (et, p) => et === "session_started" && !!p.thread_id,
		result: {
			priority: "high",
			reason:
				"session started (retry/reopen) — Lead announces to Annie in Chat with Forum link",
			updateForum: true,
		},
	},
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "approved" || p.status === "approved"),
		result: {
			priority: "high",
			reason: "ship complete — Lead notifies Annie in Chat",
			updateForum: true,
		},
	},
	// Catch-all for session_completed with unrecognized status — still update Forum
	{
		match: (et) => et === "session_completed",
		result: {
			priority: "normal",
			reason: "session completed — Forum update for status tracking",
			updateForum: true,
		},
	},

	// === NORMAL + Forum — status changes that update Forum but don't require Chat ===
	{
		match: (et) => et === "action_executed",
		result: {
			priority: "normal",
			reason: "action executed",
			updateForum: true,
		},
	},

	// === HIGH + NO Forum — urgent events requiring Lead Chat notification ===
	{
		match: (et) => et === "session_stuck",
		result: {
			priority: "high",
			reason: "session stuck — notify Annie via Chat",
			updateForum: false,
		},
	},
	{
		match: (et) => et === "session_orphaned",
		result: {
			priority: "normal",
			reason: "session orphaned",
			updateForum: false,
		},
	},
	{
		match: (et) => et === "session_stale_completed",
		result: {
			priority: "normal",
			reason: "stale completed session — tmux still alive",
			updateForum: false,
		},
	},
	{
		match: (et) => et === "cipher_principle_proposed",
		result: {
			priority: "normal",
			reason: "cipher principle proposed",
			updateForum: false,
		},
	},
];

const DEFAULT_RESULT: FilterResult = {
	priority: "normal",
	reason: "default — no matching rule",
	updateForum: false,
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
				updateForum: result.updateForum,
				timestamp: new Date().toISOString(),
			}),
		);
	}
}
