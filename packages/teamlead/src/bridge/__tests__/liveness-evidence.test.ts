import { describe, expect, it } from "vitest";
import { decideDestructive } from "../destructive-verdict.js";
import {
	activityWindowMs,
	describeActivityEvidence,
} from "../liveness-evidence.js";

/**
 * FLY-1329 (A2): activity evidence annotates the alert; it never moves a verdict.
 */

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe("FLY-1329 A2 activity evidence — wording", () => {
	it("recent heartbeat → likely-alive (the FLY-1319 shape: stale mapping, live runner)", () => {
		const v = describeActivityEvidence(
			{ heartbeatAtMs: NOW - 2 * MIN, lastMessageAtMs: null },
			NOW,
		);
		expect(v.assessment).toBe("likely-alive");
		expect(v.detail).toContain("heartbeat");
	});

	it("a recent message alone is enough for likely-alive", () => {
		const v = describeActivityEvidence(
			{ heartbeatAtMs: NOW - 60 * MIN, lastMessageAtMs: NOW - 30_000 },
			NOW,
		);
		expect(v.assessment).toBe("likely-alive");
	});

	it("all evidence older than the window → likely-dead", () => {
		const v = describeActivityEvidence(
			{ heartbeatAtMs: NOW - 40 * MIN, lastMessageAtMs: NOW - 55 * MIN },
			NOW,
		);
		expect(v.assessment).toBe("likely-dead");
	});

	/**
	 * Codex R1 LOW-5: the FLY-1319 shape — a stale heartbeat but a recent CommDB
	 * `ask` — must read likely-alive, not likely-dead. The boolean within-window
	 * signal alone carries it.
	 */
	it("stale heartbeat + a recent CommDB message → likely-alive (the FLY-1319 shape)", () => {
		const v = describeActivityEvidence(
			{
				heartbeatAtMs: NOW - 40 * MIN, // heartbeat gone stale
				lastMessageAtMs: null,
				hasRecentMessageInWindow: true, // but the runner still spoke recently
			},
			NOW,
		);
		expect(v.assessment).toBe("likely-alive");
		expect(v.detail).toContain("window");
	});

	it("the recent-message boolean alone (no stamps) is likely-alive, not unknown", () => {
		const v = describeActivityEvidence(
			{
				heartbeatAtMs: null,
				lastMessageAtMs: null,
				hasRecentMessageInWindow: true,
			},
			NOW,
		);
		expect(v.assessment).toBe("likely-alive");
	});

	/** No evidence must read as "unknown", never as a reading we do not have. */
	it("no timestamps at all → unknown (never a manufactured reading)", () => {
		const v = describeActivityEvidence(
			{ heartbeatAtMs: null, lastMessageAtMs: null },
			NOW,
		);
		expect(v.assessment).toBe("unknown");
		expect(v.detail).toContain("cannot say");
	});

	it("the env window only changes wording thresholds", () => {
		const e = { heartbeatAtMs: NOW - 20 * MIN, lastMessageAtMs: null };
		expect(describeActivityEvidence(e, NOW, 10 * MIN).assessment).toBe(
			"likely-dead",
		);
		expect(describeActivityEvidence(e, NOW, 30 * MIN).assessment).toBe(
			"likely-alive",
		);
	});

	it("activityWindowMs is fixed at 10 minutes", () => {
		expect(activityWindowMs()).toBe(600_000);
	});
});

/**
 * THE structural guarantee, stated as a test: the verdict function does not
 * accept activity evidence at all, so no amount of it can authorize destruction.
 * This is what keeps A2 an alert annotation rather than a second FLY-1319.
 */
describe("FLY-1329 A2: activity evidence cannot reach the verdict", () => {
	it("absent + very fresh activity still refuses to close (evidence is not an input)", () => {
		const v = decideDestructive({
			action: "handoff_close",
			authority: "none",
			declaredParked: false,
			liveness: "absent",
		});
		expect(v.allowed).toBe(false);
	});

	it("absent + no activity whatsoever STILL refuses to close", () => {
		// The symmetric case: "looks dead" is not evidence of death either. Only
		// dead_pin authorizes. If this ever flips, an idle-but-live runner whose
		// window lookup went stale gets destroyed — FLY-1319, exactly.
		const v = decideDestructive({
			action: "handoff_close",
			authority: "none",
			declaredParked: false,
			liveness: "absent",
		});
		expect(v.allowed).toBe(false);
	});
});
