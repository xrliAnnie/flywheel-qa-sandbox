import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import { StateStore } from "../StateStore.js";
import { StuckWatcher, WebhookStuckNotifier } from "../StuckWatcher.js";

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

describe("StuckWatcher (compat re-export)", () => {
	let store: {
		getStuckSessions: ReturnType<typeof vi.fn>;
		getOrphanSessions: ReturnType<typeof vi.fn>;
	};
	let notifier: {
		onSessionStuck: ReturnType<typeof vi.fn>;
		onSessionOrphaned: ReturnType<typeof vi.fn>;
	};
	let watcher: StuckWatcher;

	beforeEach(() => {
		store = {
			getStuckSessions: vi.fn().mockReturnValue([]),
			getOrphanSessions: vi.fn().mockReturnValue([]),
		};
		notifier = {
			onSessionStuck: vi.fn().mockResolvedValue(undefined),
			onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
		};
		watcher = new StuckWatcher(store as any, notifier as any, 15, 60_000, 60);
	});

	afterEach(() => {
		watcher.stop();
	});

	it("check() detects stuck session and notifies", async () => {
		const session = makeSession();
		store.getStuckSessions.mockReturnValue([session]);

		await watcher.check();

		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			session,
			expect.any(Number),
		);
	});

	it("check() skips already-notified sessions", async () => {
		const session = makeSession();
		store.getStuckSessions.mockReturnValue([session]);

		await watcher.check();
		await watcher.check();

		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});

	it("check() does nothing when no stuck sessions", async () => {
		store.getStuckSessions.mockReturnValue([]);

		await watcher.check();

		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
	});

	it("start/stop manages interval", () => {
		vi.useFakeTimers();

		watcher.start();
		// Starting again is a no-op
		watcher.start();

		vi.advanceTimersByTime(60_000);
		expect(store.getStuckSessions).toHaveBeenCalledTimes(1);

		watcher.stop();
		vi.advanceTimersByTime(60_000);
		expect(store.getStuckSessions).toHaveBeenCalledTimes(1);

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
	for (const project of testProjects) {
		for (const lead of project.leads) {
			registry.register(lead, mockRuntime);
		}
	}
	return { registry, mockRuntime, envelopes };
}

describe("WebhookStuckNotifier (RegistryHeartbeatNotifier via re-export)", () => {
	it("sends structured envelope via registry runtime with sessionKey", async () => {
		const { registry, envelopes } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new WebhookStuckNotifier(registry, testProjects, hbStore);
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

	it("delivers via registry runtime (not direct HTTP)", async () => {
		const { registry, mockRuntime } = createMockRegistry();
		const hbStore = await StateStore.create(":memory:");
		const notifier = new WebhookStuckNotifier(registry, testProjects, hbStore);
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
