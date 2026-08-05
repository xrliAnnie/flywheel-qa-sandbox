import { describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { encodeSenderRef } from "../sender-ref.js";

const NOW = "2026-08-05T12:00:00.000Z";
const SENDER_REF = encodeSenderRef();

function enqueueLead(
	queue: MailboxQueue,
	id: string,
	opts: { priority?: 0 | 1 | 2 | 3; carrier?: "inbox" | "external" } = {},
) {
	return queue.enqueue({
		id,
		fromAgent: "runner-a",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "question",
		content: id,
		createdAt: NOW,
		priority: opts.priority,
		carrier: opts.carrier,
		senderRef: SENDER_REF,
	});
}

describe("FLY-1572 MailboxQueue", () => {
	it("reserves identities before insert and canonical-compares every replay", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			expect(enqueueLead(queue, "q1").outcome).toBe("inserted");
			expect(enqueueLead(queue, "q1").outcome).toBe("active");
			expect(() =>
				queue.enqueue({
					id: "q1",
					fromAgent: "runner-a",
					toAgent: "lead-a",
					recipientKind: "lead",
					type: "question",
					content: "changed",
					createdAt: NOW,
					senderRef: SENDER_REF,
				}),
			).toThrow(/identity conflict/);

			queue.ack("q1", "2026-08-05T12:01:00.000Z");
			queue.archive("q1", "2026-08-05T12:02:00.000Z");
			expect(enqueueLead(queue, "q1").outcome).toBe("archived");
			expect(() =>
				queue.enqueue({
					id: "q1",
					fromAgent: "runner-a",
					toAgent: "lead-a",
					recipientKind: "lead",
					type: "question",
					content: "changed after archive",
					createdAt: NOW,
					senderRef: SENDER_REF,
				}),
			).toThrow(/identity conflict/);
		} finally {
			queue.close();
		}
	});

	it("claims only the addressed Lead lane in stable priority/seq order", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "p2", { priority: 2 });
			enqueueLead(queue, "p0", { priority: 0 });
			enqueueLead(queue, "external", { carrier: "external" });
			queue.enqueue({
				id: "runner",
				fromAgent: "lead-a",
				toAgent: "exec-1",
				recipientKind: "runner",
				type: "instruction",
				content: "runner",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});

			const claimed = queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30 * 60_000,
			});
			expect(claimed.map((row) => row.id)).toEqual(["p0", "p2"]);
			expect(claimed.every((row) => row.state === "LEASED")).toBe(true);
			expect(queue.countDeliverable("lead-a")).toBe(0);
			expect(queue.getById("external")?.state).toBe("QUEUED");
			expect(queue.getById("runner")?.state).toBe("QUEUED");
		} finally {
			queue.close();
		}
	});

	it("ACKs the whole accepted batch and clears its claim", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "q1");
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30_000,
			});
			expect(
				queue.ackBatch({
					batchId: "batch-1",
					ownerEpoch: "epoch-1",
					memberIds: ["q1"],
					now: "2026-08-05T12:00:05.000Z",
				}),
			).toBe(true);
			expect(queue.getById("q1")).toMatchObject({
				state: "ACKED",
				acked_at: "2026-08-05T12:00:05.000Z",
				claimed_by: null,
				claim_expires_at: null,
			});
		} finally {
			queue.close();
		}
	});

	it("keeps Lead delivery failures in the frozen batch until retry is due", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "q1");
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30_000,
			});
			queue.recordLeadDeliveryFailure({
				batchId: "batch-1",
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:00:01.000Z",
				nextRetryAt: "2026-08-05T12:05:00.000Z",
				error: "transport down",
				maxAttempts: 5,
			});
			expect(queue.getById("q1")).toMatchObject({
				state: "LEASED",
				batch_id: "batch-1",
				claimed_by: null,
				retry_count: 1,
			});
			expect(
				queue.claimLeadBatch({
					toAgent: "lead-a",
					msgClass: "model",
					ownerEpoch: "epoch-1",
					batchId: "ignored-for-reclaim",
					now: "2026-08-05T12:04:59.000Z",
					claimTtlMs: 30_000,
				}),
			).toEqual([]);
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:05:00.000Z",
				leaseTtlMs: 10_000,
			});
			expect(
				queue.claimLeadBatch({
					toAgent: "lead-a",
					msgClass: "model",
					ownerEpoch: "epoch-1",
					batchId: "ignored-for-reclaim",
					now: "2026-08-05T12:05:00.000Z",
					claimTtlMs: 30_000,
				}),
			).toHaveLength(1);
		} finally {
			queue.close();
		}
	});

	it("uses one settlement slot for processed and disposed evidence", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "q1");
			const evidence = { actor: "lead-a", ref: "response-1" };
			expect(
				queue.settle({
					messageOrDeliveryId: "q1",
					event: "processed",
					now: NOW,
					evidence,
				}),
			).toBe("inserted");
			expect(
				queue.settle({
					messageOrDeliveryId: "q1",
					event: "processed",
					now: NOW,
					evidence,
				}),
			).toBe("idempotent");
			expect(() =>
				queue.settle({
					messageOrDeliveryId: "q1",
					event: "disposed",
					now: NOW,
					evidence: { actor: "lead-a", reason: "no_action" },
				}),
			).toThrow(/settlement conflict/);
		} finally {
			queue.close();
		}
	});

	it("claims each Runner row once and leaves successful doorbells LEASED for pull ACK", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			queue.enqueue({
				id: "instruction-1",
				fromAgent: "lead-a",
				toAgent: "exec-1",
				recipientKind: "runner",
				type: "instruction",
				content: "continue",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			const row = queue.claimRunner({
				ownerEpoch: "epoch-1",
				now: NOW,
				claimTtlMs: 30 * 60_000,
			});
			expect(row).toMatchObject({
				id: "instruction-1",
				state: "LEASED",
				claimed_by: "epoch-1",
			});
			expect(
				queue.claimRunner({
					ownerEpoch: "epoch-1",
					now: "2026-08-05T12:00:01.000Z",
					claimTtlMs: 30 * 60_000,
				}),
			).toBeUndefined();
			expect(
				queue.recordRunnerDeliverySuccess({
					id: row!.id,
					ownerEpoch: "epoch-1",
				}),
			).toBe(true);
			expect(queue.getById("instruction-1")?.state).toBe("LEASED");
			expect(queue.countRunnerDeliverable()).toBe(0);
		} finally {
			queue.close();
		}
	});

	it("requeues Runner doorbell failures with backoff, then marks exhaustion DEAD", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			queue.enqueue({
				id: "instruction-1",
				fromAgent: "lead-a",
				toAgent: "exec-1",
				recipientKind: "runner",
				type: "instruction",
				content: "continue",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimRunner({
				ownerEpoch: "epoch-1",
				now: NOW,
				claimTtlMs: 30 * 60_000,
			});
			expect(
				queue.recordRunnerDeliveryFailure({
					id: "instruction-1",
					ownerEpoch: "epoch-1",
					now: "2026-08-05T12:00:01.000Z",
					nextRetryAt: "2026-08-05T12:00:05.000Z",
					error: "offline",
					maxAttempts: 2,
				}),
			).toEqual({ deadLettered: false });
			expect(queue.getById("instruction-1")).toMatchObject({
				state: "QUEUED",
				retry_count: 1,
				next_retry_at: "2026-08-05T12:00:05.000Z",
			});
			expect(
				queue.claimRunner({
					ownerEpoch: "epoch-1",
					now: "2026-08-05T12:00:04.000Z",
					claimTtlMs: 30 * 60_000,
				}),
			).toBeUndefined();
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:00:05.000Z",
				leaseTtlMs: 10_000,
			});
			queue.claimRunner({
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:00:05.000Z",
				claimTtlMs: 30 * 60_000,
			});
			expect(
				queue.recordRunnerDeliveryFailure({
					id: "instruction-1",
					ownerEpoch: "epoch-1",
					now: "2026-08-05T12:00:06.000Z",
					nextRetryAt: "2026-08-05T12:00:10.000Z",
					error: "offline",
					maxAttempts: 2,
				}),
			).toEqual({ deadLettered: true });
			expect(queue.getById("instruction-1")?.state).toBe("DEAD");
		} finally {
			queue.close();
		}
	});
});
