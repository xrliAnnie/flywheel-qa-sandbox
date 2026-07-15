/**
 * FLY-172 + FLY-623: orchestration tests for HeartbeatService's monitoring-loss
 * reconcile pass. FLY-623 makes RE-ADOPT the default (FLYWHEEL_HEARTBEAT_READOPT
 * unset / ON): a detached-but-alive Runner gets its heartbeat refreshed +
 * suppressed from stuck/orphan/idle + a "⚠️重连中" title, via the `reconnecting`
 * set. `FLYWHEEL_HEARTBEAT_READOPT=0` reverts to the exact FLY-172 legacy
 * (advisory-only, no refresh). The marker mechanics are covered in
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
		getStuckSessions: vi.fn().mockReturnValue([]),
		getOrphanSessions: vi.fn().mockReturnValue([]),
		getStaleCompletedSessions: vi.fn().mockReturnValue([]),
		getAwaitingReviewTimedOut: vi.fn().mockReturnValue([]),
		getActiveSessions: vi.fn().mockReturnValue([]),
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
		// FLY-637: onSessionStuck returns a "persisted" boolean now.
		onSessionStuck: vi.fn().mockResolvedValue(true),
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
	afterEach(() => service.stop());

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

	it("regression guard (§3.4): re-adopted + stale last_activity does NOT fire session_stuck", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		store.getStuckSessions.mockReturnValue([s]); // stale last_activity_at
		await service.check();
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
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

	it("alive→dead next cycle: removed from reconnecting, reapOrphans force-fails", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		mockedAlive.mockResolvedValue(true);
		await service.reconcileMonitorLoss();
		expect(service.isReconnecting("exec-1")).toBe(true);

		mockedAlive.mockResolvedValue(false); // tmux died
		await service.reconcileMonitorLoss();
		expect(service.isReconnecting("exec-1")).toBe(false);
		await service.reapOrphans();
		expect(store.forceStatus).toHaveBeenCalledWith(
			"exec-1",
			"failed",
			expect.any(String),
			expect.stringContaining("Orphaned"),
		);
	});

	it("clear-on-event: clearReconnecting removes from set + restamps; stuck detection resumes", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		store.getStuckSessions.mockReturnValue([s]);
		await service.check(); // re-adopt + stuck suppressed
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();

		// a genuine runner event proves the channel live → clear
		service.clearReconnecting("exec-1");
		expect(service.isReconnecting("exec-1")).toBe(false);
		expect(notifier.clearReconnectStamp).toHaveBeenCalledTimes(1);

		// next check: no longer suppressed → session_stuck fires
		store.getOrphanSessions.mockReturnValue([]); // heartbeat was refreshed
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
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

	it("boot-seed: seedReconnecting re-adopts pre-existing running+alive sessions; stuck suppressed", async () => {
		const s = sess();
		store.getActiveSessions.mockReturnValue([s]);
		store.getStuckSessions.mockReturnValue([s]);
		await service.seedReconnecting();
		expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-1");
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
		expect(service.isReconnecting("exec-1")).toBe(true);
		// the on-boot false-stuck window is closed
		await service.checkStuck();
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
	});

	it("boot seed returns only newly re-adopted execs and activates both layers", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		expect(await service.seedReconnecting()).toEqual(["exec-1"]);
		expect(service.isReconnecting("exec-1")).toBe(true);
		expect(service.isReconnectTitleActive("exec-1")).toBe(true);
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledWith(
			sess(),
			expect.any(Number),
			{ stampReconnectTitle: true },
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
			{ stampReconnectTitle: false },
		);
	});

	it("FLY-1264 review R2: transient boot marker retry preserves canonical title on runtime entry", async () => {
		mockedTry
			.mockResolvedValueOnce({ kind: "transient_failed", error: "busy" })
			.mockResolvedValueOnce({ kind: "absent" });
		store.getActiveSessions.mockReturnValue([sess()]);
		expect(await service.seedReconnecting()).toEqual([]);

		service.markReconnectTitleRefresherReady();
		store.getOrphanSessions.mockReturnValue([sess()]);

		await service.reconcileMonitorLoss();

		expect(service.isReconnecting("exec-1")).toBe(true);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledWith(
			sess(),
			expect.any(Number),
			{ stampReconnectTitle: false },
		);
	});

	it("FLY-1264: no-arg settle drains an episode the explicit boot ids never captured (early heartbeat-tick safety net)", async () => {
		// Models the production second call `restoreReconnectTitles()` (no ids):
		// a session that entered reconnecting via an early monitor-loss tick BEFORE
		// the refresher bound is NOT in bootReconnectExecutionIds, so only the
		// no-arg drain-all frees its title. If this path were a no-op, that title
		// would stay stuck at ⚠️重连中 forever — the exact FLY-1264 failure mode.
		store.getActiveSessions.mockReturnValue([]);
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

	it("settles only the title layer and keeps monitor-loss suppression", async () => {
		const s = sess();
		store.getActiveSessions.mockReturnValue([s]);
		store.getStuckSessions.mockReturnValue([s]);
		const seeded = await service.seedReconnecting();

		expect(service.settleReconnectTitles(seeded)).toEqual([s]);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		expect(service.isReconnecting("exec-1")).toBe(true);
		await service.checkStuck();
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
		expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();
	});

	it("accepted-event clear removes both layers but boot settle still returns its issue session", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		const seeded = await service.seedReconnecting();

		service.clearReconnecting("exec-1");
		expect(service.isReconnecting("exec-1")).toBe(false);
		expect(service.isReconnectTitleActive("exec-1")).toBe(false);
		expect(service.settleReconnectTitles(seeded)).toEqual([sess()]);
		expect(notifier.clearReconnectStamp).toHaveBeenCalledTimes(1);
	});

	it("event clear after boot title settle does not issue a stale legacy restamp", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		const seeded = await service.seedReconnecting();
		service.settleReconnectTitles(seeded);

		service.clearReconnecting("exec-1");
		expect(service.isReconnecting("exec-1")).toBe(false);
		expect(notifier.clearReconnectStamp).not.toHaveBeenCalled();
	});
});

describe("HeartbeatService legacy (FLY-623 kill-switch FLYWHEEL_HEARTBEAT_READOPT=0)", () => {
	let store: MockStore;
	let notifier: MockNotifier;
	let service: HeartbeatService;

	beforeEach(() => {
		process.env.FLYWHEEL_HEARTBEAT_READOPT = "0";
		store = makeStore();
		notifier = makeNotifier();
		service = makeService(store, notifier);
	});
	afterEach(() => {
		service.stop();
		delete process.env.FLYWHEEL_HEARTBEAT_READOPT;
	});

	it("no-op when monitorReconcile config absent", async () => {
		const noCfg = new HeartbeatService(
			store as never,
			notifier as never,
			15,
			60_000,
			60,
		);
		store.getOrphanSessions.mockReturnValue([sess()]);
		await noCfg.reconcileMonitorLoss();
		expect(mockedTry).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
	});

	it("no marker + tmux alive → advisory once, no force-fail, no heartbeat refresh", async () => {
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss(); // second cycle
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
		// legacy path NEVER refreshes heartbeat (exact FLY-172)
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
	});

	it("reapOrphans skips a monitor-lost (alive) session — no false failed", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.reconcileMonitorLoss();
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
	});

	it("alive→dead next cycle: removed from set, then reapOrphans force-fails", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		mockedAlive.mockResolvedValueOnce(true);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);

		mockedAlive.mockResolvedValue(false);
		await service.reconcileMonitorLoss();
		await service.reapOrphans();
		expect(store.forceStatus).toHaveBeenCalledWith(
			"exec-1",
			"failed",
			expect.any(String),
			expect.stringContaining("Orphaned"),
		);
	});

	it("no marker + tmux dead → not monitor-lost → reapOrphans force-fails", async () => {
		mockedAlive.mockResolvedValue(false);
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		await service.reapOrphans();
		expect(store.forceStatus).toHaveBeenCalledTimes(1);
	});

	it("valid marker wins over tmux alive (marker-first): reconciled, no advisory", async () => {
		mockedTry.mockResolvedValue({
			kind: "reconciled",
			status: "awaiting_review",
		});
		mockedAlive.mockResolvedValue(true);
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		expect(mockedAlive).not.toHaveBeenCalled();
	});

	it("transient marker failure → reapOrphans skips force-fail (retry next cycle)", async () => {
		mockedTry.mockResolvedValue({ kind: "transient_failed", error: "down" });
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.reconcileMonitorLoss();
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("quarantined marker → applyQuarantineFallback invoked with tmux liveness", async () => {
		mockedTry.mockResolvedValue({
			kind: "quarantined",
			reason: "rejected",
			routeStatus: "blocked",
			quarantinePath: "/q/exec-1.json",
		});
		mockedAlive.mockResolvedValue(false);
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(mockedFallback).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				tmuxAlive: false,
				routeStatus: "blocked",
			}),
		);
	});

	it("checkStuck suppressed for monitor-lost session; resumes after death", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		store.getStuckSessions.mockReturnValue([s]);

		await service.check();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();

		mockedAlive.mockResolvedValue(false);
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});

	it("no CommDB target (gone) → not protected → reapOrphans force-fails", async () => {
		mockedTarget.mockReturnValue(undefined);
		mockedLookup.mockReturnValue({ kind: "gone" }); // FLY-720: liveness reads via lookupTmuxTarget
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		await service.reapOrphans();
		expect(store.forceStatus).toHaveBeenCalledTimes(1);
	});

	it("boot-seed is a no-op under kill-switch", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		expect(await service.seedReconnecting()).toEqual([]);
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
	});
});
