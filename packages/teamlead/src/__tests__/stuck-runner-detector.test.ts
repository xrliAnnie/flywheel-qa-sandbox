import { describe, expect, it, vi } from "vitest";
import { STUCK_THRESHOLD_MS } from "../bridge/stuck-candidate.js";
import {
	type CaptureOutcome,
	defaultHasPendingReviewSignal,
	dispositionSuppresses,
	LEAD_GRACE_MS,
	type StuckEscalationPayload,
	StuckRunnerDetector,
	type StuckRunnerDetectorDeps,
	type StuckUnhandledPayload,
} from "../bridge/stuck-runner-detector.js";
import type { Session, StuckDispositionRow } from "../StateStore.js";

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

	it("retries emit when emit resolves false (e.g. no owning Lead)", async () => {
		const emit = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
		const h = harness({ emit });
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(emit).toHaveBeenCalledTimes(1);
		expect(h.detector.episodeFor("exec-1")?.escalated).toBe(false);
		h.clock.now = T0 + STUCK_THRESHOLD_MS * 2;
		await h.detector.checkSession(session());
		expect(emit).toHaveBeenCalledTimes(2);
		expect(h.detector.episodeFor("exec-1")?.escalatedAt).toBe(
			T0 + STUCK_THRESHOLD_MS * 2,
		);
	});

	it("uses a precaptured outcome without calling its own capture dep", async () => {
		const captureSpy = vi.fn(async (): Promise<CaptureOutcome> => {
			throw new Error("must not be called");
		});
		const h = harness({ capture: captureSpy });
		h.clock.now = T0;
		await h.detector.checkSession(session(), { ok: true, output: "frozen" });
		h.clock.now = T0 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session(), { ok: true, output: "frozen" });
		expect(captureSpy).not.toHaveBeenCalled();
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("precaptured { ok:false } fails closed (skip, keep clock)", async () => {
		const h = harness();
		h.clock.now = T0;
		await h.detector.checkSession(session(), { ok: true, output: "frozen" });
		h.clock.now = T0 + STUCK_THRESHOLD_MS;
		const r = await h.detector.checkSession(session(), {
			ok: false,
			error: "infra error",
		});
		expect(r).toBeNull();
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.firstStagnantAt).toBe(T0);
	});
});

// ── FLY-195 plan §3.4: disposition consult on the escalation path ──

function dispositionRow(
	over: Partial<StuckDispositionRow> = {},
): StuckDispositionRow {
	return {
		execution_id: "exec-1",
		episode_fingerprint: "x",
		disposition: "false_positive",
		snooze_until_ms: null,
		noted_by: "product-lead",
		note: null,
		created_at: "2026-06-03",
		...over,
	};
}

describe("dispositionSuppresses", () => {
	it("suppresses on any non-snooze disposition", () => {
		for (const d of [
			"handled_remanaged",
			"false_positive",
			"legitimate_wait",
			"needs_founder",
		] as const) {
			expect(
				dispositionSuppresses(dispositionRow({ disposition: d }), T0),
			).toBe(true);
		}
	});

	it("snooze suppresses only until expiry; missing ts never suppresses", () => {
		const snooze = dispositionRow({
			disposition: "snooze",
			snooze_until_ms: T0 + 1,
		});
		expect(dispositionSuppresses(snooze, T0)).toBe(true);
		expect(dispositionSuppresses(snooze, T0 + 1)).toBe(false);
		expect(
			dispositionSuppresses(
				dispositionRow({ disposition: "snooze", snooze_until_ms: null }),
				T0,
			),
		).toBe(false);
	});

	it("no row never suppresses", () => {
		expect(dispositionSuppresses(undefined, T0)).toBe(false);
	});
});

describe("StuckRunnerDetector — disposition on escalation (Bridge-restart rebuild)", () => {
	it("does NOT re-page the Lead for an episode already judged (persisted disposition)", async () => {
		const h = harness({
			getDisposition: () => dispositionRow({ disposition: "false_positive" }),
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();
		const ep = h.detector.episodeFor("exec-1");
		expect(ep?.escalated).toBe(true);
		expect(ep?.annieAlerted).toBe(true);
	});

	it("an EXPIRED snooze does not suppress — Lead is re-paged", async () => {
		const h = harness({
			getDisposition: () =>
				dispositionRow({ disposition: "snooze", snooze_until_ms: T0 - 1 }),
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("disposition read error on escalation path → emit anyway (over-page, never drop)", async () => {
		const h = harness({
			getDisposition: () => {
				throw new Error("db hiccup");
			},
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});
});

// ── FLY-195 plan §3.6: Q7 fallback (runner_stuck_unhandled) ──

interface Q7Harness extends Harness {
	alerts: StuckUnhandledPayload[];
	alertUnhandled: ReturnType<typeof vi.fn>;
	setDisposition: (row: StuckDispositionRow | undefined) => void;
}

function q7harness(over: Partial<StuckRunnerDetectorDeps> = {}): Q7Harness {
	let row: StuckDispositionRow | undefined;
	const alerts: StuckUnhandledPayload[] = [];
	const alertUnhandled = vi.fn(async (p: StuckUnhandledPayload) => {
		alerts.push(p);
		return true;
	});
	const h = harness({
		getDisposition: () => row,
		alertUnhandled,
		...over,
	}) as Q7Harness;
	h.alerts = alerts;
	h.alertUnhandled = alertUnhandled;
	h.setDisposition = (r) => {
		row = r;
	};
	return h;
}

/** Stagnate → escalate at T0+threshold, then advance past the grace window. */
async function escalateAndPassGrace(h: Q7Harness): Promise<void> {
	h.setOutput("stuck silent");
	await stagnate(h); // escalates at T0 + STUCK_THRESHOLD_MS
	h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
	await h.detector.checkSession(session());
}

describe("StuckRunnerDetector — Q7 fallback (unhandled → Annie)", () => {
	it("no disposition past grace → alerts Annie exactly once", async () => {
		const h = q7harness();
		await escalateAndPassGrace(h);
		expect(h.alertUnhandled).toHaveBeenCalledTimes(1);
		const p = h.alerts[0]!;
		expect(p.session.execution_id).toBe("exec-1");
		expect(p.escalatedAt).toBe(T0 + STUCK_THRESHOLD_MS);
		expect(p.stuckMinutes).toBeGreaterThanOrEqual(10);
		// further polls: same episode, no re-alert
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 3;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).toHaveBeenCalledTimes(1);
	});

	it("does not alert before the grace window elapses", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h);
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS - 1;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
	});

	it("a disposition arriving during grace suppresses the Annie alert (re-read at claim time, Codex R2 LOW-R2-2)", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h);
		// Lead writes the receipt AFTER the escalation, BEFORE grace expiry.
		h.setDisposition(dispositionRow({ disposition: "legitimate_wait" }));
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.annieAlerted).toBe(true);
	});

	it("an unexpired snooze suppresses; after expiry (still stuck) Annie is alerted", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h);
		const expiry = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 2;
		h.setDisposition(
			dispositionRow({ disposition: "snooze", snooze_until_ms: expiry }),
		);
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		// Snooze expired, episode still frozen → page Annie.
		h.clock.now = expiry + 1;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).toHaveBeenCalledTimes(1);
	});

	it("alert failure (throw) retries on the next poll", async () => {
		const failing = vi
			.fn()
			.mockRejectedValueOnce(new Error("discord down"))
			.mockResolvedValue(true);
		const h = q7harness({ alertUnhandled: failing });
		await escalateAndPassGrace(h);
		expect(failing).toHaveBeenCalledTimes(1);
		expect(h.detector.episodeFor("exec-1")?.annieAlerted).toBeFalsy();
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS + 30_000;
		await h.detector.checkSession(session());
		expect(failing).toHaveBeenCalledTimes(2);
		expect(h.detector.episodeFor("exec-1")?.annieAlerted).toBe(true);
	});

	it("alert resolving false retries on the next poll", async () => {
		const declining = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const h = q7harness({ alertUnhandled: declining });
		await escalateAndPassGrace(h);
		expect(declining).toHaveBeenCalledTimes(1);
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS + 30_000;
		await h.detector.checkSession(session());
		expect(declining).toHaveBeenCalledTimes(2);
	});

	it("disposition re-read error defers (neither pages nor terminally suppresses)", async () => {
		let shouldThrow = false;
		const h = q7harness({
			getDisposition: () => {
				if (shouldThrow) throw new Error("db hiccup");
				return undefined;
			},
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		shouldThrow = true;
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.annieAlerted).toBeFalsy();
		// Read recovers → alert goes out.
		shouldThrow = false;
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS + 30_000;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).toHaveBeenCalledTimes(1);
	});

	it("output changing after escalation clears the episode — no Annie alert", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h);
		h.setOutput("runner resumed!");
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		// fresh episode (not escalated)
		expect(h.detector.episodeFor("exec-1")?.escalated).toBe(false);
	});

	it("grace window does not start while the escalation emit is still failing", async () => {
		const emit = vi.fn().mockResolvedValue(false);
		const h = q7harness({ emit });
		h.setOutput("stuck silent");
		await stagnate(h);
		// emit never persisted → escalatedAt unset → no Q7 alert even far past grace.
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 5;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
	});
});
