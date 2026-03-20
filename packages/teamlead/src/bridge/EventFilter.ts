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
	// session_started with NO thread_id must notify agent (agent creates Forum Post)
	{
		match: (et, p) => et === "session_started" && !p.thread_id,
		result: {
			action: "notify_agent",
			priority: "normal",
			reason: "session started — no thread, agent must create Forum Post",
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
	{
		match: (et, p) =>
			et === "session_completed" &&
			(p.decision_route === "approved" || p.status === "approved"),
		result: {
			action: "forum_only",
			priority: "low",
			reason: "approved completion — Forum tag update only",
		},
	},
];

const DEFAULT_RESULT: FilterResult = {
	action: "notify_agent",
	priority: "normal",
	reason: "default — no matching rule",
};

export class EventFilter {
	classify(
		eventType: string,
		payload: Partial<HookPayload>,
	): FilterResult {
		for (const rule of FILTER_RULES) {
			if (rule.match(eventType, payload)) {
				return rule.result;
			}
		}
		return DEFAULT_RESULT;
	}
}
