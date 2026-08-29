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
 * `none_escalate` vs `human_by_design` (the distinction is load-bearing):
 *  - `none_escalate`: the owner-first / auto response is ALREADY spent or is
 *    deliberately out of scope — the ticket lands directly ESCALATED at
 *    enqueue and never enters the ARC retry loop. Legacy precedent:
 *    `runner_lead_pending_unhandled` (the FLY-637-ext ladder already nudged
 *    the Lead K times); new: `zombie_session_backlog` (reaping = FLY-1066).
 *  - `human_by_design`: a human decision by design (permissions, billing,
 *    re-login, investigation). The ticket opens NEW; the AutoRepairBot's
 *    dispatch returns `needs_human` with the kind-specific reason and the Hub
 *    escalates with that copy — the pre-FLY-1082 behavior, byte-compatible.
 */

import {
	ALERT_EVENT_TYPES,
	type AlertEventType,
} from "../LeadAlertNotifier.js";

/**
 * Ticket owner class. `cross_by_provider` = "nobody rescues their own side":
 * the ticket's provider decides the owning bot (claude problem → codex bot and
 * vice versa — the ticket-owner-map cross family). `founder_direct` = no bot
 * owner by design (a human decision); resolveTicketOwner returns `none`.
 */
export type KindOwner =
	| "claude"
	| "codex"
	| "cross_by_provider"
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
	// nudge rounds) — lands directly ESCALATED (legacy special case, now
	// contract-driven).
	runner_lead_pending_unhandled: {
		owner: "founder_direct",
		arc: "none_escalate",
	},

	// ── Provider-agnostic infra kinds — Claude workhorse default (CMP-2).
	crash_loop: { owner: "claude", arc: "human_by_design" },
	pane_hash_stuck: {
		owner: "claude",
		arc: "auto",
		remediationRef: "lead-resume-enter (audited single Enter, FLY-368)",
	},
	pane_error_stalled: { owner: "claude", arc: "human_by_design" },
	// FLY-1048 PR-C: unified detection escalation kinds. Bridge-side, provider-
	// neutral default owner (claude); no executable auto-fix — a human decides
	// (fleet aggregate → investigate common cause; page-undeliverable → ensure
	// the founder is reached), mirroring the pane_error_stalled sibling contract.
	detection_fleet_aggregate: { owner: "claude", arc: "human_by_design" },
	detection_page_undeliverable: { owner: "claude", arc: "human_by_design" },
	runner_stuck_unhandled: {
		owner: "claude",
		arc: "auto",
		remediationRef: "runner-recovery-nudge (audited continue, FLY-368)",
	},
	runner_throttle_stalled: {
		owner: "claude",
		arc: "auto",
		remediationRef: "runner-recovery-nudge (audited continue, FLY-927 W-B)",
	},
	auto_qa_stuck: { owner: "claude", arc: "human_by_design" },
	codex_gate_blocked: { owner: "claude", arc: "human_by_design" },
	three_stage_stuck: { owner: "claude", arc: "human_by_design" },
	founder_milestone_undelivered: { owner: "claude", arc: "human_by_design" },
	tui_window_lost: { owner: "claude", arc: "human_by_design" },
	restart_guard_bypass: { owner: "claude", arc: "human_by_design" },
	bridge_boot_stale_checkout: { owner: "claude", arc: "human_by_design" },
	bridge_wrapper_fail: { owner: "claude", arc: "human_by_design" },
	bin_integrity_drift: { owner: "claude", arc: "human_by_design" },
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

	// ── FLY-1082 fleet kinds — every one has a named owner + executable ARC
	// (or an explicit (b) posture). Fleet-level failures never fall through to
	// the founder unowned again.
	swap_pressure_high: {
		owner: "claude",
		arc: "auto",
		remediationRef:
			"pressure-hold（可逆暂停派新 runner）+ 各 Lead 降载通知 (FLY-1082)",
	},
	tmux_server_lost: {
		owner: "claude",
		arc: "auto",
		remediationRef:
			"server-loss coordinator：成组终态迁移 + 按 Lead 分组通知带 resume 指针 (FLY-1082)",
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
};

/**
 * Does this kind land directly ESCALATED at enqueue (bypassing the ARC retry
 * loop)? Drives the infra-alert-wiring ticket seed + the Hub's by-design
 * escalate path — the generalization of the old hardcoded
 * `runner_lead_pending_unhandled` special case.
 */
export function escalatesAtEnqueue(kind: AlertEventType): boolean {
	return KIND_CONTRACTS[kind]?.arc === "none_escalate";
}

/**
 * FLY-1082 (Task 3.1): founder-facing copy for the fleet kinds' T2
 * escalation — the four-element template (kind · ARC 试了什么 · 为什么失败 ·
 * Annie 只需拍的那一个决定) renders from this table. 人话 only, never a PRD
 * number (founder-facing copy rule). Kinds absent here keep the legacy
 * escalate line byte-for-byte (存量 kind 文案不回归重写).
 */
export const FLEET_ESCALATION_COPY: Partial<
	Record<AlertEventType, { label: string; decision: string }>
> = {
	swap_pressure_high: {
		label: "机器内存吃紧（OOM 预警）",
		decision:
			"水位一直没退：要不要人工收掉一批 runner（还是同意继续 hold 等它回落）？",
	},
	tmux_server_lost: {
		label: "承载 runner 的 tmux server 丢了",
		decision:
			"有 Lead 没收到阵亡通知或没动手：要不要点名让它复活自己的 runner？",
	},
	bridge_abnormal_exit: {
		label: "Bridge 非正常退出",
		decision: "复活后对账一直没走完：要不要人工看一眼 Bridge 日志？",
	},
	infra_bot_down: {
		label: "infra bot 掉线",
		decision: "自动重启没救活：要不要人工重启这个 bot（或先停用它）？",
	},
	zombie_session_backlog: {
		label: "跨 Lead 僵尸 session 积压",
		decision: "要不要人工清理这批僵尸 session？",
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
			if (c.owner === "founder_direct") {
				problems.push(
					`${kind}: arc="auto" must be bot-owned (founder_direct cannot run an ARC)`,
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
