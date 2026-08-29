/**
 * FLY-871 R2/C7 — flywheel-account-summary CLI: reads ledger + store, prints
 * the terse per-account summary. (This CLI is the production consumer that makes
 * the ledger read-side non-dead — the bot invokes it daily.)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseRateLimits,
	recordBalance,
} from "../account-heal/account-ledger.js";
import { writeStore } from "../account-heal/account-store.js";
import { runAccountSummaryCli } from "../account-heal/account-summary-cli.js";

describe("runAccountSummaryCli", () => {
	let dir: string;
	let ledgerPath: string;
	let storePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly871-summary-cli-"));
		ledgerPath = join(dir, "ledger.json");
		storePath = join(dir, "accounts.json");
		writeStore(
			{
				generation: 1,
				activeAccount: "school",
				accounts: [
					{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
				],
			},
			storePath,
		);
		const snap = parseRateLimits(
			{
				rate_limits: {
					five_hour: { used_percentage: 20, resets_at: 1738425600 },
				},
			},
			"2026-07-04T20:00:00.000Z",
			true,
		);
		if (snap) recordBalance("school", snap, ledgerPath);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("prints the account summary from the ledger + store", () => {
		const logs: string[] = [];
		const code = runAccountSummaryCli({
			ledgerPath,
			storePath,
			now: () => "2026-07-04T20:00:00.000Z",
			log: (m) => logs.push(m),
		});
		expect(code).toBe(0);
		expect(logs[0]).toContain("Claude accounts (1)");
		expect(logs[0]).toContain("★ school");
		expect(logs[0]).toContain("5h 20%");
	});

	it("empty pool prints the no-accounts line", () => {
		const logs: string[] = [];
		runAccountSummaryCli({
			ledgerPath: join(dir, "missing-ledger.json"),
			storePath: join(dir, "missing-store.json"),
			now: () => "2026-07-04T20:00:00.000Z",
			log: (m) => logs.push(m),
		});
		expect(logs[0]).toBe("No Claude accounts provisioned.");
	});
});
