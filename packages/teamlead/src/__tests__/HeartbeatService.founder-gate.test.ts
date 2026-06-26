import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HeartbeatNotifier,
	HeartbeatService,
} from "../HeartbeatService.js";
import type { Session, StateStore } from "../StateStore.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-ar",
		issue_id: "FLY-100",
		project_name: "flywheel",
		status: "awaiting_review",
		issue_identifier: "FLY-100",
		awaiting_review_entered_at: "2026-06-25 10:00:00",
		...overrides,
	};
}

describe("HeartbeatService.checkFounderGatePending (FLY-523)", () => {
	let store: {
		getStuckSessions: ReturnType<typeof vi.fn>;
		getOrphanSessions: ReturnType<typeof vi.fn>;
		getStaleCompletedSessions: ReturnType<typeof vi.fn>;
		getAwaitingReviewSessions: ReturnType<typeof vi.fn>;
		forceStatus: ReturnType<typeof vi.fn>;
	};
	let baseNotifier: {
		onSessionStuck: ReturnType<typeof vi.fn>;
		onSessionOrphaned: ReturnType<typeof vi.fn>;
		onSessionStale: ReturnType<typeof vi.fn>;
		onSessionMonitoringLost: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		store = {
			getStuckSessions: vi.fn().mockReturnValue([]),
			getOrphanSessions: vi.fn().mockReturnValue([]),
			getStaleCompletedSessions: vi.fn().mockReturnValue([]),
			getAwaitingReviewSessions: vi.fn().mockReturnValue([]),
			forceStatus: vi.fn(),
		};
		baseNotifier = {
			onSessionStuck: vi.fn().mockResolvedValue(undefined),
			onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
			onSessionStale: vi.fn().mockResolvedValue(undefined),
			onSessionMonitoringLost: vi.fn().mockResolvedValue(undefined),
		};
	});

	function makeService(): HeartbeatService {
		return new HeartbeatService(
			store as unknown as StateStore,
			baseNotifier as unknown as HeartbeatNotifier,
			15,
			60_000,
			60,
		);
	}

	it("no-op (and does NOT touch the store) when no founderGateNotifier is wired — byte-compat", async () => {
		store.getAwaitingReviewSessions.mockReturnValue([makeSession()]);
		const service = makeService();
		await service.checkFounderGatePending();
		expect(store.getAwaitingReviewSessions).not.toHaveBeenCalled();
		service.stop();
	});

	it("notifies the founder once per awaiting_review session when wired", async () => {
		const s1 = makeSession({ execution_id: "a1" });
		const s2 = makeSession({ execution_id: "a2" });
		store.getAwaitingReviewSessions.mockReturnValue([s1, s2]);
		const founderGateNotifier = {
			notifyGatePending: vi.fn().mockResolvedValue(undefined),
		};
		const service = makeService();
		service.setFounderGateNotifier(founderGateNotifier);
		await service.checkFounderGatePending();
		expect(founderGateNotifier.notifyGatePending).toHaveBeenCalledTimes(2);
		expect(founderGateNotifier.notifyGatePending).toHaveBeenCalledWith(s1);
		expect(founderGateNotifier.notifyGatePending).toHaveBeenCalledWith(s2);
		service.stop();
	});

	it("one notifier failure does not stop the others", async () => {
		const s1 = makeSession({ execution_id: "a1" });
		const s2 = makeSession({ execution_id: "a2" });
		store.getAwaitingReviewSessions.mockReturnValue([s1, s2]);
		const notifyGatePending = vi
			.fn()
			.mockRejectedValueOnce(new Error("discord down"))
			.mockResolvedValueOnce(undefined);
		const service = makeService();
		service.setFounderGateNotifier({ notifyGatePending });
		await service.checkFounderGatePending();
		expect(notifyGatePending).toHaveBeenCalledTimes(2);
		service.stop();
	});

	it("check() drives checkFounderGatePending", async () => {
		const s1 = makeSession();
		store.getAwaitingReviewSessions.mockReturnValue([s1]);
		const founderGateNotifier = {
			notifyGatePending: vi.fn().mockResolvedValue(undefined),
		};
		const service = makeService();
		service.setFounderGateNotifier(founderGateNotifier);
		await service.check();
		expect(founderGateNotifier.notifyGatePending).toHaveBeenCalledWith(s1);
		service.stop();
	});
});
