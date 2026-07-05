/**
 * FLY-725: pure decision policy for the founder milestone-report patrol.
 *
 * Mirrors the FLY-637 `lead-pending-escalation.ts` split: this module is PURE
 * (no I/O, injected clock) and decides notify-vs-skip for ONE terminal session;
 * the GatePoller owns the durable markers, baseline seeding, Discord POST, and
 * retry budget. Keeping the decision pure makes the grace / milestone-set /
 * dedup / session-role rules unit-testable without a StateStore or Discord.
 */

import type { MilestoneKind } from "flywheel-config";

/** The minimal slice of a Session the policy reasons about. */
export interface MilestonePolicySession {
	/** FSM status — only completed/failed/blocked map to a milestone. */
	status: string;
	/** FLY-59 session role; only `main` (or legacy null) is founder-facing. */
	session_role?: string;
	/**
	 * Terminal timestamp (parsed `last_activity_at`) in ms, or null if unparseable.
	 * The caller parses the SQL string (keeps this module I/O-free).
	 */
	lastActivityMs: number | null;
}

export type MilestonePolicyAction =
	| { kind: "notify"; milestone: MilestoneKind }
	| { kind: "skip"; reason: string };

/** Terminal FSM status → milestone kind. Non-terminal statuses map to nothing. */
const STATUS_TO_MILESTONE: Record<string, MilestoneKind> = {
	completed: "completed",
	failed: "failed",
	blocked: "blocked",
};

/** Founder-facing label + emoji per milestone (used by the report body builder). */
const MILESTONE_LABEL: Record<MilestoneKind, { emoji: string; zh: string }> = {
	completed: { emoji: "✅", zh: "完成" },
	failed: { emoji: "🔴", zh: "失败" },
	blocked: { emoji: "⛔", zh: "受阻" },
	// Reserved for the follow-up (v1 never emits ship_ready).
	ship_ready: { emoji: "🚀", zh: "可 ship" },
};

export function milestoneLabel(milestone: MilestoneKind): {
	emoji: string;
	zh: string;
} {
	return MILESTONE_LABEL[milestone];
}

/**
 * Decide whether this terminal session should get a founder milestone ping now.
 *
 * @param session     status + role + parsed terminal timestamp
 * @param enabled     the project's configured milestone set (already resolved)
 * @param hasMarker   a durable/in-process dedup marker already exists for this (session, milestone)
 * @param nowMs       injected clock
 * @param graceMs     min age since the terminal transition before pinging (settle buffer)
 */
export function decideMilestoneReport(
	session: MilestonePolicySession,
	enabled: readonly MilestoneKind[],
	hasMarker: boolean,
	nowMs: number,
	graceMs: number,
): MilestonePolicyAction {
	// QA runners (and any non-main role) are not founder-facing milestones.
	if (session.session_role != null && session.session_role !== "main") {
		return { kind: "skip", reason: "not_main_session" };
	}
	const milestone = STATUS_TO_MILESTONE[session.status];
	if (!milestone) {
		return { kind: "skip", reason: "non_terminal_status" };
	}
	if (!enabled.includes(milestone)) {
		return { kind: "skip", reason: "milestone_not_enabled" };
	}
	if (hasMarker) {
		return { kind: "skip", reason: "already_notified" };
	}
	if (session.lastActivityMs === null) {
		return { kind: "skip", reason: "no_timestamp" };
	}
	if (nowMs - session.lastActivityMs < graceMs) {
		return { kind: "skip", reason: "within_grace" };
	}
	return { kind: "notify", milestone };
}
