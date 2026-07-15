import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";

export function usageResult(
	fivePct: number,
	sevenPct: number,
	resets: { five?: string; seven?: string } = {},
): Extract<AccountUsageResult, { ok: unknown }> {
	const five = resets.five ?? "2026-07-14T23:00:00.000Z";
	const seven = resets.seven ?? "2026-07-21T14:00:00.000Z";
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
