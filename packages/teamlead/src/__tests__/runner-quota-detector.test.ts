/**
 * FLY-696 M1/③ — runner-side quota detection decision.
 *
 * A Claude runner pane can be the first to surface the shared-account cap (Codex
 * R1#1). `detectRunnerQuotaCap` is the pure decision reused by a scan that
 * piggybacks the runner idle poll: honor the §3.3 transient short-circuit, then
 * (only on a real cap) produce the same accountLimit metadata the Lead path
 * produces, so the runner alert flows through the identical enqueue→switch loop.
 * (Shared-account note: the Lead shares the cap and would catch it within a poll
 * cycle anyway — this just surfaces it faster / when all Leads are idle.)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStore } from "../account-heal/account-store.js";
import { detectRunnerQuotaCap } from "../account-heal/runner-quota-detector.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

const NOW = new Date("2026-07-03T20:00:00Z");

let dir: string;
let storePath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-runnerdet-"));
	storePath = join(dir, "claude-accounts.json");
	writeStore(
		{
			generation: 2,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		},
		storePath,
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("detectRunnerQuotaCap", () => {
	it("real cap → accountLimit metadata (same shape as the Lead path)", () => {
		const m = detectRunnerQuotaCap({
			pane: fx("usage-limit-real.txt"),
			now: NOW,
			isTransient: () => false,
			storePath,
		});
		expect(m).toMatchObject({
			provider: "claude",
			scope: "5h",
			observedAccount: "personal",
			observedGeneration: 2,
		});
	});

	it("transient 529 throttle → null (§3.3: retry in place, never switch)", () => {
		const m = detectRunnerQuotaCap({
			pane: fx("usage-limit-real.txt"),
			now: NOW,
			isTransient: () => true, // recognizer says transient
			storePath,
		});
		expect(m).toBeNull();
	});

	it("no gauge / not a cap → null", () => {
		expect(
			detectRunnerQuotaCap({
				pane: "just a runner doing work\n",
				now: NOW,
				isTransient: () => false,
				storePath,
			}),
		).toBeNull();
	});

	it("calls the injected transient recognizer before parsing", () => {
		const isTransient = vi.fn(() => true);
		detectRunnerQuotaCap({
			pane: fx("usage-limit-real.txt"),
			now: NOW,
			isTransient,
			storePath,
		});
		expect(isTransient).toHaveBeenCalledOnce();
	});
});
