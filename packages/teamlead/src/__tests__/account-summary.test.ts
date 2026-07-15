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
