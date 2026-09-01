/**
 * FLY-1082 (Task 1.1): the alert-kind CONTRACT — every kind in the union must
 * declare who owns its ticket and what the ARC posture is. The 2026-07-09 OOM
 * incident happened because fleet-level failures had no kind at all: nobody
 * owned them, so by design they fell through to the founder. This registry
 * makes "an ownerless kind" structurally impossible:
 *
 *  - COMPILE time: `KIND_CONTRACTS` is a `Record` over the `AlertEventType`
 *    union — adding a kind to `ALERT_EVENT_TYPES` without a contract entry is
 *    a type error.
 *  - STARTUP time: `validateKindContracts()` runs in plugin initialization
 *    (before listen) and THROWS listing every offending kind — the Bridge
 *    refuses to start on a contract violation. Deliberately no "warn and
 *    continue" and no kill-switch: this is a code-integrity check, not a
 *    behavior.
 *
 * Contract shape (PRD §4.4): every kind is either
 *  (a) `arc: "auto"` — has an EXECUTABLE, reversible remediation
 *      (`remediationRef` names it) and a bot owner, or
 *  (b) `arc: "none_escalate" | "human_by_design"` — explicitly no ARC, with
 *      the owner still named.
 *
 * FLY-2075: `arc` describes remediation posture only. It no longer drives an
 * enqueue-time or reconcile-time automatic founder escalation; every ticket
 * enters the Hub ledger as NEW unless a real ARC attempt advances it.
 */

import {
	ALERT_EVENT_TYPES,
	type AlertEventType,
} from "../LeadAlertNotifier.js";

/**
 * Ticket owner class. `cross_by_provider` = "nobody rescues their own side":
 * the ticket's provider decides the owning bot (claude problem → codex bot and
 * vice versa — the ticket-owner-map cross family). `founder_direct` = no bot
 * owner by design (a human decision); `owning_lead` resolves from the alert's
 * trusted Lead identity.
 */
export type KindOwner =
	| "claude"
	| "codex"
	| "cross_by_provider"
	| "owning_lead"
	| "founder_direct";

export type KindArc = "auto" | "none_escalate" | "human_by_design";

export interface KindContract {
	owner: KindOwner;
	arc: KindArc;
	/**
	 * Names the executable remediation (REQUIRED for arc="auto") or, for a
	 * (b)-type kind, where the real fix lands (e.g. "FLY-1066").
	 */
	remediationRef?: string;
}

/**
 * The whitelist (PRD §4.1 / §10.0 CH-1) as an exhaustive Record over the
 * union — a kind missing here is a COMPILE error. Legacy kinds are mapped to
 * their CURRENT behavior (zero behavior change); the 5 FLY-1082 fleet kinds
 * carry the new fleet contracts.
 */
export const KIND_CONTRACTS: Record<AlertEventType, KindContract> = {
	// ── Account / auth family — cross-assigned ("nobody rescues their own side").
	rate_limit: { owner: "cross_by_provider", arc: "human_by_design" },
	usage_limit: {
		owner: "cross_by_provider",
		arc: "auto",
		remediationRef:
			"account-switch repair (FLY-696, gated FLYWHEEL_ACCOUNT_SELF_HEAL)",
	},
	login_expired: { owner: "cross_by_provider", arc: "human_by_design" },
	runner_login_expired: { owner: "cross_by_provider", arc: "human_by_design" },

	// ── Human-decision kinds — no bot owner by design.
	permission_blocked: { owner: "founder_direct", arc: "human_by_design" },
	// FLY-637-ext ladder output: the owner-first response already happened (K
	// nudge rounds). The arc posture remains descriptive; the Hub records NEW.
	runner_lead_pending_unhandled: {
		owner: "founder_direct",
		arc: "none_escalate",
	},

	// ── Provider-agnostic infra kinds — Claude workhorse default (CMP-2).
	crash_loop: { owner: "claude", arc: "human_by_design" },
	pane_hash_stuck: { owner: "claude", arc: "human_by_design" },
	pane_error_stalled: { owner: "claude", arc: "human_by_design" },
	// Legacy display-only kinds retained for persisted alert rows.
	detection_fleet_aggregate: { owner: "claude", arc: "human_by_design" },
	detection_page_undeliverable: { owner: "claude", arc: "human_by_design" },
	delivery_dead_letter: { owner: "founder_direct", arc: "none_escalate" },
	inbox_loop_stalled: { owner: "founder_direct", arc: "none_escalate" },
	orphan_pane: { owner: "claude", arc: "human_by_design" },
	mailbox_dead_letter: { owner: "founder_direct", arc: "none_escalate" },
	// FLY-1586: a real notification was held back by the cutover. It needs a
	// human decision (replay or discard), so it is not auto-repaired — nothing
	// here can know whether the held-back message still matters.
	legacy_row_quarantined: { owner: "founder_direct", arc: "none_escalate" },
	rules_bundle_legacy: { owner: "claude", arc: "human_by_design" },
	workflow_route_input_rejected: {
		owner: "claude",
		arc: "human_by_design",
	},
	stale_approved_ship_dead: {
		owner: "founder_direct",
		arc: "none_escalate",
	},
	runner_pane_loss: { owner: "claude", arc: "human_by_design" },
	ship_attempt_failed: {
		owner: "claude",
		arc: "human_by_design",
	},
	complete_marker_held: { owner: "claude", arc: "human_by_design" },
	runner_stuck_unhandled: {
		owner: "claude",
		arc: "human_by_design",
	},
	runner_throttle_stalled: {
		owner: "claude",
		arc: "human_by_design",
	},
	auto_qa_stuck: { owner: "claude", arc: "human_by_design" },
	codex_gate_blocked: { owner: "claude", arc: "human_by_design" },
	review_advisory_pass: { owner: "claude", arc: "human_by_design" },
	review_job_failed: { owner: "owning_lead", arc: "human_by_design" },
	review_ruling_recorded: { owner: "claude", arc: "human_by_design" },
	review_ruling_disputed: { owner: "claude", arc: "human_by_design" },
	review_ruling_notify_failed: { owner: "claude", arc: "human_by_design" },
	three_stage_stuck: { owner: "claude", arc: "human_by_design" },
	three_stage_takeover_failed: { owner: "claude", arc: "human_by_design" },
	workflow_engine_escalation: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1385 run hold/terminate API",
	},
	workflow_engine_issue_alert: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1385 dead-execution activity tripwire",
	},
	founder_gate_delivery_failed: { owner: "claude", arc: "human_by_design" },
	tui_window_lost: { owner: "claude", arc: "human_by_design" },
	restart_guard_bypass: { owner: "claude", arc: "human_by_design" },
	calendar_wild_write: {
		owner: "claude",
		arc: "none_escalate",
		remediationRef:
			"engineering/doc/FLY-2137-calendar-write-governance/plan.md",
	},
	restart_storm_hold: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef:
			"inspect the held service, then explicitly resume its restart ledger (FLY-1501)",
	},
	bridge_boot_stale_checkout: { owner: "claude", arc: "human_by_design" },
	bridge_wrapper_fail: { owner: "claude", arc: "human_by_design" },
	bin_integrity_drift: { owner: "claude", arc: "human_by_design" },
	discord_plugin_integrity_failed: {
		owner: "claude",
		arc: "human_by_design",
	},
	external_merge_suspect: { owner: "claude", arc: "human_by_design" },
	notify_digest_failed: { owner: "claude", arc: "human_by_design" },
	// FLY-1099: founder-reply ingest reliability kinds — all human-investigation
	// alerts (a dead founder-reply pass / a pinned or dead-lettered founder
	// message / an unreachable runner registration each need a human to look at
	// the message or the session; no reversible auto-remediation exists).
	founder_reply_pass_dead: { owner: "claude", arc: "human_by_design" },
	founder_reply_pinned: { owner: "claude", arc: "human_by_design" },
	founder_reply_dead_letter: { owner: "claude", arc: "human_by_design" },
	founder_notify_dead_letter: { owner: "claude", arc: "human_by_design" },
	founder_reply_unreachable_runner: {
		owner: "claude",
		arc: "human_by_design",
	},
	commdb_finalize_stuck: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "inspect comm.db and retry lifecycle closeout (FLY-1238)",
	},
	merged_gate_guard_unavailable: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef:
			"verify GitHub PR state and retire or re-drive gate (FLY-1238)",
	},
	// FLY-1081 (merged from main): shell-only deploy notices fired by
	// restart-services.sh / update-flywheel.sh via lead-alert.sh — the Bridge
	// never emits them; same legacy human posture as the other shell kinds.
	deploy_failed: { owner: "claude", arc: "human_by_design" },
	deploy_degraded: { owner: "claude", arc: "human_by_design" },
	// FLY-1256: the quota monitor already performed (or deliberately declined)
	// the switch/revive. Bridge ARC would duplicate an external safety action.
	account_switched: { owner: "claude", arc: "human_by_design" },
	account_switch_degraded: { owner: "claude", arc: "human_by_design" },
	machine_account_conflict: { owner: "claude", arc: "human_by_design" },
	model_config: { owner: "claude", arc: "human_by_design" },
	model_cap_switched: { owner: "claude", arc: "human_by_design" },
	model_cap_unknown: { owner: "claude", arc: "human_by_design" },
	model_cap_persistent_unknown: {
		owner: "claude",
		arc: "human_by_design",
	},
	model_bench_malformed: { owner: "claude", arc: "human_by_design" },
	quota_choice: { owner: "founder_direct", arc: "human_by_design" },
	quota_switch_confirmation: { owner: "claude", arc: "human_by_design" },
	quota_no_target: { owner: "claude", arc: "human_by_design" },
	quota_blocked_recovered: { owner: "claude", arc: "human_by_design" },
	quota_read_blind: { owner: "claude", arc: "human_by_design" },
	account_switch_failed: { owner: "claude", arc: "human_by_design" },
	account_identity_mismatch: { owner: "claude", arc: "human_by_design" },
	quota_revive_stuck: { owner: "claude", arc: "human_by_design" },
	quota_monitor_down: { owner: "claude", arc: "human_by_design" },
	quota_guard_bypassed: { owner: "claude", arc: "human_by_design" },

	// ── FLY-1082 fleet kinds — every one has a named owner + executable ARC
	// (or an explicit (b) posture). The Hub does not infer a founder page from
	// either posture.
	swap_pressure_high: {
		owner: "claude",
		arc: "auto",
		remediationRef:
			"pressure-hold（可逆暂停派新 runner）+ owner-routed alert ticket",
	},
	tmux_server_lost: {
		owner: "claude",
		arc: "auto",
		remediationRef:
			"server-loss coordinator：成组终态迁移 + 按 Lead 分组通知带 resume 指针 (FLY-1082)",
	},
	tmux_hold: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef:
			"inspect the durable tmux hold and follow the FLY-1285 recovery runbook",
	},
	tmux_split_brain: {
		owner: "founder_direct",
		arc: "human_by_design",
		remediationRef:
			"choose the authoritative tmux generation before any signal/create/reap",
	},
	bridge_abnormal_exit: {
		owner: "claude",
		arc: "auto",
		remediationRef:
			"launchd respawn + 复活后 boot 对账自检（ACK → 安静 resolve）(FLY-1082)",
	},
	infra_bot_down: {
		owner: "cross_by_provider",
		arc: "auto",
		remediationRef: "launchctl kickstart -k <job>（幂等可逆）(FLY-1082)",
	},
	zombie_session_backlog: {
		owner: "claude",
		arc: "none_escalate",
		remediationRef: "FLY-1066",
	},
	// FLY-1309: identity/lease incidents are deliberately fail-closed. Recovery
	// requires establishing which Lead generation is authoritative, so the ARC
	// loop must never guess or kill a process on its own.
	lead_dual_active: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 lead identity recovery",
	},
	lead_dual_active_sensor_degraded: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 process sensor recovery",
	},
	lead_lease_store_broken: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 lease store recovery",
	},
	lead_lease_bypass_used: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 bypass audit",
	},
	lead_lease_would_block: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 lease enforcement recovery",
	},
	lead_lease_control_broken: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 lease control-plane recovery",
	},
	lead_identity_source_broken: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 canonical identity recovery",
	},
	lead_backend_drift: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1309 carrier/backend reconciliation",
	},
	// FLY-1364: observations of fail-closed shell safety paths. A human decides
	// whether a foreign cmux ref or prolonged rescue hold is safe to resolve.
	cmux_cleanup: { owner: "claude", arc: "human_by_design" },
	cmux_watcher_stalled: {
		owner: "claude",
		arc: "human_by_design",
	},
	cmux_watcher_unrecovered: {
		owner: "claude",
		arc: "human_by_design",
	},
	tmux_rescue_hold: { owner: "claude", arc: "human_by_design" },
	// Informational routing bypasses owner/ARC; keep an exhaustive inert contract.
	flag_scan_failed: { owner: "claude", arc: "human_by_design" },
	flag_scan_handoff: { owner: "claude", arc: "human_by_design" },
	flag_scan_no_clock: { owner: "claude", arc: "human_by_design" },
	meeting_notes_failed: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef:
			"按 signature 里的 failureClass 定位(schema=raya 存档损坏 / identity=issue 歧义 / linear·bridge=依赖不可用 / config=preflight);恢复依赖健康即可,幂等 tick 自行收敛,无需手工补状态",
	},
	// FLY-1929: host IPC-voucher pressure / kernel-panic recurrence. There is NO
	// executable remediation today — the containment action (restarting an Apple
	// LaunchDaemon) is root- and founder-gated, so this is honestly human_by_design
	// rather than a pending "auto".
	host_voucher_incident: {
		owner: "claude",
		arc: "human_by_design",
		remediationRef: "FLY-1929",
	},
};

/**
 * Startup validation (fail-loud, PRD §4.4): every kind must satisfy
 * (a) arc="auto" with a remediationRef and a BOT owner, or (b) an explicit
 * no-ARC posture with the owner named. Violations throw listing every
 * offending kind — the Bridge must refuse to start (called in plugin
 * initialization, before listen). Parameters are injectable for tests only.
 */
export function validateKindContracts(
	contracts: Record<string, KindContract> = KIND_CONTRACTS,
	kinds: readonly string[] = ALERT_EVENT_TYPES,
): void {
	const problems: string[] = [];
	for (const kind of kinds) {
		const c = contracts[kind];
		if (!c) {
			problems.push(`${kind}: missing contract entry`);
			continue;
		}
		if (!c.owner) {
			problems.push(`${kind}: missing owner`);
			continue;
		}
		if (c.arc === "auto") {
			if (!c.remediationRef?.trim()) {
				problems.push(`${kind}: arc="auto" requires a remediationRef`);
			}
			if (c.owner === "founder_direct" || c.owner === "owning_lead") {
				problems.push(
					`${kind}: arc="auto" must be bot-owned (${c.owner} cannot run an ARC)`,
				);
			}
		}
	}
	if (problems.length > 0) {
		throw new Error(
			`[kind-contract] INVALID kind contract(s) — Bridge refuses to start (FLY-1082 fail-loud):\n  ${problems.join(
				"\n  ",
			)}`,
		);
	}
}
