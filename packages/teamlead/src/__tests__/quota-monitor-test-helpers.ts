import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";

export function usageResult(
	fivePct: number,
	sevenPct: number,
	// `null` is a meaningful value (an unopened window), so default only on
	// `undefined` — `??` would silently swap an explicit null back to a timestamp.
	resets: { five?: string | null; seven?: string | null } = {},
): Extract<AccountUsageResult, { ok: unknown }> {
	const five =
		resets.five === undefined ? "2026-07-14T23:00:00.000Z" : resets.five;
	const seven =
		resets.seven === undefined ? "2026-07-21T14:00:00.000Z" : resets.seven;
	const raw = {
		five_hour: { utilization: fivePct, resets_at: five },
		seven_day: { utilization: sevenPct, resets_at: seven },
	};
	return {
		ok: {
			raw,
			fiveH: { pct: fivePct, resetsAt: five },
			sevenD: { pct: sevenPct, resetsAt: seven },
		},
	};
}
