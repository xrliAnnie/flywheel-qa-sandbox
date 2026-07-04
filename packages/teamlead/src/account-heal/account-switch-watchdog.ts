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
	/** Post the switch result into the Alerts thread. */
	post: (detail: string) => Promise<void>;
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
			await deps.post(result.detail);
			fired++;
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
