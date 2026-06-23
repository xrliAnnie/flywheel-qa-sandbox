/**
 * FLY-368: the conservative auto-repair bot.
 *
 * Given an alert, it attempts ONLY the two safe, reversible recovery actions a
 * human already does by hand — and NOTHING destructive:
 *   - `runner_stuck_unhandled` → the audited runner `continue` nudge (requires
 *     the structured `metadata.runnerStuck` fingerprint — Codex R1 HIGH-2);
 *   - `pane_hash_stuck` (Lead)  → a single Enter on the EXACT resume-menu shape
 *     (the audited `attemptLeadResumeEnter`, which itself refuses anything that
 *     is not the safe resume menu).
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

import type { AlertPayload } from "../LeadAlertNotifier.js";
import type {
	LeadResumeEnterInput,
	LeadResumeEnterOutcome,
} from "./lead-resume-enter.js";
import type {
	RunnerNudgeInput,
	RunnerNudgeOutcome,
} from "./runner-recovery-nudge.js";

/**
 * "attempted" = a safe action was sent but recovery is NOT yet confirmed (Codex
 * code R1 MEDIUM-2: a delivered keystroke is not proof the runner/Lead advanced).
 * The authoritative "✅ 已恢复" comes later from the Hub's resolve path (driven by
 * the reconcile pass / onRecovery), NOT from the bot. "needs_human" = no safe
 * action was taken.
 */
export type RepairOutcome = "attempted" | "needs_human";

export interface RepairResult {
	outcome: RepairOutcome;
	/** "runner_nudge" | "lead_resume_enter" | "none" */
	action: string;
	/** Human-readable line the Hub posts into the per-error thread. */
	detail: string;
}

export interface AutoRepairBotDeps {
	/** Bound `attemptRunnerRecoveryNudge` (with its Bridge deps pre-applied). */
	runnerNudge: (input: RunnerNudgeInput) => Promise<RunnerNudgeOutcome>;
	/** Bound `attemptLeadResumeEnter` (with its Bridge deps pre-applied). */
	leadResumeEnter: (
		input: LeadResumeEnterInput,
	) => Promise<LeadResumeEnterOutcome>;
	logger?: (msg: string) => void;
}

// FLY-368 rework: auto-repair is attributed to Aunt Cass (the fleet-recovery
// CoS / "the fixer") — the audit actor reflects that. Gate logic is unchanged.
const ACTOR = "aunt-cass";

/** Account/billing/login/permission kinds the bot must NEVER touch — human-only. */
const HUMAN_ONLY_REASON: Partial<Record<AlertPayload["eventType"], string>> = {
	rate_limit:
		"API rate limit reached — waits out on its own; not auto-fixable (a human can confirm it is not a tight loop).",
	usage_limit:
		"Claude usage cap hit — needs an account top-up; not auto-fixable.",
	login_expired:
		"CLI login expired — needs a human re-login; not auto-fixable.",
	permission_blocked:
		"waiting on a permission prompt — NEVER auto-confirmed (a human must approve/deny).",
	crash_loop: "crash-looping — needs investigation; not auto-fixable.",
};

export class AutoRepairBot {
	constructor(private readonly deps: AutoRepairBotDeps) {}

	private log(msg: string): void {
		(this.deps.logger ?? ((m) => console.log(`[AutoRepairBot] ${m}`)))(msg);
	}

	/**
	 * Attempt a conservative repair for one alert. `correlationKey` is the Hub's
	 * stable incident key (used for the Lead-Enter audit trail).
	 */
	async attempt(
		payload: AlertPayload,
		correlationKey: string,
	): Promise<RepairResult> {
		switch (payload.eventType) {
			case "runner_stuck_unhandled":
				return this.repairRunner(payload);
			case "pane_hash_stuck":
				return this.repairLeadPane(payload, correlationKey);
			default: {
				const reason =
					HUMAN_ONLY_REASON[payload.eventType] ??
					"no safe auto-repair for this alert kind.";
				return {
					outcome: "needs_human",
					action: "none",
					detail: `🙋 需要 Annie：${reason}`,
				};
			}
		}
	}

	private async repairRunner(payload: AlertPayload): Promise<RepairResult> {
		const meta = payload.metadata?.runnerStuck;
		if (!meta?.executionId || !meta?.episodeFingerprint) {
			return {
				outcome: "needs_human",
				action: "none",
				detail:
					"🙋 需要 Annie：stuck-runner alert lacks the structured fingerprint — refusing to nudge blind.",
			};
		}
		const outcome = await this.deps.runnerNudge({
			actor: ACTOR,
			executionId: meta.executionId,
			leadId: payload.leadId,
			fingerprint: meta.episodeFingerprint,
			phrase: "continue",
		});
		if (outcome.body.nudged) {
			return {
				outcome: "attempted",
				action: "runner_nudge",
				detail: `🔧 已 nudge runner（发送 "continue" 到 ${outcome.body.tmuxWindow}）。观察是否前进（恢复后会自动标记 ✅）。`,
			};
		}
		this.log(
			`runner nudge refused for ${meta.executionId}: ${outcome.body.error}`,
		);
		return {
			outcome: "needs_human",
			action: "none",
			detail: `🙋 需要 Annie：runner nudge 被安全闸拒绝（${outcome.body.error ?? "unknown"}）。`,
		};
	}

	private async repairLeadPane(
		payload: AlertPayload,
		correlationKey: string,
	): Promise<RepairResult> {
		const outcome = await this.deps.leadResumeEnter({
			actor: ACTOR,
			projectName: payload.projectName,
			leadId: payload.leadId,
			correlationKey,
			eventId: payload.eventId,
		});
		if (outcome.sent) {
			return {
				outcome: "attempted",
				action: "lead_resume_enter",
				detail:
					"🔧 已对 resume 菜单发送 Enter 解卡。观察是否恢复（恢复后会自动标记 ✅）。",
			};
		}
		return {
			outcome: "needs_human",
			action: "none",
			detail: `🙋 需要 Annie：${outcome.reason}`,
		};
	}
}
