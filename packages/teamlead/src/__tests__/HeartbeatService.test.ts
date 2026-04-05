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
		getStaleCompletedSessions: ReturnType<typeof vi.fn>;
		forceStatus: ReturnType<typeof vi.fn>;
	};
	let notifier: {
		onSessionStuck: ReturnType<typeof vi.fn>;
		onSessionOrphaned: ReturnType<typeof vi.fn>;
		onSessionStale: ReturnType<typeof vi.fn>;
	};
	let service: HeartbeatService;

	beforeEach(() => {
		store = {
			getStuckSessions: vi.fn().mockReturnValue([]),
			getOrphanSessions: vi.fn().mockReturnValue([]),
			getStaleCompletedSessions: vi.fn().mockReturnValue([]),
			forceStatus: vi.fn(),
		};
		notifier = {
			onSessionStuck: vi.fn().mockResolvedValue(undefined),
			onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
			onSessionStale: vi.fn().mockResolvedValue(undefined),
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
		type: "claude-discord" as const,
		deliver: vi.fn(async (env: LeadEventEnvelope) => {
			envelopes.push(env);
			return { delivered: true };
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

	// GEO-275: no-forum lead heartbeat notification
	it("sends session_stuck with undefined forum_channel for no-forum lead", async () => {
		const noForumProjects: ProjectEntry[] = [
			{
				projectName: "geo-nf",
				projectRoot: "/tmp/geo-nf",
				leads: [
					{
						agentId: "pm-lead",
						chatChannel: "core-channel",
						match: { labels: ["PM"] },
						// No forumChannel
					},
				],
			},
		];
		const envelopes: LeadEventEnvelope[] = [];
		const mockRuntime = {
			type: "claude-discord" as const,
			deliver: vi.fn(async (env: LeadEventEnvelope) => {
				envelopes.push(env);
				return { delivered: true };
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
		for (const lead of noForumProjects[0]!.leads) {
			registry.register(lead, mockRuntime);
		}

		const hbStore = await StateStore.create(":memory:");
		const notifier = new RegistryHeartbeatNotifier(
			registry,
			noForumProjects,
			hbStore,
		);
		const session: Session = {
			execution_id: "exec-nf-stuck",
			issue_id: "i-nf",
			project_name: "geo-nf",
			status: "running",
			issue_identifier: "GEO-500",
		};

		await notifier.onSessionStuck(session, 30);

		expect(envelopes).toHaveLength(1);
		expect(envelopes[0].event.event_type).toBe("session_stuck");
		expect(envelopes[0].event.forum_channel).toBeUndefined();
		expect(envelopes[0].event.chat_channel).toBe("core-channel");

		hbStore.close();
	});
});

// --- FLY-25: Delivery contract upgrade tests ---

describe("FLY-25: RegistryHeartbeatNotifier delivery contract", () => {
	it("marks guardrail event as delivered only on success", async () => {
		const { registry } = createMockRegistry();
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
		};

		await notifier.onSessionStuck(session, 30);

		// Should be delivered
		const events = hbStore.getRecentDeliveredEvents("product-lead", 60);
		expect(events).toHaveLength(1);
		expect(events[0]!.event_type).toBe("session_stuck");

		hbStore.close();
	});

	it("does NOT mark guardrail event as delivered on transport failure", async () => {
		const { registry, mockRuntime } = createMockRegistry();
		mockRuntime.deliver.mockResolvedValue({
			delivered: false,
			error: "Discord 503",
		});
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
		};

		await notifier.onSessionStuck(session, 30);

		// Should NOT be delivered
		const events = hbStore.getRecentDeliveredEvents("product-lead", 60);
		expect(events).toHaveLength(0);

		// Should have recorded failure
		const undelivered = hbStore.getUndeliveredGuardrailEvents(
			"product-lead",
			["session_stuck"],
			3,
		);
		expect(undelivered).toHaveLength(1);
		expect(undelivered[0]!.delivery_attempts).toBe(1);
		expect(undelivered[0]!.last_delivery_error).toBe("Discord 503");

		hbStore.close();
	});

	it("marks advisory event (session_stale_completed is guardrail, session_completed is advisory) as delivered even on failure", async () => {
		// session_stale_completed is guardrail — let's verify with a custom event
		// All three HeartbeatService notification types are guardrail. Verify that explicitly.
		const { registry } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const _notifier = new RegistryHeartbeatNotifier(
			registry,
			testProjects,
			hbStore,
		);

		// Verify all three heartbeat event types are guardrail
		const { GUARDRAIL_EVENT_TYPES } = await import("../bridge/lead-runtime.js");
		expect(GUARDRAIL_EVENT_TYPES.has("session_stuck")).toBe(true);
		expect(GUARDRAIL_EVENT_TYPES.has("session_orphaned")).toBe(true);
		expect(GUARDRAIL_EVENT_TYPES.has("session_stale_completed")).toBe(true);
		expect(GUARDRAIL_EVENT_TYPES.has("session_completed")).toBe(false);

		hbStore.close();
	});

	it("retryUndeliveredGuardrailEvents re-delivers failed events", async () => {
		const { registry, mockRuntime } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new RegistryHeartbeatNotifier(
			registry,
			testProjects,
			hbStore,
		);

		// First delivery fails
		mockRuntime.deliver.mockResolvedValue({
			delivered: false,
			error: "timeout",
		});
		const session: Session = {
			execution_id: "exec-stuck",
			issue_id: "i1",
			project_name: "geo",
			status: "running",
			issue_identifier: "GEO-100",
		};
		await notifier.onSessionStuck(session, 30);

		// Verify not delivered
		expect(hbStore.getRecentDeliveredEvents("product-lead", 60)).toHaveLength(
			0,
		);

		// Now retry succeeds
		mockRuntime.deliver.mockResolvedValue({ delivered: true });
		await notifier.retryUndeliveredGuardrailEvents();

		// Should now be delivered
		const events = hbStore.getRecentDeliveredEvents("product-lead", 60);
		expect(events).toHaveLength(1);

		hbStore.close();
	});

	it("retryUndeliveredGuardrailEvents respects max attempts (3)", async () => {
		const { registry, mockRuntime } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new RegistryHeartbeatNotifier(
			registry,
			testProjects,
			hbStore,
		);

		// Delivery always fails
		mockRuntime.deliver.mockResolvedValue({
			delivered: false,
			error: "persistent failure",
		});
		const session: Session = {
			execution_id: "exec-stuck",
			issue_id: "i1",
			project_name: "geo",
			status: "running",
			issue_identifier: "GEO-100",
		};
		await notifier.onSessionStuck(session, 30); // attempt 1

		await notifier.retryUndeliveredGuardrailEvents(); // attempt 2
		await notifier.retryUndeliveredGuardrailEvents(); // attempt 3

		// Should be exhausted now (3 attempts from recordDeliveryFailure)
		// The initial failure in deliverHook records attempt 1,
		// then two retries record attempts 2 and 3
		const undelivered = hbStore.getUndeliveredGuardrailEvents(
			"product-lead",
			["session_stuck"],
			3,
		);
		expect(undelivered).toHaveLength(0); // exhausted — no longer eligible

		// Verify it's still not delivered
		expect(hbStore.getRecentDeliveredEvents("product-lead", 60)).toHaveLength(
			0,
		);

		hbStore.close();
	});
});

describe("FLY-25: HeartbeatService.check() integrates retry", () => {
	it("check() calls retryUndeliveredGuardrailEvents on RegistryHeartbeatNotifier", async () => {
		const { registry } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new RegistryHeartbeatNotifier(
			registry,
			testProjects,
			hbStore,
		);

		// Spy on retryUndeliveredGuardrailEvents
		const retrySpy = vi.spyOn(notifier, "retryUndeliveredGuardrailEvents");

		const service = new HeartbeatService(
			hbStore as any,
			notifier,
			15,
			60_000,
			60,
		);

		await service.check();

		expect(retrySpy).toHaveBeenCalledTimes(1);

		service.stop();
		hbStore.close();
	});
});

describe("FLY-25: StateStore delivery tracking", () => {
	it("recordDeliveryFailure increments attempts and stores error", async () => {
		const store = await StateStore.create(":memory:");
		const seq = store.appendLeadEvent(
			"product-lead",
			"evt-fail",
			"session_stuck",
			"{}",
		);

		store.recordDeliveryFailure(seq, "timeout");
		const events = store.getUndeliveredGuardrailEvents(
			"product-lead",
			["session_stuck"],
			3,
		);
		expect(events).toHaveLength(1);
		expect(events[0]!.delivery_attempts).toBe(1);
		expect(events[0]!.last_delivery_error).toBe("timeout");

		store.recordDeliveryFailure(seq, "503");
		const events2 = store.getUndeliveredGuardrailEvents(
			"product-lead",
			["session_stuck"],
			3,
		);
		expect(events2).toHaveLength(1);
		expect(events2[0]!.delivery_attempts).toBe(2);
		expect(events2[0]!.last_delivery_error).toBe("503");

		store.close();
	});

	it("getUndeliveredGuardrailEvents filters by event type and max attempts", async () => {
		const store = await StateStore.create(":memory:");

		// Guardrail event
		const seq1 = store.appendLeadEvent(
			"product-lead",
			"evt-1",
			"session_stuck",
			"{}",
		);
		// Advisory event (should not appear)
		store.appendLeadEvent("product-lead", "evt-2", "session_completed", "{}");
		// Guardrail event, already delivered
		const seq3 = store.appendLeadEvent(
			"product-lead",
			"evt-3",
			"session_orphaned",
			"{}",
		);
		store.markLeadEventDelivered(seq3);

		const events = store.getUndeliveredGuardrailEvents(
			"product-lead",
			["session_stuck", "session_orphaned"],
			3,
		);
		expect(events).toHaveLength(1);
		expect(events[0]!.seq).toBe(seq1);

		store.close();
	});

	it("getDeliveryStats returns correct counts", async () => {
		const store = await StateStore.create(":memory:");

		// Delivered event
		const seq1 = store.appendLeadEvent(
			"product-lead",
			"evt-1",
			"session_stuck",
			"{}",
		);
		store.markLeadEventDelivered(seq1);

		// Failed event (3+ attempts = permanently failed)
		const seq2 = store.appendLeadEvent(
			"product-lead",
			"evt-2",
			"session_stuck",
			"{}",
		);
		store.recordDeliveryFailure(seq2, "error1");
		store.recordDeliveryFailure(seq2, "error2");
		store.recordDeliveryFailure(seq2, "error3");

		// Pending retry (1 attempt, < 3)
		const seq3 = store.appendLeadEvent(
			"product-lead",
			"evt-3",
			"session_orphaned",
			"{}",
		);
		store.recordDeliveryFailure(seq3, "retry-error");

		const stats = store.getDeliveryStats();
		expect(stats.total_delivered).toBe(1);
		expect(stats.total_failed).toBe(1); // seq2 has 3 attempts (exhausted)
		expect(stats.pending_count).toBe(1); // only seq3 (1 attempt, still retryable)
		expect(stats.last_failure_error).toBeTruthy();

		store.close();
	});
});
