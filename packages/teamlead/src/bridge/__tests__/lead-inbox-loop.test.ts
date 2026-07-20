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

describe("LeadInboxLoop", () => {
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
		const consumer = loop(queue, {
			async deliverBatch(batch) {
				batches.push(batch);
				if (fail) throw new Error("socket disconnected");
				return receipt(batch);
			},
		});
		expect((await consumer.tick()).ok).toBe(false);
		enqueueModel(queue, "C", 0);
		fail = false;
		expect((await consumer.tick()).ok).toBe(true);
		expect(
			batches.map((batch) => batch.members.map((m) => m.deliveryId)),
		).toEqual([
			["A", "B"],
			["A", "B"],
		]);
		expect(queue.getById("C")?.consumed_at).toBeNull();
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

	it("quarantines a poison protocol row once and emits one advisory", async () => {
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
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{
				maxProtocolAttempts: 2,
				handleProtocol: async () => {
					throw new Error("invalid ACK");
				},
				onProtocolQuarantine: advisory,
			},
		);
		expect((await consumer.tick()).ok).toBe(false);
		const second = await consumer.tick();
		expect(second).toMatchObject({ ok: true, protocolConsumed: 1 });
		expect(queue.getById("protocol-poison")).toMatchObject({
			attempts: 2,
			disposition: "quarantined",
			consumed_at: "2026-07-19T12:00:00.000Z",
		});
		expect(advisory).toHaveBeenCalledTimes(1);
		expect((await consumer.tick()).ok).toBe(true);
		expect(advisory).toHaveBeenCalledTimes(1);
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
