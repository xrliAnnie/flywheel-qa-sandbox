/**
 * FLY-927 (Task 3.5, W-B acceptance): PRD §4.2's "idle 1h ≠ 冻结" judgement
 * standard as PERMANENT acceptance assertions over the COMMITTED real
 * fixtures. Test-only — no logic changes; a future recognizer edit that
 * re-breaks any of these is a regression, not a tuning choice.
 *
 * Known accepted blind spot (FLY-193/FLY-218 docs): a runner frozen
 * mid-extended-thinking WITHOUT an esc hint is indistinguishable from a live
 * turn in a single capture — fixing it would re-break the idle-spam cure.
 * Follow-up: capture a real frozen-mid-thinking pane before revisiting.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isIdleHealthyPane, isTransientThrottlePane } from "../LeadWatchdog.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const loadFixture = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

describe("FLY-927 acceptance: idle 1h ≠ frozen (isIdleHealthyPane)", () => {
	it.each([
		"idle-cos-lead.txt",
		"idle-ops-lead.txt",
		"idle-product-lead.txt",
		// The Peter trap (FLY-193): 100%-ctx idle pane MUST stay suppressed.
		"idle-product-lead-ctx100.txt",
	])("MUST-SUPPRESS real idle fixture %s", (fixture) => {
		expect(isIdleHealthyPane(loadFixture(fixture))).toBe(true);
	});

	it.each([
		// A resume/compact menu replaces the TUI — a human must answer it.
		"freeze-resume-menu.txt",
		"freeze-compact-prompt.txt",
		// A frozen auto-compact is a REAL stuck condition.
		"freeze-compacting.txt",
	])("MUST-ALERT real freeze fixture %s (never idle-suppressed)", (fixture) => {
		expect(isIdleHealthyPane(loadFixture(fixture))).toBe(false);
	});
});

describe("FLY-927 acceptance: 529 — healthy transient suppressed, true blocks alert", () => {
	it("MUST-SUPPRESS: live 529 backoff (lead alive, self-resolves)", () => {
		expect(isTransientThrottlePane(loadFixture("throttle-529-live.txt"))).toBe(
			true,
		);
	});

	it.each([
		// A GENUINE usage cap right after a throttle must never be masked.
		"throttle-529-then-usage-cap.txt",
		// Menu overlays / frozen compacts beside a stale 529 stay must-alert.
		"throttle-529-then-resume-menu.txt",
		"throttle-529-then-compacting.txt",
		// A frozen normal turn (no retry hint) above a stale 529.
		"throttle-529-then-frozen-work.txt",
	])("MUST-ALERT: %s is NOT throttle-suppressed", (fixture) => {
		expect(isTransientThrottlePane(loadFixture(fixture))).toBe(false);
	});
});
