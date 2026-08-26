/**
 * FLY-368: the conservative auto-repair bot.
 *
 * Given an alert, it attempts only safe, reversible recovery actions and
 * nothing destructive.
 *
 * Everything else — rate/usage/login/permission/crash, compact prompts, unknown
 * states — is left for a human (returns `needs_human` with an actionable reason).
 * The bot NEVER restarts/kills a Lead or Runner; those stay founder-gated
 * (FLY-175) and belong to the FLY-271 recovery engine.
 *
 * Enablement (default OFF) is owned by the caller (plugin.ts only constructs the
 * bot when `FLYWHEEL_AUTO_REPAIR=1`); when absent, AlertChannelHub simply does
 * not run any repair.
 */

import type { AccountSwitchRepair } from "../account-heal/account-switch-repair.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";

/**
 * "attempted" = a safe action was sent but recovery is NOT yet confirmed (Codex
 * code R1 MEDIUM-2: a delivered keystroke is not proof the runner/Lead advanced).
 * The authoritative "✅ 已恢复" comes later from the Hub's resolve path (driven by
 * the reconcile pass / onRecovery), NOT from the bot. "needs_human" = no safe
 * action was taken. "no_action" = the observed state is already safe or the
 * episode has ended; it is monitored without consuming an attempt.
 */
export type RepairOutcome = "attempted" | "needs_human" | "no_action";

export interface RepairResult {
	outcome: RepairOutcome;
	/** Audit label for the attempted repair, or "none". */
	action: string;
	/**
	 * The line the Hub posts into the per-error thread.
	 *  - `attempted`: the full Cass-voiced "🔧 已 …" line, posted verbatim.
	 *  - `needs_human`: the reason only; enqueue leaves the ticket NEW and silent
	 *    (except an explicit cap-owner handoff), while a rejected reconcile retry
	 *    posts the reason without a mention.
	 *  - `no_action`: a neutral monitoring line, posted without any mention.
	 */
	detail: string;
}

export interface AutoRepairBotDeps {
	/**
	 * FLY-696: the Claude account-switch repair (canAttempt/attempt). When wired
	 * (plugin.ts, gated on FLYWHEEL_ACCOUNT_SELF_HEAL + a provisioned pool), a
	 * usage_limit alert becomes an attemptable account rotation instead of
	 * needs_human. Absent → usage_limit stays human-only (byte-compat).
	 */
	accountSwitch?: AccountSwitchRepair;
	/**
	 * FLY-1082: fleet-kind repairs, wired by plugin.ts (fleet-sensors module).
	 * All REVERSIBLE by construction: the pressure-hold can be lifted, the
	 * kickstart is idempotent. Absent → the kind degrades to needs_human
	 * (sensor kill-switch off / tests).
	 */
	fleetRepair?: {
		/**
		 * swap_pressure_high: the sensor already places the hold at trigger and
		 * routes the human signal through the alert ticket. This idempotent repair
		 * reconfirms only the hold and never re-pauses a recovered episode.
		 */
		swapPressure?: (payload: AlertPayload) => Promise<RepairResult>;
		/** infra_bot_down: `launchctl kickstart -k` the dead bot's job. */
		infraBotKickstart?: (payload: AlertPayload) => Promise<RepairResult>;
	};
}

/** Account/billing/login/permission kinds the bot must NEVER touch — human-only. */
export const HUMAN_ONLY_REASON: Partial<
	Record<AlertPayload["eventType"], string>
> = {
	rate_limit:
		"API rate limit reached — waits out on its own; not auto-fixable (a human can confirm it is not a tight loop).",
	usage_limit:
		"Claude usage cap hit — needs an account top-up; not auto-fixable.",
	login_expired:
		"CLI login expired — needs a human re-login; not auto-fixable.",
	permission_blocked:
		"waiting on a permission prompt — NEVER auto-confirmed (a human must approve/deny).",
	crash_loop: "crash-looping — needs investigation; not auto-fixable.",
	// FLY-637-ext: the Lead has ignored a runner's blocking question for several
	// backoff rounds. The runner is fine — do NOT nudge it; the ticket remains
	// available for explicit duty handling.
	runner_lead_pending_unhandled:
		"a runner is blocked waiting on the Lead to answer its question, and the Lead has not responded after several reminders — the Lead needs a human poke (the runner is fine; nothing to auto-repair).",
};

export class AutoRepairBot {
	constructor(private readonly deps: AutoRepairBotDeps) {}

	/**
	 * FLY-368 v1.58.0: does Cass actually attempt a repair for this alert? The Hub
	 * uses it to word the ack honestly (only kinds that get tried say
	 * "正在尝试自动修复…"; everything else remains NEW for duty handling). Shares its logic
	 * with `attempt()` so the two can never drift.
	 *
	 * FLY-696: now payload-aware (Codex R2/R5) — `usage_limit` is attemptable only
	 * when the account-switch repair is wired AND says so (flag on + usable
	 * accountLimit metadata + an available account), which is exactly what the
	 * `attempt()` branch below does, keeping ack and outcome in sync.
	 */
	canAttempt(payload: AlertPayload): boolean {
		if (payload.eventType === "usage_limit") {
			return this.deps.accountSwitch?.canAttempt(payload) ?? false;
		}
		// FLY-1082: fleet kinds — attemptable iff the wired repair (or, for the
		// detection-time remediations, the evidence metadata) is present, so the
		// Hub ack never claims a repair that won't happen.
		switch (payload.eventType) {
			case "swap_pressure_high":
				return !!this.deps.fleetRepair?.swapPressure;
			case "infra_bot_down":
				return !!this.deps.fleetRepair?.infraBotKickstart;
			case "tmux_server_lost":
				return !!payload.metadata?.tmuxServerLost;
			case "bridge_abnormal_exit":
				return true; // launchd respawn IS the remediation; boot self-check confirms
			default:
				return false;
		}
	}

	/**
	 * Attempt a conservative repair for one alert. `correlationKey` is the Hub's
	 * stable incident key (used for the Lead-Enter audit trail).
	 */
	async attempt(
		payload: AlertPayload,
		_correlationKey: string,
	): Promise<RepairResult> {
		switch (payload.eventType) {
			// FLY-1082: fleet kinds. swap / bot-down run the wired reversible
			// repair; server-loss / abnormal-exit report the detection-time
			// remediation honestly (the coordinator / launchd already acted —
			// "attempted" here, the reconcile recovery probe decides ✅).
			case "swap_pressure_high": {
				const repair = this.deps.fleetRepair?.swapPressure;
				if (repair) return repair(payload);
				return {
					outcome: "needs_human",
					action: "none",
					detail:
						"swap 压力修复未接线（传感器 kill-switch 关闭或未配置）— 需要人工降载。",
				};
			}
			case "infra_bot_down": {
				const repair = this.deps.fleetRepair?.infraBotKickstart;
				if (repair) return repair(payload);
				return {
					outcome: "needs_human",
					action: "none",
					detail:
						"infra bot kickstart 未接线（传感器 kill-switch 关闭或未配置）— 需要人工重启 launchd job。",
				};
			}
			case "tmux_server_lost": {
				const m = payload.metadata?.tmuxServerLost;
				if (!m) {
					return {
						outcome: "needs_human",
						action: "none",
						detail:
							"tmux server 丢失但缺少协调器摘要（迁移/通知证据缺失）— 需要人工核对 runner 状态。",
					};
				}
				// Codex R2 HIGH: an INCOMPLETE migration must never read as
				// attempted — the recovery probe would quietly resolve the ticket
				// while failed sessions loop silently after the retry budget is spent.
				if (m.migrated < m.casualties) {
					return {
						outcome: "needs_human",
						action: "none",
						detail: `${m.casualties} 个阵亡 runner 只成功迁移了 ${m.migrated} 个（其余在静默重试）— 需要你看一眼卡住的 session 迁移。`,
					};
				}
				if (m.leadsFailed > 0) {
					return {
						outcome: "needs_human",
						action: "none",
						detail: `已迁移 ${m.migrated} 个 runner 终态，但 ${m.leadsFailed} 个 Lead 的阵亡通知投递失败 — 需要你确认这些 Lead 知情并复活各自的 runner。`,
					};
				}
				return {
					outcome: "attempted",
					action: "server_loss_coordinator",
					detail: `🔧 已成组迁移 ${m.migrated} 个 runner 到终态，并给 ${m.leadsNotified} 个 Lead 发了各自的阵亡清单 + resume 指针。respawn 由各 Lead 驱动（铁律）。`,
				};
			}
			case "bridge_abnormal_exit":
				return {
					outcome: "attempted",
					action: "launchd_respawn",
					detail:
						"🔧 launchd 已复活 Bridge（本工单即由复活后的 Bridge 开出）。boot 对账自检完成后自动标记 ✅。",
				};
			case "usage_limit": {
				// FLY-696: a real Claude quota cap → ENQUEUE a durable pending switch
				// (a cross-provider Infra Bot claims it, else the Bridge deadline sweep fires
				// it after the deadline — C8c). Gated by the same canAttempt predicate
				// (flag on + usable metadata + available account) so the ack never
				// claims a repair that won't happen. Absent/not-attemptable → the
				// human-only reason (byte-compat when self-heal is off/unwired).
				if (this.deps.accountSwitch?.canAttempt(payload)) {
					const d = await this.deps.accountSwitch.enqueue(payload);
					return { outcome: d.outcome, action: d.action, detail: d.detail };
				}
				return {
					outcome: "needs_human",
					action: "none",
					detail:
						HUMAN_ONLY_REASON.usage_limit ??
						"no safe auto-repair for this alert kind.",
				};
			}
			default: {
				const reason =
					HUMAN_ONLY_REASON[payload.eventType] ??
					"no safe auto-repair for this alert kind.";
				// Reason-only: the Hub decides whether this is an enqueue-time silent
				// NEW ticket or a reconcile-time no-mention rejection post.
				return { outcome: "needs_human", action: "none", detail: reason };
			}
		}
	}
}
