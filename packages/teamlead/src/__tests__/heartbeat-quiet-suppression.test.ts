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
	return {
		getStuckSessions: vi.fn(() => stuck),
		getOrphanSessions: vi.fn(() => []),
		getStaleCompletedSessions: vi.fn(() => []),
		getAwaitingReviewTimedOut: vi.fn(() => []),
		forceStatus: vi.fn(),
	};
}

function makeNotifier() {
	return {
		onSessionStuck: vi.fn(async () => {}),
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

function build(stuck: Session[], probe?: (session: Session) => QuietSignals) {
	const store = makeStore(stuck);
	const notifier = makeNotifier();
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
