/**
 * FLY-172 + FLY-623: orchestration tests for HeartbeatService's monitoring-loss
 * reconcile pass. FLY-623 makes RE-ADOPT the sole path: a detached-but-alive
 * Runner gets its heartbeat refreshed +
 * suppressed from stuck/orphan/idle while the title is restored to the actual
 * phase/status, via the `reconnecting` set. The marker mechanics are covered in
 * complete-marker-reconciler.test.ts; here we mock that module + tmux-lookup to
 * test the orchestration deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", () => {
	// FLY-720: isSessionTmuxAlive now reads pane liveness via lookupTmuxTarget +
	// probeRunnerProcessLiveness. Keep these tests driving liveness through the
	// existing `isTmuxWindowAlive` mock by DERIVING the pane probe from it
	// (true → "alive", false → "absent"), so the existing test bodies are unchanged.
	const isTmuxWindowAlive = vi.fn(async () => true);
	return {
		getTmuxTargetFromCommDb: vi.fn(() => ({
			tmuxWindow: "geoforge3d:@0",
			sessionName: "geoforge3d",
		})),
		isTmuxWindowAlive,
		lookupTmuxTarget: vi.fn(() => ({
			kind: "found",
			target: { tmuxWindow: "geoforge3d:@0", sessionName: "geoforge3d" },
		})),
		probeRunnerProcessLiveness: vi.fn(async () =>
			(await isTmuxWindowAlive("geoforge3d:@0")) ? "alive" : "absent",
		),
	};
});

vi.mock("../bridge/complete-marker-reconciler.js", () => ({
	tryReconcileComplete: vi.fn(async () => ({ kind: "absent" })),
	applyQuarantineFallback: vi.fn(),
}));

import {
	applyQuarantineFallback,
	tryReconcileComplete,
} from "../bridge/complete-marker-reconciler.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
	lookupTmuxTarget,
} from "../bridge/tmux-lookup.js";
import { HeartbeatService } from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

const mockedTry = vi.mocked(tryReconcileComplete);
const mockedFallback = vi.mocked(applyQuarantineFallback);
const mockedAlive = vi.mocked(isTmuxWindowAlive);
const mockedTarget = vi.mocked(getTmuxTargetFromCommDb);
const mockedLookup = vi.mocked(lookupTmuxTarget);

function sess(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-374",
		project_name: "geoforge3d",
		status: "running",
		issue_identifier: "GEO-374",
		heartbeat_at: "2026-05-27 09:00:00",
		last_activity_at: "2026-05-27 09:00:00",
		...overrides,
	};
}

type MockStore = Record<string, ReturnType<typeof vi.fn>>;
type MockNotifier = Record<string, ReturnType<typeof vi.fn>>;

function makeStore(): MockStore {
	return {
		getOrphanSessions: vi.fn().mockReturnValue([]),
		getStaleCompletedSessions: vi.fn().mockReturnValue([]),
		getAwaitingReviewTimedOut: vi.fn().mockReturnValue([]),
		getActiveSessions: vi.fn().mockReturnValue([]),
		// FLY-1329 (A3): boot re-adopt now reads every parked role. These
		// fixtures seed `running` sessions, where both queries agree — each test
		// feeds this alongside getActiveSessions. The widened query\'s own
		// semantics are pinned on a real StateStore in
		// statestore.fly1329-readopt-candidates.test.ts.
		getReadoptCandidateSessions: vi.fn().mockReturnValue([]),
		getSession: vi.fn((id: string) => (id === "exec-1" ? sess() : undefined)),
		updateHeartbeat: vi.fn(),
		markGateTimeoutNotified: vi.fn(),
		forceStatus: vi.fn(),
		// FLY-637 persistent quiet-wake dedup surface (no-op for these tests).
		hasQuietWakeNotified: vi.fn().mockReturnValue(false),
		recordQuietWakeNotified: vi.fn(),
		clearQuietWakeNotified: vi.fn(),
		pruneQuietWakeNotifiedNotIn: vi.fn(),
	};
}

function makeNotifier(): MockNotifier {
	return {
		onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
		onSessionStale: vi.fn().mockResolvedValue(undefined),
		onSessionMonitoringLost: vi.fn().mockResolvedValue(undefined),
		onSessionMonitoringReestablished: vi.fn().mockResolvedValue(undefined),
		clearReconnectStamp: vi.fn(),
	};
}

function makeService(
	store: MockStore,
	notifier: MockNotifier,
): HeartbeatService {
	return new HeartbeatService(
		store as never,
		notifier as never,
		15,
		60_000,
		60,
		undefined,
		24,
		6 * 3_600_000,
		{ bridgeBaseUrl: "http://127.0.0.1:9876", ingestToken: "tok" },
	);
}

beforeEach(() => {
	mockedTry.mockReset().mockResolvedValue({ kind: "absent" });
	mockedFallback.mockReset();
	mockedAlive.mockReset().mockResolvedValue(true);
	mockedTarget.mockReset().mockReturnValue({
		tmuxWindow: "geoforge3d:@0",
		sessionName: "geoforge3d",
	});
	mockedLookup.mockReset().mockReturnValue({
		kind: "found",
		target: { tmuxWindow: "geoforge3d:@0", sessionName: "geoforge3d" },
	});
});

describe("HeartbeatService re-adopt (FLY-623 readopt ON, default)", () => {
	let store: MockStore;
	let notifier: MockNotifier;
	let service: HeartbeatService;

	beforeEach(() => {
		store = makeStore();
		notifier = makeNotifier();
		service = makeService(store, notifier);
	});
	afterEach(() => {
		service.stop();
	});

	it("no marker + tmux alive → re-adopt (updateHeartbeat) + one-time re-established advisory", async () => {
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss(); // stay cycle
		// re-adopt: heartbeat refreshed every cycle while alive
		expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-1");
		expect(store.updateHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
		// advisory fires ONCE per episode; legacy monitoring-lost is NOT used
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(service.isReconnecting("exec-1")).toBe(true);
	});

	it("reapOrphans skips a re-adopted (alive) session — no false failed", async () => {
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
	});

	it("stay through marker-first: a later valid terminal marker reconciles (no refresh past terminal)", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		// cycle 1: no marker, alive → re-adopt
		await service.reconcileMonitorLoss();
		expect(service.isReconnecting("exec-1")).toBe(true);
		const callsAfterCycle1 = store.updateHeartbeat.mock.calls.length;
		// cycle 2: marker now present + reconciled → leave reconnecting, no refresh
		mockedTry.mockResolvedValue({
			kind: "reconciled",
			status: "awaiting_review",
		});
		store.getOrphanSessions.mockReturnValue([]); // heartbeat fresh → not an orphan candidate
		await service.reconcileMonitorLoss(); // reconnecting member still re-processed
		expect(service.isReconnecting("exec-1")).toBe(false);
		expect(store.updateHeartbeat.mock.calls.length).toBe(callsAfterCycle1);
	});

	it("clear-on-event: clearReconnecting removes from set + restamps", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.check();

		// a genuine runner event proves the channel live → clear
		service.clearReconnecting("exec-1");
		expect(service.isReconnecting("exec-1")).toBe(false);
		expect(notifier.clearReconnectStamp).toHaveBeenCalledTimes(1);
	});

	it("clearReconnecting is a no-op when not reconnecting (never restamps)", () => {
		service.clearReconnecting("exec-1");
		expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();
	});

	it("valid marker wins over tmux alive (marker-first): reconciled, no re-adopt", async () => {
		mockedTry.mockResolvedValue({
			kind: "reconciled",
			status: "awaiting_review",
		});
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(mockedAlive).not.toHaveBeenCalled();
	});

	it("settled ship-attempt marker is fully consumed: no tmux probe or re-adopt fallthrough", async () => {
		mockedTry.mockResolvedValue({
			kind: "settled_ship_attempt_failed",
			settle: "marked",
		});
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(mockedAlive).not.toHaveBeenCalled();
	});

	it("held marker suppresses liveness probing and orphan reaping", async () => {
		mockedTry.mockResolvedValue({
			kind: "held_for_lead",
			invariant: "workflow_rework_verification_advance_cas_failed",
			alertState: "accepted",
		});
		store.getOrphanSessions.mockReturnValue([sess()]);

		await service.reconcileMonitorLoss();
		await service.reapOrphans();

		expect(mockedAlive).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
	});

	it("quarantined + tmux alive → re-adopt + reapOrphans skips (FLY-172 R1 HIGH parity)", async () => {
		mockedTry.mockResolvedValue({
			kind: "quarantined",
			reason: "invalid",
			quarantinePath: "/q/exec-1.json",
		});
		mockedAlive.mockResolvedValue(true);
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(mockedFallback).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-1", tmuxAlive: true }),
		);
		expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-1");
		expect(service.isReconnecting("exec-1")).toBe(true);
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("boot-seed: seedReconnecting re-adopts pre-existing running+alive sessions", async () => {
		const s = sess();
		store.getActiveSessions.mockReturnValue([s]);
		store.getReadoptCandidateSessions.mockReturnValue([s]);
		await service.seedReconnecting();
		expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-1");
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
		expect(service.isReconnecting("exec-1")).toBe(true);
	});

	it("boot seed returns only newly re-adopted execs and activates both layers", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		store.getReadoptCandidateSessions.mockReturnValue([sess()]);
		expect(await service.seedReconnecting()).toEqual(["exec-1"]);
		expect(service.isReconnecting("exec-1")).toBe(true);
		expect(service.isReconnectTitleActive("exec-1")).toBe(true);
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledWith(
			sess(),
			expect.any(Number),
			expect.objectContaining({ stampReconnectTitle: true }),
		);

		// Same process, same episode: no duplicate boot candidate or title stamp.
		expect(await service.seedReconnecting()).toEqual([]);
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
	});

	it("FLY-1264 review R2: a runtime re-entry preserves the canonical title without spending two renames", async () => {
		service.markReconnectTitleRefresherReady();
		store.getOrphanSessions.mockReturnValue([sess()]);

		await service.reconcileMonitorLoss();

		expect(service.isReconnecting("exec-1")).toBe(true);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledWith(
			sess(),
			expect.any(Number),
			expect.objectContaining({ stampReconnectTitle: false }),
		);
	});

	it("FLY-1264 review R2: transient boot marker retry preserves canonical title on runtime entry", async () => {
		mockedTry
			.mockResolvedValueOnce({ kind: "transient_failed", error: "busy" })
			.mockResolvedValueOnce({ kind: "absent" });
		store.getActiveSessions.mockReturnValue([sess()]);
		store.getReadoptCandidateSessions.mockReturnValue([sess()]);
		expect(await service.seedReconnecting()).toEqual([]);

		service.markReconnectTitleRefresherReady();
		store.getOrphanSessions.mockReturnValue([sess()]);

		await service.reconcileMonitorLoss();

		expect(service.isReconnecting("exec-1")).toBe(true);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledWith(
			sess(),
			expect.any(Number),
			expect.objectContaining({ stampReconnectTitle: false }),
		);
	});

	it("FLY-1264: no-arg settle drains an episode the explicit boot ids never captured (early heartbeat-tick safety net)", async () => {
		// Models the production second call `restoreReconnectTitles()` (no ids):
		// a session that entered reconnecting via an early monitor-loss tick BEFORE
		// the refresher bound is NOT in bootReconnectExecutionIds, so only the
		// no-arg drain-all frees its title. If this path were a no-op, that title
		// would stay stuck at ⚠️重连中 forever — the exact FLY-1264 failure mode.
		store.getActiveSessions.mockReturnValue([]);
		store.getReadoptCandidateSessions.mockReturnValue([]);
		expect(await service.seedReconnecting()).toEqual([]); // no boot ids captured

		// Early tick enters reconnecting + activates the title while the refresher
		// is still unbound (default: markReconnectTitleRefresherReady NOT yet called).
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(service.isReconnectTitleActive("exec-1")).toBe(true);

		// No-arg drain-all releases every active title episode and returns its
		// session so the caller can enqueue a canonical refresh for that issue.
		const drained = service.settleReconnectTitles();
		expect(drained.map((s) => s.execution_id)).toEqual(["exec-1"]);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		// Internal monitor-loss protection is untouched — only the title lifetime ended.
		expect(service.isReconnecting("exec-1")).toBe(true);
		expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();

		// Idempotent: a second no-arg drain has nothing left and enqueues nothing.
		expect(service.settleReconnectTitles()).toEqual([]);
	});

	it("settles only the title layer and keeps monitor-loss state", async () => {
		const s = sess();
		store.getActiveSessions.mockReturnValue([s]);
		store.getReadoptCandidateSessions.mockReturnValue([s]);
		const seeded = await service.seedReconnecting();

		expect(service.settleReconnectTitles(seeded)).toEqual([s]);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		expect(service.isReconnecting("exec-1")).toBe(true);
		expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();
	});

	it("accepted-event clear removes both layers but boot settle still returns its issue session", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		store.getReadoptCandidateSessions.mockReturnValue([sess()]);
		const seeded = await service.seedReconnecting();

		service.clearReconnecting("exec-1");
		expect(service.isReconnecting("exec-1")).toBe(false);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		expect(service.settleReconnectTitles(seeded)).toEqual([sess()]);
		expect(notifier.clearReconnectStamp).toHaveBeenCalledTimes(1);
	});

	it("event clear after boot title settle does not issue a stale legacy restamp", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		store.getReadoptCandidateSessions.mockReturnValue([sess()]);
		const seeded = await service.seedReconnecting();
		service.settleReconnectTitles(seeded);

		service.clearReconnecting("exec-1");
		expect(service.isReconnecting("exec-1")).toBe(false);
		expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();
	});
});
