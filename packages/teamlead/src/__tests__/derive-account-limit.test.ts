/**
 * FLY-696 M1/C3 — deriveAccountLimitForAlert: the thin composition LeadWatchdog /
 * RunnerQuotaDetector call to turn a capped pane into AlertMetadata.accountLimit.
 * Reads the pool's active account + generation (the CAS snapshot) and the pane's
 * own timezone, then defers to buildAccountLimitMetadata. Kept pure/isolated so
 * the LeadWatchdog wiring is a tiny flag-gated call into that sensitive file.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStore } from "../account-heal/account-store.js";
import {
	deriveAccountLimitForAlert,
	extractTimezone,
} from "../account-heal/derive-account-limit.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

const NOW = new Date("2026-07-03T20:00:00Z");

describe("extractTimezone", () => {
	it("pulls the IANA zone from the 'reset at … (America/Chicago)' message", () => {
		expect(extractTimezone(fx("usage-limit-real.txt"), "UTC")).toBe(
			"America/Chicago",
		);
	});
	it("falls back when no zone is present", () => {
		expect(extractTimezone("no zone here", "America/New_York")).toBe(
			"America/New_York",
		);
	});
});

describe("deriveAccountLimitForAlert", () => {
	let dir: string;
	let storePath: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly696-derive-"));
		storePath = join(dir, "claude-accounts.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("uses the pool's active account + generation as the CAS snapshot", () => {
		writeStore(
			{
				generation: 7,
				activeAccount: "personal",
				accounts: [
					{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				],
			},
			storePath,
		);
		const m = deriveAccountLimitForAlert({
			pane: fx("usage-limit-real.txt"),
			now: NOW,
			storePath,
		});
		expect(m).toEqual({
			provider: "claude",
			scope: "5h",
			resetAt: "2026-07-04T02:30:00.000Z",
			observedAccount: "personal",
			observedGeneration: 7,
		});
	});

	it("returns null when the pool has no active account (not provisioned)", () => {
		writeStore({ generation: 0, activeAccount: null, accounts: [] }, storePath);
		expect(
			deriveAccountLimitForAlert({
				pane: fx("usage-limit-real.txt"),
				now: NOW,
				storePath,
			}),
		).toBeNull();
	});

	it("returns null on an ambiguous gauge (→ needs_human)", () => {
		writeStore(
			{
				generation: 1,
				activeAccount: "personal",
				accounts: [
					{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				],
			},
			storePath,
		);
		expect(
			deriveAccountLimitForAlert({
				pane: fx("usage-gauge-ambiguous.txt"),
				now: NOW,
				storePath,
			}),
		).toBeNull();
	});
});
