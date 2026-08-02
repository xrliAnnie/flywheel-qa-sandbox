import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	DurableAcceptReceipt,
	LeadDeliveryAdapter,
	LeadDeliveryBatch,
} from "../lead-delivery-adapter.js";
import {
	ACTIVE_LEAD_INBOX_INTERVAL_MS,
	IDLE_LEAD_INBOX_INTERVAL_MS,
	LeadInboxLoop,
} from "../lead-inbox-loop.js";

const queues: LeadInboxQueue[] = [];
afterEach(() => {
	for (const queue of queues.splice(0)) queue.close();
	vi.useRealTimers();
});

function makeQueue(): LeadInboxQueue {
	const queue = new LeadInboxQueue(
		join(mkdtempSync(join(tmpdir(), "fly1373-loop-")), "comm.db"),
	);
	queues.push(queue);
	return queue;
}

function enqueueModel(queue: LeadInboxQueue, id: string, priority = 1) {
	queue.enqueue({
		id,
		toLead: "lead-a",
		source: "test",
		type: "regular",
		msgClass: "model",
		priority: priority as 0 | 1 | 2 | 3,
		content: id,
	});
}

function receipt(batch: LeadDeliveryBatch): DurableAcceptReceipt {
	return {
		batchId: batch.batchId,
		memberIds: batch.members.map(({ deliveryId }) => deliveryId),
		status: "accepted_new",
	};
}

function loop(
	queue: LeadInboxQueue,
	adapter: LeadDeliveryAdapter,
	overrides: Partial<ConstructorParameters<typeof LeadInboxLoop>[0]> = {},
) {
	return new LeadInboxLoop({
		queue,
		leadId: "lead-a",
		ownerEpoch: "epoch-a",
		adapter,
		hasLiveSession: () => false,
		handleProtocol: async () => ({ disposition: "protocol_applied" }),
		now: () => new Date("2026-07-19T12:00:00.000Z"),
		batchIdFactory: () => "batch-1",
		...overrides,
	});
}

function receiptOverrides(
	enabled: boolean,
	extra: Record<string, unknown> = {},
): Partial<ConstructorParameters<typeof LeadInboxLoop>[0]> {
	return {
		receiptFoundationEnabled: () => enabled,
		...extra,
	} as unknown as Partial<ConstructorParameters<typeof LeadInboxLoop>[0]>;
}

describe("LeadInboxLoop", () => {
	it("QA fault seam pauses after last_started_at but before success", async () => {
		const queue = makeQueue();
		let release!: () => void;
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{ afterTickStarted: () => paused },
		);
		const ticking = consumer.tick();
		await vi.waitFor(() =>
			expect(queue.getHeartbeat("lead-a")?.last_started_at).toBe(
				"2026-07-19T12:00:00.000Z",
			),
		);
		expect(queue.getHeartbeat("lead-a")?.last_success_at).toBeNull();
		release();
		expect((await ticking).ok).toBe(true);
		expect(queue.getHeartbeat("lead-a")?.last_success_at).toBe(
			"2026-07-19T12:00:00.000Z",
		);
	});

	it("renders every model delivery with its stable receipt id", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "receipt-A");
		enqueueModel(queue, "receipt-B");
		let delivered!: LeadDeliveryBatch;
		const consumer = loop(queue, {
			async deliverBatch(batch) {
				delivered = batch;
				return receipt(batch);
			},
		});

		expect((await consumer.tick()).ok).toBe(true);
		expect(delivered.modelPayload).toBe(
			"[receipt:receipt-A]\nreceipt-A\n\n[receipt:receipt-B]\nreceipt-B",
		);
	});

	it("does not consume until a durable adapter receipt and audit commit", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		let release!: (value: DurableAcceptReceipt) => void;
		const pending = new Promise<DurableAcceptReceipt>((resolve) => {
			release = resolve;
		});
		let seenBatch!: LeadDeliveryBatch;
		const audit = vi.fn();
		const consumer = loop(
			queue,
			{
				async deliverBatch(batch) {
					seenBatch = batch;
					return pending;
				},
			},
			{ markAuditDelivered: audit },
		);
		const ticking = consumer.tick();
		await vi.waitFor(() => expect(seenBatch.batchId).toBe("batch-1"));
		expect(queue.getById("A")?.consumed_at).toBeNull();
		expect(audit).not.toHaveBeenCalled();
		release(receipt(seenBatch));
		expect((await ticking).ok).toBe(true);
		expect(audit).toHaveBeenCalledTimes(1);
		expect(queue.getById("A")).toMatchObject({
			disposition: "delivered",
			consumed_at: "2026-07-19T12:00:00.000Z",
		});
	});

	it("retains a failed frozen batch and excludes arrivals from its retry", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		enqueueModel(queue, "B");
		const batches: LeadDeliveryBatch[] = [];
		let fail = true;
		let nowMs = Date.parse("2026-07-19T12:00:00.000Z");
		const consumer = loop(
			queue,
			{
				async deliverBatch(batch) {
					batches.push(batch);
					if (fail) throw new Error("socket disconnected");
					return receipt(batch);
				},
			},
			receiptOverrides(false, {
				now: () => new Date(nowMs),
				retryBackoffBaseMs: 5_000,
				retryBackoffCapMs: 5_000,
			}),
		);
		expect((await consumer.tick()).ok).toBe(false);
		enqueueModel(queue, "C", 0);
		fail = false;
		nowMs += 5_000;
		expect((await consumer.tick()).ok).toBe(true);
		expect(
			batches.map((batch) => batch.members.map((m) => m.deliveryId)),
		).toEqual([
			["A", "B"],
			["A", "B"],
		]);
		expect(queue.getById("C")?.consumed_at).toBeNull();
	});

	it("persists model retry backoff and honors it for frozen and fresh claims", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		let nowMs = Date.parse("2026-07-19T12:00:00.000Z");
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new Error("socket disconnected");
			}),
		};
		const consumer = loop(
			queue,
			adapter,
			receiptOverrides(true, {
				now: () => new Date(nowMs),
				retryBackoffBaseMs: 5_000,
				retryBackoffCapMs: 60_000,
			}),
		);

		expect((await consumer.tick()).ok).toBe(false);
		expect(queue.getById("A")).toMatchObject({
			attempts: 1,
			next_retry_at: "2026-07-19T12:00:05.000Z",
		});
		nowMs += 1_000;
		expect((await consumer.tick()).ok).toBe(true);
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(1);
		enqueueModel(queue, "B", 0);
		expect((await consumer.tick()).ok).toBe(false);
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(2);
		expect(adapter.deliverBatch.mock.calls[1]?.[0].members).toEqual([
			expect.objectContaining({ deliveryId: "B" }),
		]);
		nowMs = Date.parse("2026-07-19T12:00:05.000Z");
		expect((await consumer.tick()).ok).toBe(false);
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(3);
		expect(adapter.deliverBatch.mock.calls[2]?.[0].members).toEqual([
			expect.objectContaining({ deliveryId: "A" }),
		]);
	});

	it("dead-letters an exhausted model batch and emits one durable alert", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		let nowMs = Date.parse("2026-07-19T12:00:00.000Z");
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new Error("permanent adapter failure");
			}),
		};
		const consumer = loop(
			queue,
			adapter,
			receiptOverrides(true, {
				now: () => new Date(nowMs),
				maxModelAttempts: 2,
				retryBackoffBaseMs: 1_000,
				retryBackoffCapMs: 1_000,
			}),
		);

		expect((await consumer.tick()).ok).toBe(false);
		nowMs += 1_000;
		expect((await consumer.tick()).ok).toBe(false);
		expect(queue.getById("A")).toMatchObject({
			attempts: 2,
			disposition: "dead_letter",
			consumed_at: "2026-07-19T12:00:01.000Z",
		});
		const getAlert = (
			queue as unknown as {
				getReceiptAlertOutbox?: (id: string) => {
					kind: string;
					payload: string;
				};
			}
		).getReceiptAlertOutbox;
		expect(getAlert).toBeTypeOf("function");
		expect(getAlert?.call(queue, "dead_letter:batch-1")).toMatchObject({
			kind: "dead_letter",
		});
		expect(
			JSON.parse(
				getAlert?.call(queue, "dead_letter:batch-1")?.payload ?? "null",
			),
		).toMatchObject({ batchId: "batch-1", memberIds: ["A"] });
		expect((await consumer.tick()).ok).toBe(true);
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(2);
	});

	it("rollback pauses receipt chasing without reverting delivery failure safety", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new Error("legacy retry");
			}),
		};
		const consumer = loop(
			queue,
			adapter,
			receiptOverrides(false, { maxModelAttempts: 2 }),
		);

		expect((await consumer.tick()).ok).toBe(false);
		expect((await consumer.tick()).ok).toBe(true);
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(1);
		expect(queue.getById("A")).toMatchObject({
			attempts: 1,
			consumed_at: null,
			next_retry_at: expect.any(String),
			next_unprocessed_at: null,
		});
	});

	it("uses one receipt flag snapshot for a complete tick", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		let flagReads = 0;
		const consumer = loop(
			queue,
			{
				async deliverBatch() {
					throw new Error("legacy retry");
				},
			},
			{
				maxModelAttempts: 2,
				receiptFoundationEnabled: () => flagReads++ > 0,
			},
		);

		expect((await consumer.tick()).ok).toBe(false);
		expect(flagReads).toBe(1);
		expect(queue.getById("A")).toMatchObject({
			attempts: 1,
			consumed_at: null,
			disposition: null,
			next_retry_at: expect.any(String),
		});
	});

	it("batches 50 concurrent-priority rows in priority/FIFO order without loss", async () => {
		const queue = makeQueue();
		for (let index = 0; index < 50; index++) {
			enqueueModel(queue, `message-${index}`, index % 4);
		}
		let delivered: LeadDeliveryBatch | undefined;
		const result = await loop(queue, {
			async deliverBatch(batch) {
				delivered = batch;
				return receipt(batch);
			},
		}).tick();

		expect(result).toMatchObject({ ok: true, modelConsumed: 50 });
		expect(delivered?.members).toHaveLength(50);
		expect(delivered?.members.map(({ deliveryId }) => deliveryId)).toEqual(
			[0, 1, 2, 3].flatMap((priority) =>
				Array.from({ length: 50 }, (_, index) => index)
					.filter((index) => index % 4 === priority)
					.map((index) => `message-${index}`),
			),
		);
		expect(
			Array.from(
				{ length: 50 },
				(_, index) => queue.getById(`message-${index}`)?.consumed_at,
			).every(Boolean),
		).toBe(true);
	});

	it("routes protocol rows to code without putting them in the model batch", async () => {
		const queue = makeQueue();
		queue.enqueue({
			id: "protocol-1",
			toLead: "lead-a",
			source: "ack",
			type: "ack_receipt",
			msgClass: "protocol",
			priority: 1,
			content: "{}",
		});
		enqueueModel(queue, "model-1");
		const protocol = vi.fn(async () => ({ disposition: "ack_applied" }));
		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		const result = await loop(queue, adapter, {
			handleProtocol: protocol,
		}).tick();
		expect(result).toMatchObject({
			ok: true,
			protocolConsumed: 1,
			modelConsumed: 1,
		});
		expect(protocol).toHaveBeenCalledWith(
			expect.objectContaining({ id: "protocol-1" }),
		);
		expect(adapter.deliverBatch.mock.calls[0]?.[0].members).toEqual([
			expect.objectContaining({ deliveryId: "model-1" }),
		]);
	});

	it("dead-letters a poison protocol row once even while chase is rolled back", async () => {
		const queue = makeQueue();
		queue.enqueue({
			id: "protocol-poison",
			toLead: "lead-a",
			source: "ack",
			type: "ack_receipt",
			msgClass: "protocol",
			priority: 1,
			content: "{}",
		});
		const advisory = vi.fn();
		let nowMs = Date.parse("2026-07-19T12:00:00.000Z");
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{
				maxProtocolAttempts: 2,
				...receiptOverrides(false, {
					now: () => new Date(nowMs),
					retryBackoffBaseMs: 5_000,
					retryBackoffCapMs: 5_000,
				}),
				handleProtocol: async () => {
					throw new Error("invalid ACK");
				},
				onProtocolQuarantine: advisory,
			},
		);
		expect((await consumer.tick()).ok).toBe(false);
		nowMs += 5_000;
		const second = await consumer.tick();
		expect(second).toMatchObject({ ok: true, protocolConsumed: 1 });
		expect(queue.getById("protocol-poison")).toMatchObject({
			attempts: 2,
			disposition: "dead_letter",
			consumed_at: "2026-07-19T12:00:05.000Z",
		});
		expect(advisory).toHaveBeenCalledTimes(1);
		expect((await consumer.tick()).ok).toBe(true);
		expect(advisory).toHaveBeenCalledTimes(1);
	});

	it("backs off and durably dead-letters exhausted protocol delivery", async () => {
		const queue = makeQueue();
		queue.enqueue({
			id: "protocol-poison",
			toLead: "lead-a",
			source: "ack",
			type: "ack_receipt",
			msgClass: "protocol",
			priority: 1,
			content: "{}",
		});
		let nowMs = Date.parse("2026-07-19T12:00:00.000Z");
		const handleProtocol = vi.fn(async () => {
			throw new Error("invalid ACK");
		});
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			receiptOverrides(true, {
				now: () => new Date(nowMs),
				maxProtocolAttempts: 2,
				retryBackoffBaseMs: 1_000,
				retryBackoffCapMs: 1_000,
				handleProtocol,
			}),
		);

		expect((await consumer.tick()).ok).toBe(false);
		nowMs += 500;
		expect((await consumer.tick()).ok).toBe(true);
		expect(handleProtocol).toHaveBeenCalledTimes(1);
		nowMs += 500;
		expect((await consumer.tick()).ok).toBe(true);
		expect(handleProtocol).toHaveBeenCalledTimes(2);
		expect(queue.getById("protocol-poison")).toMatchObject({
			attempts: 2,
			disposition: "dead_letter",
			consumed_at: "2026-07-19T12:00:01.000Z",
		});
		expect(
			queue.getReceiptAlertOutbox("dead_letter:protocol:protocol-poison"),
		).toMatchObject({ kind: "dead_letter" });
	});

	it("quarantines an immutable membership conflict and persists one advisory", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		const adapter = {
			deliverBatch: vi
				.fn<(batch: LeadDeliveryBatch) => Promise<DurableAcceptReceipt>>()
				.mockImplementationOnce(async (batch) => ({
					...receipt(batch),
					status: "membership_conflict" as const,
				}))
				.mockImplementation(async (batch) => receipt(batch)),
		};
		const first = await loop(queue, adapter).tick();
		expect(first.error).toBeUndefined();
		expect(first).toMatchObject({ ok: true });
		expect(queue.getById("A")).toMatchObject({
			disposition: "quarantined",
			consumed_at: "2026-07-19T12:00:00.000Z",
		});
		const advisoryId = "model_alert:lead-a:batch-1";
		expect(queue.getById(advisoryId)).toMatchObject({
			to_lead: "lead-a",
			source: "model_quarantine:batch-1",
			type: "model_batch_quarantined",
			msg_class: "model",
			priority: 2,
			consumed_at: null,
		});
		expect(queue.getById(advisoryId)?.content).toContain(
			"batch-1 quarantined 1 model message(s)",
		);
		expect((await loop(queue, adapter).tick()).ok).toBe(true);
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(2);
		expect(adapter.deliverBatch.mock.calls[1]?.[0].members).toEqual([
			expect.objectContaining({ deliveryId: advisoryId }),
		]);
		expect(queue.getById(advisoryId)?.disposition).toBe("delivered");
	});

	it("uses 1s while active/pending, 30s while idle, and nudge pulls immediately", async () => {
		vi.useFakeTimers();
		const queue = makeQueue();
		let active = false;
		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		const consumer = loop(queue, adapter, { hasLiveSession: () => active });
		expect(consumer.nextDelayMs()).toBe(IDLE_LEAD_INBOX_INTERVAL_MS);
		active = true;
		expect(consumer.nextDelayMs()).toBe(ACTIVE_LEAD_INBOX_INTERVAL_MS);
		active = false;
		consumer.start();
		await vi.runAllTicks();
		enqueueModel(queue, "doorbell");
		consumer.nudge();
		await vi.runAllTicks();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() =>
			expect(adapter.deliverBatch).toHaveBeenCalledTimes(1),
		);
		consumer.stop();
	});

	it("does not refresh success heartbeat on a failed tick", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		const result = await loop(queue, {
			async deliverBatch() {
				throw new Error("down");
			},
		}).tick();
		expect(result.ok).toBe(false);
		expect(queue.getHeartbeat("lead-a")).toMatchObject({
			last_started_at: "2026-07-19T12:00:00.000Z",
			last_success_at: null,
		});
	});
});

describe("FLY-1599 tick boundary hardening", () => {
	it("keeps a throwing recordTickStarted inside the tick boundary", async () => {
		const queue = makeQueue();
		const consumer = loop(queue, {
			deliverBatch: vi.fn(async (batch) => receipt(batch)),
		});
		const busy = vi.spyOn(queue, "recordTickStarted").mockImplementation(() => {
			throw new Error("database is locked");
		});
		// Before the fix this line REJECTED (SqliteError escaped tick entirely,
		// which in production became an unhandledRejection that killed the Bridge).
		const result = await consumer.tick();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("database is locked");
		// The loop must survive the bad tick: restore the queue and tick again.
		busy.mockRestore();
		expect((await consumer.tick()).ok).toBe(true);
	});

	it("nextDelayMs falls back to the idle delay when countPending throws", () => {
		const queue = makeQueue();
		const warn = vi.fn();
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{ logger: { warn } as never },
		);
		vi.spyOn(queue, "countPending").mockImplementation(() => {
			throw new Error("database is locked");
		});
		// Before the fix this THREW inside runAndSchedule's finally block —
		// the same process-killing escape path as the tick throw.
		expect(consumer.nextDelayMs()).toBe(IDLE_LEAD_INBOX_INTERVAL_MS);
		expect(warn).toHaveBeenCalledWith(
			"Lead inbox nextDelayMs failed; using idle delay",
			expect.objectContaining({ error: "database is locked" }),
		);
	});

	it("nothing escapes the floating runAndSchedule promise", async () => {
		const queue = makeQueue();
		const warn = vi.fn();
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{ logger: { warn } as never },
		);
		// Force a rejection PAST tick's own catch to prove the outer
		// belt-and-suspenders boundary holds on the floating promise.
		const tickSpy = vi
			.spyOn(consumer as unknown as { tick: () => Promise<never> }, "tick")
			.mockRejectedValue(new Error("boundary breach"));
		const escaped: unknown[] = [];
		const trap = (reason: unknown) => escaped.push(reason);
		process.on("unhandledRejection", trap);
		try {
			// The loop is born stopped; start() performs the mount-time first pull
			// as exactly the floating `void runAndSchedule()` promise under test.
			consumer.start();
			await vi.waitFor(() => expect(tickSpy).toHaveBeenCalled());
			await vi.waitFor(() =>
				expect(warn).toHaveBeenCalledWith(
					"Lead inbox tick escaped its boundary",
					expect.objectContaining({ error: "boundary breach" }),
				),
			);
			await new Promise((resolve) => setImmediate(resolve));
			expect(escaped).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", trap);
			consumer.stop();
		}
	});
});

describe("FLY-1599 non-Error rejection values (codex review HIGH)", () => {
	it("a `throw null` from sync SQL stays inside the tick boundary", async () => {
		const queue = makeQueue();
		const consumer = loop(queue, {
			deliverBatch: vi.fn(async (batch) => receipt(batch)),
		});
		const busy = vi.spyOn(queue, "recordTickStarted").mockImplementation(() => {
			// deliberate non-Error throw: `null` is a legal JS rejection value
			throw null;
		});
		// Before the serialization fix, `(error as Error).message` threw a
		// TypeError INSIDE the catch — escaping the boundary it exists to seal.
		const result = await consumer.tick();
		expect(result.ok).toBe(false);
		expect(result.error).toBe("null");
		busy.mockRestore();
		expect((await consumer.tick()).ok).toBe(true);
	});

	it("a string rejection past tick's catch is serialized, not re-thrown", async () => {
		const queue = makeQueue();
		const warn = vi.fn();
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{ logger: { warn } as never },
		);
		vi.spyOn(
			consumer as unknown as { tick: () => Promise<never> },
			"tick",
		).mockRejectedValue("raw string failure");
		const escaped: unknown[] = [];
		const trap = (reason: unknown) => escaped.push(reason);
		process.on("unhandledRejection", trap);
		try {
			consumer.start();
			await vi.waitFor(() =>
				expect(warn).toHaveBeenCalledWith(
					"Lead inbox tick escaped its boundary",
					expect.objectContaining({ error: "raw string failure" }),
				),
			);
			await new Promise((resolve) => setImmediate(resolve));
			expect(escaped).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", trap);
			consumer.stop();
		}
	});

	it("a rejecting afterTickStarted returns {ok:false} without touching last_success_at", async () => {
		const queue = makeQueue();
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{
				afterTickStarted: async () => {
					throw new Error("seam blew up");
				},
			},
		);
		const result = await consumer.tick();
		expect(result.ok).toBe(false);
		expect(result.error).toBe("seam blew up");
		expect(queue.getHeartbeat("lead-a")?.last_success_at ?? null).toBeNull();
	});
});
