/**
 * FLY-172: orchestration tests for HeartbeatService's monitoring-loss reconcile
 * pass — marker-first, single-owner tmux probing, skip-set management, and the
 * false-`session_stuck` suppression. The marker file mechanics themselves are
 * covered in complete-marker-reconciler.test.ts; here we mock that module + the
 * tmux-lookup module to test the orchestration logic deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: vi.fn(() => ({
		tmuxWindow: "geoforge3d:@0",
		sessionName: "geoforge3d",
	})),
	isTmuxWindowAlive: vi.fn(async () => true),
}));

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
} from "../bridge/tmux-lookup.js";
import { HeartbeatService } from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

const mockedTry = vi.mocked(tryReconcileComplete);
const mockedFallback = vi.mocked(applyQuarantineFallback);
const mockedAlive = vi.mocked(isTmuxWindowAlive);
const mockedTarget = vi.mocked(getTmuxTargetFromCommDb);

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

describe("HeartbeatService.reconcileMonitorLoss (FLY-172)", () => {
	let store: Record<string, ReturnType<typeof vi.fn>>;
	let notifier: Record<string, ReturnType<typeof vi.fn>>;
	let service: HeartbeatService;

	beforeEach(() => {
		mockedTry.mockReset().mockResolvedValue({ kind: "absent" });
		mockedFallback.mockReset();
		mockedAlive.mockReset().mockResolvedValue(true);
		mockedTarget.mockReset().mockReturnValue({
			tmuxWindow: "geoforge3d:@0",
			sessionName: "geoforge3d",
		});
		store = {
			getStuckSessions: vi.fn().mockReturnValue([]),
			getOrphanSessions: vi.fn().mockReturnValue([]),
			getStaleCompletedSessions: vi.fn().mockReturnValue([]),
			// FLY-191 Phase 2: review-timeout pass runs in the same cycle
			getAwaitingReviewTimedOut: vi.fn().mockReturnValue([]),
			markGateTimeoutNotified: vi.fn(),
			forceStatus: vi.fn(),
			getSession: vi.fn(),
		};
		notifier = {
			onSessionStuck: vi.fn().mockResolvedValue(undefined),
			onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
			onSessionStale: vi.fn().mockResolvedValue(undefined),
			onSessionMonitoringLost: vi.fn().mockResolvedValue(undefined),
		};
		service = new HeartbeatService(
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
	});
	afterEach(() => service.stop());

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
		expect(store.forceStatus).not.toHaveBeenCalled();
		// HeartbeatService must NOT have an updateHeartbeat path; none called
		expect(store.updateHeartbeat).toBeUndefined();
	});

	it("reapOrphans skips a monitor-lost (alive) session — no false failed", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]); // returned for both thresholds
		await service.reconcileMonitorLoss(); // marks monitor-lost (alive)
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
	});

	it("alive→dead next cycle: removed from set, then reapOrphans force-fails", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		mockedAlive.mockResolvedValueOnce(true); // cycle 1: alive
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);

		mockedAlive.mockResolvedValue(false); // cycle 2: dead
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
		// tmux not even probed when marker reconciled it
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

	it("CODEX R1 HIGH: quarantined marker + tmux ALIVE → advisory + reapOrphans skips (no false fail)", async () => {
		mockedTry.mockResolvedValue({
			kind: "quarantined",
			reason: "invalid",
			quarantinePath: "/q/exec-1.json",
		});
		mockedAlive.mockResolvedValue(true);
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);

		await service.reconcileMonitorLoss();
		// fallback called with tmuxAlive:true (leaves running, no status change)
		expect(mockedFallback).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-1", tmuxAlive: true }),
		);
		// MUST be treated as monitor-lost so reapOrphans skips it
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
	});

	it("checkStuck suppressed for monitor-lost session; resumes after death", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		store.getStuckSessions.mockReturnValue([s]);

		// cycle 1: alive → monitor-lost → checkStuck suppressed
		await service.check();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();

		// cycle 2: dead → removed from set → checkStuck fires
		mockedAlive.mockResolvedValue(false);
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});

	it("indeterminate tmux target (no CommDB) → not protected → reapOrphans force-fails", async () => {
		mockedTarget.mockReturnValue(undefined);
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		await service.reapOrphans();
		expect(store.forceStatus).toHaveBeenCalledTimes(1);
	});
});
