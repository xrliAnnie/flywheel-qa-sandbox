/**
 * FLY-696 M1/C5+C8c — the account-switch repair adapter.
 *
 * The seam the AutoRepairBot delegates to. Per the approved plan (Codex R5#4 /
 * C8c) an account cap does NOT switch inline: AutoRepairBot `enqueue`s a durable
 * pending record and returns a "queued" disposition; the actual switch is done
 * later by `executeSwitch` — fired by a cross-provider Infra Bot that claims the
 * record (M2) or, failing that, by the Bridge watchdog once the deadline passes
 * (M1-only = short deadline → prompt). This keeps the Hub ack honest ("排队中")
 * and never claims an inline repair that hasn't happened.
 *
 * Attemptable requires (all): a usable accountLimit metadata (provider claude —
 * MVP Claude-only), and an available account. Anything short → needs_human
 * (never a blind switch). (FLY-1243: the FLYWHEEL_ACCOUNT_SELF_HEAL env flag is
 * retired; construction is gated by the account-pool presence in plugin.ts.)
 */

import type { AlertPayload } from "../LeadAlertNotifier.js";
import {
	earliestReset,
	readStore,
	selectNextAccount,
} from "./account-store.js";
import { withMkdirLock } from "./mkdir-lock.js";
import {
	defaultPendingPath,
	type PendingSwitch,
	pendingKey,
	resolvePending,
	upsertPending,
} from "./pending-store.js";
import {
	switchAccount as defaultSwitchAccount,
	type SwitchDeps,
	type SwitchInput,
	type SwitchResult,
} from "./switch-executor.js";

export interface RepairDisposition {
	outcome: "attempted" | "needs_human";
	action: "account_switch" | "none";
	detail: string;
	/**
	 * FLY-929 W6: structured success payload for the #flywheel-notify digest.
	 * Filled ONLY on a real `switched` executor outcome — never on
	 * noop_already_switched / no_account / failed (a "duplicate trigger skipped"
	 * digest would be noise). Optional ⇒ existing consumers ignore it.
	 */
	notifySuccess?: {
		from?: string;
		to: string;
		scope?: "5h" | "weekly" | "both";
		resetAt?: string;
	};
}

export interface AccountSwitchRepairDeps {
	/** Production switch deps (withLock, applyProfile=Keychain write, readActiveProfile). */
	switchDeps: SwitchDeps;
	now?: () => number;
	storePath?: string;
	pendingPath?: string;
	pendingLockPath?: string;
	/** How long a pending record waits for a bot before the watchdog fires it. */
	deadlineMs?: number;
	/** Test seam; defaults to always-on (FLY-1243: env flag retired). */
	isEnabled?: () => boolean;
	/** Injectable for tests; defaults to the real switchAccount executor. */
	switchImpl?: (input: SwitchInput, deps: SwitchDeps) => Promise<SwitchResult>;
	/** Injectable for tests; defaults to withMkdirLock (pending writes). */
	withLock?: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>;
}

export interface AccountSwitchRepair {
	canAttempt(payload: AlertPayload): boolean;
	/** Write the durable pending record; the switch is fired later. */
	enqueue(payload: AlertPayload): Promise<RepairDisposition>;
	/** Do the actual switch for a claimed/due pending record, then resolve it. */
	executeSwitch(pending: PendingSwitch): Promise<RepairDisposition>;
}

function scopeLabel(scope: "5h" | "weekly" | "both"): string {
	return scope === "both" ? "5h+weekly" : scope;
}

export function makeAccountSwitchRepair(
	deps: AccountSwitchRepairDeps,
): AccountSwitchRepair {
	const now = deps.now ?? Date.now;
	// FLY-1243: FLYWHEEL_ACCOUNT_SELF_HEAL retired (固化 default-on). Construction
	// is gated by the account-pool presence upstream (plugin.ts); the default
	// predicate is now always-on (a real switch still needs a usable gauge + pool).
	const isEnabled = deps.isEnabled ?? (() => true);
	const doSwitch = deps.switchImpl ?? defaultSwitchAccount;
	const withLock = deps.withLock ?? withMkdirLock;
	const deadlineMs = deps.deadlineMs ?? 20_000;
	const pendingPath = deps.pendingPath ?? defaultPendingPath();
	const pendingLockPath = deps.pendingLockPath ?? `${pendingPath}.lock`;

	function usableLimit(payload: AlertPayload) {
		const al = payload.metadata?.accountLimit;
		if (!isEnabled()) return null;
		if (!al || al.provider !== "claude") return null;
		return al;
	}

	function available(
		al: NonNullable<AlertPayload["metadata"]>["accountLimit"],
	) {
		if (!al) return false;
		return (
			selectNextAccount(readStore(deps.storePath), {
				scope: al.scope,
				currentName: al.observedAccount,
				now: new Date(now()),
			}) !== null
		);
	}

	return {
		canAttempt(payload: AlertPayload): boolean {
			const al = usableLimit(payload);
			return al !== null && available(al);
		},

		async enqueue(payload: AlertPayload): Promise<RepairDisposition> {
			const al = usableLimit(payload);
			if (!al || !available(al)) {
				return {
					outcome: "needs_human",
					action: "none",
					detail:
						"Claude 用量封顶,但账号自愈未启用 / 缺可切 metadata / 无可用账号。需要 Annie(充值 / 手动切 / 等 reset)。",
				};
			}
			const nowMs = now();
			const record: PendingSwitch = {
				key: pendingKey(
					payload.eventId,
					al.observedAccount,
					al.observedGeneration,
				),
				provider: "claude",
				sourceAlertId: payload.eventId,
				observedAccount: al.observedAccount,
				observedGeneration: al.observedGeneration,
				scope: al.scope,
				resetAt: al.resetAt,
				deadlineAt: new Date(nowMs + deadlineMs).toISOString(),
				createdAt: new Date(nowMs).toISOString(),
			};
			await withLock(pendingLockPath, async () =>
				upsertPending(record, pendingPath),
			);
			return {
				outcome: "attempted",
				action: "account_switch",
				detail: `🔧 已排队 Claude 账号切换（${scopeLabel(al.scope)} 到, from ${al.observedAccount}）。对端 Infra Bot 处理中;超时由 Bridge 兜底。`,
			};
		},

		async executeSwitch(pending: PendingSwitch): Promise<RepairDisposition> {
			const result = await doSwitch(
				{
					scope: pending.scope,
					observedAccount: pending.observedAccount,
					observedGeneration: pending.observedGeneration,
					resetAt: pending.resetAt,
					now: new Date(now()),
				},
				deps.switchDeps,
			);
			// Best-effort resolve; a double-fire before this is CAS-safe (noop).
			await withLock(pendingLockPath, async () =>
				resolvePending(pending.key, pendingPath),
			);

			switch (result.outcome) {
				case "switched":
					return {
						outcome: "attempted",
						action: "account_switch",
						detail: `🔧 已切机器 Claude 账号 ${result.from}→${result.to}（${scopeLabel(pending.scope)} 到, reset ${pending.resetAt}）。新 spawn 的 runner/lead 用新账号;当前 session 等 reset 或需 founder 重启自愈。`,
						notifySuccess: {
							from: result.from,
							to: result.to,
							scope: pending.scope,
							resetAt: pending.resetAt,
						},
					};
				case "noop_already_switched":
					return {
						outcome: "attempted",
						action: "account_switch",
						detail: `🔧 机器 Claude 账号已切到 ${result.activeAccount}（重复触发,跳过）。`,
					};
				case "no_account": {
					const iso =
						result.earliestReset ?? earliestReset(readStore(deps.storePath));
					return {
						outcome: "needs_human",
						action: "none",
						detail: `所有 Claude 账号都已用尽${iso ? `,最早 reset: ${iso}` : ""}。需要你处理(等 reset / 手动 login)。`,
					};
				}
				case "failed":
					return {
						outcome: "needs_human",
						action: "none",
						detail: `切 Claude 账号失败（${result.reason}）,已保留原账号(未写坏登录)。需要你处理。`,
					};
			}
		},
	};
}
