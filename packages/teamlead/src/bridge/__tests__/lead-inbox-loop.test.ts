import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue, type MailboxRow } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
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

const queues: MailboxQueue[] = [];
afterEach(() => {
	for (const queue of queues.splice(0)) queue.close();
	vi.useRealTimers();
});

function makeQueue(): MailboxQueue {
	const queue = new MailboxQueue(
		join(mkdtempSync(join(tmpdir(), "fly1572-loop-")), "comm.db"),
	);
	queues.push(queue);
	return queue;
}

function enqueueModel(queue: MailboxQueue, id: string, priority = 1): void {
	queue.enqueue({
		id,
		fromAgent: "bridge",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "regular",
		priority: priority as 0 | 1 | 2 | 3,
		content: id,
		senderRef: encodeSenderRef(),
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
	queue: MailboxQueue,
	adapter: LeadDeliveryAdapter,
	overrides: Partial<ConstructorParameters<typeof LeadInboxLoop>[0]> = {},
): LeadInboxLoop {
	return new LeadInboxLoop({
		queue,
		leadId: "lead-a",
		ownerEpoch: "epoch-a",
		adapter,
		hasLiveSession: () => false,
		handleProtocol: async () => ({ disposition: "protocol_applied" }),
		now: () => new Date("2099-07-19T12:00:00.000Z"),
		batchIdFactory: () => "batch-1",
		...overrides,
	});
}

describe("LeadInboxLoop mailbox consumption", () => {
	it("records heartbeat and ACKs only after adapter receipt plus audit", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		let release!: (value: DurableAcceptReceipt) => void;
		const pending = new Promise<DurableAcceptReceipt>((resolve) => {
			release = resolve;
		});
		let batch!: LeadDeliveryBatch;
		const audit = vi.fn();
		const ticking = loop(
			queue,
			{
				async deliverBatch(value) {
					batch = value;
					return pending;
				},
			},
			{ markAuditDelivered: audit },
		).tick();
		await vi.waitFor(() => expect(batch.batchId).toBe("batch-1"));
		expect(queue.getById("A")?.state).toBe("LEASED");
		release(receipt(batch));
		expect(await ticking).toMatchObject({ ok: true, modelConsumed: 1 });
		expect(audit).toHaveBeenCalledTimes(1);
		expect(queue.getById("A")).toMatchObject({
			state: "ACKED",
			acked_at: "2099-07-19T12:00:00.000Z",
		});
		expect(queue.getHeartbeat("lead-a")?.last_success_at).toBe(
			"2099-07-19T12:00:00.000Z",
		);
	});

	it("renders stable delivery ids and preserves a frozen retry membership", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		enqueueModel(queue, "B");
		let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
		let fail = true;
		const batches: LeadDeliveryBatch[] = [];
		const consumer = loop(
			queue,
			{
				async deliverBatch(batch) {
					batches.push(batch);
					if (fail) throw new Error("offline");
					return receipt(batch);
				},
			},
			{
				now: () => new Date(nowMs),
				retryBackoffBaseMs: 5_000,
				retryBackoffCapMs: 5_000,
			},
		);
		expect((await consumer.tick()).ok).toBe(false);
		enqueueModel(queue, "C", 0);
		fail = false;
		nowMs += 5_000;
		expect((await consumer.tick()).ok).toBe(true);
		expect(
			batches.map((batch) => batch.members.map((row) => row.deliveryId)),
		).toEqual([
			["A", "B"],
			["A", "B"],
		]);
		expect(batches[0]?.modelPayload).toBe("[receipt:A]\nA\n\n[receipt:B]\nB");
		expect(queue.getById("C")?.state).toBe("QUEUED");
	});

	it("skips revalidation for terminal members of a frozen batch", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		enqueueModel(queue, "B");
		const now = "2099-07-19T12:00:00.000Z";
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-a",
			now,
			leaseTtlMs: 30_000,
		});
		queue.claimLeadBatch({
			toAgent: "lead-a",
			msgClass: "model",
			ownerEpoch: "epoch-a",
			batchId: "batch-1",
			now,
			claimTtlMs: 30_000,
		});
		expect(queue.ack("A", now)).toBe(true);

		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		const revalidateModel = vi.fn(async (row: MailboxRow) =>
			row.id === "A"
				? ({ deliver: false, disposition: "revoked_answered" } as const)
				: ({ deliver: true } as const),
		);
		expect(
			await loop(queue, adapter, { revalidateModel }).tick(),
		).toMatchObject({ ok: true, modelConsumed: 2 });
		expect(revalidateModel).toHaveBeenCalledTimes(1);
		expect(revalidateModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "B" }),
		);
		expect(adapter.deliverBatch.mock.calls[0]?.[0].members).toEqual([
			expect.objectContaining({ deliveryId: "A" }),
			expect.objectContaining({ deliveryId: "B" }),
		]);
		expect(queue.getById("B")?.state).toBe("ACKED");
	});

	it("does not shrink a frozen batch when revalidation would revoke a member", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		enqueueModel(queue, "B");
		const now = "2099-07-19T12:00:00.000Z";
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-a",
			now,
			leaseTtlMs: 30_000,
		});
		queue.claimLeadBatch({
			toAgent: "lead-a",
			msgClass: "model",
			ownerEpoch: "epoch-a",
			batchId: "batch-before-crash",
			now,
			claimTtlMs: 30_000,
		});

		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		const revalidateModel = vi.fn(async (row: MailboxRow) =>
			row.id === "A"
				? ({ deliver: false, disposition: "revoked_orphan" } as const)
				: ({ deliver: true } as const),
		);
		expect(
			await loop(queue, adapter, {
				revalidateModel,
				batchIdFactory: () => "batch-after-crash",
			}).tick(),
		).toMatchObject({ ok: true, modelConsumed: 2 });
		expect(revalidateModel).not.toHaveBeenCalled();
		expect(adapter.deliverBatch.mock.calls[0]?.[0].members).toEqual([
			expect.objectContaining({ deliveryId: "A" }),
			expect.objectContaining({ deliveryId: "B" }),
		]);
		expect(queue.getById("A")?.state).toBe("ACKED");
		expect(queue.getById("B")?.state).toBe("ACKED");
	});

	it("re-materializes a frozen question after pre-delivery revalidation fails", async () => {
		const queue = makeQueue();
		queue.enqueue({
			id: "q1",
			deliveryId: "question:lead-a:q1",
			fromAgent: "runner-a",
			toAgent: "lead-a",
			recipientKind: "lead",
			type: "question",
			content: "raw question",
			senderRef: encodeSenderRef(),
		});
		let batchNumber = 0;
		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		const revalidateModel = vi
			.fn<(row: MailboxRow) => Promise<{ deliver: true }>>()
			.mockRejectedValueOnce(new Error("materialization failed"))
			.mockImplementationOnce(async (row) => {
				queue.materializeForDelivery({
					id: row.id,
					ownerEpoch: row.claimed_by!,
					batchId: row.batch_id!,
					sourceKind: "question",
					sourceRef: "41",
					deliveryContent: "rendered question",
				});
				return { deliver: true };
			});
		const consumer = loop(queue, adapter, {
			revalidateModel,
			batchIdFactory: () => `batch-${++batchNumber}`,
		});

		expect(await consumer.tick()).toMatchObject({
			ok: false,
			modelConsumed: 0,
		});
		expect(queue.getById("q1")).toMatchObject({
			state: "LEASED",
			batch_id: "batch-1",
			source_ref: null,
			delivery_content: null,
		});
		expect(await consumer.tick()).toMatchObject({ ok: true, modelConsumed: 1 });
		expect(revalidateModel).toHaveBeenCalledTimes(2);
		expect(adapter.deliverBatch.mock.calls[0]?.[0].members).toEqual([
			expect.objectContaining({
				deliveryId: "question:lead-a:q1",
				content: "rendered question",
			}),
		]);
		expect(queue.getById("q1")).toMatchObject({
			state: "ACKED",
			source_kind: "question",
			source_ref: "41",
			delivery_content: "rendered question",
		});
	});

	it("releases a transiently-held question for 30 seconds without hot-looping", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "question-1");
		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		const consumer = loop(queue, adapter, {
			revalidateModel: async () => ({
				deliver: false,
				disposition: "revoked_qa_hold",
				retry: true,
			}),
		});
		expect(await consumer.tick()).toMatchObject({ ok: true, modelConsumed: 0 });
		expect(queue.getById("question-1")).toMatchObject({
			state: "QUEUED",
			batch_id: null,
			next_retry_at: "2099-07-19T12:00:30.000Z",
			last_error: "revoked_qa_hold",
		});
		expect(queue.countDeliverable("lead-a")).toBe(0);
		expect(adapter.deliverBatch).not.toHaveBeenCalled();
	});

	it("routes bridge protocol separately from Lead model delivery", async () => {
		const queue = makeQueue();
		queue.enqueue({
			id: "protocol-1",
			fromAgent: "lead-a",
			toAgent: "bridge",
			recipientKind: "bridge",
			type: "ack_receipt",
			msgClass: "protocol",
			content: "{}",
			senderRef: encodeSenderRef(),
		});
		enqueueModel(queue, "model-1");
		const protocol = vi.fn(async () => ({ disposition: "ack_applied" }));
		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		expect(
			await loop(queue, adapter, { handleProtocol: protocol }).tick(),
		).toMatchObject({ ok: true, protocolConsumed: 1, modelConsumed: 1 });
		expect(queue.getById("protocol-1")?.state).toBe("ACKED");
		expect(adapter.deliverBatch.mock.calls[0]?.[0].members).toEqual([
			expect.objectContaining({ deliveryId: "model-1" }),
		]);
	});

	it("marks immutable membership conflicts DEAD", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		const result = await loop(queue, {
			async deliverBatch(batch) {
				return { ...receipt(batch), status: "membership_conflict" };
			},
		}).tick();
		expect(result.ok).toBe(true);
		expect(queue.getById("A")).toMatchObject({
			state: "DEAD",
			dead_reason: "membership_conflict:batch-1",
		});
	});

	it("uses active/pending cadence and contains SQL failures", async () => {
		const queue = makeQueue();
		let active = false;
		const warn = vi.fn();
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn(async (batch) => receipt(batch)) },
			{ hasLiveSession: () => active, logger: { warn } },
		);
		expect(consumer.nextDelayMs()).toBe(IDLE_LEAD_INBOX_INTERVAL_MS);
		active = true;
		expect(consumer.nextDelayMs()).toBe(ACTIVE_LEAD_INBOX_INTERVAL_MS);
		active = false;
		vi.spyOn(queue, "countDeliverable").mockImplementation(() => {
			throw new Error("database is locked");
		});
		expect(consumer.nextDelayMs()).toBe(IDLE_LEAD_INBOX_INTERVAL_MS);
		expect(warn).toHaveBeenCalledWith(
			"Lead inbox nextDelayMs failed; using idle delay",
			expect.objectContaining({ error: "database is locked" }),
		);
	});

	it("contains non-Error failures inside tick", async () => {
		const queue = makeQueue();
		const consumer = loop(queue, {
			deliverBatch: vi.fn(async (batch) => receipt(batch)),
		});
		vi.spyOn(queue, "recordTickStarted").mockImplementation(() => {
			throw null;
		});
		expect(await consumer.tick()).toMatchObject({ ok: false, error: "null" });
	});
});
