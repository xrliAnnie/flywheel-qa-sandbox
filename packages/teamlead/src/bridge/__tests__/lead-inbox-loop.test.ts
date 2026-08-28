import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MailboxQueue, type MailboxRow } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClaudeLeadDeliveryAdapter,
	type DurableAcceptReceipt,
	type LeadDeliveryAdapter,
	type LeadDeliveryBatch,
	LeadDeliveryUnavailableError,
} from "../lead-delivery-adapter.js";
import {
	ACTIVE_LEAD_INBOX_INTERVAL_MS,
	IDLE_LEAD_INBOX_INTERVAL_MS,
	LeadInboxLoop,
} from "../lead-inbox-loop.js";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../mailbox-queue-config.js";

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
		queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
		...overrides,
	});
}

describe("LeadInboxLoop mailbox consumption", () => {
	it("probes one Lead incarnation only once while reconciling several expired batches", async () => {
		const queue = makeQueue();
		const claimAt = "2099-07-19T11:59:50.000Z";
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-a",
			now: claimAt,
			leaseTtlMs: 60_000,
		});
		for (const [index, id] of ["expired-a", "expired-b"].entries()) {
			enqueueModel(queue, id);
			const batchId = `expired-batch-${index}`;
			expect(
				queue.claimLeadBatchQueue({
					toAgent: "lead-a",
					msgClass: "model",
					ownerEpoch: "epoch-a",
					batchId,
					now: claimAt,
					transportClaimTtlMs: 1_000,
					batchWindowMs: 0,
					batchMaxSize: 1,
					inflightMaxBatches: 3,
				}),
			).toHaveLength(1);
			queue.recordLeadBatchDelivered({
				batchId,
				ownerEpoch: "epoch-a",
				now: claimAt,
				ackLeaseTtlMs: 1_000,
			});
		}
		const recipientState = vi.fn(() => "unknown" as const);
		const logger = { warn: vi.fn() };
		const consumer = loop(
			queue,
			{ deliverBatch: vi.fn() },
			{
				queueConfig: () => ({ ...DEFAULT_MAILBOX_QUEUE_CONFIG }),
				recipientState,
				logger,
			},
		);

		expect(await consumer.tick()).toMatchObject({ ok: true, modelConsumed: 0 });
		expect(recipientState).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledWith(
			"Lead inbox held expired batches for an unknown recipient incarnation",
			{ leadId: "lead-a", skippedUnknown: 2 },
		);
		await consumer.tick();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("ON delivers one attempt-scoped batch and waits for agent ACK", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		enqueueModel(queue, "B");
		enqueueModel(queue, "C");
		let delivered!: LeadDeliveryBatch;
		const consumer = loop(
			queue,
			{
				async deliverBatch(batch) {
					delivered = batch;
					return receipt(batch);
				},
			},
			{
				queueConfig: () => ({
					...DEFAULT_MAILBOX_QUEUE_CONFIG,
					ackLeaseMs: 30_000,
				}),
			},
		);

		expect(await consumer.tick()).toMatchObject({ ok: true, modelConsumed: 3 });
		expect(delivered.batchId).toBe("batch-1#r0");
		expect(delivered.members.map(({ deliveryId }) => deliveryId)).toEqual([
			"A#r0",
			"B#r0",
			"C#r0",
		]);
		expect(delivered.modelPayload).toContain(
			"[mailbox-batch batch-1 | 3 messages",
		);
		expect(delivered.modelPayload).not.toContain("[receipt:");
		expect(delivered.modelPayload).toContain("A\n\nB\n\nC");
		expect(queue.getById("A")).toMatchObject({
			state: "LEASED",
			batch_id: "batch-1",
			notified_at: "2099-07-19T12:00:00.000Z",
			delivered_at: null,
		});
		expect(
			queue.ackBatchByRecipient({
				batchId: "batch-1",
				fromAgent: "lead-a",
				now: "2099-07-19T12:00:01.000Z",
			}),
		).toBe("applied");
		expect(queue.getById("A")?.state).toBe("ACKED");
	});

	it("ON exposes the batch ACK contract through the real Claude mailbox adapter", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "A");
		enqueueModel(queue, "B");
		const dir = mkdtempSync(join(tmpdir(), "fly1573-claude-loop-"));
		const inboxPath = join(dir, "lead-a.json");
		const consumer = loop(
			queue,
			new ClaudeLeadDeliveryAdapter({
				inboxPath,
				sidecarPath: `${inboxPath}.flywheel.jsonl`,
			}),
			{
				ackInstruction: "flywheel_inbox_ack_batch",
				queueConfig: () => ({ ...DEFAULT_MAILBOX_QUEUE_CONFIG }),
			},
		);

		expect(await consumer.tick()).toMatchObject({ ok: true, modelConsumed: 2 });
		const inbox = JSON.parse(await readFile(inboxPath, "utf8")) as Array<{
			text: string;
		}>;
		expect(inbox).toHaveLength(2);
		expect(inbox[0]?.text).toContain("[mailbox-batch batch-1 | 2 messages");
		expect(inbox[0]?.text).toContain(
			"You must ack this batch with flywheel_inbox_ack_batch",
		);
		expect(inbox[0]?.text).not.toContain("[receipt:");
		expect(inbox[1]?.text).not.toContain("[receipt:");
		expect(inbox[0]?.text).toContain("A");
		expect(inbox[1]?.text).toBe("B");
		expect(queue.getById("A")?.state).toBe("LEASED");
	});

	it("rebirth replays a receipt-gap batch as a new unread retry generation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1708-rebirth-loop-"));
		const dbPath = join(dir, "comm.db");
		const queue = new MailboxQueue(dbPath);
		queues.push(queue);
		enqueueModel(queue, "A");
		enqueueModel(queue, "B");
		const inboxPath = join(dir, "lead-a.json");
		const adapter = new ClaudeLeadDeliveryAdapter({
			inboxPath,
			sidecarPath: `${inboxPath}.flywheel.jsonl`,
		});
		const queueConfig = () => ({ ...DEFAULT_MAILBOX_QUEUE_CONFIG });

		expect(
			await loop(queue, adapter, {
				queueConfig,
				batchIdFactory: () => "batch-before-rebirth",
			}).tick(),
		).toMatchObject({ ok: true, modelConsumed: 2 });
		const oldInbox = JSON.parse(await readFile(inboxPath, "utf8")) as Array<{
			text: string;
			read: boolean;
		}>;
		await writeFile(
			inboxPath,
			JSON.stringify(oldInbox.map((message) => ({ ...message, read: true }))),
		);
		// The Claude inbox + sidecar are durable, but Bridge crashes before its
		// delivery receipt lands. This is the FLY-1708 receipt-gap seam.
		const db = new Database(dbPath);
		db.prepare(
			"UPDATE mailbox SET delivered_at = NULL WHERE batch_id = 'batch-before-rebirth'",
		).run();
		db.close();

		expect(
			queue.adoptInflightForRecipient({
				recipientKind: "lead",
				toAgent: "lead-a",
				now: "2099-07-19T12:00:01.000Z",
			}),
		).toEqual({ requeued: 2 });
		expect(
			await loop(queue, adapter, {
				queueConfig,
				batchIdFactory: () => "batch-after-rebirth",
			}).tick(),
		).toMatchObject({ ok: true, modelConsumed: 2 });

		const rebornInbox = JSON.parse(await readFile(inboxPath, "utf8")) as Array<{
			text: string;
			read: boolean;
		}>;
		expect(rebornInbox).toHaveLength(4);
		expect(rebornInbox.slice(0, 2).every(({ read }) => read)).toBe(true);
		expect(rebornInbox.slice(2).every(({ read }) => !read)).toBe(true);
		expect(rebornInbox[2]?.text).toContain(
			"[mailbox-batch batch-after-rebirth | 2 messages",
		);
		expect(queue.getById("A")).toMatchObject({
			state: "LEASED",
			batch_id: "batch-after-rebirth",
			lease_retry_count: 1,
		});
	});
	it("records heartbeat and delivery only after adapter receipt plus audit", async () => {
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
		await vi.waitFor(() => expect(batch.batchId).toBe("batch-1#r0"));
		expect(queue.getById("A")?.state).toBe("LEASED");
		release(receipt(batch));
		expect(await ticking).toMatchObject({ ok: true, modelConsumed: 1 });
		expect(audit).toHaveBeenCalledTimes(1);
		expect(queue.getById("A")).toMatchObject({
			state: "LEASED",
			notified_at: "2099-07-19T12:00:00.000Z",
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
			["A#r0", "B#r0"],
			["A#r0", "B#r0"],
		]);
		expect(batches[0]?.modelPayload).toContain("A\n\nB");
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
			expect.objectContaining({ deliveryId: "A#r0" }),
			expect.objectContaining({ deliveryId: "B#r0" }),
		]);
		expect(queue.getById("B")?.state).toBe("LEASED");
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
			expect.objectContaining({ deliveryId: "A#r0" }),
			expect.objectContaining({ deliveryId: "B#r0" }),
		]);
		expect(queue.getById("A")?.state).toBe("LEASED");
		expect(queue.getById("B")?.state).toBe("LEASED");
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
				deliveryId: "question:lead-a:q1#r0",
			}),
		]);
		expect(
			adapter.deliverBatch.mock.calls[0]?.[0].members[0]?.content,
		).toContain("rendered question");
		expect(queue.getById("q1")).toMatchObject({
			state: "LEASED",
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
			expect.objectContaining({ deliveryId: "model-1#r0" }),
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
			await loop(
				queue,
				{
					async deliverBatch(batch) {
						delivered.push(batch);
						return receipt(batch);
					},
				},
				{ queueConfig: () => ({ ...DEFAULT_MAILBOX_QUEUE_CONFIG }) },
			).tick(),
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

	it("stops retrying an unavailable Lead batch after the configured cap", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "question-transport");
		enqueueModel(queue, "question-transport-2");
		const stalled = vi.fn();
		let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
			}),
		};
		const consumer = loop(queue, adapter, {
			now: () => new Date(nowMs),
			retryBackoffBaseMs: 1,
			retryBackoffCapMs: 1,
			onModelTransportStall: stalled,
			queueConfig: () => ({
				...DEFAULT_MAILBOX_QUEUE_CONFIG,
				unavailableRetryMax: 2,
			}),
		});

		expect((await consumer.tick()).ok).toBe(false);
		for (const id of ["question-transport", "question-transport-2"]) {
			expect(queue.getById(id)).toMatchObject({
				state: "LEASED",
				retry_count: 1,
			});
		}
		nowMs += 1;
		expect((await consumer.tick()).ok).toBe(false);
		for (const id of ["question-transport", "question-transport-2"]) {
			expect(queue.getById(id)).toMatchObject({
				state: "DEAD",
				retry_count: 2,
				next_retry_at: null,
				dead_reason: "transport_unavailable_exhausted",
			});
		}
		const terminalSnapshot = [
			queue.getById("question-transport"),
			queue.getById("question-transport-2"),
		];
		for (let tick = 0; tick < 3; tick++) {
			nowMs += 1;
			expect((await consumer.tick()).ok).toBe(true);
		}
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(2);
		expect([
			queue.getById("question-transport"),
			queue.getById("question-transport-2"),
		]).toEqual(terminalSnapshot);
		expect(stalled).toHaveBeenCalledOnce();
	});

	it("keeps unavailable rows live until the terminal alert is accepted", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "question-terminal-alert");
		let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
		let alertAttempts = 0;
		const exhausted = vi.fn(async () => {
			alertAttempts += 1;
			if (alertAttempts === 1) throw new Error("terminal alert unavailable");
		});
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
			}),
		};
		const consumer = loop(queue, adapter, {
			now: () => new Date(nowMs),
			retryBackoffBaseMs: 1,
			retryBackoffCapMs: 1,
			onModelTransportExhausted: exhausted,
			queueConfig: () => ({
				...DEFAULT_MAILBOX_QUEUE_CONFIG,
				unavailableRetryMax: 1,
			}),
		});

		expect((await consumer.tick()).ok).toBe(false);
		expect(queue.getById("question-terminal-alert")).toMatchObject({
			state: "LEASED",
			retry_count: 1,
			dead_reason: null,
		});
		nowMs += 1;
		expect((await consumer.tick()).ok).toBe(false);
		expect(queue.getById("question-terminal-alert")).toMatchObject({
			state: "DEAD",
			retry_count: 2,
			dead_reason: "transport_unavailable_exhausted",
		});
		expect(exhausted).toHaveBeenCalledTimes(2);
		expect(exhausted).toHaveBeenLastCalledWith(
			expect.objectContaining({
				leadId: "lead-a",
				deliveryIds: ["question-terminal-alert"],
				attempt: 2,
				error: "socket unavailable",
			}),
		);
		for (let tick = 0; tick < 3; tick++) {
			nowMs += 1;
			expect((await consumer.tick()).ok).toBe(true);
		}
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(2);
	});

	it("caps unavailable retries on the batch claim path", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "question-queue-on-cap");
		let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
			}),
		};
		const consumer = loop(queue, adapter, {
			now: () => new Date(nowMs),
			retryBackoffBaseMs: 1,
			retryBackoffCapMs: 1,
			onModelTransportExhausted: vi.fn(async () => undefined),
			queueConfig: () => ({
				...DEFAULT_MAILBOX_QUEUE_CONFIG,
				unavailableRetryMax: 2,
			}),
		});

		expect((await consumer.tick()).ok).toBe(false);
		expect(queue.getById("question-queue-on-cap")).toMatchObject({
			state: "LEASED",
			retry_count: 1,
		});
		nowMs += 1;
		expect((await consumer.tick()).ok).toBe(false);
		expect(queue.getById("question-queue-on-cap")).toMatchObject({
			state: "DEAD",
			retry_count: 2,
			dead_reason: "transport_unavailable_exhausted",
		});
		for (let tick = 0; tick < 3; tick++) {
			nowMs += 1;
			expect((await consumer.tick()).ok).toBe(true);
		}
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(2);
	});

	it("maps the default unavailable cap to the real eight-hour backoff schedule", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "question-default-transport-cap");
		const startedAt = Date.parse("2099-07-19T12:00:00.000Z");
		let nowMs = startedAt;
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
			}),
		};
		const consumer = loop(queue, adapter, {
			now: () => new Date(nowMs),
			queueConfig: () => ({
				...DEFAULT_MAILBOX_QUEUE_CONFIG,
			}),
		});

		for (let attempt = 1; attempt <= 55; attempt++) {
			expect((await consumer.tick()).ok).toBe(false);
			const row = queue.getById("question-default-transport-cap");
			expect(row?.retry_count).toBe(attempt);
			if (attempt < 55) {
				expect(row?.state).toBe("LEASED");
				nowMs = Date.parse(row!.next_retry_at!);
			} else {
				expect(row).toMatchObject({
					state: "DEAD",
					dead_reason: "transport_unavailable_exhausted",
					next_retry_at: null,
				});
			}
		}

		expect(nowMs - startedAt).toBe(28_835_000);
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(55);
	});

	it("uses one retry budget across unavailable and ordinary failures", async () => {
		const queue = makeQueue();
		enqueueModel(queue, "question-shared-budget");
		let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
		let unavailable = true;
		const adapter = {
			deliverBatch: vi.fn(async () => {
				if (unavailable) {
					throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
				}
				throw new Error("authentication rejected");
			}),
		};
		const consumer = loop(queue, adapter, {
			now: () => new Date(nowMs),
			retryBackoffBaseMs: 1,
			retryBackoffCapMs: 1,
			maxModelAttempts: 3,
			queueConfig: () => ({
				...DEFAULT_MAILBOX_QUEUE_CONFIG,
				unavailableRetryMax: 10,
			}),
		});

		for (let attempt = 1; attempt <= 2; attempt++) {
			expect((await consumer.tick()).ok).toBe(false);
			expect(queue.getById("question-shared-budget")).toMatchObject({
				state: "LEASED",
				retry_count: attempt,
			});
			nowMs += 1;
		}
		unavailable = false;
		expect((await consumer.tick()).ok).toBe(false);
		expect(queue.getById("question-shared-budget")).toMatchObject({
			state: "DEAD",
			retry_count: 3,
			dead_reason: "delivery_attempts_exhausted",
		});
		expect(adapter.deliverBatch).toHaveBeenCalledTimes(3);
	});

	it("applies the unavailable cap to Discord route transport failures", async () => {
		const queue = makeQueue();
		enqueueDiscord(
			queue,
			"chat:lead-a:323456789012345681",
			"423456789012345681",
		);
		const adapter = {
			deliverBatch: vi.fn(async () => {
				throw new LeadDeliveryUnavailableError(
					"discord",
					"route_protocol_unavailable",
				);
			}),
		};
		const undeliverable = vi.fn(async () => {
			expect(queue.getById("chat:lead-a:323456789012345681")?.state).toBe(
				"LEASED",
			);
		});
		const result = await loop(queue, adapter, {
			onDiscordUndeliverable: undeliverable,
			queueConfig: () => ({
				...DEFAULT_MAILBOX_QUEUE_CONFIG,
				unavailableRetryMax: 1,
			}),
		}).tick();

		expect(result.ok).toBe(false);
		expect(queue.getById("chat:lead-a:323456789012345681")).toMatchObject({
			state: "DEAD",
			retry_count: 1,
			dead_reason: "transport_unavailable_exhausted",
		});
		expect(adapter.deliverBatch).toHaveBeenCalledOnce();
		expect(undeliverable).toHaveBeenCalledOnce();
		expect(undeliverable).toHaveBeenCalledWith(
			expect.objectContaining({
				attempt: 1,
				reason: expect.stringContaining("transport_unavailable_exhausted"),
			}),
		);
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
		expect(undeliverable).toHaveBeenCalledWith(
			expect.objectContaining({ attempt: 1 }),
		);
	});

	it("backs off an unalertable Discord row without blocking ordinary model mail", async () => {
		const queue = makeQueue();
		const discordId = "chat:lead-a:323456789012345680";
		enqueueDiscord(queue, discordId, "423456789012345680");
		enqueueModel(queue, "question-after-alert-failure", 2);
		let batch = 0;
		const consumer = loop(
			queue,
			{
				async deliverBatch(batch) {
					if (batch.kind === "discord_chat")
						throw new Error("permanent rejection");
					return receipt(batch);
				},
			},
			{
				maxModelAttempts: 1,
				batchIdFactory: () => `batch-${++batch}`,
				onDiscordUndeliverable: async () => {
					throw new Error("operator alert rejected");
				},
			},
		);
		const first = await consumer.tick();
		expect(queue.getById(discordId)).toMatchObject({
			state: "LEASED",
			dead_reason: null,
			retry_count: 1,
			next_retry_at: expect.any(String),
		});
		expect(first.ok).toBe(false);
		expect((await consumer.tick()).ok).toBe(true);
		expect(queue.getById("question-after-alert-failure")?.state).toBe("LEASED");
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
