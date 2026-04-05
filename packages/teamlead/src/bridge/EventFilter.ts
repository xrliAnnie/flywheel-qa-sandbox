import type { HookPayload } from "./hook-payload.js";

export interface FilterResult {
	action: "notify_agent" | "forum_only" | "skip";
	priority: "high" | "normal" | "low";
	reason: string;
}

interface FilterRule {
	match: (eventType: string, payload: Partial<HookPayload>) => boolean;
	result: FilterResult;
}

const FILTER_RULES: FilterRule[] = [
	// === HIGH — needs CEO decision ===
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "needs_review" || p.status === "awaiting_review"),
		result: {
			action: "notify_agent",
			priority: "high",
			reason: "needs_review completion",
		},
	},
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "blocked" || p.status === "blocked"),
		result: {
			action: "notify_agent",
			priority: "high",
			reason: "blocked completion",
		},
	},
	{
		match: (et) => et === "session_failed",
		result: {
			action: "notify_agent",
			priority: "high",
			reason: "session failed",
		},
	},

	// === NORMAL — important updates ===
	{
		match: (et) => et === "session_stuck",
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "session stuck",
		},
	},
	{
		match: (et) => et === "session_orphaned",
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "session orphaned",
		},
	},
	// GEO-270: Stale session patrol
	{
		match: (et) => et === "session_stale_completed",
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "stale completed session — tmux still alive",
		},
	},
	{
		match: (et) => et === "action_executed",
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "action executed",
		},
	},
	{
		match: (et) => et === "cipher_principle_proposed",
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "cipher principle proposed",
		},
	},

	// === LOW — silent Forum updates ===
	// session_started with NO thread_id — notify agent + Bridge creates Forum Post (GEO-195)
	{
		match: (et, p) => et === "session_started" && !p.thread_id,
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "session started — no thread, Bridge creates Forum Post",
		},
	},
	{
		match: (et, p) => et === "session_started" && !!p.thread_id,
		result: {
			action: "forum_only",
			priority: "low",
			reason: "session started — thread exists, Forum tag update only",
		},
	},
	// FLY-58/FLY-61: approved completion → notify Lead so it tells Annie "已 ship"
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "approved" || p.status === "approved"),
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "approved completion — notify Lead",
		},
	},
];

const DEFAULT_RESULT: FilterResult = {
	action: "notify_agent",
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
				result: result.action,
				priority: result.priority,
				reason: result.reason,
				timestamp: new Date().toISOString(),
			}),
		);
	}
}
