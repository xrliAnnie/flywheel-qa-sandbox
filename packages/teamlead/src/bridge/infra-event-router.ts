/**
 * FLY-927 (W1): infra-event Router — the three-way split that turns the alert
 * channel into a bot ticket queue.
 *
 * D1 (brainstorm gate, Tadashi 2026-07-07): classify by RESPONDER —
 *  - "ticket":       infra process-health kinds a bot can act on → the unified
 *                    alert channel's ticket queue (even when the event is bound
 *                    to an issue — the responder is the infra bot, not the
 *                    issue's Lead/founder).
 *  - "issue_thread": issue-PROGRESS kinds (a session stuck / a founder
 *                    notification undelivered) → the issue's own [FLY-XX]
 *                    Discord thread, where the responsible party has context.
 *                    ONLY when a thread is actually bound; otherwise fail-safe
 *                    to "ticket" (never silently drop).
 *  - "notify":       root-only informational notices; these bypass ticket and
 *                    issue-thread lifecycle.
 *
 * The classification is a PURE function; the routed sink wrapper
 * (`createInfraAlertSink`) is what plugin.ts installs in front of the raw
 * notifier/Hub. Everything is gated on FLYWHEEL_ALERT_ROUTING=1 — unset means
 * a pure passthrough (byte-compat, resolver never even consulted).
 */

import {
	type AlertEventType,
	type AlertPayload,
	type AlertResult,
	isInformationalKind,
} from "../LeadAlertNotifier.js";

export type AlertRouteClass = "ticket" | "issue_thread" | "notify";

/**
 * Infra process-health kinds — a bot can act on these, so they queue as
 * tickets @ the owner bot, EVEN when bound to an issue (D1: responder-based).
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
		"tmux_rescue_hold",
	]);

/**
 * Issue-progress kinds — the responder is the issue's Lead/founder, so they
 * belong in the issue's own thread WHEN one is bound. Unbound → fail-safe
 * ticket (this is exactly the case the PRD CH-1 whitelist rows cover).
 */
export const ISSUE_PROGRESS_KINDS: ReadonlySet<AlertEventType> =
	new Set<AlertEventType>([
		"three_stage_stuck",
		"three_stage_takeover_failed",
		"workflow_engine_issue_alert",
		"founder_milestone_undelivered",
		"runner_lead_pending_unhandled",
	]);

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
	if (isInformationalKind(input.eventType)) return "notify";
	if (TICKET_KINDS.has(input.eventType)) return "ticket";
	if (ISSUE_PROGRESS_KINDS.has(input.eventType) && input.boundIssueThread) {
		return "issue_thread";
	}
	// Fail-safe: an unbound progress kind — and any future kind added to the
	// union without a routing decision — degrades to the ticket queue rather
	// than being dropped.
	return "ticket";
}

/** The minimal sink face shared by LeadAlertNotifier / AlertChannelHub. */
export interface AlertSinkLike {
	alert(payload: AlertPayload): Promise<AlertResult>;
}

export interface InfraAlertSinkDeps {
	/** Today's behavior: the raw notifier, or the Hub in unified+threading mode. */
	rawSink: AlertSinkLike;
	/** FLY-1764 Flow 2 primary: one owner mailbox row. Defaults to raw for compatibility. */
	ticketSink?: AlertSinkLike;
	/** Optional observation copy. Default-off; the primary mailbox result wins. */
	copyTicketToChannel?: () => boolean;
	/** Read at CALL time (env may change). Default: FLYWHEEL_ALERT_ROUTING === "1". */
	routingEnabled?: () => boolean;
	/**
	 * sessions → issue → chat_threads resolution, injected by plugin.ts. Only
	 * consulted for ISSUE_PROGRESS_KINDS (ticket kinds never pay the lookup).
	 */
	resolveBoundIssueThread: (payload: AlertPayload) => BoundIssueThread | null;
	/** The issue-thread delivery leg (founder-thread-notifier). Never expected
	 * to throw — it classifies + escalates internally; a throw here is a bug
	 * and fail-safes back to the raw sink. */
	deliverToIssueThread: (
		payload: AlertPayload,
		thread: BoundIssueThread,
	) => Promise<AlertResult>;
	logger?: (msg: string) => void;
}

/**
 * Wrap the raw alert sink with D1 routing. Unset env → pure passthrough
 * (byte-compat). Every failure path inside routing falls back to the raw sink
 * — an alert is NEVER lost to a routing bug.
 */
export function createInfraAlertSink(deps: InfraAlertSinkDeps): AlertSinkLike {
	const routingEnabled =
		deps.routingEnabled ?? (() => process.env.FLYWHEEL_ALERT_ROUTING === "1");
	const logger =
		deps.logger ?? ((m) => console.log(`[infra-alert-router] ${m}`));
	const ticketSink = deps.ticketSink ?? deps.rawSink;
	const copyTicketToChannel = deps.copyTicketToChannel ?? (() => false);
	const deliverTicket = async (payload: AlertPayload): Promise<AlertResult> => {
		const primary = await ticketSink.alert(payload);
		if (copyTicketToChannel() && ticketSink !== deps.rawSink) {
			try {
				await deps.rawSink.alert(payload);
			} catch (err) {
				logger(
					`optional channel copy failed for ${payload.eventType}/${payload.eventId}: ${(err as Error).message}`,
				);
			}
		}
		return primary;
	};
	return {
		async alert(payload: AlertPayload): Promise<AlertResult> {
			if (!routingEnabled()) return deps.rawSink.alert(payload);
			// Ticket/notify kinds short-circuit without a thread lookup.
			if (!ISSUE_PROGRESS_KINDS.has(payload.eventType)) {
				const route = classifyInfraEvent({
					eventType: payload.eventType,
					boundIssueThread: null,
				});
				return route === "ticket"
					? deliverTicket(payload)
					: deps.rawSink.alert(payload);
			}
			let thread: BoundIssueThread | null = null;
			try {
				thread = deps.resolveBoundIssueThread(payload);
			} catch (err) {
				logger(
					`thread resolution failed for ${payload.eventType}/${payload.eventId}: ${(err as Error).message} — fail-safe to ticket queue`,
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
						`issue-thread delivery threw for ${payload.eventType}/${payload.eventId}: ${(err as Error).message} — fail-safe to ticket queue`,
					);
					return deliverTicket(payload);
				}
			}
			return deliverTicket(payload);
		},
	};
}
