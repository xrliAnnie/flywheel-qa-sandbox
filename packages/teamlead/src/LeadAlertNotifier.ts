/**
 * FLY-83: Bridge-side alert emitter for Lead lifecycle incidents.
 *
 * Two invariants:
 * - Cross-process atomic claim (Fix 2): we run the SAME
 *   `BEGIN IMMEDIATE + INSERT OR IGNORE + SELECT changes()` transaction
 *   that `scripts/lead-alert.sh` runs against `~/.flywheel/alerts/claims.db`.
 *   First writer wins, regardless of which path (Bridge or shell) fired
 *   first. The earlier `claimsReader` Set is kept as a fast-path skip
 *   (avoids building a payload when shell has already posted), but the
 *   load-bearing dedup is the atomic claimer, not the reader.
 *   Same-process dedup: StateStore.tryClaimLeadEvent against lead_events.
 * - Never throw from alert(): Discord is unreliable; failures get queued to
 *   $HOME/.flywheel/alert-queue/ for a later drainQueue() pass.
 *
 * Not responsible for deciding *when* to alert — each producer drives that.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	LEAD_LEASE_EPISODE_KINDS,
	type LeadLeaseEpisodeDeliveryState,
	type LeadLeaseEpisodeKind,
	LeadLeaseEpisodeStore,
} from "flywheel-comm/lead-lease";
import {
	buildRepairChain,
	buildSendChain,
	resolveFirstAvailableBotToken,
} from "./bridge/alert-bot-chain.js";
import {
	type AlertRateLimiter,
	formatOverflowSummary,
} from "./bridge/alert-rate-limiter.js";
import { markAutomatedDiscordText } from "./bridge/automated-message.js";
import type { ReplayFreshnessInput } from "./bridge/fleet-sensors.js";
import type { MetaAlertReason } from "./MetaAlertNotifier.js";
import type { LeadConfig, ProjectEntry } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

/**
 * FLY-182 Track B: minimal sink so LeadAlertNotifier can fire a Discord-
 * independent meta-alert when its own delivery path fails (config gap,
 * permanent failure, drain stuck). Satisfied by `MetaAlertNotifier`.
 */
export interface MetaAlertSink {
	notify(input: {
		reason: MetaAlertReason;
		title: string;
		body: string;
	}): Promise<unknown>;
}

/**
 * FLY-927: the SINGLE source of truth for the alert-kind face. `AlertEventType`
 * is derived from this array, and the pane echo-immunity regex
 * (`ALERT_ECHO_START`) derives its kind alternation from it too — so a new kind
 * can never silently miss echo stripping (the FLY-220 storm family).
 */
export const ALERT_EVENT_TYPES = [
	"rate_limit",
	"usage_limit",
	"login_expired",
	"permission_blocked",
	"crash_loop",
	"pane_hash_stuck",
	// Legacy display compatibility for historical Lead pane-error alert rows.
	"pane_error_stalled",
	// FLY-195 (plan §3.6 Q7): a stuck-runner episode the owning Lead did not
	// dispose of within the grace window — Bridge pages Annie directly.
	// eventId format (FLY-253: escalatedAt = generation salt so a post-re-arm
	// / post-TTL second fallback is not swallowed by the persistent dedup):
	// `runner-stuck-unhandled:${execution_id}:${fingerprint}:${escalatedAt}`.
	"runner_stuck_unhandled",
	// FLY-579: the auto-QA pipeline could not proceed (spawn failed, QA ended
	// without a verdict, or a fail-closed pr_head_sha). A Lead-only alert — the
	// founder is intentionally never surfaced for a non-green QA. NOT a
	// founder-facing notification (those go to the issue thread).
	"auto_qa_stuck",
	// FLY-1573: mailbox messages exhausted their agent-ack lease. This alert is
	// deliberately delivered outside the mailbox to break recursive dead-lettering.
	"mailbox_dead_letter",
	// FLY-827: a session reached awaiting_review but Codex code review is NOT
	// APPROVED for the current PR head → the hard gate blocked auto-QA + merge and
	// held the founder. A Lead-only alert (founder never surfaced pre-Codex).
	// eventId `codex-gate:${execution_id}:${sha}` (no timestamp → fires ONCE per head).
	"codex_gate_blocked",
	// FLY-1278: review convergence/audit channel. Advisories pass the hard gate;
	// rulings are supervised Lead authority; disputes and notification failures
	// require human visibility but have no safe automatic remediation.
	"review_advisory_pass",
	"review_ruling_recorded",
	"review_ruling_disputed",
	"review_ruling_notify_failed",
	// FLY-793: a DAG workflow handoff (Design→Implement→QA) could
	// not proceed — head-SHA capture failed, the previous phase runner would not
	// close, or the next phase dispatch threw. Fail-closed: the next phase is NOT
	// started and this Lead-only alert fires so a completed phase is never
	// silently stranded. Not a founder-facing notification.
	"three_stage_stuck",
	// FLY-1279: shared branch-B takeover was refused (dirty/head drift). Separate
	// from generic handoff failures so the Lead sees the exact recovery class.
	"three_stage_takeover_failed",
	// FLY-1385: the workflow engine exhausted dead-execution recovery, found a
	// non-retryable quota/auth failure, or used the one approved design fallback.
	// The run/node has already been durably held or reassigned; this alert gives
	// the Lead/founder the explicit operational receipt and recovery lever.
	"workflow_engine_escalation",
	// FLY-1385 founder A-strengthening: the issue-thread half of the dual
	// misclassification/repeated-death alert. The escalation half keeps using
	// workflow_engine_escalation so the Lead chain also receives it.
	"workflow_engine_issue_alert",
	// FLY-637-ext: the owning Lead did not answer a runner's BLOCKING question
	// gate after the configured number of backoff nudges → page Annie ONCE
	// (final fallback). DISTINCT from runner_stuck_unhandled: the runner is fine,
	// the Lead is unresponsive — so this is deliberately NOT in
	// AUTO_ATTEMPT_EVENT_TYPES and carries no runnerStuck metadata, so the
	// AutoRepairBot never sends the runner a `continue` nudge (Codex design R1 #3).
	"runner_lead_pending_unhandled",
	// FLY-725 (Annie 2026-07-01: "never silently drop"): the Bridge could not
	// deliver a failed/blocked milestone @founder ping to its issue thread
	// (permanent 4xx / missing thread|token|owner / transient retry budget
	// elapsed). Surfaced so the founder is not left in the dark. Not a runner-
	// stuck event — the runner is fine; the notification channel failed.
	"founder_milestone_undelivered",
	// FLY-871 R2/C8: a runner sitting at a login prompt (auth/session expired) —
	// DISTINCT from the lead `login_expired` so AlertChannelHub.reconcile resolves
	// it by the RUNNER pane, and the R3 rescue keys on this event's still-pending row.
	"runner_login_expired",
	// FLY-871 §12 W2: a windowed (cmux TUI) Codex Lead's founder-facing pane could
	// not be (re)created after K consecutive liveness checks — "silent no-pane". NOT
	// emitted by the TS notifier: it is fired ONLY by the runtime's
	// guard via scripts/lead-alert.sh (Discord-independent). Present in the union so
	// the shared kind face (lead-alert.sh allowlist ↔ TS) has no drift.
	"tui_window_lost",
	// FLY-913: the flywheel-restart-guard PreToolUse hook's mandatory bypass
	// alert — fired ONLY via scripts/lead-alert.sh --strict-delivery (Discord-
	// independent path; the hook fail-closes unless the strict result is
	// sent/queued_transient). NOT emitted by the TS notifier;
	// present in the union so a queued bypass alert drains with a known
	// eventType and the shared kind face (lead-alert.sh ↔ TS) has no drift.
	"restart_guard_bypass",
	// FLY-1501: an OS-supervised service hit the durable 10-minute restart
	// ceiling and its wrapper stopped exec'ing it. Emitted by the
	// kernel-independent Python gate through lead-alert.sh; kept in the shared
	// face so queued delivery and ticket routing remain type-safe.
	"restart_storm_hold",
	// FLY-939 (G-D): the Bridge booted on a STALE checkout — its running HEAD is
	// strictly behind origin/main, so merged work is NOT live (the FLY-887
	// silent-non-deploy incident shape). A Lead-only alert; the durable
	// `bridge_boot_stale_checkout` StateStore event + the boot console.warn are the
	// primary signals. Fired from TS (boot-sha-check via the notifier), never shell.
	"bridge_boot_stale_checkout",
	// FLY-927 (D4): the Bridge launchd wrapper's fail-loud path (port stuck /
	// preflight failure while the Bridge is DOWN) — fired ONLY via
	// scripts/lead-alert.sh from flywheel-bridge-wrapper.sh `bp_fail_loud`
	// (Discord-independent; direct-curl core-channel kept as fallback). Present in
	// the union so a queued wrapper alert drains with a known eventType and the
	// shared kind face (lead-alert.sh allowlist ↔ TS) has no drift.
	"bridge_wrapper_fail",
	// FLY-927 W-B: a RUNNER that is genuinely STALLED after a 529/overloaded
	// throttle — pane stagnant + throttle residue + NO live retry activity. A
	// subtype of runner_stuck_unhandled (same runnerStuck metadata contract) so
	// the AutoRepairBot can attempt the audited continue-nudge; a HEALTHY 529
	// (still retrying) never emits this (FLY-218 suppression stays).
	"runner_throttle_stalled",
	// FLY-954: <state>/bin runtime-script drift detected by
	// scripts/converge-flywheel-bin.sh (shell path via lead-alert.sh; the
	// Bridge never emits this kind itself — union parity only).
	"bin_integrity_drift",
	// FLY-1676: a launcher or fleet restart could not prove that the active
	// Discord adapter is the fork-backed pointer at fork/main with all critical
	// collaboration markers. Shell-emitted; union parity keeps queued delivery
	// and ticket routing fail-loud.
	"discord_plugin_integrity_failed",
	// FLY-945 Fix D: the external-merge reconcile pass found a merged PR it
	// cannot verify (no founder-attributed approval, or the merged head differs
	// from the head the approval was bound to) OR an externally-merged parked
	// session that is not ship-eligible. Lead-only — the session is NOT
	// finalized/archived; a human must look at the merge.
	"external_merge_suspect",
	// FLY-929 C2: the daily token report pipeline failed in place
	// (token-usage-daily.sh fail-loud via lead-alert.sh).
	"notify_digest_failed",
	// ── FLY-1099: founder-reply ingest reliability (账本诚实性 — a founder
	// approval must never disappear silently again). All five carry a durable
	// episode salt in the eventId (FLY-220 discipline) so the permanent
	// claims.db dedup can never swallow a NEW episode.
	// The founder-reply deliver pass has not completed successfully past the
	// stall threshold (incl. a HUNG pass — the GatePoller outer-layer clock
	// check observes it even while `polling` is stuck true).
	"founder_reply_pass_dead",
	// A founder message has been pinning its thread's ingest cursor past the
	// pin threshold (per-thread routing; the durable founder_reply_retry row
	// is the source).
	"founder_reply_pinned",
	// A founder message exhausted its bounded retries and was dead-lettered —
	// durably recorded + must-deliver alert (the message will NOT be
	// auto-processed; a human must act on it).
	"founder_reply_dead_letter",
	// A founder-facing ledger action (held notice / rebound notice / nudge /
	// feedback wake) failed terminally after bounded retries.
	"founder_notify_dead_letter",
	// Z2 (FLY-1049 shape): a LIVE session whose CommDB registration row is
	// gone — wake routing broken; founder replies to its gate dead-letter.
	"founder_reply_unreachable_runner",
	// FLY-1238: internal integrity alerts. These never reuse founder-facing
	// recovery copy; they route to the owning Lead after bounded retries.
	"commdb_finalize_stuck",
	"merged_gate_guard_unavailable",
	// FLY-1081: restart-services.sh / update-flywheel.sh deploy notices, fired
	// ONLY via scripts/lead-alert.sh with the system identity `--lead deploy` /
	// `--lead updater` (shell-only kinds; the Bridge never emits them). Present
	// in the union so a queued deploy alert drains with a known eventType and
	// the shared kind face (lead-alert.sh allowlist ↔ TS) has no drift.
	"deploy_failed",
	"deploy_degraded",
	// FLY-1256/FLY-1182: emitted by the external quota monitor. Successful,
	// transient-unknown, and confirmation notices are root-only informational;
	// conflict/persistent-unknown/malformed/choice and legacy failures ticket.
	"account_switched",
	"account_switch_degraded",
	"machine_account_conflict",
	"model_config",
	"model_cap_switched",
	"model_cap_unknown",
	"model_cap_persistent_unknown",
	"model_bench_malformed",
	"quota_choice",
	"quota_switch_confirmation",
	"quota_no_target",
	"quota_blocked_recovered",
	"quota_read_blind",
	"account_switch_failed",
	"account_identity_mismatch",
	"quota_revive_stuck",
	"quota_monitor_down",
	// FLY-1252: a human explicitly bypassed the manual live 5h/7d quota guard.
	// Fired via lead-alert.sh; actionable audit event, never informational.
	"quota_guard_bypassed",
	// ── FLY-1082: fleet-level failure kinds (the 2026-07-09 OOM incident gap —
	// machine-wide failures had NO kind, so nobody owned them and the founder
	// found out first). Every fleet kind has an owner + an explicit ARC posture
	// in bridge/kind-contract.ts (validated fail-loud at Bridge startup). ──
	//
	// Swap watermark crossed the high threshold (OOM EARLY WARNING — a true OOM
	// already manifests as bridge_abnormal_exit / tmux_server_lost, so there is
	// deliberately no "OOM happened" kind). Emitted by the machine-watermark
	// sensor (reconcile tick piggyback) with hysteresis + 2-tick confirmation.
	// ARC: reversible dispatch pressure-hold + per-Lead load-shed notify; the
	// ticket resolves quietly when the watermark falls below the low threshold.
	"swap_pressure_high",
	// The tmux server hosting ALL runners is gone while StateStore still has
	// running tmux sessions (server-level death — distinct from a single
	// runner's window dying). ONE episode per loss, not 13 per-runner alerts;
	// the server-loss coordinator (HeartbeatService pre-reaper phase) migrates
	// every affected runner to its terminal state and notifies each Lead with
	// its own casualty list + resume pointers. Respawn stays Lead-driven.
	"tmux_server_lost",
	// A guard helper could not positively prove a safe tmux action. The Bridge
	// durably holds affected sessions, escalates after 10 minutes, and resolves
	// only after coordinator target reconciliation.
	"tmux_hold",
	// Multiple server generations/candidates referenced the same canonical
	// socket. No automated signal/create/reap is safe; founder-directed action.
	"tmux_split_brain",
	// The Bridge process died WITHOUT a clean shutdown (fatal exit under memory
	// pressure, kill -9, crash). Two in-machine legs share one episodeSignature:
	// the wrapper preflight dirty-marker page (Bridge-independent fast path via
	// lead-alert.sh — load-bearing in the shell allowlist) and the revived
	// Bridge's boot self-check ticket (lifecycle: ACK → boot reconcile →
	// quiet resolve). The out-of-process "never came back" backstop is the
	// external liveness probe (scripts/bridge-liveness-probe.sh, Codex bot).
	"bridge_abnormal_exit",
	// One of the two infra bots (claude / codex windowed Leads) is down —
	// launchd job dead or lead pane gone. CROSS-owned via
	// metadata.infraBotDown.provider ("nobody rescues their own side": the dead
	// side's ticket is owned by the OTHER bot). ARC: launchctl kickstart -k.
	"infra_bot_down",
	// Cross-Lead zombie session backlog (CommDB↔StateStore reconcile drift,
	// the FLY-1066 three shapes) reached the threshold. NO ARC by design —
	// reaping is FLY-1066's job (kind-contract remediationRef) — so the ticket
	// lands directly ESCALATED with the sample list; never enters the ARC
	// retry loop.
	"zombie_session_backlog",
	// Legacy display-only kinds retained so persisted alerts can still drain.
	"detection_fleet_aggregate",
	"detection_page_undeliverable",
	// FLY-1279: an ACK-required Lead event exhausted its bounded delivery budget.
	"delivery_dead_letter",
	// FLY-1373: a per-Lead consume-loop stall or queue-native deadline breach.
	"inbox_loop_stalled",
	// FLY-1402: a Claude Lead was explicitly launched through the emergency
	// last-one-wins compatibility path instead of the single-file rules bundle.
	// Shell-emitted only, but kept in the shared face so queued alerts drain.
	"rules_bundle_legacy",
	// FLY-1407: a work-kind dispatch carried an invalid explicit input. The
	// request itself failed loud; this is the durable, deduplicated Lead notice.
	"workflow_route_input_rejected",
	// FLY-1393 W-1: exact-target process evidence proved an approved ship runner
	// dead; stable event id, one durable alert per execution.
	"stale_approved_ship_dead",
	// FLY-1628: StateStore says active but the recorded tmux generation/body is
	// gone. Recovery is proposed, never auto-redispatched.
	"runner_pane_loss",
	// FLY-1505: a founder-approved ship attempt reached a terminal failure or
	// could no longer be tracked. The approval stays live; a Lead diagnoses the
	// workflow before explicitly waking the runner for another attempt.
	"ship_attempt_failed",
	// FLY-1912: complete-failed marker held by an engine invariant or bounded
	// unknown-5xx replay episode.
	"complete_marker_held",
	// FLY-1309: Lead identity uniqueness, lease control, and carrier drift.
	"lead_dual_active",
	"lead_dual_active_sensor_degraded",
	"lead_lease_store_broken",
	"lead_lease_bypass_used",
	"lead_lease_would_block",
	"lead_lease_control_broken",
	"lead_identity_source_broken",
	"lead_backend_drift",
	// FLY-1364: shell-side cmux display convergence and tmux rescue telemetry.
	"cmux_cleanup",
	// FLY-1944: GatePoller proved the resident watcher unhealthy; only the
	// fully-verified stale branch attempts tuple-bound recovery.
	"cmux_watcher_stalled",
	"tmux_rescue_hold",
	// FLY-1781: engineering-only weekly flag-governance health notices. These
	// are informational (no ticket/ARC/founder DM lifecycle).
	"flag_scan_failed",
	"flag_scan_no_clock",
	"host_voucher_incident",
	/**
	 * FLY-1586: the boot cutover refused a deterministically-bad legacy row and
	 * skipped it. A REAL notification is being held back, so someone has to be
	 * told — the previous incident showed that a guard firing into a void is
	 * indistinguishable from no problem at all.
	 */
	"legacy_row_quarantined",
] as const;

export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

/** Root-only notices that must never open a ticket/thread/ARC lifecycle. */
export const INFORMATIONAL_KINDS: ReadonlySet<AlertEventType> = new Set([
	"account_switched",
	"model_cap_switched",
	"model_cap_unknown",
	"quota_switch_confirmation",
	"quota_blocked_recovered",
	"workflow_route_input_rejected",
	"flag_scan_failed",
	"flag_scan_no_clock",
]);

export function isInformationalKind(kind: AlertEventType): boolean {
	return INFORMATIONAL_KINDS.has(kind);
}

export type AlertSeverity = "info" | "warning" | "severe";

/**
 * FLY-368: optional structured metadata carried alongside an alert. NOT rendered
 * into the Discord message (`formatContent` ignores it — byte-compat text), it is
 * consumed by the AutoRepairBot for safe, gated recovery. `runnerStuck` lets the
 * bot reuse the runner recovery-nudge gates without parsing safety-critical data
 * out of the eventId string (Codex design R1 HIGH-2).
 */
export interface AlertMetadata {
	workflowEngine?: {
		runId: string;
		issueId: string;
		nodeId: string;
		executionId: string;
		disposition:
			| "held"
			| "partial"
			| "completion_receipt_missing"
			| "rework_suppressed_idle_spin"
			| "rework_retry_exhausted"
			| "rework_pane_loss_handoff"
			| "rework_stall_recovered"
			| "rework_reentry_paused"
			| "rework_reentry_resumed"
			| "rework_held_recovery_exhausted"
			| "carrier_delivery_exhausted"
			| "carrier_delivery_held"
			| "carrier_delivery_cancelled"
			| "turn_ledger_divergence"
			| "probe_unknown"
			| "stale_resubmission"
			| "dead_execution_activity_after_replacement"
			| "ship_ready_stalled"
			| "ship_ready_delivery_failed"
			| "gate_carrier_unbound"
			| "gate_materialization_stuck"
			| "card_void_stuck"
			| "founder_input_deadletter"
			| "founder_rework_round_high"
			| "voided_card_input"
			| "land_head_unavailable"
			| "engine_invariant_refusal"
			| "runner_ship_merged_before_approval"
			| "runner_ship_merged_head_mismatch"
			| "runner_ship_completion_failure"
			| "runner_ship_legacy_merge_anomaly"
			| "runner_ship_head_enrichment_failed"
			| "runner_ship_hydration_reval_failed"
			| "runner_ship_authority_conflict"
			| "resume_first_available"
			| "linear_done_deferred"
			| "observation_corrupt";
		launchCount?: number;
		maxBlindReplacements?: number;
		outputExistsForAttempt?: boolean;
		management?: { terminate: string };
		loopIteration?: number;
		attempt?: number;
		head8?: string;
		leadResolution: "resolved" | "fallback";
	};
	runnerStuck?: {
		executionId: string;
		episodeFingerprint: string;
		escalatedAt?: number;
	};
	/**
	 * FLY-696: a real quota cap (5h / weekly), NOT a transient 529. Produced at
	 * detection (the runner quota scan / RunnerQuotaDetector) after parsing the CLI usage
	 * gauge. `provider` drives server-side cross-provider gating on the dedicated
	 * account-switch route; `observedAccount`/`observedGeneration` are the CAS
	 * snapshot so a duplicate trigger from another Lead cannot double-switch.
	 * Absent when the gauge was ambiguous (→ the alert stays needs_human).
	 */
	accountLimit?: {
		provider: "claude" | "codex";
		scope: "5h" | "weekly" | "both";
		/** ISO reset instant of the hit window (weekly dominates when "both"). */
		resetAt: string;
		observedAccount: string;
		observedGeneration: number;
	};
	/**
	 * FLY-696 M3: auth/login expiry — DELIBERATELY distinct from `accountLimit`.
	 * Auth expiry is only fixed by re-login (never by waiting for a quota reset),
	 * so it carries its own metadata and evidence source. `observedGeneration`
	 * guards against marking the wrong pool profile after a switch already changed
	 * the active account.
	 */
	authLimit?: {
		provider: "claude" | "codex";
		observedAccount: string;
		observedGeneration: number;
		/** What surfaced the expiry (e.g. "lead-pane:login_expired"). */
		evidence: string;
		/**
		 * FLY-871 R2/C8: the runner's execution id when this is a
		 * `runner_login_expired` — the R3 rescue path validates + targets this
		 * exact session. Absent for a lead-pane auth alert.
		 */
		executionId?: string;
	};
	/**
	 * FLY-1082 (Task 2.5): which infra bot died — an EXPLICIT event field, not
	 * derived from a session (a bot-down event has no runner session to derive
	 * `adapter_type` from). Drives the cross owner assignment: the DEAD side's
	 * ticket is owned by the OTHER bot (dead claude → @codex, dead codex →
	 * @claude). `jobLabel` is the launchd job for the kickstart ARC action;
	 * `probeSource` records which probe detected the death (pane / launchctl).
	 */
	infraBotDown?: {
		provider: "claude" | "codex";
		jobLabel?: string;
		probeSource?: string;
	};
	/**
	 * FLY-1082 (Task 2.3): the server-loss coordinator's remediation summary —
	 * the ARC action (grouped terminal migration + per-Lead notify) runs AT
	 * DETECTION inside the HeartbeatService pre-reaper phase; this metadata is
	 * its evidence for the AutoRepairBot (attempted iff every Lead notification
	 * delivered) and for the QA chain.
	 */
	tmuxServerLost?: {
		/** Total casualties in the episode (Codex R2: migrated<casualties ⇒
		 * the remediation is INCOMPLETE — must not read as attempted/recovered). */
		casualties: number;
		/** Runners migrated to their terminal state by the coordinator. */
		migrated: number;
		/** Leads whose grouped casualty notification was delivered. */
		leadsNotified: number;
		/** Leads whose notification FAILED (>0 ⇒ needs_human escalation). */
		leadsFailed: number;
	};
	tmuxHold?: {
		socketPath: string;
		incidentId: string;
		reason: string;
		casualtiesHeld: number;
		reachablePid?: number;
		orphanPids?: number[];
	};
}

/**
 * FLY-927 (Task 1.2/2.3): per-ticket context rendered into the 🎫 header line
 * and used for the owner @-target `allowed_mentions` — computed by the plugin
 * wiring layer (owner map) BEFORE `alert()` so the root POST carries the
 * mention atomically (the Hub gets the messageId only after the POST, so a
 * retro-fit @ is impossible). Absent → the 🎫 line renders `owner —` and all
 * mentions stay suppressed. Survives the retry queue (serialized with the
 * payload).
 */
export interface AlertTicketContext {
	/** Discord snowflake of the ONE owner bot to @; null = no owner configured. */
	ownerUserId: string | null;
	/** Human-readable owner label when no mention is possible (e.g. "claude bot"). */
	ownerLabel: string;
	/** Ticket lifecycle status (NEW/ACK/REPAIRING/MONITORING/RESOLVED/ESCALATED). */
	status: string;
	/** First-seen instant (ms epoch) — claims/episode first time. */
	firstSeenMs: number;
	/** Persisted owner ref (`infra_bot:claude|codex` / `lead:<id>`); not rendered. */
	ownerRef?: string;
}

export interface AlertPayload {
	leadId: string;
	projectName: string;
	eventId: string;
	eventType: AlertEventType;
	title: string;
	body: string;
	severity: AlertSeverity;
	sessionKey?: string;
	/** FLY-368: optional structured metadata (ignored by Discord rendering). */
	metadata?: AlertMetadata;
	/** FLY-927: ticket header + owner @-target context (unified+tickets mode only). */
	ticket?: AlertTicketContext;
	/**
	 * FLY-1081: explicit @-target (e.g. the founder on a deploy_failed) written
	 * by lead-alert.sh --mention-user. Serialized with the queue record so a
	 * Bridge drain re-post still truly pings — content prefix + the unified
	 * allowed_mentions whitelist both derive from it (validated snowflake only;
	 * a malformed id degrades to plain text).
	 */
	mentionUserId?: string;
	/**
	 * Durable recurring-fault identity (FLY-1309) and, for swap alerts, the
	 * episode key used by delayed replay freshness checks.
	 */
	episodeId?: string;
	sourceFingerprint?: string;
}

export interface AlertAttemptOptions {
	/**
	 * FLY-1573: the durable dead-letter outbox already waited its shared
	 * ambiguous-attempt reclaim fence and is now replaying an attempt that has no
	 * delivery receipt. `alert_claims` and `lead_events` prove only that an
	 * attempt was claimed; neither proves Discord/durable delivery. A fenced
	 * replay therefore bypasses those attempt-only dedup checks, but still must
	 * write an `alert_delivery_receipts` row before the outbox settles.
	 *
	 * This is intentionally a call option rather than serialized payload state:
	 * only the outbox that owns the reclaim fence may grant it.
	 */
	replayAfterAmbiguousAttempt?: boolean;
}

/**
 * FLY-1082 (Task 1.4): the routing sentinel for fleet/system alerts. A payload
 * with this projectName carries NO projects.json lead — machine-scoped
 * failures (swap watermark / tmux server loss / bot down / zombie backlog)
 * have no owning Lead by nature. Routing identity and display fields are
 * DECOUPLED on this path: `projectName` is the sentinel, `leadId` is a
 * display-only affected-target summary (e.g. "tmux-server"), and delivery
 * rides the unified channel + sender chain. `alert()` accepts the identity
 * ONLY when it is actually deliverable (see `fleetIdentityDeliverable`) —
 * otherwise the fail-loud unknown-lead dead-letter is unchanged.
 */
export const FLEET_ALERT_PROJECT = "machine";

export function isFleetAlertPayload(p: { projectName: string }): boolean {
	return p.projectName === FLEET_ALERT_PROJECT;
}

export interface AlertResult {
	sent?: boolean;
	skipped?: "duplicate" | "no-channel" | "no-token" | "unknown-lead";
	queued?: boolean;
	dmSent?: boolean;
	/** FLY-182: payload routed to dead-letter (permanent failure, no retry). */
	deadLettered?: boolean;
	/**
	 * FLY-368: on a successful unified-channel POST, the channel + posted message
	 * id so AlertChannelHub can open a thread off the root message. ONLY attached
	 * on the unified+threading path (Codex R1 LOW-10: the legacy result stays
	 * exactly `{ sent: true }`). Never carries a token.
	 */
	channelId?: string;
	messageId?: string;
}

/**
 * FLY-368 (rework): fleet-wide unified alert routing. When set, ALL Lead +
 * Q7-runner alerts route to one channel. The root alert is posted via the STUCK
 * agent's OWN bot (correct attribution — the Bridge holds the token, so it works
 * even if that agent is dead) with a fallback chain: own bot → repair bot (Cass)
 * → alphabetical fleet (see `bridge/alert-bot-chain.ts`). `repairBotTokenEnv` is
 * the env-var NAME of the repair/fallback bot (default `CASS_BOT_TOKEN`).
 */
export interface UnifiedAlertConfig {
	channelId: string;
	repairBotTokenEnv: string;
}

export type FetchLike = typeof globalThis.fetch;
export type ClaimsReader = () => Promise<Set<string>>;

/**
 * Atomic claim against the shared `claims.db`.
 *  - `true`  → this caller inserted the row (we won the race; proceed).
 *  - `false` → row already existed (another Bridge or the shell path
 *    already claimed; skip Discord POST).
 *  - `null`  → claim infrastructure failed (sqlite missing, DB locked
 *    past timeout, etc.). Caller should fall through to "best-effort
 *    POST anyway" — duplicate alerts are recoverable; silent failures
 *    are not.
 */
export type ClaimsClaimer = (
	eventId: string,
	leadId: string,
	kind: AlertEventType,
) => Promise<boolean | null>;

export interface LeadAlertNotifierConfig {
	store: StateStore;
	projects: ProjectEntry[];
	fetchFn?: FetchLike;
	queueDir?: string;
	claimsReader?: ClaimsReader;
	claimsClaimer?: ClaimsClaimer;
	logger?: (msg: string) => void;
	/** FLY-182: Discord-independent meta-alert sink (best-effort). */
	metaAlert?: MetaAlertSink;
	/** FLY-182: dead-letter dir (default ~/.flywheel/alert-deadletter). */
	deadLetterDir?: string;
	/** FLY-182: max queue files before oldest are dead-lettered (default 500). */
	queueMax?: number;
	/** FLY-182: max queue-file age before dead-lettered (default 3 days). */
	queueMaxAgeMs?: number;
	/** FLY-368: when set, ALL alerts route to one unified channel. */
	unifiedAlert?: UnifiedAlertConfig;
	/**
	 * FLY-927: ticket schema header (🎫 line) enable — read at CALL time so a
	 * live env flip applies. Default: FLYWHEEL_ALERT_TICKETS === "1". Only
	 * effective in unified mode; the legacy per-lead path never renders it.
	 */
	ticketsEnabled?: () => boolean;
	/**
	 * FLY-927 (T1): unified-channel root-message rate limiter (20/min in prod).
	 * Absent (FLYWHEEL_ALERT_RATE_PER_MIN unset) ⇒ no limiting = byte-compat.
	 * Only consulted on the unified path — legacy per-lead sends are never
	 * limited (the T1 cap is a #flywheel-alerts channel semantic).
	 */
	rateLimiter?: AlertRateLimiter;
	/** FLY-1309 durable episode DB (test seam; defaults to shared state). */
	episodeDbPath?: string;
	/**
	 * Synchronous delayed-replay evidence. true = this exact episode is proven
	 * over; false = proven live; null = unknown, so delivery must fail open.
	 */
	replayFreshnessProbe?: (input: ReplayFreshnessInput) => boolean | null;
}

/** Queue reasons that are PERMANENT — config doesn't change at runtime, so
 * retrying is pointless. These are dead-lettered on drain regardless of
 * whether today's config could now resolve a channel (Codex design R1#3 —
 * prevents the legacy `no-channel` backlog from flooding core on config flip). */
const PERMANENT_QUEUE_REASONS = new Set([
	"no-channel",
	"no-token",
	"unknown-lead",
]);

const DEFAULT_QUEUE_MAX = 500;
const DEFAULT_QUEUE_MAX_AGE_MS = 259_200_000; // 3 days

const DISCORD_API = "https://discord.com/api/v10";

/** Result of a Discord POST attempt. `transient` failures are retryable.
 * FLY-368: `messageId` is the posted message id (parsed from the Discord JSON
 * response) on the unified path, so AlertChannelHub can open a thread off it. */
type PostOutcome =
	| { ok: true; messageId?: string }
	| { ok: false; status?: number; transient: boolean };

/** 5xx and 429 are transient (retry); other 4xx are permanent (dead-letter). */
function isTransientStatus(status: number): boolean {
	return status >= 500 || status === 429;
}

/**
 * FLY-368 rework (Codex code R1 MEDIUM): a permanent status that means "THIS bot
 * can't post here" (auth/perms/not-a-member) → try the next bot in the send
 * chain. Any other permanent 4xx (400/405/413/...) is a malformed request that
 * fails identically for every bot → stop and dead-letter, don't burn the fleet.
 * `undefined` (network error with no status) is NOT a fall-through (it's
 * transient and handled before this is consulted).
 */
function isSendChainFallthrough(status: number | undefined): boolean {
	return status === 401 || status === 403 || status === 404;
}

export class LeadAlertNotifier {
	private store: StateStore;
	private projects: ProjectEntry[];
	private fetchFn: FetchLike;
	private queueDir: string;
	private claimsReader?: ClaimsReader;
	private claimsClaimer?: ClaimsClaimer;
	private logger: (msg: string) => void;
	private metaAlert?: MetaAlertSink;
	private deadLetterDir: string;
	private queueMax: number;
	private queueMaxAgeMs: number;
	private unifiedAlert?: UnifiedAlertConfig;
	private ticketsEnabled: () => boolean;
	private rateLimiter?: AlertRateLimiter;
	private episodeDbPath: string;
	private replayFreshnessMode: "accept_delayed" | "drop_stale";
	private replayFreshnessProbe?: (
		input: ReplayFreshnessInput,
	) => boolean | null;

	private withDeliveryReceipt(
		payload: AlertPayload,
		result: AlertResult,
		outcome: "sent" | "queued_durable" | "deadlettered_durable",
	): AlertResult {
		try {
			this.store.recordAlertDeliveryReceipt(
				payload.eventId,
				outcome,
				new Date().toISOString(),
			);
		} catch (error) {
			// The visible/durable delivery already happened. Keep alert()'s historical
			// never-throw contract; the FLY-1573 outbox will leave its intent pending
			// and apply the shared 30-minute ambiguous-attempt fence before replay.
			this.logger(
				`delivery receipt write failed event=${payload.eventId}: ${(error as Error).message}`,
			);
		}
		return result;
	}

	constructor(config: LeadAlertNotifierConfig) {
		this.store = config.store;
		this.projects = config.projects;
		this.fetchFn = config.fetchFn ?? (globalThis.fetch as FetchLike);
		this.queueDir =
			config.queueDir ?? join(homedir(), ".flywheel", "alert-queue");
		this.claimsReader = config.claimsReader;
		this.claimsClaimer = config.claimsClaimer;
		this.logger =
			config.logger ??
			((msg) => {
				console.log(`[LeadAlertNotifier] ${msg}`);
			});
		this.metaAlert = config.metaAlert;
		this.deadLetterDir =
			config.deadLetterDir ?? join(homedir(), ".flywheel", "alert-deadletter");
		this.queueMax = config.queueMax ?? DEFAULT_QUEUE_MAX;
		this.queueMaxAgeMs = config.queueMaxAgeMs ?? DEFAULT_QUEUE_MAX_AGE_MS;
		this.unifiedAlert = config.unifiedAlert;
		this.ticketsEnabled =
			config.ticketsEnabled ??
			(() => process.env.FLYWHEEL_ALERT_TICKETS === "1");
		this.rateLimiter = config.rateLimiter;
		this.replayFreshnessProbe = config.replayFreshnessProbe;
		const replayFreshnessRaw =
			process.env.FLYWHEEL_ALERT_REPLAY_FRESHNESS?.trim();
		if (replayFreshnessRaw === "drop_stale") {
			this.replayFreshnessMode = "drop_stale";
		} else {
			this.replayFreshnessMode = "accept_delayed";
			if (replayFreshnessRaw && replayFreshnessRaw !== "accept_delayed") {
				this.logger(
					`invalid FLYWHEEL_ALERT_REPLAY_FRESHNESS=${replayFreshnessRaw}; using accept_delayed`,
				);
			}
		}
		this.episodeDbPath =
			config.episodeDbPath ??
			process.env.FLYWHEEL_LEAD_EPISODE_DB ??
			join(homedir(), ".flywheel", "state", "lease-episodes.db");
		mkdirSync(this.queueDir, { recursive: true });
	}

	/** Fire a meta-alert (Discord-independent), best-effort — never throws. */
	private async fireMetaAlert(
		reason: MetaAlertReason,
		title: string,
		body: string,
	): Promise<void> {
		if (!this.metaAlert) return;
		try {
			await this.metaAlert.notify({ reason, title, body });
		} catch (err) {
			this.logger(`meta-alert notify failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Route a payload to the dead-letter dir (PERMANENT failure — never retried,
	 * kept for audit) and fire a meta-alert so the silent failure surfaces.
	 */
	private async deadLetter(
		payload: AlertPayload,
		reason: string,
	): Promise<void> {
		try {
			mkdirSync(this.deadLetterDir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const file = `${stamp}-${payload.leadId}-${payload.eventType}.json`;
			writeFileSync(
				join(this.deadLetterDir, file),
				JSON.stringify(
					{ ...payload, deadLetteredAt: new Date().toISOString(), reason },
					null,
					2,
				),
				"utf-8",
			);
		} catch (err) {
			this.logger(`dead-letter write failed: ${(err as Error).message}`);
		}
		await this.fireMetaAlert(
			"alert_dead_lettered",
			"LeadAlert dropped (dead-letter)",
			`A Lead alert could not be delivered and was dead-lettered (reason=${reason}, lead=${payload.leadId}, type=${payload.eventType}). The Discord alert path may be misconfigured or down.`,
		);
	}

	/**
	 * FLY-1082 (Task 1.4): can the fleet identity actually deliver right now?
	 * Requires the unified channel AND a resolvable sender token (the D2
	 * single-sender env when set — no fallback behind it, matching its gating
	 * semantics — else the repair chain). Anything less keeps the fail-loud
	 * dead-letter: better a recorded drop than a mis-attributed send.
	 */
	private fleetIdentityDeliverable(): boolean {
		if (!this.unifiedAlert?.channelId) return false;
		const senderEnv = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
		if (senderEnv) return !!process.env[senderEnv];
		return (
			resolveFirstAvailableBotToken(
				buildRepairChain(this.projects, this.unifiedAlert.repairBotTokenEnv),
			) !== null
		);
	}

	async alert(
		payload: AlertPayload,
		attempt: AlertAttemptOptions = {},
	): Promise<AlertResult> {
		const resolved = this.resolveLead(payload.leadId, payload.projectName);
		// FLY-1082 (Task 1.4): a deliverable fleet payload proceeds WITHOUT a
		// projects.json lead (unified channel + send chain need none); `lead` and
		// `project` stay null and every lead-specific step below guards on that.
		if (
			!resolved &&
			!(isFleetAlertPayload(payload) && this.fleetIdentityDeliverable())
		) {
			this.logger(
				`unknown lead: project=${payload.projectName} leadId=${payload.leadId}`,
			);
			// Permanent routing failure (Codex CR R1) — dead-letter for audit
			// (deadLetter() also fires the Discord-independent meta-alert) so the
			// dropped payload is recorded, not just announced.
			await this.deadLetter(payload, "unknown-lead");
			return this.withDeliveryReceipt(
				payload,
				{ skipped: "unknown-lead", deadLettered: true },
				"deadlettered_durable",
			);
		}
		const lead = resolved?.lead ?? null;
		const project = resolved?.project ?? null;

		// Step 1: shell-side fast-path read. Avoids building a payload when
		// shell has already posted an alert for this eventId. Not the
		// load-bearing dedup — that's Step 2.
		if (!attempt.replayAfterAmbiguousAttempt && this.claimsReader) {
			try {
				const claimed = await this.claimsReader();
				if (claimed.has(payload.eventId)) {
					return { skipped: "duplicate" };
				}
			} catch (err) {
				this.logger(
					`claimsReader failed (treating as not claimed): ${(err as Error).message}`,
				);
			}
		}

		// Step 2 (Fix 2): atomic cross-process claim. INSERT OR IGNORE inside
		// BEGIN IMMEDIATE against the SAME claims.db file that lead-alert.sh
		// writes. Whoever writes the row first wins; everyone else gets
		// `false` and skips. On infrastructure failure (`null`) we proceed
		// to the Bridge-only dedup so a partial outage doesn't silence
		// alerts entirely.
		if (!attempt.replayAfterAmbiguousAttempt && this.claimsClaimer) {
			try {
				const won = await this.claimsClaimer(
					payload.eventId,
					payload.leadId,
					payload.eventType,
				);
				if (won === false) {
					return { skipped: "duplicate" };
				}
				// won === true  → proceed; we own the alert.
				// won === null  → claim infra broken; fall through to Bridge-side dedup.
			} catch (err) {
				this.logger(
					`claimsClaimer threw (falling back to Bridge dedup): ${(err as Error).message}`,
				);
			}
		}

		// Step 3: Bridge-only dedup via lead_events UNIQUE. Catches duplicate
		// in-process re-fires plus same-Bridge-process retries that
		// might bypass the cross-process claim (e.g., when claimsClaimer
		// returned null).
		const firstClaim = this.store.tryClaimLeadEvent(
			payload.leadId,
			payload.eventId,
			payload.eventType,
			JSON.stringify(payload),
			payload.sessionKey,
		);
		if (!firstClaim && !attempt.replayAfterAmbiguousAttempt) {
			return { skipped: "duplicate" };
		}
		if (attempt.replayAfterAmbiguousAttempt) {
			this.logger(
				`replaying after ambiguous-attempt fence event=${payload.eventId}`,
			);
		}

		// Step 4: Resolve channel (PERMANENT failure → dead-letter; config doesn't
		// change at runtime). FLY-182: do NOT blind-retry no-channel.
		const channel = this.resolveChannel(lead, project);
		if (!channel) {
			await this.deadLetter(payload, "no-channel");
			return this.withDeliveryReceipt(
				payload,
				{ skipped: "no-channel", deadLettered: true },
				"deadlettered_durable",
			);
		}

		// FLY-927 (T1): unified-channel root-message rate cap. Over the per-minute
		// budget → the alert is queued ONCE (the existing queue format — the drain
		// pass delivers it) + counted for the aggregate overflow summary. Runs
		// AFTER the dedup claims (a queued alert already owns its eventId) and
		// after channel resolution (config failures keep their dead-letter path).
		if (
			this.unifiedAlert &&
			this.rateLimiter &&
			!this.rateLimiter.tryAcquire(Date.now())
		) {
			this.rateLimiter.noteOverflow(payload.eventType);
			this.enqueue(payload, "rate-limited");
			return this.withDeliveryReceipt(
				payload,
				{ queued: true },
				"queued_durable",
			);
		}

		// Step 5: Fire the Discord POST.
		// FLY-368 rework: in unified mode the root alert is posted via the
		// owner-attributed send chain (stuck agent's own bot → Cass → alphabetical
		// fleet, try-in-order, fall through 401/403/404). In legacy (per-lead) mode
		// the single-token path is unchanged (byte-compat).
		let messageId: string | undefined;
		let usedToken: string | null = null;
		if (this.unifiedAlert) {
			const sent = await this.postAlertWithSendChain(payload, channel);
			if (!sent.ok) {
				if (sent.transient) {
					this.enqueue(payload, `discord-${sent.status ?? "net"}`);
					return this.withDeliveryReceipt(
						payload,
						{ queued: true },
						"queued_durable",
					);
				}
				await this.deadLetter(payload, `discord-${sent.status ?? "4xx"}`);
				return this.withDeliveryReceipt(
					payload,
					{ deadLettered: true },
					"deadlettered_durable",
				);
			}
			messageId = sent.messageId;
			usedToken = sent.usedToken ?? null;
		} else {
			// Legacy per-lead path — unreachable for the fleet identity (it requires
			// unified mode), so a null lead here is a config error: dead-letter.
			const token = lead ? this.resolveToken(lead) : null;
			if (!token) {
				await this.deadLetter(payload, "no-token");
				return this.withDeliveryReceipt(
					payload,
					{ skipped: "no-token", deadLettered: true },
					"deadlettered_durable",
				);
			}
			const outcome = await this.postMessage(channel, token, payload);
			if (!outcome.ok) {
				if (outcome.transient) {
					this.enqueue(payload, `discord-${outcome.status ?? "net"}`);
					return this.withDeliveryReceipt(
						payload,
						{ queued: true },
						"queued_durable",
					);
				}
				await this.deadLetter(payload, `discord-${outcome.status ?? "4xx"}`);
				return this.withDeliveryReceipt(
					payload,
					{ deadLettered: true },
					"deadlettered_durable",
				);
			}
			messageId = outcome.messageId;
			usedToken = token;
		}

		// Step 6: Severe follow-up DM (best-effort). FLY-368 (Codex R1 LOW-3): use
		// the WINNING root token so the DM comes from the same bot that visibly
		// posted the root — not an independent re-resolve.
		let dmSent = false;
		if (payload.severity === "severe" && lead?.alertDmUserId && usedToken) {
			dmSent = await this.sendDm(lead.alertDmUserId, usedToken, payload);
		}

		// FLY-368: on the unified path, surface channel + posted message id so the
		// Hub can open a per-error thread. ONLY in unified mode (Codex R1 LOW-10:
		// the legacy result object stays exactly `{ sent: true }`).
		const base: AlertResult = dmSent
			? { sent: true, dmSent: true }
			: { sent: true };
		if (this.unifiedAlert) {
			base.channelId = channel;
			if (messageId) base.messageId = messageId;
		}
		return this.withDeliveryReceipt(payload, base, "sent");
	}

	/**
	 * FLY-368 rework: post the root alert via the owner-attributed send chain
	 * (own bot → Cass → alphabetical fleet). Shared by `alert()` and
	 * `drainQueue()` so the retry path uses the SAME logic (Codex R1 MEDIUM-2).
	 *  - first 2xx wins (returns messageId + the winning token);
	 *  - permanent rejection (401/403/404) on a candidate → try the next;
	 *  - transient (429/5xx/network) → STOP, report transient (don't burn the
	 *    chain on a blip; caller queues / leaves the queue file);
	 *  - all candidates permanently fail / none resolve → ok:false, transient:false.
	 * Tokens are resolved from env at call time (never persisted).
	 */
	private async postAlertWithSendChain(
		payload: AlertPayload,
		channel: string,
	): Promise<{
		ok: boolean;
		messageId?: string;
		usedTokenEnv?: string;
		usedToken?: string;
		transient?: boolean;
		status?: number;
	}> {
		const repairEnv = this.unifiedAlert?.repairBotTokenEnv ?? "";
		// FLY-927 (D2, single sender identity): when FLYWHEEL_ALERT_SENDER_TOKEN_ENV
		// names a token env, the send chain COLLAPSES to that one identity — the
		// gate keeper's own voice, replacing the own-bot→Cass→alpha attribution
		// chain (the 7-06 PRD decision supersedes the 6-22 own-bot one). If the
		// named env doesn't resolve, the loop below finds no token and the caller
		// dead-letters + meta-alerts — deliberately NO silent fallback to the
		// own-bot chain (gating semantics: better a dead-letter than an
		// unauthorized sender). Unset ⇒ the legacy chain, byte-identical.
		const senderEnv = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
		const chain = senderEnv
			? [senderEnv]
			: buildSendChain(this.projects, payload.leadId, repairEnv);
		let lastStatus: number | undefined;
		for (const tokenEnv of chain) {
			const token = process.env[tokenEnv];
			if (!token) continue;
			const outcome = await this.postMessage(channel, token, payload);
			if (outcome.ok) {
				return {
					ok: true,
					messageId: outcome.messageId,
					usedTokenEnv: tokenEnv,
					usedToken: token,
				};
			}
			if (outcome.transient) {
				// Transient on this candidate → stop; the alert is retryable as a whole.
				return { ok: false, transient: true, status: outcome.status };
			}
			// Permanent. ONLY 401/403/404 (this bot lacks channel perms) falls through
			// to the next candidate (Codex code R1 MEDIUM). Any other permanent status
			// (400/405/413/... — a malformed request that will fail identically for
			// EVERY bot) stops immediately and dead-letters; trying the rest of the
			// fleet would be pointless and noisy.
			if (!isSendChainFallthrough(outcome.status)) {
				return { ok: false, transient: false, status: outcome.status };
			}
			lastStatus = outcome.status;
		}
		return { ok: false, transient: false, status: lastStatus };
	}

	/**
	 * Drain the retry queue. Oldest first. Successes are unlinked; TRANSIENT
	 * failures stay for the next pass; everything else (permanent reason,
	 * malformed, unknown lead, unresolved channel/token, permanent 4xx, aged
	 * out, over cap) is moved to the dead-letter dir so the queue can never
	 * grow without bound or spin forever at sent=0 (FLY-182).
	 *
	 * Does NOT fire meta-alerts per file (would be 1667× on a backlog drain);
	 * returns `deadLettered` so the caller (Bridge drain loop) can fire ONE
	 * debounced meta-alert when delivery failures dead-letter. Proven-stale
	 * episodes are audited in the same directory but counted separately as
	 * `staleSuppressed`, never as a delivery failure.
	 */
	async drainQueue(): Promise<{
		sent: number;
		remaining: number;
		deadLettered: number;
		/** Expected product suppression, intentionally not a delivery failure. */
		staleSuppressed: number;
		/**
		 * FLY-927 (Codex R1 HIGH): unified-mode drains that actually POSTed, with
		 * the root channel+message id — the Bridge drain loop feeds these through
		 * the Hub so a rate-limited (or transiently-failed) alert still gets its
		 * per-error thread + ticket lifecycle instead of silently bypassing them.
		 * Entries without a parsed messageId are omitted (root-only degrade —
		 * same contract as the live path). Empty on the legacy path.
		 */
		delivered: Array<{
			payload: AlertPayload;
			channelId: string;
			messageId: string;
		}>;
	}> {
		let entries = readdirSync(this.queueDir)
			.filter((f) => f.endsWith(".json"))
			.sort((left, right) => {
				// FLY-1309: shell (`YYYYMMDD...`) and TS/lease-audit (`YYYY-MM-DD...`)
				// filenames do not share one lexical chronology. Queue content owns
				// time; mtime is the legacy/malformed fallback, filename only a tie-break.
				const delta =
					this.queueEntryTimeMs(left) - this.queueEntryTimeMs(right);
				return delta || left.localeCompare(right);
			});
		let sent = 0;
		let deadLettered = 0;
		let staleSuppressed = 0;
		const delivered: Array<{
			payload: AlertPayload;
			channelId: string;
			messageId: string;
		}> = [];

		// FLY-927 (T1): pending overflow → ONE aggregate summary per window, posted
		// before the per-entry drain. The summary consumes a token; when even that
		// is refused, the counts are KEPT for the next round — never a recursive
		// summary-of-summaries. Cleared only after the summary actually posts.
		if (this.unifiedAlert && this.rateLimiter) {
			const overflow = this.rateLimiter.peekOverflow();
			if (overflow && this.rateLimiter.tryAcquire(Date.now())) {
				const posted = await this.postRawToUnifiedChannel(
					formatOverflowSummary(overflow),
				);
				if (posted) this.rateLimiter.clearOverflow();
			}
		}

		// Cap: dead-letter the oldest beyond queueMax before doing any work.
		if (entries.length > this.queueMax) {
			const overflow = entries.slice(0, entries.length - this.queueMax);
			for (const file of overflow) {
				this.moveQueueFileToDeadLetter(file, "queue-cap");
				deadLettered++;
			}
			entries = entries.slice(entries.length - this.queueMax);
		}

		for (const file of entries) {
			const path = join(this.queueDir, file);
			let parsed: AlertPayload & { queueReason?: string; queuedAt?: string };
			try {
				parsed = JSON.parse(readFileSync(path, "utf-8"));
			} catch (err) {
				// Malformed → dead-letter (never skip forever — Codex CR R2#2).
				this.logger(`malformed queue entry ${file}: ${(err as Error).message}`);
				this.moveQueueFileToDeadLetter(file, "malformed");
				deadLettered++;
				continue;
			}

			// FLY-1309 ack-before-unlink recovery: a prior drain may have committed
			// delivery then crashed before removing this file. Never POST it again.
			if (this.episodeDeliveryState(parsed) === "delivered") {
				unlinkSync(path);
				continue;
			}

			// Aging.
			if (this.queueFileAgeMs(parsed.queuedAt, path) > this.queueMaxAgeMs) {
				this.moveQueueFileToDeadLetter(file, "aged-out");
				deadLettered++;
				continue;
			}

			// β mode: suppress only when the synchronous truth source proves this
			// exact episode ended. Unknown/false/throw all fail open to delivery.
			if (
				this.replayFreshnessMode === "drop_stale" &&
				this.replayFreshnessProbe
			) {
				let stale: boolean | null = null;
				try {
					stale = this.replayFreshnessProbe({
						eventType: parsed.eventType,
						leadId: parsed.leadId,
						eventId: parsed.eventId,
						episodeId: parsed.episodeId,
					});
				} catch (err) {
					this.logger(
						`replay freshness probe failed for ${parsed.eventId}: ${(err as Error).message}; delivering`,
					);
				}
				if (stale === true) {
					this.moveQueueFileToDeadLetter(file, "stale-episode");
					staleSuppressed++;
					continue;
				}
			}

			// Recorded permanent reason → dead-letter REGARDLESS of whether
			// today's config can resolve a channel (Codex design R1#3: stops the
			// legacy no-channel backlog flooding core after fallbackToCore flip).
			if (
				parsed.queueReason &&
				PERMANENT_QUEUE_REASONS.has(parsed.queueReason)
			) {
				this.moveQueueFileToDeadLetter(file, `permanent-${parsed.queueReason}`);
				deadLettered++;
				continue;
			}

			// FLY-368 rework (Codex R1 MEDIUM-2): drain retries use the SAME
			// owner-attributed send chain as the first send in unified mode, so a
			// queued alert is never re-sent via stale single-token logic. Chain is
			// recomputed here (env/config may have changed); tokens are not stored.
			//
			// FLY-1081 (Codex R1#1): the unified branch comes BEFORE resolveLead /
			// resolveChannel. System-identity records written by lead-alert.sh
			// (`--lead deploy` / `updater` / `bridge` — deliberately NO projects.json
			// entry) would otherwise be dead-lettered as unknown-lead and never
			// re-posted — exactly the deploy-failure alerts that most need recovery
			// delivery. Only the legacy branch keeps the resolveLead gates.
			if (this.unifiedAlert) {
				const channel = this.unifiedAlert.channelId;
				// FLY-927 (T1): each drained root message consumes a token. Refused →
				// STOP this drain round immediately; queue files stay untouched (no
				// rewrite, no re-enqueue) and the next round resumes oldest-first.
				if (this.rateLimiter && !this.rateLimiter.tryAcquire(Date.now())) {
					break;
				}
				const sentResult = await this.postAlertWithSendChain(parsed, channel);
				if (sentResult.ok) {
					this.markEpisodeTerminal(parsed, "delivered");
					unlinkSync(path);
					sent++;
					// FLY-927 (Codex R1 HIGH): hand the delivered root to the Hub so a
					// drained alert still gets its thread + ticket lifecycle.
					if (sentResult.messageId) {
						const { queueReason: _qr, queuedAt: _qa, ...payload } = parsed;
						delivered.push({
							payload: payload as AlertPayload,
							channelId: channel,
							messageId: sentResult.messageId,
						});
					}
				} else if (!sentResult.transient) {
					// Every candidate permanently failed → dead-letter.
					this.moveQueueFileToDeadLetter(
						file,
						`discord-${sentResult.status ?? "4xx"}`,
					);
					deadLettered++;
				}
				// transient → leave for the next pass.
				continue;
			}

			const resolved = this.resolveLead(parsed.leadId, parsed.projectName);
			if (!resolved) {
				this.moveQueueFileToDeadLetter(file, "unknown-lead");
				deadLettered++;
				continue;
			}
			const { lead, project } = resolved;
			const channel = this.resolveChannel(lead, project);
			if (!channel) {
				// Config problem — permanent. Dead-letter, don't spin.
				this.moveQueueFileToDeadLetter(file, "no-channel");
				deadLettered++;
				continue;
			}

			const token = this.resolveToken(lead);
			if (!token) {
				this.moveQueueFileToDeadLetter(file, "no-token");
				deadLettered++;
				continue;
			}
			const outcome = await this.postMessage(channel, token, parsed);
			if (outcome.ok) {
				this.markEpisodeTerminal(parsed, "delivered");
				unlinkSync(path);
				sent++;
			} else if (!outcome.transient) {
				// Permanent 4xx → dead-letter (retry pointless).
				this.moveQueueFileToDeadLetter(
					file,
					`discord-${outcome.status ?? "4xx"}`,
				);
				deadLettered++;
			}
			// transient → leave for the next pass.
		}

		const remaining = readdirSync(this.queueDir).filter((f) =>
			f.endsWith(".json"),
		).length;
		return { sent, remaining, deadLettered, staleSuppressed, delivered };
	}

	/**
	 * FLY-927 (T1): post a RAW single message (the overflow summary) to the
	 * unified channel — no claims, no queue, no 🎫-header formatting. Sender
	 * identity: the D2 override when set, else the repair chain (Cass→alpha);
	 * mentions always fully suppressed. Best-effort: any failure returns false
	 * and the caller keeps the overflow counts for the next round.
	 */
	private async postRawToUnifiedChannel(content: string): Promise<boolean> {
		const channel = this.unifiedAlert?.channelId;
		if (!channel) return false;
		const senderEnv = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
		const chain = senderEnv
			? [senderEnv]
			: buildRepairChain(
					this.projects,
					this.unifiedAlert?.repairBotTokenEnv ?? "",
				);
		for (const tokenEnv of chain) {
			const token = process.env[tokenEnv];
			if (!token) continue;
			try {
				const res = await this.fetchFn(
					`${DISCORD_API}/channels/${channel}/messages`,
					{
						method: "POST",
						headers: {
							Authorization: `Bot ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							content: markAutomatedDiscordText(content),
							allowed_mentions: { parse: [] as string[] },
						}),
					},
				);
				if (res.ok) return true;
				if (!isSendChainFallthrough(res.status)) return false;
				// 401/403/404 → try the next candidate.
			} catch {
				return false; // network blip — retry next drain round
			}
		}
		return false;
	}

	/** Move a queue file into the dead-letter dir (no retry, kept for audit). */
	private moveQueueFileToDeadLetter(file: string, reason: string): void {
		const src = join(this.queueDir, file);
		try {
			const parsed = JSON.parse(readFileSync(src, "utf8")) as AlertPayload & {
				queuedAt?: string;
			};
			this.markEpisodeTerminal(parsed, "dead_lettered", reason);
		} catch {
			// Malformed queue entries have no trustworthy episode identity.
		}
		try {
			mkdirSync(this.deadLetterDir, { recursive: true });
			renameSync(src, join(this.deadLetterDir, `${reason}-${file}`));
		} catch (err) {
			this.logger(
				`dead-letter move failed for ${file} (${reason}): ${(err as Error).message}`,
			);
			// Best-effort: remove so a permanently-broken file can't loop forever.
			try {
				unlinkSync(src);
			} catch {
				/* already gone */
			}
		}
	}

	private episodeDeliveryState(
		payload: AlertPayload & { queuedAt?: string },
	): LeadLeaseEpisodeDeliveryState | undefined {
		if (!payload.episodeId || !payload.sourceFingerprint) return undefined;
		if (
			!LEAD_LEASE_EPISODE_KINDS.includes(
				payload.eventType as LeadLeaseEpisodeKind,
			)
		) {
			this.logger(
				`episode ${payload.episodeId} carries invalid kind ${payload.eventType}`,
			);
			return undefined;
		}
		let store: LeadLeaseEpisodeStore | undefined;
		try {
			store = new LeadLeaseEpisodeStore(this.episodeDbPath);
			let episode = store.getEpisode(payload.episodeId);
			if (!episode) {
				store.restoreQueued({
					episodeId: payload.episodeId,
					sourceFingerprint: payload.sourceFingerprint,
					kind: payload.eventType as LeadLeaseEpisodeKind,
					payload: { ...payload },
					createdAt: payload.queuedAt ?? new Date().toISOString(),
				});
				episode = store.getEpisode(payload.episodeId);
				this.logger(
					`restored missing lease episode ${payload.episodeId} from queue`,
				);
			}
			return episode?.deliveryState;
		} catch (error) {
			// Successful delivery remains authoritative even if the audit DB is
			// unavailable; log and continue so a corrupt store cannot cause an
			// infinite repost loop.
			this.logger(
				`lease episode state unavailable for ${payload.episodeId}: ${(error as Error).message}`,
			);
			return undefined;
		} finally {
			store?.close();
		}
	}

	private markEpisodeTerminal(
		payload: AlertPayload,
		state: "delivered" | "dead_lettered",
		reason?: string,
	): void {
		if (!payload.episodeId) return;
		let store: LeadLeaseEpisodeStore | undefined;
		try {
			store = new LeadLeaseEpisodeStore(this.episodeDbPath);
			store.markDelivery(payload.episodeId, state, reason);
		} catch (error) {
			this.logger(
				`lease episode ${state} ack degraded for ${payload.episodeId}: ${(error as Error).message}`,
			);
		} finally {
			store?.close();
		}
	}

	/** Age of a queue file in ms — from `queuedAt` if present, else file mtime. */
	private queueFileAgeMs(queuedAt: string | undefined, path: string): number {
		const now = Date.now();
		if (queuedAt) {
			const t = Date.parse(queuedAt);
			if (!Number.isNaN(t)) return now - t;
		}
		try {
			return now - statSync(path).mtimeMs;
		} catch {
			return 0;
		}
	}

	private queueEntryTimeMs(file: string): number {
		const path = join(this.queueDir, file);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				queuedAt?: unknown;
			};
			if (typeof parsed.queuedAt === "string") {
				const timestamp = Date.parse(parsed.queuedAt);
				if (Number.isFinite(timestamp)) return timestamp;
			}
		} catch {
			// Malformed entries are still ordered deterministically by mtime below;
			// the drain loop then moves them to dead-letter.
		}
		try {
			return statSync(path).mtimeMs;
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	}

	private resolveLead(
		leadId: string,
		projectName: string,
	): { lead: LeadConfig; project: ProjectEntry } | null {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) return null;
		const lead = project.leads.find((l) => l.agentId === leadId);
		if (!lead) return null;
		return { lead, project };
	}

	private resolveChannel(
		lead: LeadConfig | null,
		project: ProjectEntry | null,
	): string | null {
		// FLY-368: unified channel wins over per-lead routing when configured —
		// this is what funnels every Lead/Q7-runner alert into one place.
		// FLY-1082: the fleet identity (null lead/project) only ever reaches this
		// in unified mode, so it always resolves on the first branch.
		if (this.unifiedAlert?.channelId) return this.unifiedAlert.channelId;
		if (lead?.alertChannel) return lead.alertChannel;
		if (lead?.alertFallbackToCore && project?.generalChannel) {
			return project.generalChannel;
		}
		return null;
	}

	/**
	 * Legacy (non-unified) per-lead token resolution — unchanged byte-compat.
	 * The unified path no longer uses this; it resolves per-alert via the
	 * owner-attributed send chain (`postAlertWithSendChain`).
	 */
	private resolveToken(lead: LeadConfig): string | null {
		const envName = lead.alertBotTokenEnv ?? lead.botTokenEnv;
		if (envName) {
			const fromEnv = process.env[envName];
			if (fromEnv) return fromEnv;
		}
		return lead.botToken ?? null;
	}

	private async postMessage(
		channelId: string,
		token: string,
		payload: AlertPayload,
	): Promise<PostOutcome> {
		const url = `${DISCORD_API}/channels/${channelId}/messages`;
		try {
			const res = await this.fetchFn(url, {
				method: "POST",
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: markAutomatedDiscordText(
						formatContent(payload, {
							ticketHeader:
								!!this.unifiedAlert &&
								this.ticketsEnabled() &&
								!isInformationalKind(payload.eventType),
						}),
					),
					// FLY-368 (Codex code R1 MEDIUM-3): suppress all mentions on the
					// unified-channel root alert so an issue id / title / body can never
					// @everyone/@here/@role-ping the channel. Gated on unified mode so the
					// legacy per-lead POST body stays byte-identical.
					// FLY-927 (Task 1.2/2.3): in unified+tickets mode with a validated
					// owner snowflake, the ONE owner bot is whitelisted so the 🎫 header's
					// `<@owner>` actually pings — everything else stays suppressed.
					// FLY-1081: a validated payload.mentionUserId joins that whitelist
					// (deduped) so a drained deploy_failed still truly pings the founder;
					// both absent → the exact `{parse: []}` suppression contract.
					...(this.unifiedAlert
						? { allowed_mentions: this.unifiedAllowedMentions(payload) }
						: {}),
				}),
			});
			if (!res.ok) {
				const text = await safeText(res);
				this.logger(
					`Discord POST ${res.status} ${res.statusText} for ${payload.leadId}/${payload.eventType}: ${text}`,
				);
				return {
					ok: false,
					status: res.status,
					transient: isTransientStatus(res.status),
				};
			}
			// FLY-368: parse the posted message id ONLY in unified mode (so the
			// legacy path is byte-identical and never depends on response parsing).
			if (this.unifiedAlert) {
				try {
					const body =
						(await (
							res.json as undefined | (() => Promise<{ id?: string }>)
						)?.()) ?? {};
					return { ok: true, messageId: body.id };
				} catch {
					return { ok: true };
				}
			}
			return { ok: true };
		} catch (err) {
			// Network/transport error — transient, retry via queue.
			this.logger(
				`Discord POST threw for ${payload.leadId}/${payload.eventType}: ${(err as Error).message}`,
			);
			return { ok: false, transient: true };
		}
	}

	/**
	 * FLY-927: the validated owner snowflake for the root-POST mention whitelist.
	 * Non-null ONLY in unified+tickets mode with a well-formed Discord snowflake
	 * (reuses the Hub's founderId/infraBotId validation judgement) — a malformed
	 * id degrades to plain text rather than a Discord-rejected mentions body.
	 */
	private ticketOwnerMention(payload: AlertPayload): string | null {
		if (
			!this.unifiedAlert ||
			!this.ticketsEnabled() ||
			isInformationalKind(payload.eventType)
		) {
			return null;
		}
		const id = payload.ticket?.ownerUserId?.trim();
		return id && /^\d{17,20}$/.test(id) ? id : null;
	}

	/**
	 * FLY-1081: the unified-path `allowed_mentions` body — the 🎫 owner whitelist
	 * (FLY-927) merged with the payload's explicit mentionUserId (shell deploy
	 * alerts drained by the Bridge), deduped. Both absent → the exact FLY-368
	 * suppression contract `{parse: []}`. The legacy path never calls this (its
	 * POST body stays byte-identical: no allowed_mentions key at all).
	 */
	private unifiedAllowedMentions(
		payload: AlertPayload,
	): { users: string[] } | { parse: string[] } {
		const users = [
			...new Set(
				[this.ticketOwnerMention(payload), validMentionUserId(payload)].filter(
					(id): id is string => id !== null,
				),
			),
		];
		return users.length > 0 ? { users } : { parse: [] as string[] };
	}

	private async sendDm(
		userId: string,
		token: string,
		payload: AlertPayload,
	): Promise<boolean> {
		const createUrl = `${DISCORD_API}/users/@me/channels`;
		try {
			const res = await this.fetchFn(createUrl, {
				method: "POST",
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ recipient_id: userId }),
			});
			if (!res.ok) {
				this.logger(
					`DM channel create ${res.status} for user ${userId}: ${await safeText(res)}`,
				);
				return false;
			}
			const body =
				(await (
					res.json as undefined | (() => Promise<{ id?: string }>)
				)?.()) ?? {};
			const dmChannelId = body.id;
			if (!dmChannelId) return false;
			return (await this.postMessage(dmChannelId, token, payload)).ok;
		} catch (err) {
			this.logger(`DM fan-out failed: ${(err as Error).message}`);
			return false;
		}
	}

	private enqueue(payload: AlertPayload, reason: string): void {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = `${stamp}-${payload.leadId}-${payload.eventType}.json`;
		const path = join(this.queueDir, file);
		const record = {
			...payload,
			queuedAt: new Date().toISOString(),
			queueReason: reason,
		};
		writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
	}
}

/** A Lead whose alert path can never deliver with the current config. */
export interface UnreachableAlertLead {
	projectName: string;
	leadId: string;
	reason: string;
}

/**
 * FLY-182 (§4.1): find Leads whose alert channel/token cannot resolve from
 * config — the silent gap that broke alerting for 25 days. Called at Bridge
 * startup so a misconfigured alert path is surfaced LOUDLY instead of failing
 * silently. Token check is config-shape only (a configured env var may still
 * be empty at runtime; that surfaces as a permanent no-token dead-letter).
 */
export function findUnreachableAlertLeads(
	projects: ProjectEntry[],
	unified?: {
		channelId?: string;
		repairBotTokenEnv?: string;
		/** FLY-927 (D2): the single-sender env NAME — when set it is the
		 * authoritative chain, so startup validation checks IT (a misspelled
		 * sender env fails loud at boot instead of dead-lettering at runtime). */
		senderTokenEnv?: string;
	},
): UnreachableAlertLead[] {
	const out: UnreachableAlertLead[] = [];
	// FLY-368 rework: in unified mode every alert resolves a token via the
	// fleet-wide send chain (own → repair/Cass → alphabetical). A lead is
	// therefore unreachable ONLY if the ENTIRE fleet has no resolvable bot token
	// — a single fleet-wide failure, not per-lead noise. (The per-thread
	// repair-bot fail-loud lives in plugin.ts.)
	if (unified?.channelId) {
		// FLY-927 (Codex R1 MEDIUM): D2 override — the sender identity IS the
		// chain; there is deliberately NO own-bot/repair fallback behind it.
		const senderEnv = unified.senderTokenEnv?.trim();
		if (senderEnv) {
			if (!process.env[senderEnv]) {
				out.push({
					projectName: "*",
					leadId: "*",
					reason: `FLYWHEEL_ALERT_SENDER_TOKEN_ENV "${senderEnv}" is not set / empty — single-sender mode has no fallback, alerts cannot be sent`,
				});
			}
			return out;
		}
		const repairEnv = unified.repairBotTokenEnv ?? "";
		const anyBot = resolveFirstAvailableBotToken(
			buildRepairChain(projects, repairEnv),
		);
		if (!anyBot) {
			out.push({
				projectName: "*",
				leadId: "*",
				reason:
					"unified alert channel set but NO fleet bot token resolves (repair chain Cass→alpha empty) — alerts cannot be sent",
			});
		}
		return out;
	}
	// Legacy (non-unified) per-lead channel+token validation — unchanged.
	for (const project of projects) {
		for (const lead of project.leads) {
			const hasChannel =
				!!lead.alertChannel ||
				(!!lead.alertFallbackToCore && !!project.generalChannel);
			if (!hasChannel) {
				out.push({
					projectName: project.projectName,
					leadId: lead.agentId,
					reason:
						"no alertChannel and no alertFallbackToCore+generalChannel — alerts cannot resolve a channel",
				});
				continue;
			}
			// Codex CR R1: check the token actually RESOLVES at runtime, not just
			// that an env-var NAME is configured — a misspelled/unset env var would
			// otherwise pass startup and only surface as a dead-letter on the first
			// real alert.
			const tokenEnvName = lead.alertBotTokenEnv ?? lead.botTokenEnv;
			const tokenResolves =
				(!!tokenEnvName && !!process.env[tokenEnvName]) || !!lead.botToken;
			if (!tokenResolves) {
				out.push({
					projectName: project.projectName,
					leadId: lead.agentId,
					reason: tokenEnvName
						? `alert token env "${tokenEnvName}" is not set / empty (and no inline botToken)`
						: "no alertBotTokenEnv / botTokenEnv / botToken configured",
				});
			}
		}
	}
	return out;
}

/**
 * FLY-1081 (Codex R1#2): the ONE validated judgement for the payload's explicit
 * @-target — same snowflake regex as `ticketOwnerMention`. Consumed by BOTH
 * `formatContent` (the visible `<@id> ` prefix) and the unified
 * `allowed_mentions` whitelist, so content and whitelist can never disagree.
 * A malformed id degrades to plain text (no prefix, no whitelist entry).
 */
function validMentionUserId(payload: AlertPayload): string | null {
	const id = payload.mentionUserId?.trim();
	return id && /^\d{17,20}$/.test(id) ? id : null;
}

/** Local HH:MM for the 🎫 header's first-seen stamp (Hub `hhmm` idiom). */
function ticketHHMM(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "??:??";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * FLY-927 (Task 1.2): the 🎫 ticket header — appended AFTER the existing first
 * line so the `ALERT_ECHO_START` anchor on `(<leadId> / <kind>)`
 * keeps matching (append-only = minimum echo-regression radius, FLY-220).
 * Rendered ONLY when the caller enables it (unified mode + FLYWHEEL_ALERT_TICKETS=1);
 * legacy output stays byte-identical.
 */
function formatContent(
	payload: AlertPayload,
	opts?: { ticketHeader?: boolean },
): string {
	const sev =
		payload.severity === "severe"
			? "🚨"
			: payload.severity === "warning"
				? "⚠️"
				: "ℹ️";
	// FLY-1081: the explicit mention rides at the very front of the content —
	// Discord only truly pings an id present in BOTH content and the
	// allowed_mentions whitelist (unifiedAllowedMentions). Absent/invalid →
	// empty prefix, output byte-identical. ALERT_ECHO_START keys on the
	// unanchored `(<lead> / <kind>)` token, so the prefix cannot break
	// echo immunity.
	const mention = validMentionUserId(payload);
	const prefix = mention ? `<@${mention}> ` : "";
	const firstLine = `${prefix}${sev} **${payload.title}** (${payload.leadId} / ${payload.eventType})`;
	if (!opts?.ticketHeader) {
		return `${firstLine}\n${payload.body}`;
	}
	const t = payload.ticket;
	const ownerId = t?.ownerUserId?.trim();
	const owner =
		ownerId && /^\d{17,20}$/.test(ownerId)
			? `<@${ownerId}>`
			: t?.ownerLabel?.trim() || "—";
	const status = t?.status?.trim() || "NEW";
	const firstSeen = ticketHHMM(t?.firstSeenMs ?? Date.now());
	return `${firstLine}\n🎫 ${payload.projectName} · 首见 ${firstSeen} · owner ${owner} · 状态 ${status}\n${payload.body}`;
}

async function safeText(
	res: Response | { text?: () => Promise<string> },
): Promise<string> {
	try {
		return typeof res.text === "function" ? await res.text() : "";
	} catch {
		return "";
	}
}
