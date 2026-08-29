import { describe, expect, it, vi } from "vitest";
import { STUCK_THRESHOLD_MS } from "../bridge/stuck-candidate.js";
import { stuckUnhandledEventId } from "../bridge/stuck-escalation.js";
import {
	type CaptureOutcome,
	type CommSignals,
	defaultHasPendingReviewSignal,
	dispositionSuppresses,
	LEAD_GRACE_MS,
	type StuckDispositionRows,
	type StuckEscalationPayload,
	StuckRunnerDetector,
	type StuckRunnerDetectorDeps,
	type StuckUnhandledPayload,
	selectStuckDisposition,
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
	setRecentActivity: (fn: () => boolean) => void;
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
	let recentActivityFn = () => false;
	const emitted: StuckEscalationPayload[] = [];
	const emit = vi.fn(async (p: StuckEscalationPayload) => {
		emitted.push(p);
		return true;
	});
	const detector = new StuckRunnerDetector({
		capture: (..._a) => captureFn(),
		probeCommSignals: (..._a): CommSignals => ({
			hasPendingGate: pendingGateFn(),
			hasRecentOutbound: recentActivityFn(),
		}),
		emit,
		// Required dep (Codex code R1 MEDIUM-4) — default no-op for tests that
		// don't exercise expiry; expiry-focused suites inject their own.
		consumeExpiredDispositions: () => {},
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
		setRecentActivity: (fn) => {
			recentActivityFn = fn;
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

	it("CommDB probe error is treated as parked (no escalation)", async () => {
		const h = harness({
			probeCommSignals: () => {
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

	// FLY-253 L1
	it("never escalates a runner with recent CommDB outbound activity", async () => {
		const h = harness();
		h.setRecentActivity(() => true);
		h.setOutput("parked after DONE report");
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
	});

	it("activity arriving during the Q7 grace cancels the episode AND the pending Q7 (intentional — Codex R1 #5)", async () => {
		const alerts: StuckUnhandledPayload[] = [];
		const alertUnhandled = vi.fn(async (p: StuckUnhandledPayload) => {
			alerts.push(p);
			return true;
		});
		const h = harness({ alertUnhandled });
		h.setOutput("stuck silent");
		await stagnate(h); // escalated at T0 + threshold
		expect(h.emit).toHaveBeenCalledTimes(1);
		// Runner sends a CommDB message during the grace window.
		h.setRecentActivity(() => true);
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(alertUnhandled).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
		// Window lapses, pane still frozen → fresh episode → re-escalates after
		// a NEW threshold (delay, not a miss).
		h.setRecentActivity(() => false);
		const t1 = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 2;
		h.clock.now = t1;
		await h.detector.checkSession(session());
		h.clock.now = t1 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(2);
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

	// FLY-253 (Codex R2 #1): timed semantics generalized — a TTL'd latch
	// (legitimate_wait/needs_founder with snooze_until_ms) expires like snooze.
	it("a TTL'd legitimate_wait suppresses until expiry, then stops", () => {
		const ttl = dispositionRow({
			disposition: "legitimate_wait",
			episode_fingerprint: "*",
			snooze_until_ms: T0 + 1,
		});
		expect(dispositionSuppresses(ttl, T0)).toBe(true);
		expect(dispositionSuppresses(ttl, T0 + 1)).toBe(false);
	});

	it("an untimed (NULL) latch is permanent (TTL=0)", () => {
		const permanent = dispositionRow({
			disposition: "needs_founder",
			episode_fingerprint: "*",
			snooze_until_ms: null,
		});
		expect(dispositionSuppresses(permanent, T0 + 1e12)).toBe(true);
	});
});

// ── FLY-253 (Codex R1 #3): exact vs sentinel precedence ──

describe("selectStuckDisposition", () => {
	const exactExpiredSnooze = dispositionRow({
		disposition: "snooze",
		snooze_until_ms: T0 - 1,
	});
	const sentinelActive = dispositionRow({
		disposition: "legitimate_wait",
		episode_fingerprint: "*",
		snooze_until_ms: T0 + 100_000,
	});
	const exactActive = dispositionRow({ disposition: "false_positive" });
	const sentinelExpired = dispositionRow({
		disposition: "legitimate_wait",
		episode_fingerprint: "*",
		snooze_until_ms: T0 - 5,
	});

	it("expired exact snooze + active sentinel ⇒ sentinel suppresses (the R1 bug)", () => {
		const s = selectStuckDisposition(
			{ exact: exactExpiredSnooze, sentinel: sentinelActive },
			T0,
		);
		expect(s?.effective).toBe(true);
		expect(s?.row.episode_fingerprint).toBe("*");
	});

	it("active exact + expired sentinel ⇒ exact suppresses", () => {
		const s = selectStuckDisposition(
			{ exact: exactActive, sentinel: sentinelExpired },
			T0,
		);
		expect(s?.effective).toBe(true);
		expect(s?.row.disposition).toBe("false_positive");
	});

	it("both active ⇒ exact wins (attribution)", () => {
		const s = selectStuckDisposition(
			{ exact: exactActive, sentinel: sentinelActive },
			T0,
		);
		expect(s?.effective).toBe(true);
		expect(s?.row.disposition).toBe("false_positive");
	});

	it("both expired ⇒ expired selection (drives the reminder reset), exact preferred", () => {
		const s = selectStuckDisposition(
			{ exact: exactExpiredSnooze, sentinel: sentinelExpired },
			T0,
		);
		expect(s?.effective).toBe(false);
		expect(s?.row.disposition).toBe("snooze");
	});

	it("no rows ⇒ undefined", () => {
		expect(selectStuckDisposition({}, T0)).toBeUndefined();
	});
});

describe("StuckRunnerDetector — disposition on escalation (Bridge-restart rebuild)", () => {
	it("does NOT re-page the Lead for an episode already judged (persisted disposition)", async () => {
		const h = harness({
			getDispositionRows: () => ({
				exact: dispositionRow({ disposition: "false_positive" }),
			}),
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled();
		const ep = h.detector.episodeFor("exec-1");
		expect(ep?.escalated).toBe(true);
		expect(ep?.annieAlerted).toBe(true);
	});

	it("an EXPIRED snooze does not suppress — Lead is re-paged (and the token is consumed)", async () => {
		const consume = vi.fn();
		const h = harness({
			getDispositionRows: () => ({
				exact: dispositionRow({
					disposition: "snooze",
					snooze_until_ms: T0 - 1,
				}),
			}),
			consumeExpiredDispositions: consume,
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
		expect(consume).toHaveBeenCalledTimes(1);
	});

	it("disposition read error on escalation path → emit anyway (over-page, never drop)", async () => {
		const h = harness({
			getDispositionRows: () => {
				throw new Error("db hiccup");
			},
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	// ── FLY-253 L2: the execution sentinel latch ──

	it("LEARN-57 replay: one legitimate_wait latch silences EVERY later episode (different fingerprints) — 0 escalations, 0 Q7", async () => {
		const alertUnhandled = vi.fn(async () => true);
		// Simulate the Lead's receipt: an execution-scoped sentinel, active.
		const h = harness({
			getDispositionRows: () => ({
				sentinel: dispositionRow({
					disposition: "legitimate_wait",
					episode_fingerprint: "*",
					snooze_until_ms: T0 + 72 * 3_600_000, // 72h TTL
				}),
			}),
			alertUnhandled,
		});
		// Three distinct pane frames, each stagnating past the threshold —
		// exactly the incident shape (mailbox wake / next-round echo between).
		let t = T0;
		for (const frame of ["frame-A", "frame-B", "frame-C"]) {
			h.setOutput(frame);
			h.clock.now = t;
			await h.detector.checkSession(session());
			h.clock.now = t + STUCK_THRESHOLD_MS;
			await h.detector.checkSession(session());
			// drive a potential Q7 pass too
			h.clock.now = t + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
			await h.detector.checkSession(session());
			t = h.clock.now;
		}
		expect(h.emit).not.toHaveBeenCalled();
		expect(alertUnhandled).not.toHaveBeenCalled();
	});

	it("control (no latch): the same three-frame sequence escalates 3 times", async () => {
		const h = harness();
		let t = T0;
		for (const frame of ["frame-A", "frame-B", "frame-C"]) {
			h.setOutput(frame);
			h.clock.now = t;
			await h.detector.checkSession(session());
			h.clock.now = t + STUCK_THRESHOLD_MS;
			await h.detector.checkSession(session());
			t = h.clock.now;
		}
		expect(h.emit).toHaveBeenCalledTimes(3);
	});

	it("expired-receipt consume failure rolls back `escalated` so the next poll retries (Codex R3 LOW-1)", async () => {
		const consume = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("db locked");
			})
			.mockImplementation(() => {});
		let rows: StuckDispositionRows = {
			exact: dispositionRow({
				disposition: "snooze",
				snooze_until_ms: T0 - 1,
			}),
		};
		const h = harness({
			getDispositionRows: () => rows,
			consumeExpiredDispositions: consume,
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		// consume threw → NO emit this poll, escalated rolled back
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.escalated).toBe(false);
		// next poll: consume succeeds (row gone afterwards) → emit goes out
		rows = {};
		h.clock.now = T0 + STUCK_THRESHOLD_MS * 2;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("a malformed snooze (NULL ts) neither suppresses nor consumes — Lead re-paged, no reminder loop", async () => {
		const consume = vi.fn();
		const h = harness({
			getDispositionRows: () => ({
				exact: dispositionRow({
					disposition: "snooze",
					snooze_until_ms: null,
				}),
			}),
			consumeExpiredDispositions: consume,
		});
		h.setOutput("stuck silent");
		await stagnate(h);
		expect(h.emit).toHaveBeenCalledTimes(1);
		expect(consume).not.toHaveBeenCalled();
	});
});

// ── FLY-253 (Codex R1 #1): re_arm reaches the in-memory episode ──

describe("StuckRunnerDetector — rearmExecution", () => {
	it("re-arms a suppressed episode: same fingerprint, no pane change → re-escalates after threshold", async () => {
		let rows: StuckDispositionRows = {
			sentinel: dispositionRow({
				disposition: "legitimate_wait",
				episode_fingerprint: "*",
				snooze_until_ms: null, // permanent latch
			}),
		};
		const h = harness({ getDispositionRows: () => rows });
		h.setOutput("frozen frame");
		await stagnate(h);
		expect(h.emit).not.toHaveBeenCalled(); // latched
		// Lead re-arms: route deletes the DB row AND calls rearmExecution.
		rows = {};
		h.detector.rearmExecution("exec-1");
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
		// Same frozen frame, no pane change: fresh episode → threshold → emit.
		const t1 = T0 + STUCK_THRESHOLD_MS * 2;
		h.clock.now = t1;
		await h.detector.checkSession(session());
		h.clock.now = t1 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(1);
	});
});

// ── FLY-195 plan §3.6: Q7 fallback (runner_stuck_unhandled) ──

interface Q7Harness extends Harness {
	alerts: StuckUnhandledPayload[];
	alertUnhandled: ReturnType<typeof vi.fn>;
	setDisposition: (row: StuckDispositionRow | undefined) => void;
	setRows: (rows: StuckDispositionRows) => void;
	consume: ReturnType<typeof vi.fn>;
}

function q7harness(over: Partial<StuckRunnerDetectorDeps> = {}): Q7Harness {
	let rows: StuckDispositionRows = {};
	const alerts: StuckUnhandledPayload[] = [];
	const alertUnhandled = vi.fn(async (p: StuckUnhandledPayload) => {
		alerts.push(p);
		return true;
	});
	// Default consume mimics the store: drops currently-expired timed rows.
	const consume = vi.fn((_id: string, _fp: string, nowMs: number) => {
		const expired = (r: StuckDispositionRow | undefined) =>
			r?.snooze_until_ms != null && r.snooze_until_ms <= nowMs;
		rows = {
			...(rows.exact && !expired(rows.exact) ? { exact: rows.exact } : {}),
			...(rows.sentinel && !expired(rows.sentinel)
				? { sentinel: rows.sentinel }
				: {}),
		};
	});
	const h = harness({
		getDispositionRows: () => rows,
		consumeExpiredDispositions: consume,
		alertUnhandled,
		...over,
	}) as Q7Harness;
	h.alerts = alerts;
	h.alertUnhandled = alertUnhandled;
	h.consume = consume;
	h.setDisposition = (r) => {
		rows = r ? { exact: r } : {};
	};
	h.setRows = (r) => {
		rows = r;
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

	// FLY-253 (Codex R1 #2 + R2 #2): REWRITTEN from "expiry → page Annie".
	// snooze means "ask ME again later" — expiry now reminds the LEAD first
	// (reminder reset: consume token + drop episode → fresh escalation after
	// threshold, grace re-anchored); Annie only if the Lead stays silent again.
	it("snooze expiry: reminder reset → exactly one NEW Lead escalation → Annie only after the new grace lapses (exactly once)", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h); // escalation #1 at T0+threshold
		expect(h.emit).toHaveBeenCalledTimes(1);
		const expiry = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 2;
		h.setDisposition(
			dispositionRow({ disposition: "snooze", snooze_until_ms: expiry }),
		);
		// During the snooze: no Annie page.
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		// Expiry: the Q7 pass consumes the token and resets the episode —
		// NO Annie page, NO immediate re-emit.
		h.clock.now = expiry + 1;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		expect(h.consume).toHaveBeenCalledTimes(1);
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
		// Fresh episode rebuilds → threshold → escalation #2 to the LEAD.
		h.clock.now = expiry + 2;
		await h.detector.checkSession(session());
		h.clock.now = expiry + 2 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(2);
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		// Lead silent through the NEW grace → Annie, exactly once.
		h.clock.now = expiry + 2 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).toHaveBeenCalledTimes(1);
		// No reminder loop: token consumed, later polls add nothing.
		h.clock.now = expiry + 2 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 3;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(2);
		expect(h.alertUnhandled).toHaveBeenCalledTimes(1);
	});

	it("TTL'd legitimate_wait expiry is OBSERVED (not terminally muted — Codex R2 #1) and reminds the Lead", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h); // escalation #1
		const expiry = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 2;
		h.setRows({
			sentinel: dispositionRow({
				disposition: "legitimate_wait",
				episode_fingerprint: "*",
				snooze_until_ms: expiry, // server-computed TTL
			}),
		});
		// Within TTL: suppressed, but NOT terminal — annieAlerted stays unset.
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.annieAlerted).toBeFalsy();
		// TTL lapses → reminder reset → fresh escalation to the Lead.
		h.clock.now = expiry + 1;
		await h.detector.checkSession(session());
		expect(h.consume).toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
		h.clock.now = expiry + 2;
		await h.detector.checkSession(session());
		h.clock.now = expiry + 2 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(2);
	});

	it("pane change AROUND expiry: natural episode turnover, reminder semantics intact (Codex code R1 LOW-5)", async () => {
		const h = q7harness();
		h.setOutput("frame-A");
		await stagnate(h); // escalation #1 on frame-A
		// Expiry far enough out that a full frame-B stagnation cycle fits inside.
		const expiry = T0 + STUCK_THRESHOLD_MS * 4;
		h.setRows({
			sentinel: dispositionRow({
				disposition: "legitimate_wait",
				episode_fingerprint: "*",
				snooze_until_ms: expiry,
			}),
		});
		// Pane changes BEFORE expiry → fresh episode, latch still suppresses it.
		h.setOutput("frame-B");
		h.clock.now = T0 + STUCK_THRESHOLD_MS * 2;
		await h.detector.checkSession(session());
		h.clock.now = T0 + STUCK_THRESHOLD_MS * 3;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(1); // suppressed by active latch
		// Pane changes again AFTER expiry → fresh episode; the expired latch is
		// consumed on the candidate path and the LEAD gets the reminder.
		h.setOutput("frame-C");
		const t1 = expiry + 1;
		h.clock.now = t1;
		await h.detector.checkSession(session());
		h.clock.now = t1 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.consume).toHaveBeenCalled();
		expect(h.emit).toHaveBeenCalledTimes(2);
		expect(h.alertUnhandled).not.toHaveBeenCalled();
	});

	it("PERSISTENT claims-style dedup does not swallow the second-generation Q7 (Codex code R1 LOW-5 / R2 #3 end-to-end)", async () => {
		// Alerter that mimics LeadAlertNotifier's durable claims.db: dedup by the
		// REAL eventId format across the whole test ("process lifetime").
		const claimed = new Set<string>();
		const alertUnhandled = vi.fn(async (p: StuckUnhandledPayload) => {
			const eventId = stuckUnhandledEventId(
				p.session.execution_id,
				p.episodeFingerprint,
				p.escalatedAt,
			);
			if (claimed.has(eventId)) return true; // duplicate ⇒ reported resolved
			claimed.add(eventId);
			return true;
		});
		const h = q7harness({ alertUnhandled });
		h.setOutput("frozen frame"); // SAME fingerprint throughout
		await stagnate(h); // gen-1 escalation
		// gen-1 Q7
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(claimed.size).toBe(1);
		// Lead re-arms (route cleared rows + detector reset).
		h.setRows({});
		h.detector.rearmExecution("exec-1");
		// gen-2: same frozen frame, fresh episode → new escalation → new grace.
		const t1 = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS + 1;
		h.clock.now = t1;
		await h.detector.checkSession(session());
		h.clock.now = t1 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(2);
		// gen-2 Q7 MUST land as a NEW claim (escalatedAt salt), not a duplicate.
		h.clock.now = t1 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(claimed.size).toBe(2);
	});

	it("TTL'd needs_founder expiry follows the same reminder path (R2 #1: not just snooze)", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h);
		const expiry = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 2;
		h.setRows({
			sentinel: dispositionRow({
				disposition: "needs_founder",
				episode_fingerprint: "*",
				snooze_until_ms: expiry,
			}),
		});
		h.clock.now = expiry + 1;
		await h.detector.checkSession(session());
		expect(h.consume).toHaveBeenCalled();
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
	});

	it("a PERMANENT latch (NULL ts) terminally suppresses — annieAlerted set, no expiry to observe", async () => {
		const h = q7harness();
		h.setOutput("stuck silent");
		await stagnate(h);
		h.setRows({
			sentinel: dispositionRow({
				disposition: "legitimate_wait",
				episode_fingerprint: "*",
				snooze_until_ms: null, // TTL=0
			}),
		});
		h.clock.now = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.annieAlerted).toBe(true);
	});

	// Codex code R1 HIGH-2: sql.js mutates memory BEFORE persisting — a save()
	// failure can leave the rows already deleted. If the Q7 pass kept the old
	// escalated episode on consume-throw, the NEXT poll would read "no receipt"
	// and page Annie off the OLD grace, skipping the Lead reminder entirely.
	// The episode is therefore reset even when consume throws: every outcome
	// funnels back through the candidate path (Lead-reminder-first guarantee).
	it("Q7-pass consume throw with rows ALREADY gone (partial persist failure) still reminds the LEAD first, never Annie directly", async () => {
		const consumeRemovesThenThrows = vi.fn(() => {
			// simulate: memory rows deleted, save() throws
			throw new Error("save failed after delete");
		});
		const h = q7harness({
			consumeExpiredDispositions: consumeRemovesThenThrows,
		});
		h.setOutput("stuck silent");
		await stagnate(h); // escalation #1
		const expiry = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 2;
		h.setDisposition(
			dispositionRow({ disposition: "snooze", snooze_until_ms: expiry }),
		);
		h.clock.now = expiry + 1;
		await h.detector.checkSession(session());
		// consume threw → episode reset ANYWAY (no stale grace can survive).
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		// Rows are gone (partial failure): fresh episode → threshold → the LEAD
		// gets the reminder; Annie is NOT paged off the old grace.
		h.setRows({});
		h.clock.now = expiry + 2;
		await h.detector.checkSession(session());
		h.clock.now = expiry + 2 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(2); // reminder to the Lead
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		// Annie only after the NEW grace lapses with the Lead silent.
		h.clock.now = expiry + 2 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS;
		await h.detector.checkSession(session());
		expect(h.alertUnhandled).toHaveBeenCalledTimes(1);
	});

	it("Q7-pass consume throw with rows INTACT: reset still funnels through the candidate path (consume retried before the reminder emit)", async () => {
		const failingConsume = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("db locked");
			})
			.mockImplementation(() => {});
		const h = q7harness({ consumeExpiredDispositions: failingConsume });
		h.setOutput("stuck silent");
		await stagnate(h);
		const expiry = T0 + STUCK_THRESHOLD_MS + LEAD_GRACE_MS * 2;
		h.setDisposition(
			dispositionRow({ disposition: "snooze", snooze_until_ms: expiry }),
		);
		h.clock.now = expiry + 1;
		await h.detector.checkSession(session());
		// consume threw → episode reset (HIGH-2 semantics), no Annie page.
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
		expect(h.alertUnhandled).not.toHaveBeenCalled();
		// Row still there: fresh episode → threshold → candidate path retries
		// consume (succeeds) → reminder emit to the Lead.
		h.clock.now = expiry + 2;
		await h.detector.checkSession(session());
		h.clock.now = expiry + 2 + STUCK_THRESHOLD_MS;
		await h.detector.checkSession(session());
		expect(failingConsume).toHaveBeenCalledTimes(2);
		expect(h.emit).toHaveBeenCalledTimes(2);
		expect(h.alertUnhandled).not.toHaveBeenCalled();
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
			getDispositionRows: () => {
				if (shouldThrow) throw new Error("db hiccup");
				return {};
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

// ── Codex PR R1 MEDIUM-2: decision-time session re-read ──

describe("StuckRunnerDetector — decision-time session re-read (MEDIUM-2)", () => {
	it("a snapshot that flipped to awaiting_review mid-poll is NOT escalated (episode cleared)", async () => {
		const h = harness({
			refreshSession: () => session({ status: "awaiting_review" }),
		});
		h.setOutput("stuck silent");
		// snapshot still claims running on both polls
		await stagnate(h, session({ status: "running" }));
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
	});

	it("a mid-poll flip to needs_review gray zone is NOT escalated", async () => {
		const h = harness({
			refreshSession: () =>
				session({ status: "running", decision_route: "needs_review" }),
		});
		h.setOutput("stuck silent");
		await stagnate(h, session());
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("session row vanishing mid-poll clears the episode without escalating", async () => {
		let gone = false;
		const h = harness({
			refreshSession: () => (gone ? undefined : session()),
		});
		h.setOutput("stuck silent");
		h.clock.now = T0;
		await h.detector.checkSession(session());
		expect(h.detector.episodeFor("exec-1")).toBeDefined();
		gone = true;
		h.clock.now = T0 + STUCK_THRESHOLD_MS;
		const r = await h.detector.checkSession(session());
		expect(r).toBeNull();
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")).toBeUndefined();
	});

	it("re-read failure fails closed (skip, keep the episode clock)", async () => {
		let shouldThrow = false;
		const h = harness({
			refreshSession: () => {
				if (shouldThrow) throw new Error("db hiccup");
				return session();
			},
		});
		h.setOutput("stuck silent");
		h.clock.now = T0;
		await h.detector.checkSession(session());
		shouldThrow = true;
		h.clock.now = T0 + STUCK_THRESHOLD_MS;
		const r = await h.detector.checkSession(session());
		expect(r).toBeNull();
		expect(h.emit).not.toHaveBeenCalled();
		expect(h.detector.episodeFor("exec-1")?.firstStagnantAt).toBe(T0);
		// recovery → escalates off the still-stuck episode
		shouldThrow = false;
		h.clock.now = T0 + STUCK_THRESHOLD_MS + 1;
		await h.detector.checkSession(session());
		expect(h.emit).toHaveBeenCalledTimes(1);
	});

	it("escalation payload carries the FRESH session, not the stale snapshot", async () => {
		const h = harness({
			refreshSession: () => session({ issue_identifier: "FRESH-1" }),
		});
		h.setOutput("stuck silent");
		await stagnate(h, session({ issue_identifier: "STALE-0" }));
		expect(h.emit).toHaveBeenCalledTimes(1);
		expect(h.emitted[0]!.session.issue_identifier).toBe("FRESH-1");
	});
});
