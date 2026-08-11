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
import { LeadDeliveryUnavailableError } from "../lead-delivery-adapter.js";
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

function enqueueDiscord(
	queue: MailboxQueue,
	id: string,
	replyChannelId: string,
	content = "hello",
): void {
	const envelope = {
		v: 1,
		receiptId: id,
		leadId: "lead-a",
		chatId: "123456789012345678",
		originChannelId: "123456789012345678",
		messageId: id.split(":").at(-1),
		authorId: "223456789012345678",
		authorName: "Annie",
		ts: "2099-07-19T12:00:00.000Z",
		priority: 1,
		msgKind: "guild",
		attachments: [],
		text: content,
		replyChannelId,
	};
	queue.enqueue({
		id,
		fromAgent: "founder",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "discord_chat",
		content: `[discord-chat-receipt v1] ${JSON.stringify(envelope)}`,
		deliveryContent: content,
		senderRef: encodeSenderRef(),
	});
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

	it("delivers one route-homogeneous Discord batch with route metadata", async () => {
		const queue = makeQueue();
		enqueueDiscord(
			queue,
			"chat:lead-a:323456789012345678",
			"423456789012345678",
		);
		enqueueDiscord(
			queue,
			"chat:lead-a:323456789012345679",
			"423456789012345678",
		);
		enqueueDiscord(
			queue,
			"chat:lead-a:323456789012345680",
			"423456789012345680",
		);
		const delivered: LeadDeliveryBatch[] = [];
		expect(
			await loop(queue, {
				async deliverBatch(batch) {
					delivered.push(batch);
					return receipt(batch);
				},
			}).tick(),
		).toMatchObject({ ok: true, modelConsumed: 2 });
		expect(delivered[0]).toMatchObject({
			kind: "discord_chat",
			replyChannelId: "423456789012345678",
		});
		expect(queue.getById("chat:lead-a:323456789012345680")?.state).toBe(
			"QUEUED",
		);
	});

	it("quarantines one malformed Discord singleton without calling the adapter", async () => {
		const queue = makeQueue();
		queue.enqueue({
			id: "bad-discord",
			fromAgent: "founder",
			toAgent: "lead-a",
			recipientKind: "lead",
			type: "discord_chat",
			content: "broken",
			senderRef: encodeSenderRef(),
		});
		enqueueModel(queue, "normal-after");
		const adapter = { deliverBatch: vi.fn(async (batch) => receipt(batch)) };
		expect(await loop(queue, adapter).tick()).toMatchObject({ ok: true });
		expect(queue.getById("bad-discord")).toMatchObject({
			state: "DEAD",
			dead_reason: expect.stringContaining("discord_undeliverable:route_parse"),
		});
		expect(adapter.deliverBatch).not.toHaveBeenCalled();
		expect(
			await loop(queue, adapter, { batchIdFactory: () => "batch-2" }).tick(),
		).toMatchObject({
			ok: true,
			modelConsumed: 1,
		});
	});

	it("does not exhaust ordinary model rows during a Codex transport outage", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "question-transport");
		const stalled = vi.fn();
		const result = await loop(
			queue,
			{
				async deliverBatch() {
					throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
				},
			},
			{ maxModelAttempts: 1, onModelTransportStall: stalled },
		).tick();
		expect(result.ok).toBe(false);
		expect(queue.getById("question-transport")).toMatchObject({
			state: "LEASED",
			retry_count: 1,
		});
		expect(stalled).toHaveBeenCalledOnce();
	});

	it("quarantines and alerts after a bounded permanent Discord failure", async () => {
		const queue = makeQueue();
		enqueueDiscord(
			queue,
			"chat:lead-a:323456789012345679",
			"423456789012345679",
		);
		const warn = vi.fn();
		const undeliverable = vi.fn(async () => {
			expect(queue.getById("chat:lead-a:323456789012345679")?.state).toBe(
				"LEASED",
			);
		});
		const result = await loop(
			queue,
			{
				async deliverBatch() {
					throw new Error("Codex Lead inbox rejected: authentication rejected");
				},
			},
			{
				maxModelAttempts: 1,
				logger: { warn },
				onDiscordUndeliverable: undeliverable,
			},
		).tick();
		expect(result.ok).toBe(false);
		expect(queue.getById("chat:lead-a:323456789012345679")).toMatchObject({
			state: "DEAD",
			dead_reason: expect.stringContaining("discord_undeliverable"),
		});
		expect(warn).toHaveBeenCalledWith(
			"discord_mailbox_undeliverable",
			expect.objectContaining({
				deliveryIds: ["chat:lead-a:323456789012345679"],
			}),
		);
		expect(undeliverable).toHaveBeenCalledOnce();
	});

	it("keeps an undeliverable Discord row leased when its alert is rejected", async () => {
		const queue = makeQueue();
		enqueueDiscord(queue, "chat:lead-a:alert-failed", "423456789012345680");
		const result = await loop(
			queue,
			{
				async deliverBatch() {
					throw new Error("permanent rejection");
				},
			},
			{
				maxModelAttempts: 1,
				onDiscordUndeliverable: async () => {
					throw new Error("operator alert rejected");
				},
			},
		).tick();
		expect(result.ok).toBe(false);
		expect(queue.getById("chat:lead-a:alert-failed")).toMatchObject({
			state: "LEASED",
			dead_reason: null,
		});
	});

	it("rate-limits Discord stall alerts and clears the episode on recovery", async () => {
		const queue = makeQueue();
		enqueueDiscord(
			queue,
			"chat:lead-a:323456789012345678",
			"423456789012345678",
		);
		let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
		let failing = true;
		const warn = vi.fn();
		const stalled = vi.fn();
		const consumer = loop(
			queue,
			{
				async deliverBatch(batch) {
					if (failing)
						throw new LeadDeliveryUnavailableError(
							"discord",
							"socket unavailable",
						);
					return receipt(batch);
				},
			},
			{
				now: () => new Date(nowMs),
				retryBackoffBaseMs: 1,
				retryBackoffCapMs: 1,
				logger: { warn },
				onDiscordDeliveryStall: stalled,
			},
		);
		for (let attempt = 0; attempt < 5; attempt++) {
			expect((await consumer.tick()).ok).toBe(false);
			nowMs += 1;
		}
		expect(
			warn.mock.calls.filter(
				([event]) => event === "discord_mailbox_delivery_stalled",
			),
		).toHaveLength(1);
		expect(stalled).toHaveBeenCalledOnce();
		failing = false;
		expect((await consumer.tick()).ok).toBe(true);
		expect(warn).toHaveBeenCalledWith("discord_mailbox_delivery_recovered", {
			leadId: "lead-a",
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
