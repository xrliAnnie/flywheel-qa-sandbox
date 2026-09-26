/**
 * FLY-696 M1/② — the account-switch watchdog tick.
 *
 * Piggybacks the Bridge's existing 30s poll cadence (no new timer — FLY-169
 * discipline): reads the durable pending records and fires `executeSwitch` on
 * those whose deadline has passed and no Infra Bot has claimed (M1-only = the
 * bot never claims, so the watchdog fires within a poll cycle → prompt). The
 * pending record is resolved inside executeSwitch. Restart-safe: a record
 * written before a Bridge restart is picked up by the next tick. One failing
 * record is logged and never wedges the others.
 */

import type { RepairDisposition } from "./account-switch-repair.js";
import {
	duePending,
	type PendingSwitch,
	readPending,
} from "./pending-store.js";

export interface AccountSwitchWatchdogDeps {
	now: () => number;
	pendingPath?: string;
	executeSwitch: (pending: PendingSwitch) => Promise<RepairDisposition>;
	/**
	 * Post the switch result into the Alerts thread. FLY-929: the full
	 * disposition rides along as an OPTIONAL second argument so the plugin's
	 * post site can route needs_human failures to the owner bot and append the
	 * notify digest on `notifySuccess` — existing single-arg callers are
	 * untouched (byte-compat).
	 */
	post: (detail: string, disposition?: RepairDisposition) => Promise<void>;
	/**
	 * FLY-871 R3/W5: fired AFTER a successful switch (`outcome === "attempted"`) so
	 * the rescue runtime can sweep every session still stuck at a login prompt in
	 * the incident window (Annie 4945ebf9: "换号成功就把这一波卡登录的都救了"). Optional
	 * ⇒ undefined = no sweep (byte-compat / self-heal off). Independently
	 * try/caught so a sweep failure never wedges the switch or the poll loop.
	 */
	onSwitchSuccess?: () => Promise<void>;
	logger?: (msg: string) => void;
}

/** Fire all due pending switches. Returns how many were fired. */
export async function accountSwitchWatchdogTick(
	deps: AccountSwitchWatchdogDeps,
): Promise<number> {
	const due = duePending(readPending(deps.pendingPath), deps.now());
	let fired = 0;
	for (const pending of due) {
		try {
			const result = await deps.executeSwitch(pending);
			await deps.post(result.detail, result);
			fired++;
			// FLY-871 R3/W5: a successful switch → sweep the incident-window logins.
			if (result.outcome === "attempted" && deps.onSwitchSuccess) {
				try {
					await deps.onSwitchSuccess();
				} catch (sweepErr) {
					deps.logger?.(
						`account-switch watchdog: post-switch rescue sweep failed: ${
							sweepErr instanceof Error ? sweepErr.message : String(sweepErr)
						}`,
					);
				}
			}
		} catch (err) {
			deps.logger?.(
				`account-switch watchdog: executeSwitch failed for ${pending.key}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return fired;
}
