/**
 * FLY-927 (Task 3.4, W-B): runner throttle-stall classification + the
 * AutoRepairBot subtype wiring. Synthetic fixtures first (FLY-218 precedent);
 * real captures replace them as a follow-up.
 */
import { describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import { AutoRepairBot } from "../AutoRepairBot.js";
import {
	detectThrottleStall,
	evaluateStuckCandidate,
} from "../stuck-candidate.js";

const STALLED_PANE = [
	"⏺ pushing branch…",
	"  ⎿ API Error: 529 overloaded_error",
	"  Server is temporarily limiting requests (not your usage limit)",
	"", // no spinner at all — dead after the throttle
].join("\n");

const HEALTHY_RETRY_PANE = [
	"⏺ pushing branch…",
	"  Server is temporarily limiting requests (not your usage limit)",
	"✻ Retrying in 8s (attempt 3/10)… (esc to interrupt)",
].join("\n");

const FROZEN_PLAIN_PANE = [
	"⏺ running tests…",
	"✻ Cooking… (esc to interrupt)",
].join("\n");

describe("detectThrottleStall (must-alert / must-not fixtures)", () => {
	it("MUST-CLASSIFY: stagnant pane + throttle residue + no live retry", () => {
		expect(detectThrottleStall(STALLED_PANE)).toBe(true);
	});

	it("MUST-NOT: a live retry line (spinner carrying its own retry text)", () => {
		expect(detectThrottleStall(HEALTHY_RETRY_PANE)).toBe(false);
	});

	it("MUST-NOT: a plain frozen turn without throttle residue (stays runner_stuck_unhandled)", () => {
		expect(detectThrottleStall(FROZEN_PLAIN_PANE)).toBe(false);
	});

	it("conservative: residue + spinner WITHOUT retry text on the spinner line → classified stalled", () => {
		const pane = [
			"  Server is temporarily limiting requests (not your usage limit)",
			"✻ Cooking… (esc to interrupt)",
		].join("\n");
		// stagnant (caller-established) + residue + spinner not vouching a retry
		expect(detectThrottleStall(pane)).toBe(true);
	});

	it("evaluateStuckCandidate stamps throttleStalled on the escalated episode", () => {
		const base = {
			status: "running",
			hasPendingGate: false,
			hasRecentCommActivity: false,
			hasPendingReviewSignal: false,
			output: STALLED_PANE,
			thresholdMs: 1000,
		};
		const first = evaluateStuckCandidate({
			...base,
			prior: null,
			now: 0,
		} as never);
		const result = evaluateStuckCandidate({
			...base,
			prior: first.episode,
			now: 5000,
		} as never);
		expect(result.candidate).toBe(true);
		expect(result.episode?.throttleStalled).toBe(true);
	});
});

describe("AutoRepairBot runner_throttle_stalled subtype", () => {
	function payload(over: Partial<AlertPayload> = {}): AlertPayload {
		return {
			leadId: "l",
			projectName: "p",
			eventId: "e",
			eventType: "runner_throttle_stalled",
			title: "t",
			body: "b",
			severity: "warning",
			...over,
		};
	}

	it("canAttempt(runner_throttle_stalled) === true", () => {
		const bot = new AutoRepairBot({
			runnerNudge: vi.fn(),
			leadResumeEnter: vi.fn(),
		});
		expect(bot.canAttempt(payload())).toBe(true);
	});

	it("attempt reuses the audited continue-nudge with the runnerStuck metadata", async () => {
		const runnerNudge = vi.fn(async () => ({
			body: { nudged: true, tmuxWindow: "w1" },
		})) as never;
		const bot = new AutoRepairBot({ runnerNudge, leadResumeEnter: vi.fn() });
		const r = await bot.attempt(
			payload({
				metadata: {
					runnerStuck: { executionId: "x1", episodeFingerprint: "fp" },
				},
			}),
			"ck",
		);
		expect(r.outcome).toBe("attempted");
		expect(runnerNudge).toHaveBeenCalledTimes(1);
	});

	it("missing runnerStuck metadata → refuses to nudge blind (needs_human)", async () => {
		const bot = new AutoRepairBot({
			runnerNudge: vi.fn(),
			leadResumeEnter: vi.fn(),
		});
		const r = await bot.attempt(payload(), "ck");
		expect(r.outcome).toBe("needs_human");
	});
});
