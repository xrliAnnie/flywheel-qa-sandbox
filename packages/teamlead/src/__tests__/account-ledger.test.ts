/**
 * FLY-871 R2/C7 — account state ledger: statusLine rate_limits parser, gauge
 * fallback, store round-trip, record APIs, and the extracted selection fn
 * (v1 == selectNextAccount, ledger ignored).
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AccountLedger,
	balanceFromGauge,
	parseRateLimits,
	readLedger,
	recommendNextAccount,
	recordAuthHealth,
	recordBalance,
	recordCapEvent,
	recordCapRecovery,
	recordPoolFreshness,
	writeLedger,
} from "../account-heal/account-ledger.js";
import type { AccountStore } from "../account-heal/account-store.js";
import { selectNextAccount } from "../account-heal/account-store.js";
import type { UsageGauge } from "../account-heal/usage-gauge.js";

function tmp(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "fly871-ledger-"));
	return { dir, path: join(dir, "ledger.json") };
}

describe("parseRateLimits (statusLine primary source)", () => {
	const AT = "2026-07-04T20:00:00.000Z";

	it("parses full payload {rate_limits:{...}} with epoch->ISO reset", () => {
		const snap = parseRateLimits(
			{
				rate_limits: {
					five_hour: { used_percentage: 45, resets_at: 1738425600 },
					seven_day: { used_percentage: 82, resets_at: 1738857600 },
				},
			},
			AT,
			true,
		);
		expect(snap).not.toBeNull();
		expect(snap?.fivehPct).toBe(45);
		expect(snap?.weeklyPct).toBe(82);
		expect(snap?.fivehResetAt).toBe(new Date(1738425600 * 1000).toISOString());
		expect(snap?.weeklyResetAt).toBe(new Date(1738857600 * 1000).toISOString());
		expect(snap?.source).toBe("statusline");
		expect(snap?.observedWhileActive).toBe(true);
	});

	it("accepts the rate_limits object directly (not wrapped)", () => {
		const snap = parseRateLimits(
			{ five_hour: { used_percentage: 10, resets_at: 1738425600 } },
			AT,
			true,
		);
		expect(snap?.fivehPct).toBe(10);
		expect(snap?.weeklyPct).toBeNull();
	});

	it("each window independently absent", () => {
		const snap = parseRateLimits(
			{
				rate_limits: {
					seven_day: { used_percentage: 60, resets_at: 1738857600 },
				},
			},
			AT,
			false,
		);
		expect(snap?.fivehPct).toBeNull();
		expect(snap?.fivehResetAt).toBeNull();
		expect(snap?.weeklyPct).toBe(60);
		expect(snap?.observedWhileActive).toBe(false);
	});

	it("returns null when rate_limits is entirely absent", () => {
		expect(parseRateLimits({ context_window: {} }, AT, true)).toBeNull();
		expect(parseRateLimits({ rate_limits: {} }, AT, true)).toBeNull();
	});

	it("returns null for non-object input", () => {
		expect(parseRateLimits(null, AT, true)).toBeNull();
		expect(parseRateLimits("nope", AT, true)).toBeNull();
	});

	it("ignores a non-numeric used_percentage / resets_at", () => {
		const snap = parseRateLimits(
			{ rate_limits: { five_hour: { used_percentage: "45", resets_at: "x" } } },
			AT,
			true,
		);
		// both fields unusable -> the window is empty -> whole thing null
		expect(snap).toBeNull();
	});
});

describe("balanceFromGauge (fallback source)", () => {
	it("maps a parsed gauge into a snapshot tagged source=gauge", () => {
		const gauge: UsageGauge = {
			fivehPct: 100,
			weeklyPct: 82,
			fivehResetAt: "2026-07-04T21:30:00.000Z",
			weeklyResetAt: "2026-07-06T14:00:00.000Z",
			scope: "5h",
			confidence: "high",
		};
		const snap = balanceFromGauge(gauge, "2026-07-04T20:00:00.000Z", true);
		expect(snap.source).toBe("gauge");
		expect(snap.fivehPct).toBe(100);
		expect(snap.weeklyResetAt).toBe("2026-07-06T14:00:00.000Z");
	});
});

describe("ledger store", () => {
	it("missing file -> empty ledger", () => {
		const { dir, path } = tmp();
		try {
			expect(readLedger(path)).toEqual({ updatedAt: "", accounts: {} });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("malformed file -> empty ledger (tolerant)", () => {
		const { dir, path } = tmp();
		try {
			writeLedger({ updatedAt: "x", accounts: {} } as AccountLedger, path);
			// corrupt it
			require("node:fs").writeFileSync(path, "{ not json");
			expect(readLedger(path).accounts).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips + leaves no temp file (atomic)", () => {
		const { dir, path } = tmp();
		try {
			recordBalance(
				"school",
				parseRateLimits(
					{
						rate_limits: {
							five_hour: { used_percentage: 30, resets_at: 1738425600 },
						},
					},
					"2026-07-04T20:00:00.000Z",
					true,
				)!,
				path,
			);
			const l = readLedger(path);
			expect(l.accounts.school?.balance?.fivehPct).toBe(30);
			expect(l.updatedAt).toBe("2026-07-04T20:00:00.000Z");
			// no leftover temp files
			expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("record APIs", () => {
	it("cap event append + recovery marks the latest open event", () => {
		const { dir, path } = tmp();
		try {
			recordCapEvent(
				"school",
				{
					at: "2026-07-04T10:00:00Z",
					scope: "5h",
					resetAt: "2026-07-04T15:00:00Z",
				},
				path,
			);
			recordCapEvent(
				"school",
				{
					at: "2026-07-04T16:00:00Z",
					scope: "weekly",
					resetAt: "2026-07-07T09:00:00Z",
				},
				path,
			);
			recordCapRecovery("school", "2026-07-04T16:30:00Z", path);
			const evs = readLedger(path).accounts.school?.capEvents ?? [];
			expect(evs).toHaveLength(2);
			// latest open (the weekly one) got recovered; the earlier one stays open
			expect(evs[1]?.recoveredAt).toBe("2026-07-04T16:30:00Z");
			expect(evs[0]?.recoveredAt).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cap recovery is a no-op when no open event / no entry", () => {
		const { dir, path } = tmp();
		try {
			recordCapRecovery("ghost", "2026-07-04T16:30:00Z", path); // no entry
			expect(readLedger(path).accounts.ghost).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("auth health + pool freshness records", () => {
		const { dir, path } = tmp();
		try {
			recordAuthHealth(
				"school",
				{
					lastVerifiedAt: "2026-07-04T12:00:00Z",
					lastFreshness: "stale",
					reason: "refresh refused",
				},
				path,
			);
			recordPoolFreshness(
				"school",
				{
					expiresAt: "2026-07-04T23:00:00Z",
					capturedBackAt: "2026-07-04T11:00:00Z",
				},
				"2026-07-04T12:05:00Z",
				path,
			);
			const e = readLedger(path).accounts.school;
			expect(e?.auth.lastFreshness).toBe("stale");
			expect(e?.pool?.expiresAt).toBe("2026-07-04T23:00:00Z");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("recommendNextAccount (v1 == selectNextAccount, ledger hook ignored)", () => {
	const store: AccountStore = {
		generation: 3,
		activeAccount: "school",
		accounts: [
			{
				name: "school",
				quotaExhaustedUntil: "2999-01-01T00:00:00Z",
				weeklyResetAt: null,
			},
			{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
			{ name: "business", quotaExhaustedUntil: null, weeklyResetAt: null },
		],
	};
	const input = {
		scope: "5h" as const,
		currentName: "school",
		now: new Date("2026-07-04T20:00:00Z"),
	};

	it("v1 returns exactly what selectNextAccount returns", () => {
		expect(recommendNextAccount(store, input)).toBe(
			selectNextAccount(store, input),
		);
	});

	it("passing a ledger does not change the v1 result (hook is inert in v1)", () => {
		const ledger: AccountLedger = {
			updatedAt: "2026-07-04T20:00:00Z",
			accounts: {
				// even if 'business' looks "healthier" in the ledger, v1 must ignore it
				business: {
					name: "business",
					balance: {
						fivehPct: 1,
						weeklyPct: 1,
						fivehResetAt: null,
						weeklyResetAt: null,
						source: "statusline",
						observedAt: "2026-07-04T20:00:00Z",
						observedWhileActive: false,
					},
					capEvents: [],
					auth: {},
				},
			},
		};
		expect(recommendNextAccount(store, input, ledger)).toBe(
			selectNextAccount(store, input),
		);
	});
});
