/**
 * FLY-523: founder-gate-pending auto-notify.
 *
 * When a run is implemented + code-review-passed and sitting in `awaiting_review`
 * waiting for the founder to approve the ship, this notifier tells the founder
 * DIRECTLY — via `LeadAlertNotifier` (the FLY-368 unified "founder action needed"
 * channel + optional DM) — instead of relying on the Lead to remember to relay
 * the pending question (the FLY-163 gap that left finished work silently waiting).
 *
 * It owns NO state of its own: dedup + delivery reliability (claims.db +
 * lead_events UNIQUE + queue / dead-letter / drain) live in `LeadAlertNotifier`.
 * The dedup key is the per-review-window `awaiting_review_entered_at`, so the
 * alert fires once per review window and a re-review (which re-stamps the entry)
 * naturally re-notifies.
 *
 * Driven by `HeartbeatService.checkFounderGatePending()` on the existing
 * heartbeat timer (no new periodic load).
 */

import type { FounderGateNotifier } from "./HeartbeatService.js";
import type {
	AlertPayload,
	AlertResult,
	AlertSeverity,
} from "./LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "./ProjectConfig.js";
import type { Session, StateStore } from "./StateStore.js";

/** Minimal alert dependency — satisfied by `LeadAlertNotifier`. */
export interface AlertSink {
	alert(payload: AlertPayload): Promise<AlertResult>;
}

export interface FounderGatePendingNotifierConfig {
	projects: ProjectEntry[];
	store: Pick<StateStore, "getSessionLabels">;
	alertNotifier: AlertSink;
	/**
	 * Severity controls how the alert renders / whether it DMs the founder.
	 * Default `"warning"` → prominent in the unified channel, no DM-spam (only
	 * `"severe"` DMs `alertDmUserId`). Configurable so ops can dial it up.
	 */
	severity?: AlertSeverity;
	logger?: (msg: string) => void;
}

export class FounderGatePendingNotifier implements FounderGateNotifier {
	private readonly projects: ProjectEntry[];
	private readonly store: Pick<StateStore, "getSessionLabels">;
	private readonly alertNotifier: AlertSink;
	private readonly severity: AlertSeverity;
	private readonly logger: (msg: string) => void;

	constructor(config: FounderGatePendingNotifierConfig) {
		this.projects = config.projects;
		this.store = config.store;
		this.alertNotifier = config.alertNotifier;
		this.severity = config.severity ?? "warning";
		this.logger =
			config.logger ?? ((m) => console.warn(`[founder-gate-notify] ${m}`));
	}

	async notifyGatePending(session: Session): Promise<void> {
		// Resolve the project's Lead so the alert is attributed correctly (the
		// unified send-chain posts via that agent's own bot). Resolution can throw
		// for an unknown project / lead-less project — skip quietly rather than
		// crash the heartbeat loop.
		let leadId: string;
		try {
			const labels = this.store.getSessionLabels(session.execution_id);
			const { lead } = resolveLeadForIssue(
				this.projects,
				session.project_name,
				labels,
			);
			leadId = lead.agentId;
		} catch (err) {
			this.logger(
				`cannot resolve lead for project="${session.project_name}" exec=${session.execution_id}: ${(err as Error).message} — skipping`,
			);
			return;
		}

		const label = session.issue_identifier ?? session.issue_id;
		const heading = session.issue_title
			? `${label} — ${session.issue_title}`
			: label;
		// Per-review-window dedup key. The notifier holds no state — LeadAlertNotifier
		// dedups on this eventId — so it MUST be (a) stable across heartbeat ticks
		// within one review window (notify once) and (b) distinct for a re-review (a
		// fresh window → re-notify). The awaiting_review entry timestamp alone is only
		// second-precision (SQLite datetime('now')); a feedback → re-request cycle
		// inside the SAME second would collide and silently suppress the re-notify
		// (Codex R1 MEDIUM). The bound review_question_id is a fresh uuid per
		// needs_review completion (setReviewBinding), so it disambiguates same-second
		// re-reviews. Combine both: unique whenever EITHER changes, stable while both
		// hold. (Escalation paths to awaiting_review may have no bound question →
		// "noqid"; they still get the timestamp anchor.)
		const anchor = session.awaiting_review_entered_at ?? "noanchor";
		const reviewId = session.review_question_id ?? "noqid";

		const payload: AlertPayload = {
			leadId,
			projectName: session.project_name,
			eventId: `founder-gate-pending:${session.execution_id}:${anchor}:${reviewId}`,
			eventType: "founder_action_needed",
			title: "Ready to ship — needs your approval",
			body: `${heading} is implemented and code-reviewed, and is now waiting for your ship approval (awaiting_review). Approve / request changes when you're ready.`,
			severity: this.severity,
			sessionKey: session.execution_id,
		};

		try {
			await this.alertNotifier.alert(payload);
		} catch (err) {
			// LeadAlertNotifier is contractually no-throw, but never let a surprise
			// failure escape into the heartbeat loop.
			this.logger(
				`alert() threw for exec=${session.execution_id}: ${(err as Error).message}`,
			);
		}
	}
}
