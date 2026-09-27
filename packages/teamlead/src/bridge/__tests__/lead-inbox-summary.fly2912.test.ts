import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadDeliveryBatch } from "../lead-delivery-adapter.js";
import {
	LeadInboxLoop,
	type LeadInboxLoopOptions,
} from "../lead-inbox-loop.js";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../mailbox-queue-config.js";

const roots: string[] = [];
const queues: MailboxQueue[] = [];
afterEach(() => {
	for (const queue of queues.splice(0)) queue.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function setup(overrides: Partial<LeadInboxLoopOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "fly2912-inbox-summary-"));
	roots.push(root);
	const queue = new MailboxQueue(join(root, "comm.db"));
	queues.push(queue);
	let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
	let sourceContent = "[只读账目概览] 阶段变更 3 条";
	const scope = {
		projectName: "project-a",
		leadId: "lead-a",
		storeEpoch: "store-a",
	};
	const readScope = () => ({
		...scope,
		ownerEpoch: "owner-a",
		now: new Date(nowMs).toISOString(),
	});
	const prepareAuditSummary = vi.fn(
		(input: {
			batchId: string;
			transportBatchId: string;
			memberIds: readonly string[];
			now: string;
		}) => {
			queue.initializeLeadAuditSummaryCursor({
				...readScope(),
				throughSeq: 0,
				anchorEventId: null,
			});
			const offer = queue.freezeLeadAuditSummaryOffer({
				...readScope(),
				...input,
				fromSeq: 0,
				throughSeq: 3,
				anchorEventId: "event-3",
				content: sourceContent,
			});
			if (!offer) throw new Error("summary owner fence lost");
			return {
				content: offer.content,
				receipt: {
					...scope,
					transportBatchId: input.transportBatchId,
					memberIds: input.memberIds,
				},
			};
		},
	);
	const accepted = (batch: LeadDeliveryBatch) => ({
		batchId: batch.batchId,
		memberIds: batch.members.map(({ deliveryId }) => deliveryId),
		status: "accepted_new" as const,
	});
	const adapter = {
		deliverBatch: vi.fn(async (batch: LeadDeliveryBatch) => accepted(batch)),
	};
	const loop = new LeadInboxLoop({
		queue,
		leadId: "lead-a",
		ownerEpoch: "owner-a",
		adapter,
		hasLiveSession: () => false,
		handleProtocol: async () => ({ disposition: "done" }),
		now: () => new Date(nowMs),
		batchIdFactory: () => "batch-a",
		queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
		prepareAuditSummary,
		retryBackoffBaseMs: 5_000,
		retryBackoffCapMs: 5_000,
		...overrides,
	});
	const enqueue = (id: string, discord = false) =>
		queue.enqueue({
			id,
			fromAgent: discord ? "founder" : "runner",
			toAgent: "lead-a",
			recipientKind: "lead",
			type: discord ? "discord_chat" : "regular",
			senderRef: encodeSenderRef(),
			content: discord
				? `[discord-chat-receipt v1] ${JSON.stringify({
						v: 1,
						receiptId: "chat:lead-a:423456789012345678",
						leadId: "lead-a",
						chatId: "123456789012345678",
						originChannelId: "123456789012345678",
						messageId: "423456789012345678",
						authorId: "223456789012345678",
						authorName: "Annie",
						ts: new Date(nowMs).toISOString(),
						priority: 1,
						msgKind: "guild",
						attachments: [],
						text: id,
						replyChannelId: "323456789012345678",
					})}`
				: id,
			deliveryContent: id,
		});
	return {
		queue,
		loop,
		enqueue,
		adapter,
		prepareAuditSummary,
		accepted,
		cursor: () => queue.getLeadAuditSummaryCursor(readScope()),
		offer: () =>
			queue.getLeadAuditSummaryOffer({
				...readScope(),
				transportBatchId: "batch-a#r0",
			}),
		advance: () => {
			nowMs += 5_000;
		},
		changeContent: (value: string) => {
			sourceContent = value;
		},
	};
}

describe("FLY-2912 summary rides existing Lead batches", () => {
	it.each(["dead", "hold"] as const)(
		"does not prepare a summary when the interrupt decision is %s",
		async (kind) => {
			const f = setup({
				interruptHooks: {
					decide: async () =>
						kind === "dead"
							? { kind, reason: "binding_mismatch" }
							: { kind, reason: "busy", retryAfterMs: 10_000 },
				},
			});
			f.queue.enqueue({
				id: "interrupt-a",
				fromAgent: "lead-interrupt:a",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: "lead_interrupt",
				senderRef: encodeSenderRef(),
				content: "founder action",
			});
			expect((await f.loop.tick()).ok).toBe(true);
			expect(f.prepareAuditSummary).not.toHaveBeenCalled();
			expect(f.adapter.deliverBatch).not.toHaveBeenCalled();
			expect(f.cursor()).toBeUndefined();
			expect(f.queue.getById("interrupt-a")?.state).toBe(
				kind === "dead" ? "DEAD" : "QUEUED",
			);
		},
	);

	it.each(["mail", "custom"] as const)(
		"attaches and receipts a summary through the interrupt %s path",
		async (kind) => {
			const delivered: LeadDeliveryBatch[] = [];
			const onDelivered = vi.fn();
			const f = setup({
				interruptHooks: {
					decide: async (_row, batch) =>
						kind === "mail"
							? { kind, onDelivered }
							: {
									kind,
									deliver: async () => {
										delivered.push(structuredClone(batch));
										return { receipt: f.accepted(batch) };
									},
								},
				},
			});
			f.queue.enqueue({
				id: "interrupt-a",
				fromAgent: "lead-interrupt:a",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: "lead_interrupt",
				senderRef: encodeSenderRef(),
				content: "founder action",
			});
			expect((await f.loop.tick()).ok).toBe(true);
			const batch =
				kind === "mail"
					? f.adapter.deliverBatch.mock.calls[0]![0]
					: delivered[0]!;
			expect(batch.members[0]!.content).toContain("founder action");
			expect(batch.members[0]!.content).toContain("只读账目概览");
			expect(batch.modelPayload).toContain("只读账目概览");
			expect(batch.members.map((member) => member.deliveryId)).toEqual([
				"interrupt-a#r0",
			]);
			expect(f.cursor()?.offeredThroughSeq).toBe(3);
			expect(f.queue.getById("interrupt-a")?.notified_at).not.toBeNull();
			expect(f.queue.getById("interrupt-a")).toMatchObject({
				state: "LEASED",
				acked_at: null,
			});
			if (kind === "custom") {
				expect(f.adapter.deliverBatch).not.toHaveBeenCalled();
			} else {
				expect(onDelivered).toHaveBeenCalledOnce();
			}
		},
	);

	it("appends to the final Claude member and Codex payload, preserving membership and ACK header", async () => {
		const f = setup();
		f.enqueue("question-a");
		f.enqueue("question-b");
		expect((await f.loop.tick()).ok).toBe(true);
		const batch = f.adapter.deliverBatch.mock.calls[0]![0];
		expect(batch.batchId).toBe("batch-a#r0");
		expect(batch.members.map(({ deliveryId }) => deliveryId)).toEqual([
			"question-a#r0",
			"question-b#r0",
		]);
		expect(batch.members[0]!.content).toContain(
			"[mailbox-batch batch-a | 2 messages | from runner]",
		);
		expect(batch.members[0]!.content).not.toContain("只读账目概览");
		expect(batch.members[1]!.content).toBe(
			"question-b\n\n[只读账目概览] 阶段变更 3 条",
		);
		expect(batch.modelPayload).toContain(
			"question-a\n\nquestion-b\n\n[只读账目概览] 阶段变更 3 条",
		);
		expect(f.cursor()?.offeredThroughSeq).toBe(3);
		expect(f.offer()?.acceptedAt).not.toBeNull();
	});

	it("keeps the founder Discord route and original member content", async () => {
		const f = setup();
		f.enqueue("founder-message", true);
		expect((await f.loop.tick()).ok).toBe(true);
		const batch = f.adapter.deliverBatch.mock.calls[0]![0];
		expect(batch).toMatchObject({
			kind: "discord_chat",
			replyChannelId: "323456789012345678",
		});
		expect(batch.members[0]!.content).toContain(
			"founder-message\n\n[只读账目概览]",
		);
		expect(f.cursor()?.offeredThroughSeq).toBe(3);
	});

	it("does not build or deliver a summary when no model batch exists", async () => {
		const f = setup();
		expect((await f.loop.tick()).ok).toBe(true);
		expect(f.prepareAuditSummary).not.toHaveBeenCalled();
		expect(f.adapter.deliverBatch).not.toHaveBeenCalled();
	});

	it("does not turn an audit-only revalidated notification into a wake", async () => {
		const f = setup({
			revalidateModel: async () => ({
				deliver: false,
				disposition: "audit_only",
				auditDecision: {
					policyVersion: "notification-v2",
					reason: "ordinary_stage",
					proofRef: "proof-a",
					decidedAt: "2099-07-19T12:00:00.000Z",
				},
			}),
		});
		f.enqueue("quiet-stage");
		expect((await f.loop.tick()).ok).toBe(true);
		expect(f.prepareAuditSummary).not.toHaveBeenCalled();
		expect(f.adapter.deliverBatch).not.toHaveBeenCalled();
	});

	it("retries frozen bytes after a lost receipt and advances only after accepted_duplicate", async () => {
		const f = setup();
		f.enqueue("question-a");
		f.adapter.deliverBatch.mockRejectedValueOnce(new Error("lost receipt"));
		expect((await f.loop.tick()).ok).toBe(false);
		expect(f.cursor()?.offeredThroughSeq).toBe(0);
		expect(f.offer()?.acceptedAt).toBeNull();
		f.changeContent("new events must wait");
		f.advance();
		f.adapter.deliverBatch.mockImplementationOnce(async (batch) => ({
			...f.accepted(batch),
			status: "accepted_duplicate" as never,
		}));
		expect((await f.loop.tick()).ok).toBe(true);
		expect(f.adapter.deliverBatch.mock.calls[1]![0]).toEqual(
			f.adapter.deliverBatch.mock.calls[0]![0],
		);
		expect(f.cursor()?.offeredThroughSeq).toBe(3);
	});

	it.each(["revalidation", "adapter receipt", "frozen retry"])(
		"delivers the remaining task when another member is ACKED during %s",
		async (timing) => {
			const f = setup({
				revalidateModel: async () => {
					await Promise.resolve();
					if (timing === "revalidation")
						f.queue.ack("question-a", "2099-07-19T12:00:00.000Z");
					return { deliver: true };
				},
			});
			f.enqueue("question-a");
			f.enqueue("question-b");
			f.adapter.deliverBatch.mockImplementationOnce(async (batch) => {
				await Promise.resolve();
				if (timing !== "revalidation")
					f.queue.ack("question-a", "2099-07-19T12:00:00.000Z");
				if (timing === "frozen retry") throw new Error("lost receipt");
				return f.accepted(batch);
			});
			const first = await f.loop.tick();
			if (timing === "frozen retry") {
				expect(first.ok).toBe(false);
				f.changeContent("later events must wait");
				f.advance();
				f.adapter.deliverBatch.mockImplementationOnce(async (batch) => ({
					...f.accepted(batch),
					status: "accepted_duplicate" as never,
				}));
				expect((await f.loop.tick()).ok).toBe(true);
				expect(f.adapter.deliverBatch.mock.calls[1]![0]).toEqual(
					f.adapter.deliverBatch.mock.calls[0]![0],
				);
			} else expect(first.ok).toBe(true);
			expect(
				f.adapter.deliverBatch.mock.calls[0]![0].members.map(
					({ deliveryId }) => deliveryId,
				),
			).toEqual(["question-a#r0", "question-b#r0"]);
			expect(f.queue.getById("question-a")).toMatchObject({
				state: "ACKED",
				claimed_by: null,
			});
			expect(f.queue.getById("question-b")).toMatchObject({
				state: "LEASED",
				last_error: null,
				dead_reason: null,
			});
			expect(f.queue.getById("question-b")?.notified_at).not.toBeNull();
			expect(f.cursor()?.offeredThroughSeq).toBe(3);
			expect(f.offer()?.acceptedAt).not.toBeNull();
		},
	);

	it("does not advance for a mismatched adapter receipt", async () => {
		const f = setup();
		f.enqueue("question-a");
		f.adapter.deliverBatch.mockImplementationOnce(async (batch) => ({
			...f.accepted(batch),
			memberIds: ["foreign#r0"],
		}));
		expect((await f.loop.tick()).ok).toBe(false);
		expect(f.cursor()?.offeredThroughSeq).toBe(0);
		expect(f.offer()?.acceptedAt).toBeNull();
	});

	it.each([false, true])(
		"does not spend transport attempts on summary preparation failure (Discord=%s)",
		async (discord) => {
			const prepare = vi.fn<
				NonNullable<LeadInboxLoopOptions["prepareAuditSummary"]>
			>(() => {
				throw new Error("queue unavailable");
			});
			const f = setup({ prepareAuditSummary: prepare, maxModelAttempts: 1 });
			f.enqueue("question-a", discord);
			for (let tick = 0; tick < 2; tick++) {
				expect((await f.loop.tick()).ok).toBe(false);
				f.advance();
			}
			expect(prepare).toHaveBeenCalledTimes(2);
			expect(f.adapter.deliverBatch).not.toHaveBeenCalled();
			expect(f.queue.getById("question-a")).toMatchObject({
				state: "LEASED",
				retry_count: 0,
				dead_reason: null,
				last_error: null,
				notified_at: null,
				delivered_at: null,
			});
			prepare.mockImplementation(f.prepareAuditSummary);
			expect((await f.loop.tick()).ok).toBe(true);
			expect(f.adapter.deliverBatch).toHaveBeenCalledTimes(1);
			expect(f.cursor()?.offeredThroughSeq).toBe(3);
		},
	);

	it("empty frozen attachments keep the task payload and never advance", async () => {
		const f = setup();
		f.changeContent("");
		f.enqueue("question-a");
		expect((await f.loop.tick()).ok).toBe(true);
		const batch = f.adapter.deliverBatch.mock.calls[0]![0];
		expect(batch.modelPayload.endsWith("question-a")).toBe(true);
		expect(f.cursor()?.offeredThroughSeq).toBe(0);
		expect(f.offer()?.acceptedAt).toBeNull();
	});
});
