/**
 * FLY-871 R2/C7 — account summary (the bot's daily "看" read of the ledger + store).
 */

import { describe, expect, it } from "vitest";
import {
	type AccountLedger,
	buildAccountSummary,
	formatAccountSummary,
} from "../account-heal/account-ledger.js";
import type { AccountStore } from "../account-heal/account-store.js";

const store: AccountStore = {
	generation: 4,
	activeAccount: "school",
	accounts: [
		{
			name: "school",
			quotaExhaustedUntil: null,
			weeklyResetAt: "2026-07-07T14:00:00Z",
		},
		{
			name: "personal",
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
			authExpired: true,
		},
	],
};

const ledger: AccountLedger = {
	updatedAt: "2026-07-04T20:00:00.000Z",
	accounts: {
		school: {
			name: "school",
			balance: {
				fivehPct: 40,
				weeklyPct: 82,
				fivehResetAt: null,
				weeklyResetAt: "2026-07-07T14:00:00Z",
				source: "statusline",
				observedAt: "2026-07-04T19:30:00.000Z",
				observedWhileActive: true,
			},
			capEvents: [
				{
					at: "2026-07-04T10:00:00Z",
					scope: "5h",
					resetAt: "2026-07-04T15:00:00Z",
				},
			],
			auth: { lastFreshness: "refreshed" },
		},
		// personal: no ledger entry (idle, no data)
	},
};

describe("buildAccountSummary", () => {
	const lines = buildAccountSummary(ledger, store, "2026-07-04T20:00:00.000Z");

	it("marks the active account + carries balance %/age from the ledger", () => {
		const school = lines.find((l) => l.name === "school");
		expect(school?.active).toBe(true);
		expect(school?.fivehPct).toBe(40);
		expect(school?.weeklyPct).toBe(82);
		expect(school?.balanceAgeMin).toBe(30); // 19:30 → 20:00
		expect(school?.balanceLive).toBe(true);
		expect(school?.authHealth).toBe("refreshed");
		expect(school?.openCaps).toBe(1); // one un-recovered cap event
	});

	it("an idle account with no ledger data reads unknown/auth-unusable from the store", () => {
		const personal = lines.find((l) => l.name === "personal");
		expect(personal?.active).toBe(false);
		expect(personal?.fivehPct).toBeNull();
		expect(personal?.balanceAgeMin).toBeNull();
		expect(personal?.authHealth).toBe("unknown");
		expect(personal?.authUnusable).toBe(true); // store authExpired flag
	});
});

describe("formatAccountSummary", () => {
	it("renders a terse per-account line, ★ on the active one", () => {
		const text = formatAccountSummary(
			buildAccountSummary(ledger, store, "2026-07-04T20:00:00.000Z"),
		);
		expect(text).toContain("Claude accounts (2)");
		expect(text).toMatch(
			/★ school:.*5h 40%.*7d 82%.*30m live.*refreshed.*caps:1/,
		);
		expect(text).toMatch(/personal:.*auth✗/);
	});

	it("keeps the legacy output byte-for-byte when the store has no observation", () => {
		expect(
			formatAccountSummary(
				buildAccountSummary(ledger, store, "2026-07-04T20:00:00.000Z"),
			),
		).toBe(
			"Claude accounts (2):\n★ school: 5h 40% · 7d 82% (30m live) · refreshed caps:1\n  personal: 5h ? · 7d ? (no-data) · auth✗",
		);
	});

	it("handles an empty pool", () => {
		expect(
			formatAccountSummary(
				buildAccountSummary(
					{ updatedAt: "", accounts: {} },
					{ generation: 0, activeAccount: null, accounts: [] },
					"2026-07-04T20:00:00.000Z",
				),
			),
		).toBe("No Claude accounts provisioned.");
	});
});

describe("FLY-1252 summary observation precedence", () => {
	function observedStore(
		lastObservedAt: string,
		fivehPct = 12,
		weeklyPct = 34,
	): AccountStore {
		return {
			...store,
			accounts: store.accounts.map((account) =>
				account.name === "school"
					? {
							...account,
							lastObservedAt,
							observedFiveHPct: fivehPct,
							observedSevenDPct: weeklyPct,
							weeklyResetAt: "2026-07-08T14:00:00Z",
						}
					: account,
			),
		};
	}

	it("uses the newer store observation as one unmixed snapshot and labels its age", () => {
		const [school] = buildAccountSummary(
			ledger,
			observedStore("2026-07-04T19:50:00.000Z"),
			"2026-07-04T20:00:00.000Z",
		);
		expect(school).toMatchObject({
			balanceSource: "observed",
			fivehPct: 12,
			weeklyPct: 34,
			weeklyResetAt: "2026-07-08T14:00:00Z",
			balanceAgeMin: 10,
		});
		expect(formatAccountSummary([school!])).toContain("observed 10m ago");
	});

	it("uses the newer ledger snapshot as one unmixed snapshot and preserves legacy rendering", () => {
		const [school] = buildAccountSummary(
			ledger,
			observedStore("2026-07-04T19:00:00.000Z", 99, 98),
			"2026-07-04T20:00:00.000Z",
		);
		expect(school).toMatchObject({
			balanceSource: "ledger",
			fivehPct: 40,
			weeklyPct: 82,
			weeklyResetAt: "2026-07-07T14:00:00Z",
			balanceAgeMin: 30,
		});
		expect(formatAccountSummary([school!])).toBe(
			"Claude accounts (1):\n★ school: 5h 40% · 7d 82% (30m live) · refreshed caps:1",
		);
	});

	it("lets the parseable timestamp win when the other source is malformed", () => {
		const [ledgerWins] = buildAccountSummary(
			ledger,
			observedStore("not-an-iso-time", 99, 98),
			"2026-07-04T20:00:00.000Z",
		);
		expect(ledgerWins?.balanceSource).toBe("ledger");

		const malformedLedger: AccountLedger = {
			...ledger,
			accounts: {
				...ledger.accounts,
				school: {
					...ledger.accounts.school!,
					balance: {
						...ledger.accounts.school!.balance!,
						observedAt: "not-an-iso-time",
					},
				},
			},
		};
		const [storeWins] = buildAccountSummary(
			malformedLedger,
			observedStore("2026-07-04T19:50:00.000Z"),
			"2026-07-04T20:00:00.000Z",
		);
		expect(storeWins?.balanceSource).toBe("observed");
	});

	it("uses a valid store observation when the ledger has no balance", () => {
		const emptyLedger: AccountLedger = { updatedAt: "", accounts: {} };
		const [school] = buildAccountSummary(
			emptyLedger,
			observedStore("2026-07-04T19:55:00.000Z"),
			"2026-07-04T20:00:00.000Z",
		);
		expect(school).toMatchObject({
			balanceSource: "observed",
			fivehPct: 12,
			weeklyPct: 34,
			balanceAgeMin: 5,
		});
	});
});
