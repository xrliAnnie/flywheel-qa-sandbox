import { describe, expect, it, vi } from "vitest";
import {
	classifyReceiver,
	RECEIVER_HEARTBEAT_EVENT_MIN_INTERVAL_MS,
	RECEIVER_STALL_MS,
	type ResidentReceiverCandidate,
	type ResidentReceiverEvent,
	ResidentReceiverSupervisor,
} from "../resident-receiver-supervisor.js";

const candidate = (
	overrides: Partial<ResidentReceiverCandidate> = {},
): ResidentReceiverCandidate => ({
	executionId: "exec-1",
	issueId: "FLY-2268",
	projectName: "flywheel",
	commDbPath: "/tmp/comm.db",
	wakeMode: "external-watcher",
	receiverContext: {
		leadName: "flywheel-eng-lead",
		runnerName: "flywheel-abc123",
		teamName: "flywheel-eng-lead",
	},
	...overrides,
});

function harness() {
	let nowMs = 1_000_000;
	let candidates: ResidentReceiverCandidate[] = [candidate()];
	let registered = false;
	let enqueueAccepted = true;
	const startFailures = new Set<string>();
	const stopFailures = new Set<string>();
	const delivered: Array<{ executionId: string; messageId: string }> = [];
	const events: Array<{
		event: ResidentReceiverEvent;
		payload: Record<string, unknown>;
	}> = [];
	const watchers: Array<{
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		health: ReturnType<typeof vi.fn>;
		onDelivered?: (message: {
			id: string;
			to: string;
			content: string;
			metadata?: Record<string, unknown>;
		}) => void | Promise<void>;
	}> = [];
	const alert = vi.fn().mockResolvedValue(undefined);
	const createReceiver = vi.fn((current: ResidentReceiverCandidate) => {
		const watcher = {
			start: vi.fn(async () => {
				if (startFailures.has(current.executionId)) {
					throw new Error(`start failed for ${current.executionId}`);
				}
			}),
			stop: vi.fn(async () => {
				if (stopFailures.has(current.executionId)) {
					throw new Error(`stop failed for ${current.executionId}`);
				}
			}),
			health: vi.fn(async () => ({ ok: true, lastEventTs: nowMs })),
			onDelivered: undefined,
		};
		watchers.push(watcher);
		return watcher;
	});
	const supervisor = new ResidentReceiverSupervisor({
		listCandidates: () => candidates,
		hasCommSession: () => registered,
		createReceiver,
		enqueueDelivery: (executionId, message) => {
			delivered.push({ executionId, messageId: message.id });
			return enqueueAccepted;
		},
		record: (_current, event, payload) => events.push({ event, payload }),
		alert,
		nowMs: () => nowMs,
	});
	return {
		supervisor,
		createReceiver,
		watchers,
		delivered,
		events,
		alert,
		setRegistered(value: boolean) {
			registered = value;
		},
		setEnqueueAccepted(value: boolean) {
			enqueueAccepted = value;
		},
		failStartFor(executionId: string) {
			startFailures.add(executionId);
		},
		allowStartFor(executionId: string) {
			startFailures.delete(executionId);
		},
		failStopFor(executionId: string) {
			stopFailures.add(executionId);
		},
		setCandidates(value: ResidentReceiverCandidate[]) {
			candidates = value;
		},
		advance(ms: number) {
			nowMs += ms;
		},
	};
}

describe("FLY-2268 resident receiver lifecycle ownership", () => {
	it("retries delayed CommDB registration and arms exactly once", async () => {
		const h = harness();

		await h.supervisor.arm("exec-1", "admission");
		expect(h.createReceiver).not.toHaveBeenCalled();

		h.setRegistered(true);
		await h.supervisor.reconcile("boot");
		await h.supervisor.reconcile("boot");

		expect(h.createReceiver).toHaveBeenCalledTimes(1);
		expect(h.watchers[0]?.start).toHaveBeenCalledTimes(1);
		expect(h.events).toContainEqual({
			event: "receiver_armed",
			payload: expect.objectContaining({ source: "admission" }),
		});
	});

	it("boot-arms an eligible non-loop worker and routes each delivery once", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.reconcile("boot");

		await h.watchers[0]?.onDelivered?.({
			id: "message-1",
			to: "flywheel-abc123",
			content: "next boundary",
		});
		expect(h.delivered).toEqual([
			{ executionId: "exec-1", messageId: "message-1" },
		]);
		expect(h.events).toContainEqual({
			event: "receiver_armed",
			payload: expect.objectContaining({ source: "boot" }),
		});
	});

	it("rejects a delivery for a different mailbox identity", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");

		await expect(
			h.watchers[0]?.onDelivered?.({
				id: "message-wrong",
				to: "someone-else",
				content: "wrong recipient",
			}),
		).rejects.toThrow("receiver recipient mismatch");
		expect(h.delivered).toEqual([]);
	});

	it("rejects delivery when no durable runner consumer accepts the wake", async () => {
		const h = harness();
		h.setRegistered(true);
		h.setEnqueueAccepted(false);
		await h.supervisor.arm("exec-1", "admission");

		await expect(
			h.watchers[0]?.onDelivered?.({
				id: "message-without-consumer",
				to: "flywheel-abc123",
				content: "must remain on the transport",
			}),
		).rejects.toThrow("receiver durable consumer unavailable");
	});

	it("disarms when StateStore no longer returns the worker", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");
		h.setCandidates([]);

		await h.supervisor.reconcile("boot");

		expect(h.watchers[0]?.stop).toHaveBeenCalledTimes(1);
	});

	it("refuses a late callback from a superseded watcher", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");
		const staleDelivery = h.watchers[0]?.onDelivered;
		h.setCandidates([]);
		await h.supervisor.reconcile("boot");

		await expect(
			staleDelivery?.({
				id: "late-message",
				to: "flywheel-abc123",
				content: "must remain unread",
			}),
		).rejects.toThrow("receiver ownership changed");
		expect(h.delivered).toEqual([]);
	});

	it("isolates one watcher start failure and arms the remaining candidates", async () => {
		const h = harness();
		h.setCandidates([
			candidate(),
			candidate({
				executionId: "exec-2",
				receiverContext: {
					leadName: "flywheel-eng-lead",
					runnerName: "flywheel-def456",
					teamName: "flywheel-eng-lead",
				},
			}),
		]);
		h.setRegistered(true);
		h.failStartFor("exec-1");

		await expect(h.supervisor.reconcile("boot")).resolves.toBeUndefined();

		expect(h.createReceiver).toHaveBeenCalledTimes(2);
		expect(h.watchers[1]?.start).toHaveBeenCalledTimes(1);
		expect(h.events).toContainEqual({
			event: "receiver_stalled",
			payload: expect.objectContaining({
				operation: "arm",
				error: "start failed for exec-1",
			}),
		});
	});

	it("contains an admission arm failure and retries it on reconcile", async () => {
		const h = harness();
		h.setRegistered(true);
		h.failStartFor("exec-1");

		await expect(
			h.supervisor.arm("exec-1", "admission"),
		).resolves.toBeUndefined();
		h.allowStartFor("exec-1");
		await h.supervisor.reconcile("boot");

		expect(h.createReceiver).toHaveBeenCalledTimes(2);
		expect(h.watchers[1]?.start).toHaveBeenCalledTimes(1);
		expect(h.events).toContainEqual({
			event: "receiver_stalled",
			payload: expect.objectContaining({
				operation: "arm",
				source: "admission",
				error: "start failed for exec-1",
			}),
		});
	});

	it("isolates one watcher stop failure and arms a newly eligible candidate", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");
		h.failStopFor("exec-1");
		h.setCandidates([
			candidate({
				executionId: "exec-2",
				receiverContext: {
					leadName: "flywheel-eng-lead",
					runnerName: "flywheel-def456",
					teamName: "flywheel-eng-lead",
				},
			}),
		]);

		await expect(h.supervisor.reconcile("boot")).resolves.toBeUndefined();

		expect(h.createReceiver).toHaveBeenCalledTimes(2);
		expect(h.watchers[1]?.start).toHaveBeenCalledTimes(1);
		expect(h.events).toContainEqual({
			event: "receiver_stalled",
			payload: expect.objectContaining({
				operation: "disarm",
				error: "stop failed for exec-1",
			}),
		});
	});
});

describe("FLY-2268 resident receiver health", () => {
	it.each([
		{
			name: "unsupported",
			input: {
				candidate: true,
				wakeMode: "none" as const,
				armed: false,
				pendingRegistration: false,
				nowMs: 10,
				armedAtMs: 0,
			},
			expected: "unsupported",
		},
		{
			name: "starting",
			input: {
				candidate: true,
				wakeMode: "external-watcher" as const,
				armed: false,
				pendingRegistration: true,
				nowMs: 10,
				armedAtMs: 0,
			},
			expected: "starting",
		},
		{
			name: "receiver_missing",
			input: {
				candidate: true,
				wakeMode: "external-watcher" as const,
				armed: false,
				pendingRegistration: false,
				nowMs: RECEIVER_STALL_MS + 1,
				armedAtMs: 0,
			},
			expected: "receiver_missing",
		},
		{
			name: "receiver_stalled",
			input: {
				candidate: true,
				wakeMode: "external-watcher" as const,
				armed: true,
				pendingRegistration: false,
				nowMs: RECEIVER_STALL_MS + 1,
				armedAtMs: 0,
				health: { ok: true, lastEventTs: 0 },
			},
			expected: "receiver_stalled",
		},
		{
			name: "healthy",
			input: {
				candidate: true,
				wakeMode: "external-watcher" as const,
				armed: true,
				pendingRegistration: false,
				nowMs: RECEIVER_STALL_MS,
				armedAtMs: 0,
				health: { ok: true, lastEventTs: RECEIVER_STALL_MS },
			},
			expected: "healthy",
		},
	])("classifies $name", ({ input, expected }) => {
		expect(classifyReceiver(input)).toBe(expected);
	});

	it("rearms and alerts at most once after three consecutive stalls", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");
		h.watchers[0]?.health.mockResolvedValue({ ok: false });

		await h.supervisor.healthTick();
		await h.supervisor.healthTick();
		await h.supervisor.healthTick();
		h.watchers[1]?.health.mockResolvedValue({ ok: false });
		await h.supervisor.healthTick();
		await h.supervisor.healthTick();

		expect(h.createReceiver).toHaveBeenCalledTimes(2);
		expect(h.watchers[0]?.stop).toHaveBeenCalledTimes(1);
		expect(h.alert).toHaveBeenCalledTimes(1);
		expect(
			h.events.filter(({ event }) => event === "receiver_stalled"),
		).toHaveLength(1);
		expect(h.events).toContainEqual({
			event: "receiver_armed",
			payload: expect.objectContaining({ source: "rearm" }),
		});
	});

	it("throttles durable heartbeat events per worker", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");

		await h.supervisor.healthTick();
		h.advance(RECEIVER_HEARTBEAT_EVENT_MIN_INTERVAL_MS - 1);
		await h.supervisor.healthTick();
		h.advance(1);
		await h.supervisor.healthTick();

		expect(
			h.events.filter(({ event }) => event === "receiver_heartbeat"),
		).toHaveLength(2);
	});

	it("contains one watcher health exception and still checks its peer", async () => {
		const h = harness();
		h.setCandidates([
			candidate(),
			candidate({
				executionId: "exec-2",
				receiverContext: {
					leadName: "flywheel-eng-lead",
					runnerName: "flywheel-def456",
					teamName: "flywheel-eng-lead",
				},
			}),
		]);
		h.setRegistered(true);
		await h.supervisor.reconcile("boot");
		h.watchers[0]?.health.mockRejectedValue(new Error("health unavailable"));

		await h.supervisor.healthTick();

		expect(h.watchers[1]?.health).toHaveBeenCalledTimes(1);
		expect(
			h.events.filter(({ event }) => event === "receiver_heartbeat"),
		).toHaveLength(2);
	});

	it("isolates one alert failure and still rearms the remaining candidate", async () => {
		const h = harness();
		h.setCandidates([
			candidate(),
			candidate({
				executionId: "exec-2",
				receiverContext: {
					leadName: "flywheel-eng-lead",
					runnerName: "flywheel-def456",
					teamName: "flywheel-eng-lead",
				},
			}),
		]);
		h.setRegistered(true);
		await h.supervisor.reconcile("boot");
		h.watchers[0]?.health.mockResolvedValue({ ok: false });
		h.watchers[1]?.health.mockResolvedValue({ ok: false });
		h.alert.mockRejectedValueOnce(new Error("lead inbox unavailable"));

		await h.supervisor.healthTick();
		await h.supervisor.healthTick();
		await expect(h.supervisor.healthTick()).resolves.toBeUndefined();

		expect(h.createReceiver).toHaveBeenCalledTimes(4);
		expect(h.watchers[0]?.stop).toHaveBeenCalledTimes(1);
		expect(h.watchers[1]?.stop).toHaveBeenCalledTimes(1);
		expect(h.events).toContainEqual({
			event: "receiver_stalled",
			payload: expect.objectContaining({
				operation: "health",
				error: "lead inbox unavailable",
			}),
		});
	});

	it("retries a stalled-receiver alert until it is durably accepted", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");
		h.watchers[0]?.health.mockResolvedValue({ ok: false });
		h.alert.mockRejectedValueOnce(new Error("lead inbox unavailable"));

		await h.supervisor.healthTick();
		await h.supervisor.healthTick();
		await h.supervisor.healthTick();
		expect(h.alert).toHaveBeenCalledTimes(1);

		h.watchers[1]?.health.mockResolvedValue({ ok: false });
		await h.supervisor.healthTick();
		expect(h.alert).toHaveBeenCalledTimes(2);
	});

	it("retries a rearm after the old watcher fails to stop", async () => {
		const h = harness();
		h.setRegistered(true);
		await h.supervisor.arm("exec-1", "admission");
		h.watchers[0]?.health.mockResolvedValue({ ok: false });
		h.failStopFor("exec-1");

		await h.supervisor.healthTick();
		await h.supervisor.healthTick();
		await h.supervisor.healthTick();
		await h.supervisor.healthTick();

		expect(h.createReceiver).toHaveBeenCalledTimes(2);
		expect(h.watchers[1]?.start).toHaveBeenCalledTimes(1);
		expect(h.alert).not.toHaveBeenCalled();
		expect(h.events).toContainEqual({
			event: "receiver_stalled",
			payload: expect.objectContaining({
				operation: "health",
				error: "stop failed for exec-1",
			}),
		});
	});

	it("stops all watchers idempotently", async () => {
		const h = harness();
		h.setCandidates([
			candidate(),
			candidate({
				executionId: "exec-2",
				receiverContext: {
					leadName: "flywheel-eng-lead",
					runnerName: "flywheel-def456",
					teamName: "flywheel-eng-lead",
				},
			}),
		]);
		h.setRegistered(true);
		await h.supervisor.reconcile("boot");
		h.failStopFor("exec-1");

		await expect(h.supervisor.stop()).resolves.toBeUndefined();
		await expect(h.supervisor.stop()).resolves.toBeUndefined();

		expect(h.watchers[0]?.stop).toHaveBeenCalledTimes(1);
		expect(h.watchers[1]?.stop).toHaveBeenCalledTimes(1);
	});
});
