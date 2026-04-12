import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDRAIL_EVENT_TYPES } from "../bridge/lead-runtime.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { IdleWatchdogConfig } from "../RunnerIdleWatchdog.js";
import { RunnerIdleWatchdog } from "../RunnerIdleWatchdog.js";
import type { Session } from "../StateStore.js";

// --- Fixtures ---

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
];

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-100",
		project_name: "geo",
		status: "running",
		issue_identifier: "GEO-100",
		issue_labels: "Product",
		...overrides,
	};
}

// --- Helpers to create mock stores and runtimes ---

function createMockStore(sessions: Session[] = []) {
	let events: Array<{
		leadId: string;
		eventId: string;
		eventType: string;
		payload: string;
		sessionKey?: string;
		seq: number;
		delivered: boolean;
		failureError?: string;
	}> = [];
	let seqCounter = 0;

	return {
		getActiveSessions: vi.fn(() => sessions),
		appendLeadEvent: vi.fn(
			(
				leadId: string,
				eventId: string,
				eventType: string,
				payload: string,
				sessionKey?: string,
			) => {
				// Check for duplicate
				const existing = events.find(
					(e) => e.leadId === leadId && e.eventId === eventId,
				);
				if (existing) return existing.seq;

				seqCounter++;
				events.push({
					leadId,
					eventId,
					eventType,
					payload,
					sessionKey,
					seq: seqCounter,
					delivered: false,
				});
				return seqCounter;
			},
		),
		isLeadEventDelivered: vi.fn((leadId: string, eventId: string) => {
			return events.some(
				(e) => e.leadId === leadId && e.eventId === eventId && e.delivered,
			);
		}),
		markLeadEventDelivered: vi.fn((seq: number) => {
			const ev = events.find((e) => e.seq === seq);
			if (ev) ev.delivered = true;
		}),
		recordDeliveryFailure: vi.fn((_seq: number, _error: string) => {}),
		_events: events,
		_resetEvents: () => {
			events = [];
			seqCounter = 0;
		},
	};
}

function createMockRuntime(delivered = true) {
	return {
		deliver: vi.fn(async () => ({
			delivered,
			error: delivered ? undefined : "test delivery failure",
		})),
		shutdown: vi.fn(),
	};
}

function createMockRegistry(runtime?: ReturnType<typeof createMockRuntime>) {
	return {
		getForLead: vi.fn((_agentId: string) => runtime),
		register: vi.fn(),
		resolve: vi.fn(),
		resolveWithLead: vi.fn(),
		shutdownAll: vi.fn(),
		get size() {
			return runtime ? 1 : 0;
		},
	};
}

type StatusResponse = {
	result: { status: string; reason: string; stale_seconds?: number };
	captureErrorStatus?: number;
};

// Build a watchdog with a mocked statusQuery for deterministic testing
function createTestWatchdog(opts: {
	sessions?: Session[];
	statusResponses?: StatusResponse[];
	delivered?: boolean;
}) {
	const sessions = opts.sessions ?? [makeSession()];
	const store = createMockStore(sessions);
	const runtime = createMockRuntime(opts.delivered ?? true);
	const registry = createMockRegistry(runtime);

	let responseIndex = 0;
	const statusResponses = opts.statusResponses ?? [
		{ result: { status: "executing", reason: "active" } },
	];

	// We'll create the watchdog with a dummy captureSessionFn,
	// then replace the internal statusQuery with our mock.
	const captureSessionFn = vi.fn(async () => ({
		output: "dummy",
		executionId: "exec-1",
		projectName: "geo",
	}));

	const config: IdleWatchdogConfig = {
		pollIntervalMs: 30_000,
		waitingThresholdCycles: 2,
		projects: testProjects,
		store: store as any,
		runtimeRegistry: registry as any,
		captureSessionFn: captureSessionFn as any,
	};

	const watchdog = new RunnerIdleWatchdog(config);

	// Override the internal statusQuery with our mock
	const mockQuery = vi.fn(async () => {
		const resp = statusResponses[responseIndex];
		if (responseIndex < statusResponses.length - 1) responseIndex++;
		return resp;
	});
	(watchdog as any).statusQuery = {
		query: mockQuery,
		stopEviction: vi.fn(),
	};

	return { watchdog, store, runtime, registry, mockQuery };
}

// --- Tests ---

describe("RunnerIdleWatchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("state transitions", () => {
		it("executing→waiting→waiting triggers notification after 2 cycles", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "executing", reason: "active" } },
					{ result: { status: "waiting", reason: "permission prompt" } },
					{ result: { status: "waiting", reason: "permission prompt" } },
				],
			});

			// Cycle 1: executing — no event
			await watchdog.pollOnce();
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			// Cycle 2: waiting (1st) — below threshold
			await watchdog.pollOnce();
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			// Cycle 3: waiting (2nd) — threshold met, should notify
			await watchdog.pollOnce();
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
			const payload = JSON.parse(store.appendLeadEvent.mock.calls[0][3]);
			expect(payload.event_type).toBe("runner_idle_detected");
			expect(payload.status).toBe("waiting");

			watchdog.stop();
		});

		it("executing clears dedup state, counter uses Date.now()", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "waiting", reason: "prompt" } },
					{ result: { status: "waiting", reason: "prompt" } },
					// → triggers (counter=Date.now())
					{ result: { status: "executing", reason: "active" } },
					// → clears dedup
					{ result: { status: "waiting", reason: "prompt2" } },
					{ result: { status: "waiting", reason: "prompt2" } },
					// → triggers again (counter=Date.now(), different)
				],
			});

			await watchdog.pollOnce(); // waiting 1
			vi.advanceTimersByTime(1); // ensure different Date.now()
			await watchdog.pollOnce(); // waiting 2 → trigger
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
			const eventId1 = store.appendLeadEvent.mock.calls[0][1];
			expect(eventId1).toContain("_waiting_");

			await watchdog.pollOnce(); // executing → clear dedup

			await watchdog.pollOnce(); // waiting 1 (new cycle)
			vi.advanceTimersByTime(1);
			await watchdog.pollOnce(); // waiting 2 → trigger again
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);
			const eventId2 = store.appendLeadEvent.mock.calls[1][1];
			expect(eventId2).toContain("_waiting_");
			// Different timestamps → different eventIds
			expect(eventId1).not.toBe(eventId2);

			watchdog.stop();
		});
	});

	describe("dedup", () => {
		it("same waiting status doesn't re-notify within one transition", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "waiting", reason: "prompt" } },
					{ result: { status: "waiting", reason: "prompt" } },
					// → triggers
					{ result: { status: "waiting", reason: "prompt" } },
					// → should NOT trigger again
				],
			});

			await watchdog.pollOnce();
			await watchdog.pollOnce(); // trigger
			await watchdog.pollOnce(); // should be deduped
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			watchdog.stop();
		});
	});

	describe("immediate trigger", () => {
		it("idle status triggers without debounce", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{
						result: {
							status: "idle",
							reason: "shell prompt detected",
						},
					},
				],
			});

			await watchdog.pollOnce();
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
			const payload = JSON.parse(store.appendLeadEvent.mock.calls[0][3]);
			expect(payload.status).toBe("idle");

			watchdog.stop();
		});

		it("unknown status triggers without debounce", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{
						result: {
							status: "unknown",
							reason: "tmux window not found",
						},
					},
				],
			});

			await watchdog.pollOnce();
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
			const payload = JSON.parse(store.appendLeadEvent.mock.calls[0][3]);
			expect(payload.status).toBe("unknown");

			watchdog.stop();
		});
	});

	describe("event payload", () => {
		it("emits correct event_type, execution_id, status, summary", async () => {
			const { watchdog, store, runtime } = createTestWatchdog({
				statusResponses: [
					{
						result: {
							status: "idle",
							reason: "Runner exited to shell",
						},
					},
				],
			});

			await watchdog.pollOnce();

			expect(store.appendLeadEvent).toHaveBeenCalledWith(
				"product-lead",
				expect.stringContaining("idle_exec-1_idle_"),
				"runner_idle_detected",
				expect.any(String),
				"exec-1",
			);

			const payload = JSON.parse(store.appendLeadEvent.mock.calls[0][3]);
			expect(payload).toMatchObject({
				event_type: "runner_idle_detected",
				execution_id: "exec-1",
				issue_id: "GEO-100",
				status: "idle",
				summary: "Runner exited to shell",
				session_role: "main",
			});

			expect(runtime.deliver).toHaveBeenCalledTimes(1);
			expect(store.markLeadEventDelivered).toHaveBeenCalledTimes(1);

			watchdog.stop();
		});
	});

	describe("session eligibility", () => {
		it("only monitors running sessions, skips awaiting_review", async () => {
			const { watchdog, mockQuery } = createTestWatchdog({
				sessions: [
					makeSession({
						execution_id: "exec-run",
						status: "running",
					}),
					makeSession({
						execution_id: "exec-review",
						status: "awaiting_review",
					}),
					makeSession({
						execution_id: "exec-ship",
						status: "approved_to_ship",
					}),
				],
				statusResponses: [
					{ result: { status: "executing", reason: "active" } },
				],
			});

			await watchdog.pollOnce();
			// Only exec-run should be checked (getActiveSessions returns all,
			// but filter keeps only "running")
			expect(mockQuery).toHaveBeenCalledTimes(1);
			expect(mockQuery).toHaveBeenCalledWith("exec-run", "geo");

			watchdog.stop();
		});
	});

	describe("stale entry eviction", () => {
		it("removes entries for sessions no longer active", async () => {
			const sessions = [
				makeSession({ execution_id: "exec-1" }),
				makeSession({ execution_id: "exec-2" }),
			];
			const { watchdog, store } = createTestWatchdog({
				sessions,
				statusResponses: [
					{
						result: {
							status: "idle",
							reason: "shell prompt",
						},
					},
				],
			});

			await watchdog.pollOnce();
			// Both sessions processed, stateMap should have 2 entries
			expect((watchdog as any).stateMap.size).toBe(2);

			// Remove exec-2 from active sessions
			store.getActiveSessions.mockReturnValue([
				makeSession({ execution_id: "exec-1" }),
			]);

			await watchdog.pollOnce();
			expect((watchdog as any).stateMap.size).toBe(1);
			expect((watchdog as any).stateMap.has("exec-1")).toBe(true);
			expect((watchdog as any).stateMap.has("exec-2")).toBe(false);

			watchdog.stop();
		});
	});

	describe("concurrent poll guard", () => {
		it("second poll is skipped if first still running", async () => {
			let resolveQuery: (() => void) | null = null;
			const { watchdog, mockQuery } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "executing", reason: "active" } },
				],
			});

			// Make the query hang
			mockQuery.mockImplementationOnce(
				() =>
					new Promise<StatusResponse>((resolve) => {
						resolveQuery = () =>
							resolve({
								result: {
									status: "executing",
									reason: "active",
								},
							});
					}),
			);

			const poll1 = watchdog.pollOnce();
			const poll2 = watchdog.pollOnce(); // Should be skipped

			await poll2; // Should return immediately

			// Resolve the first poll
			resolveQuery!();
			await poll1;

			// Only 1 query call (the second poll was skipped)
			expect(mockQuery).toHaveBeenCalledTimes(1);

			watchdog.stop();
		});
	});

	describe("captureErrorStatus", () => {
		it("skips idle notification for infra errors", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{
						result: {
							status: "unknown",
							reason: "CommDB not found",
						},
						captureErrorStatus: 404,
					},
				],
			});

			await watchdog.pollOnce();
			// Should NOT emit an event — this is an infra error, not a real idle
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			watchdog.stop();
		});

		it("triggers for tmux-unreachable (no captureErrorStatus)", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{
						result: {
							status: "unknown",
							reason: "tmux window not found",
						},
						// No captureErrorStatus → genuine tmux-unreachable
					},
				],
			});

			await watchdog.pollOnce();
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			watchdog.stop();
		});
	});

	describe("delivery failure", () => {
		it("persists event and updates notifiedForStatus even on delivery failure", async () => {
			const { watchdog, store, runtime } = createTestWatchdog({
				delivered: false,
				statusResponses: [
					{
						result: {
							status: "idle",
							reason: "shell prompt",
						},
					},
					{
						result: {
							status: "idle",
							reason: "shell prompt",
						},
					},
				],
			});

			await watchdog.pollOnce();

			// Event was persisted
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
			// Delivery was attempted but failed
			expect(runtime.deliver).toHaveBeenCalledTimes(1);
			expect(store.recordDeliveryFailure).toHaveBeenCalledTimes(1);
			// markDelivered was NOT called
			expect(store.markLeadEventDelivered).not.toHaveBeenCalled();

			// notifiedForStatus was updated (because event was persisted),
			// so next poll should NOT re-append
			await watchdog.pollOnce();
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1); // Still 1

			watchdog.stop();
		});
	});

	describe("GUARDRAIL_EVENT_TYPES", () => {
		it("includes runner_idle_detected", () => {
			expect(GUARDRAIL_EVENT_TYPES.has("runner_idle_detected")).toBe(true);
		});
	});

	describe("re-entry dedup", () => {
		it("executing→idle→executing→idle generates two separate events", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{
						result: {
							status: "idle",
							reason: "shell prompt",
						},
					},
					// → triggers (counter=1)
					{
						result: {
							status: "executing",
							reason: "active",
						},
					},
					// → clears dedup
					{
						result: {
							status: "idle",
							reason: "shell prompt again",
						},
					},
					// → triggers again (counter=2)
				],
			});

			await watchdog.pollOnce(); // idle → trigger
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			await watchdog.pollOnce(); // executing → clear

			vi.advanceTimersByTime(1); // ensure different Date.now()
			await watchdog.pollOnce(); // idle → trigger again
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);

			// Verify different eventIds (Date.now()-based)
			const eventId1 = store.appendLeadEvent.mock.calls[0][1];
			const eventId2 = store.appendLeadEvent.mock.calls[1][1];
			expect(eventId1).not.toBe(eventId2);

			watchdog.stop();
		});
	});

	describe("interleaving resets waitingCycleCount", () => {
		it("waiting→idle→waiting does NOT trigger prematurely", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "waiting", reason: "prompt" } },
					// waitingCycleCount=1
					{
						result: {
							status: "idle",
							reason: "shell prompt",
						},
					},
					// idle triggers immediately, BUT also resets waitingCycleCount=0
					{ result: { status: "waiting", reason: "prompt again" } },
					// waitingCycleCount=1 — below threshold(2), should NOT trigger
				],
			});

			await watchdog.pollOnce(); // waiting (count=1, below threshold)
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			await watchdog.pollOnce(); // idle → triggers immediately
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			await watchdog.pollOnce(); // waiting (count=1 again, below threshold)
			// Should NOT trigger — the idle in between broke the waiting streak
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			watchdog.stop();
		});

		it("waiting→unknown→waiting does NOT trigger prematurely", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "waiting", reason: "prompt" } },
					{
						result: {
							status: "unknown",
							reason: "tmux not found",
						},
					},
					// unknown triggers immediately, resets waitingCycleCount
					{ result: { status: "waiting", reason: "prompt" } },
					// waitingCycleCount=1 — below threshold
				],
			});

			await watchdog.pollOnce(); // waiting (count=1)
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			await watchdog.pollOnce(); // unknown → triggers
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			await watchdog.pollOnce(); // waiting (count=1, not 2)
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			watchdog.stop();
		});

		it("waiting→captureErrorStatus→waiting does NOT trigger prematurely", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "waiting", reason: "prompt" } },
					// waitingCycleCount=1
					{
						result: {
							status: "unknown",
							reason: "CommDB 502",
						},
						captureErrorStatus: 502,
					},
					// infra error → skipped, BUT resets waitingCycleCount=0
					{ result: { status: "waiting", reason: "prompt" } },
					// waitingCycleCount=1, below threshold — should NOT trigger
				],
			});

			await watchdog.pollOnce(); // waiting (count=1)
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			await watchdog.pollOnce(); // captureErrorStatus → skip, reset count
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			await watchdog.pollOnce(); // waiting (count=1, NOT 2)
			// Should NOT trigger — infra error broke the waiting streak
			expect(store.appendLeadEvent).not.toHaveBeenCalled();

			watchdog.stop();
		});

		it("waiting(alerted)→captureErrorStatus→waiting→waiting re-alerts", async () => {
			const { watchdog, store } = createTestWatchdog({
				statusResponses: [
					{ result: { status: "waiting", reason: "prompt" } },
					{ result: { status: "waiting", reason: "prompt" } },
					// → triggers (notifiedForStatus = "waiting")
					{
						result: {
							status: "unknown",
							reason: "CommDB 502",
						},
						captureErrorStatus: 502,
					},
					// infra error → clears waitingCycleCount AND notifiedForStatus
					{ result: { status: "waiting", reason: "prompt again" } },
					{ result: { status: "waiting", reason: "prompt again" } },
					// → should trigger again (fresh alert after infra recovery)
				],
			});

			await watchdog.pollOnce(); // waiting (count=1)
			await watchdog.pollOnce(); // waiting (count=2) → trigger
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);

			await watchdog.pollOnce(); // captureErrorStatus → reset all dedup state

			await watchdog.pollOnce(); // waiting (count=1)
			vi.advanceTimersByTime(1);
			await watchdog.pollOnce(); // waiting (count=2) → should trigger again
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);

			watchdog.stop();
		});
	});

	describe("cross-restart eventId uniqueness", () => {
		it("Date.now()-based transitionCounter avoids post-restart collisions", async () => {
			// Simulate: first process emits an event at time T=1000
			vi.setSystemTime(1000);

			const { watchdog: watchdog1, store } = createTestWatchdog({
				statusResponses: [
					{
						result: {
							status: "idle",
							reason: "shell prompt",
						},
					},
				],
			});

			await watchdog1.pollOnce();
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
			const eventId1 = store.appendLeadEvent.mock.calls[0][1];
			expect(eventId1).toBe("idle_exec-1_idle_1000");

			// Mark as delivered
			store.markLeadEventDelivered(1);
			watchdog1.stop();

			// Simulate Bridge restart: new watchdog, same store, time moves forward
			vi.setSystemTime(2000);

			const runtime2 = createMockRuntime(true);
			const registry2 = createMockRegistry(runtime2);
			const config2: IdleWatchdogConfig = {
				pollIntervalMs: 30_000,
				waitingThresholdCycles: 2,
				projects: testProjects,
				store: store as any,
				runtimeRegistry: registry2 as any,
				captureSessionFn: vi.fn() as any,
			};
			const watchdog2 = new RunnerIdleWatchdog(config2);
			(watchdog2 as any).statusQuery = {
				query: vi.fn(async () => ({
					result: { status: "idle", reason: "shell prompt again" },
				})),
				stopEviction: vi.fn(),
			};

			await watchdog2.pollOnce();
			expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);
			const eventId2 = store.appendLeadEvent.mock.calls[1][1];
			expect(eventId2).toBe("idle_exec-1_idle_2000");

			// Different eventIds — no collision despite "restart"
			expect(eventId1).not.toBe(eventId2);
			// The new event was emitted (not deduped against the old one)
			expect(runtime2.deliver).toHaveBeenCalledTimes(1);

			watchdog2.stop();
		});
	});

	describe("start/stop lifecycle", () => {
		it("start sets up interval, stop clears it", () => {
			const { watchdog } = createTestWatchdog({});

			watchdog.start();
			// Should not throw on double start
			watchdog.start();

			watchdog.stop();
			// Should not throw on double stop
			watchdog.stop();
		});
	});
});
