/**
 * FLY-1048 PR-C (C4a): old/new escalation-flow mutual exclusion — the
 * StuckRunnerDetector side.
 *
 * When the UNIFIED detection-escalation flow owns an ACTIVE episode
 * (detection_escalations row, status != RESOLVED) for the same
 * (executionId, episodeFingerprint), the OLD emitters must not double-fire:
 *   - the runner_stuck_escalation Lead emit is skipped, and
 *   - the Q7 fallback (runner_stuck_unhandled / runner_throttle_stalled) is
 *     skipped — the unified flow's ~30min reconcile owns the founder page.
 *
 * The guard is a per-poll SHORT-CIRCUIT, never a terminal hand-over: the
 * episode is left un-escalated so the moment the unified row goes inactive
 * while the runner is STILL frozen, the old flow resumes on the next poll
 * (the "C is never missed" north star outranks tidiness). A throwing guard
 * is treated as "not owned" — fail toward alerting.
 *
 * Dep absent (env FLYWHEEL_DETECTION_ESCALATION unset → the plugin never
 * wires it) = pre-PR-C behavior byte-for-byte.
 */

import { describe, expect, it, vi } from "vitest";
import { STUCK_THRESHOLD_MS } from "../bridge/stuck-candidate.js";
import {
	type CaptureOutcome,
	type CommSignals,
	LEAD_GRACE_MS,
	type StuckEscalationPayload,
	StuckRunnerDetector,
	type StuckRunnerDetectorDeps,
	type StuckUnhandledPayload,
} from "../bridge/stuck-runner-detector.js";
import type { Session } from "../StateStore.js";

const T0 = 1_000_000_000_000;

function session(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "ISSUE-1",
		project_name: "geo",
		status: "running",
		...over,
	};
}

interface Harness {
	detector: StuckRunnerDetector;
	emit: ReturnType<typeof vi.fn>;
	emitted: StuckEscalationPayload[];
	clock: { now: number };
}

function harness(over: Partial<StuckRunnerDetectorDeps> = {}): Harness {
	const clock = { now: T0 };
	const emitted: StuckEscalationPayload[] = [];
	const emit = vi.fn(async (p: StuckEscalationPayload) => {
		emitted.push(p);
		return true;
	});
	const detector = new StuckRunnerDetector({
		capture: async (): Promise<CaptureOutcome> => ({
			ok: true,
			output: "frozen output, unchanged",
		}),
		probeCommSignals: (): CommSignals => ({
			hasPendingGate: false,
			hasRecentOutbound: false,
		}),
		emit,
		consumeExpiredDispositions: () => {},
		now: () => clock.now,
		...over,
	});
	return { detector, emit, emitted, clock };
}

/** Two same-output polls across the stagnation threshold. */
async function stagnate(h: Harness, s = session()): Promise<void> {
	h.clock.now = T0;
	await h.detector.checkSession(s);
	h.clock.now = T0 + STUCK_THRESHOLD_MS;
	await h.detector.checkSession(s);
}

describe("StuckRunnerDetector — unified-flow episode guard (FLY-1048 C4a)", () => {
	it("dep absent → escalation emits exactly as before (byte-compat)", async () => {
		const h = harness();
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("unifiedOwnsEpisode=false → escalation emits (guard is a no-op)", async () => {
		const owns = vi.fn(() => false);
		const h = harness({ unifiedOwnsEpisode: owns });
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
		// The guard was consulted with the episode's own identity.
		expect(owns).toHaveBeenCalledWith(
			"exec-1",
			h.emitted[0]!.episodeFingerprint,
		);
	});

	it("unifiedOwnsEpisode=true → old Lead emit is SKIPPED", async () => {
		const h = harness({ unifiedOwnsEpisode: () => true });
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("guard-skip is per-poll: row goes inactive while still frozen → old flow resumes", async () => {
		let owned = true;
		const h = harness({ unifiedOwnsEpisode: () => owned });
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();

		// Unified episode resolved (e.g. Lead dismissed) but the pane is STILL
		// frozen — the very next poll must emit through the old flow.
		owned = false;
		h.clock.now = T0 + STUCK_THRESHOLD_MS + 30_000;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("a THROWING guard is treated as not-owned (fail toward alerting)", async () => {
		const h = harness({
			unifiedOwnsEpisode: () => {
				throw new Error("db unavailable");
			},
		});
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("Q7 fallback is suppressed while the unified flow owns the episode, and resumes when it stops", async () => {
		let owned = false;
		const alerted: StuckUnhandledPayload[] = [];
		const alertUnhandled = vi.fn(async (p: StuckUnhandledPayload) => {
			alerted.push(p);
			return true;
		});
		const h = harness({
			alertUnhandled,
			unifiedOwnsEpisode: () => owned,
		});

		// Old flow escalates first (row not yet written — the race window).
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);

		// Unified row appears before the Q7 grace elapses → Q7 must stay quiet
		// (the unified reconcile owns the founder page now).
		owned = true;
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS + 1;
		await h.detector.checkSession(session());
		expect(alertUnhandled).not.toHaveBeenCalled();

		// Row resolved while STILL frozen → the next poll pages via Q7 again.
		owned = false;
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS + 30_000;
		await h.detector.checkSession(session());
		expect(alertUnhandled).toHaveBeenCalledTimes(1);
		expect(alerted[0]!.episodeFingerprint).toBe(
			h.emitted[0]!.episodeFingerprint,
		);
	});

	it("Q7 guard throwing → Q7 still pages (fail toward alerting)", async () => {
		const alertUnhandled = vi.fn(async () => true);
		let armed = false;
		const h = harness({
			alertUnhandled,
			unifiedOwnsEpisode: () => {
				if (!armed) return false; // let the initial escalation go out
				throw new Error("db unavailable");
			},
		});
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);

		armed = true;
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS + 1;
		await h.detector.checkSession(session());
		expect(alertUnhandled).toHaveBeenCalledTimes(1);
	});
});
