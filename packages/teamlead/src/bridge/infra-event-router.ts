/**
 * FLY-927 (W1): infra-event Router — responder-based durable alert routing.
 *
 * D1 (brainstorm gate, Tadashi 2026-07-07): classify by RESPONDER —
 *  - "ticket":       ordinary alerts → durable Claw mailbox (even when the
 *                    event is bound to an issue — the responder is the infra
 *                    bot, not the issue's Lead/founder).
 *  - "issue_thread": issue-PROGRESS kinds (a session stuck / a founder
 *                    notification undelivered) → the issue's own [FLY-XX]
 *                    Discord thread, where the responsible party has context.
 *                    ONLY when a thread is actually bound; otherwise fail-safe
 *                    to "ticket" (never silently drop).
 *  - "lead_inbox":   review-job failures → the owning Lead's durable mailbox;
 *                    the founder thread is never part of this route.
 *
 * The classification is a PURE function; the routed sink wrapper
 * (`createInfraAlertSink`) is what plugin.ts installs in front of the raw
 * notifier/Hub. FLY-1831 welded this shipped routing path on.
 */

import type {
	AlertEventType,
	AlertPayload,
	AlertResult,
} from "../LeadAlertNotifier.js";
import { isDiscordSnowflake } from "./founder-notify-utils.js";

export type AlertRouteClass = "ticket" | "issue_thread" | "lead_inbox";

/**
 * Infra process-health kinds — a bot can act on these, so they queue as durable
 * Claw mailbox tickets, EVEN when bound to an issue (D1: responder-based).
 */
export const TICKET_KINDS: ReadonlySet<AlertEventType> =
	new Set<AlertEventType>([
		"rate_limit",
		"usage_limit",
		"login_expired",
		"permission_blocked",
		"crash_loop",
		"pane_hash_stuck",
		// FLY-1048 (A4): same responder family as pane_hash_stuck — an infra bot
		// can act on a frozen-after-error Lead pane. Owner map: provider-agnostic
		// default (claude bot).
		"pane_error_stalled",
		// Legacy display-only kinds retained for persisted alert rows.
		"detection_fleet_aggregate",
		"detection_page_undeliverable",
		"runner_stuck_unhandled",
		"runner_login_expired",
		"runner_throttle_stalled",
		"ship_attempt_failed",
		"runner_pane_loss",
		"tui_window_lost",
		"restart_guard_bypass",
		"restart_storm_hold",
		"bridge_boot_stale_checkout",
		"auto_qa_stuck",
		"codex_gate_blocked",
		"bridge_wrapper_fail",
		// FLY-1182 actionable quota-monitor tickets. Informational quota notices
		// bypass lifecycle in AlertChannelHub/isInformationalKind.
		"machine_account_conflict",
		"model_cap_persistent_unknown",
		"model_bench_malformed",
		"quota_choice",
		"quota_no_target",
		"quota_read_blind",
		"account_switch_failed",
		"quota_revive_stuck",
		"quota_monitor_down",
		// FLY-1082: fleet-failure kinds — the responder is an infra bot (owner
		// per bridge/kind-contract.ts), so they queue as tickets like the rest
		// of the process-health family.
		"swap_pressure_high",
		"tmux_server_lost",
		"tmux_hold",
		"tmux_split_brain",
		"bridge_abnormal_exit",
		"infra_bot_down",
		"zombie_session_backlog",
		"cmux_cleanup",
		"cmux_watcher_stalled",
		"tmux_rescue_hold",
	]);

/**
 * Issue-progress kinds — the responder is in the issue's human lane, so they
 * belong in the issue's own thread WHEN one is bound. Unbound → fail-safe
 * ticket (this is exactly the case the PRD CH-1 whitelist rows cover).
 */
export const ISSUE_PROGRESS_KINDS: ReadonlySet<AlertEventType> =
	new Set<AlertEventType>([
		"three_stage_stuck",
		"three_stage_takeover_failed",
		"workflow_engine_issue_alert",
		"founder_gate_delivery_failed",
		"runner_lead_pending_unhandled",
	]);

/** Review failures are actionable by the issue's owning Lead, never founder. */
export const LEAD_INBOX_KINDS: ReadonlySet<AlertEventType> =
	new Set<AlertEventType>(["review_job_failed"]);

/** The issue thread an event resolved to (sessions → issue → chat_threads). */
export interface BoundIssueThread {
	threadId: string;
	channelId: string;
	issueId: string;
	issueIdentifier?: string;
	executionId: string;
}

export interface RouteInput {
	eventType: AlertEventType;
	/** Resolved by the caller (null = no bound thread / resolution failed). */
	boundIssueThread: BoundIssueThread | null;
}

export function classifyInfraEvent(input: RouteInput): AlertRouteClass {
	if (TICKET_KINDS.has(input.eventType)) return "ticket";
	if (LEAD_INBOX_KINDS.has(input.eventType)) return "lead_inbox";
	if (ISSUE_PROGRESS_KINDS.has(input.eventType) && input.boundIssueThread) {
		return "issue_thread";
	}
	// Fail-safe: an unbound progress kind — and any future kind added to the
	// union without a routing decision — degrades to the durable mailbox rather
	// than being dropped.
	return "ticket";
}

/** The minimal sink face shared by LeadAlertNotifier / AlertChannelHub. */
export interface AlertSinkLike {
	alert(payload: AlertPayload): Promise<AlertResult>;
}

export interface InfraAlertSinkDeps {
	/** The unified-channel Hub, reserved for explicit founder escalations. */
	rawSink: AlertSinkLike;
	/** FLY-1764 Flow 2 primary: one durable alert letter to Claw. */
	ticketSink: AlertSinkLike;
	/** One durable alert letter to the issue's owning Lead. */
	leadInboxSink: AlertSinkLike;
	/** Canonical founder id added to explicit founder-escalation payloads. */
	founderUserId?: string;
	/** Test seam; production routing is welded on by default. */
	routingEnabled?: () => boolean;
	/**
	 * sessions → issue → chat_threads resolution, injected by plugin.ts. Only
	 * consulted for ISSUE_PROGRESS_KINDS (ticket kinds never pay the lookup).
	 */
	resolveBoundIssueThread: (payload: AlertPayload) => BoundIssueThread | null;
	/** The issue-thread delivery leg (founder-thread-notifier). Never expected
	 * to throw — it classifies + escalates internally; a throw here is a bug
	 * and fail-safes back to the Claw mailbox. */
	deliverToIssueThread: (
		payload: AlertPayload,
		thread: BoundIssueThread,
	) => Promise<AlertResult>;
	logger?: (msg: string) => void;
}

/**
 * Wrap the raw alert sink with D1 routing. Every delivery failure inside
 * routing falls back to the Claw mailbox — an alert is NEVER lost to a bug.
 */
export function createInfraAlertSink(deps: InfraAlertSinkDeps): AlertSinkLike {
	const routingEnabled = deps.routingEnabled ?? (() => true);
	const logger =
		deps.logger ?? ((m) => console.log(`[infra-alert-router] ${m}`));
	return {
		async alert(payload: AlertPayload): Promise<AlertResult> {
			if (!routingEnabled()) return deps.rawSink.alert(payload);
			if (LEAD_INBOX_KINDS.has(payload.eventType)) {
				try {
					return await deps.leadInboxSink.alert(payload);
				} catch (err) {
					logger(
						`owning-Lead inbox delivery threw for ${payload.eventType}/${payload.eventId}: ${(err as Error).message} — fail-safe to Claw mailbox`,
					);
					return deps.ticketSink.alert(payload);
				}
			}
			const explicitMention = isDiscordSnowflake(payload.mentionUserId)
				? payload.mentionUserId
				: undefined;
			if (
				payload.eventType === "workflow_engine_escalation" ||
				payload.eventType === "cmux_watcher_unrecovered"
			) {
				const mentionUserId =
					explicitMention ??
					(isDiscordSnowflake(deps.founderUserId)
						? deps.founderUserId
						: undefined);
				if (mentionUserId) {
					return deps.rawSink.alert({ ...payload, mentionUserId });
				}
				logger(
					`founder escalation ${payload.eventId} has no valid founder id — fail-safe to Claw mailbox`,
				);
				return deps.ticketSink.alert(payload);
			}
			if (explicitMention) return deps.rawSink.alert(payload);
			// Ordinary alert kinds short-circuit to Claw's mailbox.
			if (!ISSUE_PROGRESS_KINDS.has(payload.eventType)) {
				return deps.ticketSink.alert(payload);
			}
			let thread: BoundIssueThread | null = null;
			try {
				thread = deps.resolveBoundIssueThread(payload);
			} catch (err) {
				logger(
					`thread resolution failed for ${payload.eventType}/${payload.eventId}: ${(err as Error).message} — fail-safe to Claw mailbox`,
				);
			}
			const route = classifyInfraEvent({
				eventType: payload.eventType,
				boundIssueThread: thread,
			});
			if (route === "issue_thread" && thread) {
				try {
					return await deps.deliverToIssueThread(payload, thread);
				} catch (err) {
					logger(
						`issue-thread delivery threw for ${payload.eventType}/${payload.eventId}: ${(err as Error).message} — fail-safe to Claw mailbox`,
					);
					return deps.ticketSink.alert(payload);
				}
			}
			return deps.ticketSink.alert(payload);
		},
	};
}
