import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import {
	HeartbeatService,
	RegistryHeartbeatNotifier,
} from "../HeartbeatService.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
	{
		projectName: "p",
		projectRoot: "/tmp/p",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-stuck",
		issue_id: "GEO-100",
		project_name: "geoforge",
		status: "running",
		issue_identifier: "GEO-100",
		last_activity_at: "2026-03-06 09:00:00",
		...overrides,
	};
}

describe("HeartbeatService", () => {
	let store: {
		getStuckSessions: ReturnType<typeof vi.fn>;
		getOrphanSessions: ReturnType<typeof vi.fn>;
		forceStatus: ReturnType<typeof vi.fn>;
	};
	let notifier: {
		onSessionStuck: ReturnType<typeof vi.fn>;
		onSessionOrphaned: ReturnType<typeof vi.fn>;
	};
	let service: HeartbeatService;

	beforeEach(() => {
		store = {
			getStuckSessions: vi.fn().mockReturnValue([]),
			getOrphanSessions: vi.fn().mockReturnValue([]),
			forceStatus: vi.fn(),
		};
		notifier = {
			onSessionStuck: vi.fn().mockResolvedValue(undefined),
			onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
		};
		service = new HeartbeatService(
			store as any,
			notifier as any,
			15,
			60_000,
			60,
		);
	});

	afterEach(() => {
		service.stop();
	});

	// --- Stuck detection (inherited from StuckWatcher) ---

	it("check() detects stuck session and notifies", async () => {
		const session = makeSession();
		store.getStuckSessions.mockReturnValue([session]);

		await service.check();

		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			session,
			expect.any(Number),
		);
	});

	it("check() skips already-notified stuck sessions", async () => {
		const session = makeSession();
		store.getStuckSessions.mockReturnValue([session]);

		await service.check();
		await service.check();

		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});

	it("check() re-notifies if session leaves and re-enters stuck", async () => {
		const session = makeSession();
		store.getStuckSessions.mockReturnValue([session]);
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);

		// Session is no longer stuck
		store.getStuckSessions.mockReturnValue([]);
		await service.check();

		// Session becomes stuck again
		store.getStuckSessions.mockReturnValue([session]);
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(2);
	});

	it("check() does nothing when no stuck or orphan sessions", async () => {
		await service.check();

		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
		expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
	});

	// --- Orphan reaping ---

	it("reapOrphans() detects orphan, force-fails, and notifies", async () => {
		const orphan = makeSession({
			execution_id: "exec-orphan",
			heartbeat_at: "2026-03-06 08:00:00",
		});
		store.getOrphanSessions.mockReturnValue([orphan]);

		await service.reapOrphans();

		expect(store.forceStatus).toHaveBeenCalledWith(
			"exec-orphan",
			"failed",
			expect.any(String),
			expect.stringContaining("Orphaned"),
		);
		expect(notifier.onSessionOrphaned).toHaveBeenCalledWith(
			orphan,
			expect.any(Number),
		);
	});

	it("reapOrphans() skips already-notified orphans", async () => {
		const orphan = makeSession({
			execution_id: "exec-orphan",
			heartbeat_at: "2026-03-06 08:00:00",
		});
		store.getOrphanSessions.mockReturnValue([orphan]);

		await service.reapOrphans();
		await service.reapOrphans();

		expect(notifier.onSessionOrphaned).toHaveBeenCalledTimes(1);
		expect(store.forceStatus).toHaveBeenCalledTimes(1);
	});

	it("reapOrphans() re-notifies if session leaves and re-enters orphan state", async () => {
		const orphan = makeSession({
			execution_id: "exec-orphan",
			heartbeat_at: "2026-03-06 08:00:00",
		});
		store.getOrphanSessions.mockReturnValue([orphan]);
		await service.reapOrphans();

		store.getOrphanSessions.mockReturnValue([]);
		await service.reapOrphans();

		store.getOrphanSessions.mockReturnValue([orphan]);
		await service.reapOrphans();

		expect(notifier.onSessionOrphaned).toHaveBeenCalledTimes(2);
	});

	it("reapOrphans() does not dedup if notification fails", async () => {
		const orphan = makeSession({
			execution_id: "exec-orphan",
			heartbeat_at: "2026-03-06 08:00:00",
		});
		store.getOrphanSessions.mockReturnValue([orphan]);
		notifier.onSessionOrphaned.mockRejectedValueOnce(
			new Error("notify failed"),
		);

		await service.reapOrphans();
		// Notification failed — should retry next cycle
		notifier.onSessionOrphaned.mockResolvedValue(undefined);
		// forceStatus will be called again since notify failed and we retry
		await service.reapOrphans();

		expect(notifier.onSessionOrphaned).toHaveBeenCalledTimes(2);
	});

	it("check() calls both checkStuck and reapOrphans", async () => {
		const stuck = makeSession({ execution_id: "exec-stuck" });
		const orphan = makeSession({
			execution_id: "exec-orphan",
			heartbeat_at: "2026-03-06 08:00:00",
		});
		store.getStuckSessions.mockReturnValue([stuck]);
		store.getOrphanSessions.mockReturnValue([orphan]);

		await service.check();

		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			stuck,
			expect.any(Number),
		);
		expect(notifier.onSessionOrphaned).toHaveBeenCalledWith(
			orphan,
			expect.any(Number),
		);
		expect(store.forceStatus).toHaveBeenCalledWith(
			"exec-orphan",
			"failed",
			expect.any(String),
			expect.stringContaining("Orphaned"),
		);
	});

	// --- Timer management ---

	it("start/stop manages interval", async () => {
		vi.useFakeTimers();

		service.start();
		// Starting again is a no-op
		service.start();

		vi.advanceTimersByTime(60_000);
		// Flush async microtasks so check() completes fully (checkStuck + reapOrphans)
		await vi.advanceTimersByTimeAsync(0);
		expect(store.getStuckSessions).toHaveBeenCalledTimes(1);
		expect(store.getOrphanSessions).toHaveBeenCalledTimes(1);

		service.stop();
		vi.advanceTimersByTime(60_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.getStuckSessions).toHaveBeenCalledTimes(1);
		expect(store.getOrphanSessions).toHaveBeenCalledTimes(1);

		vi.useRealTimers();
	});
});

/** Helper: create a mock RuntimeRegistry with a single mock LeadRuntime. */
function createMockRegistry() {
	const envelopes: LeadEventEnvelope[] = [];
	const mockRuntime = {
		type: "openclaw" as const,
		deliver: vi.fn(async (env: LeadEventEnvelope) => {
			envelopes.push(env);
		}),
		sendBootstrap: vi.fn(async () => {}),
		health: vi.fn(async () => ({
			status: "healthy" as const,
			lastDeliveryAt: null,
			lastDeliveredSeq: 0,
		})),
		shutdown: vi.fn(async () => {}),
	};
	const registry = new RuntimeRegistry();
	// Register for all test projects' leads
	for (const project of testProjects) {
		for (const lead of project.leads) {
			registry.register(lead, mockRuntime);
		}
	}
	return { registry, mockRuntime, envelopes };
}

describe("RegistryHeartbeatNotifier", () => {
	it("sends session_stuck envelope via registry runtime with sessionKey", async () => {
		const { registry, envelopes } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new RegistryHeartbeatNotifier(
			registry,
			testProjects,
			hbStore,
		);
		const session: Session = {
			execution_id: "exec-stuck",
			issue_id: "i1",
			project_name: "geo",
			status: "running",
			issue_identifier: "GEO-100",
			thread_id: "1234.5678",
		};

		await notifier.onSessionStuck(session, 30);

		expect(envelopes).toHaveLength(1);
		const env = envelopes[0];
		expect(env.leadId).toBe("product-lead");
		expect(env.sessionKey).toBe("flywheel:GEO-100");
		expect(env.event.event_type).toBe("session_stuck");
		expect(env.event.minutes_since_activity).toBe(30);
		expect(env.event.thread_id).toBe("1234.5678");
		expect(env.event.forum_channel).toBe("test-channel");

		hbStore.close();
	});

	it("sends session_orphaned envelope via registry runtime with sessionKey", async () => {
		const { registry, envelopes } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new RegistryHeartbeatNotifier(
			registry,
			testProjects,
			hbStore,
		);
		const session: Session = {
			execution_id: "exec-orphan",
			issue_id: "i2",
			project_name: "geo",
			status: "running",
			issue_identifier: "GEO-200",
			thread_id: "5678.1234",
		};

		await notifier.onSessionOrphaned(session, 75);

		expect(envelopes).toHaveLength(1);
		const env = envelopes[0];
		expect(env.leadId).toBe("product-lead");
		expect(env.sessionKey).toBe("flywheel:GEO-200");
		expect(env.event.event_type).toBe("session_orphaned");
		expect(env.event.status).toBe("failed");
		expect(env.event.minutes_since_activity).toBe(75);
		expect(env.event.thread_id).toBe("5678.1234");
		expect(env.event.forum_channel).toBe("test-channel");

		hbStore.close();
	});

	it("delivers via registry runtime (not direct HTTP)", async () => {
		const { registry, mockRuntime } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new RegistryHeartbeatNotifier(
			registry,
			testProjects,
			hbStore,
		);
		await notifier.onSessionStuck(
			{
				execution_id: "e1",
				issue_id: "i1",
				project_name: "p",
				status: "running",
			},
			15,
		);

		expect(mockRuntime.deliver).toHaveBeenCalledTimes(1);

		hbStore.close();
	});
});
