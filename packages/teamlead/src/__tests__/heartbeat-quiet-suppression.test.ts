import { describe, expect, it, vi } from "vitest";
import type { QuietSignals } from "../bridge/quiet-classifier.js";
import { HeartbeatService } from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

/**
 * FLY-626: HeartbeatService.checkStuck must not wake the Lead with
 * `session_stuck` for a legitimately-quiet runner. Advisory-only — orphan
 * force-fail + monitoring-lost are NOT gated by the probe (Codex R1 #4).
 */

function makeStuckSession(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-stuck",
		issue_id: "GEO-100",
		project_name: "geo",
		status: "running",
		issue_identifier: "GEO-100",
		last_activity_at: "2026-03-06 09:00:00", // long ago → stuck
		...over,
	};
}

function makeStore(stuck: Session[]) {
	const notified = new Set<string>(); // FLY-637 persistent dedup (test)
	const key = (e: string, s: string, f: string) => `${e}|${s}|${f}`;
	return {
		getStuckSessions: vi.fn(() => stuck),
		getOrphanSessions: vi.fn(() => []),
		getStaleCompletedSessions: vi.fn(() => []),
		getAwaitingReviewTimedOut: vi.fn(() => []),
		forceStatus: vi.fn(),
		// FLY-637 persistent quiet-wake dedup, Set-backed for real behavior.
		_notified: notified,
		hasQuietWakeNotified: vi.fn((e: string, s: string, f: string) =>
			notified.has(key(e, s, f)),
		),
		recordQuietWakeNotified: vi.fn((e: string, s: string, f: string) => {
			notified.add(key(e, s, f));
		}),
		clearQuietWakeNotified: vi.fn((e: string, s?: string) => {
			for (const k of [...notified]) {
				const [ke, ks] = k.split("|");
				if (ke === e && (!s || ks === s)) notified.delete(k);
			}
		}),
		pruneQuietWakeNotifiedNotIn: vi.fn((s: string, keep: string[]) => {
			for (const k of [...notified]) {
				const [ke, ks] = k.split("|");
				if (ks === s && !keep.includes(ke)) notified.delete(k);
			}
		}),
	};
}

/** `persisted` controls the onSessionStuck return (FLY-637 success signal). */
function makeNotifier(persisted = true) {
	return {
		onSessionStuck: vi.fn(async () => persisted),
		onSessionOrphaned: vi.fn(async () => {}),
		onSessionStale: vi.fn(async () => {}),
		onSessionMonitoringLost: vi.fn(async () => {}),
	};
}

function signals(over: Partial<QuietSignals> = {}): QuietSignals {
	return {
		status: "running",
		hasPendingGate: false,
		hasRecentComm: false,
		hasPendingReviewSignal: false,
		declaredKind: null,
		...over,
	};
}

function build(
	stuck: Session[],
	probe?: (session: Session) => QuietSignals,
	deps?: {
		store?: ReturnType<typeof makeStore>;
		notifier?: ReturnType<typeof makeNotifier>;
	},
) {
	const store = deps?.store ?? makeStore(stuck);
	const notifier = deps?.notifier ?? makeNotifier();
	const service = new HeartbeatService(
		// biome-ignore lint/suspicious/noExplicitAny: test mocks
		store as any,
		// biome-ignore lint/suspicious/noExplicitAny: test mocks
		notifier as any,
		15, // stuck threshold minutes
		300_000, // interval
		60, // orphan threshold minutes
		undefined, // transitionOpts
		24, // staleThresholdHours
		6 * 3_600_000, // staleCheckIntervalMs
		undefined, // monitorReconcile (unwired → reconcile/review no-op)
		48, // reviewTimeoutHours
		probe, // FLY-626 quiet probe
	);
	return { service, store, notifier };
}

describe("HeartbeatService FLY-626 session_stuck suppression", () => {
	it("suppresses session_stuck for a self-declared parked runner", async () => {
		const { service, notifier } = build([makeStuckSession()], () =>
			signals({ declaredKind: "parked" }),
		);
		await service.check();
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
	});

	it("suppresses for long_task / pending_gate / recent_comm", async () => {
		for (const s of [
			signals({ declaredKind: "long_task" }),
			signals({ hasPendingGate: true }),
			signals({ hasRecentComm: true }),
		]) {
			const { service, notifier } = build([makeStuckSession()], () => s);
			await service.check();
			expect(notifier.onSessionStuck).not.toHaveBeenCalled();
		}
	});

	it("still wakes for an unexplained stuck runner", async () => {
		const { service, notifier } = build([makeStuckSession()], () => signals());
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});

	it("byte-compat: no probe ⇒ wakes (pre-FLY-626)", async () => {
		const { service, notifier } = build([makeStuckSession()], undefined);
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});
});

describe("HeartbeatService FLY-637 persistent stuck dedup", () => {
	afterEach(() => {
		delete process.env.FLYWHEEL_QUIET_PERSIST_DEDUP;
	});

	it("reports a stuck runner once and not again across checks", async () => {
		const { service, notifier } = build([makeStuckSession()], () => signals());
		await service.check();
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});

	it("a Bridge restart (new service, same store) does NOT re-wake the same stuck episode (#3/#4)", async () => {
		const stuck = [makeStuckSession()];
		const store = makeStore(stuck);
		const { service: s1, notifier: n1 } = build([], () => signals(), { store });
		await s1.check();
		expect(n1.onSessionStuck).toHaveBeenCalledTimes(1);
		expect(store._notified.size).toBe(1); // persisted
		// fresh service = wiped in-memory notifiedStuck, but the persistent row remains
		const { service: s2, notifier: n2 } = build([], () => signals(), { store });
		await s2.check();
		expect(n2.onSessionStuck).not.toHaveBeenCalled();
	});

	it("a recovered-then-re-stuck runner can be re-reported (prune)", async () => {
		const stuck = [makeStuckSession()];
		const store = makeStore(stuck);
		const { service, notifier } = build([], () => signals(), { store });
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		// runner recovers → leaves the stuck set → prune clears its dedup row
		stuck.length = 0;
		await service.check();
		expect(store._notified.size).toBe(0);
		// gets stuck again later → re-reported
		stuck.push(makeStuckSession());
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(2);
	});

	it("a non-persisted wake (no lead/runtime) is NOT deduped → retried next cycle (#2 HIGH)", async () => {
		const store = makeStore([makeStuckSession()]);
		const notifier = makeNotifier(false); // onSessionStuck resolves false = not persisted
		const { service } = build([], () => signals(), { store, notifier });
		await service.check();
		await service.check();
		// retried each cycle — no durable suppression of a wake that never happened
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(2);
		expect(store._notified.size).toBe(0); // nothing recorded
	});

	it("kill-switch FLYWHEEL_QUIET_PERSIST_DEDUP=0 reverts to in-memory dedup (byte-compat)", async () => {
		process.env.FLYWHEEL_QUIET_PERSIST_DEDUP = "0";
		const stuck = [makeStuckSession()];
		const store = makeStore(stuck);
		const { service: s1, notifier: n1 } = build([], () => signals(), { store });
		await s1.check();
		await s1.check();
		expect(n1.onSessionStuck).toHaveBeenCalledTimes(1); // in-memory dedup
		expect(store._notified.size).toBe(0); // no persistence
		// fresh service re-wakes (MVP: in-memory only, restart re-alerts)
		const { service: s2, notifier: n2 } = build([], () => signals(), { store });
		await s2.check();
		expect(n2.onSessionStuck).toHaveBeenCalledTimes(1);
	});
});
