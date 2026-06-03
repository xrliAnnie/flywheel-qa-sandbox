import { describe, expect, it, vi } from "vitest";
import { STUCK_THRESHOLD_MS } from "../bridge/stuck-candidate.js";
import {
	type CaptureOutcome,
	defaultHasPendingReviewSignal,
	type StuckEscalationPayload,
	StuckRunnerDetector,
	type StuckRunnerDetectorDeps,
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
	setOutput: (o: string) => void;
	setCapture: (fn: () => Promise<CaptureOutcome>) => void;
	setPendingGate: (fn: () => boolean) => void;
	clock: { now: number };
}

function harness(over: Partial<StuckRunnerDetectorDeps> = {}): Harness {
	const clock = { now: T0 };
	let output = "working...";
	let captureFn: () => Promise<CaptureOutcome> = async () => ({
		ok: true,
		output,
	});
	let pendingGateFn = () => false;
	const emitted: StuckEscalationPayload[] = [];
	const emit = vi.fn(async (p: StuckEscalationPayload) => {
		emitted.push(p);
		return true;
	});
	const detector = new StuckRunnerDetector({
		capture: (..._a) => captureFn(),
		hasPendingGate: (..._a) => pendingGateFn(),
		emit,
		now: () => clock.now,
		...over,
	});
	return {
		detector,
		emit,
		emitted,
		setOutput: (o) => {
			output = o;
		},
		setCapture: (fn) => {
			captureFn = fn;
		},
		setPendingGate: (fn) => {
			pendingGateFn = fn;
		},
		clock,
	};
}

/** Advance two polls of the same output across the threshold. */
async function stagnate(h: Harness, s = session()): Promise<void> {
	h.clock.now = T0;
	await h.detector.checkSession(s);
	h.clock.now = T0 + STUCK_THRESHOLD_MS;
	await h.detector.checkSession(s);
}

describe("defaultHasPendingReviewSignal", () => {
	it("is true only for needs_review route", () => {
		expect(
			defaultHasPendingReviewSignal(
				session({ decision_route: "needs_review" }),
			),
		).toBe(true);
		expect(
			defaultHasPendingReviewSignal(
				session({ decision_route: "auto_approve" }),
			),
		).toBe(false);
		expect(defaultHasPendingReviewSignal(session())).toBe(false);
	});
});

describe("StuckRunnerDetector — happy path", () => {
	it("escalates once after threshold stagnation with evidence", async () => {
		const h = harness();
		h.setOutput(
			"⎿ Read file\nAPI Error: Stream idle timeout - partial response received\n╭──╮\n│ > │\n╰──╯",
		);
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
		const p = h.emitted[0]!;
		expect(p.session.execution_id).toBe("exec-1");
		expect(p.evidence.stream_error_signature).toBe(true);
		expect(p.evidence.stuck_minutes).toBe(10);
		expect(p.episodeFingerprint).toBeTruthy();
	});

	it("dedups: does not re-escalate the same episode", async () => {
		const h = harness();
		h.setOutput("stuck and silent");
		await stagnate(h);
		h.clock.now = T0 + STUCK_THRESHOLD_MS * 2;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("does not escalate before threshold", async () => {
		const h = harness();
		h.setOutput("busy");
		h.clock.now = T0;
		await h.detector.checkSession(session());
		h.clock.now = T0 + STUCK_THRESHOLD_MS - 1;
		await h.detector.checkSession(session());
		expect(h.emit).not.toHaveBeenCalled();
	});
});

describe("StuckRunnerDetector — fail-closed (FLY-191 #213 R1 lesson)", () => {
	it("capture error: skips without escalating and without resetting the clock", async () => {
		const h = harness();
		h.setOutput("stuck silent output");
		h.clock.now = T0;
		await h.detector.checkSession(session()); // episode starts at T0
		const epAtStart = h.detector.episodeFor("exec-1");
		expect(epAtStart?.firstStagnantAt).toBe(T0);

		// Capture fails on the next poll → must skip, NOT escalate, NOT reset.
		h.setCapture(async () => ({ ok: false, error: "tmux window not found" }));
		h.clock.now = T0 + STUCK_THRESHOLD_MS;
		const r = await h.detector.checkSession(session());
		expect(r).toBeNull();
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.firstStagnantAt).toBe(T0);

		// Capture recovers, same output, now past threshold → escalates.
		h.setCapture(async () => ({ ok: true, output: "stuck silent output" }));
		h.clock.now = T0 + STUCK_THRESHOLD_MS + 1;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("capture throwing is caught and treated as fail-closed", async () => {
		const h = harness();
		h.setCapture(async () => {
			throw new Error("boom");
		});
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("pending-gate query error is treated as parked (no escalation)", async () => {
		const h = harness({
			hasPendingGate: () => {
				throw new Error("commdb locked");
			},
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();
	});
});

describe("StuckRunnerDetector — exclusions", () => {
	it("never escalates awaiting_review (FLY-191 idle-reachable)", async () => {
		const h = harness();
		h.setOutput("idle at prompt");
		await stagnate(h, session({ status: "awaiting_review" }));
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
	});

	it("never escalates a runner with a pending gate question", async () => {
		const h = harness();
		h.setPendingGate(() => true);
		h.setOutput("⎿ flywheel-comm gate approve_to_ship");
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("never escalates the needs_review gray zone", async () => {
		const h = harness();
		h.setOutput("⎿ awaiting review");
		await stagnate(h, session({ decision_route: "needs_review" }));
		expect(h.emit).not.toHaveBeenCalled();
	});
});

describe("StuckRunnerDetector — episode lifecycle", () => {
	it("resets the episode when output changes (progress)", async () => {
		const h = harness();
		h.setOutput("a");
		h.clock.now = T0;
		await h.detector.checkSession(session());
		h.setOutput("b");
		h.clock.now = T0 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.firstStagnantAt).toBe(
			T0 + STUCK_THRESHOLD_MS,
		);
	});

	it("pruneInactive drops episodes for gone executions", async () => {
		const h = harness();
		h.setOutput("x");
		await h.detector.checkSession(session());
		expect(h.detector.episodeFor("exec-1")).toBeDefined();
		h.detector.pruneInactive(new Set(["other"]));
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
	});

	it("retries emit on next poll when emit fails (rolls back escalated)", async () => {
		const failingEmit = vi
			.fn()
			.mockRejectedValueOnce(new Error("deliver failed"))
			.mockResolvedValue(true);
		const h = harness({ emit: failingEmit });
		h.setOutput("stuck silent");
		await stagnate(h); // first emit throws → escalated rolled back
		expect(failingEmit).toHaveBeenCalledTimes(1);
		// next poll, still stuck, same episode → retries emit
		h.clock.now = T0 + STUCK_THRESHOLD_MS * 2;
		await h.detector.checkSession(session());
		expect(failingEmit).toHaveBeenCalledTimes(2);
	});
});
