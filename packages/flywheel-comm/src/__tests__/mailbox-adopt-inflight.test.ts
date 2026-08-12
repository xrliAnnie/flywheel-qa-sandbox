import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";

const NOW = "2026-08-11T22:00:00.000Z";
const OWNER = "owner-fly-1708";

function fixture(): { db: Database.Database; queue: MailboxQueue } {
	const db = new Database(":memory:");
	db.exec(MAILBOX_SCHEMA);
	const queue = new MailboxQueue(db);
	queue.acquireOrRenewOwner({
		ownerEpoch: OWNER,
		now: NOW,
		leaseTtlMs: 60_000,
	});
	return { db, queue };
}

function enqueue(
	queue: MailboxQueue,
	id: string,
	input: {
		toAgent?: string;
		recipientKind?: "lead" | "runner";
		carrier?: "inbox" | "external";
	} = {},
): void {
	queue.enqueue({
		id,
		fromAgent: "runner-a",
		toAgent: input.toAgent ?? "lead-a",
		recipientKind: input.recipientKind ?? "lead",
		type: "question",
		content: id,
		createdAt: NOW,
		carrier: input.carrier,
		senderRef: encodeSenderRef(),
	});
}

describe("FLY-1708 in-flight recipient adoption", () => {
	it("requeues every in-flight inbox batch for exactly one recipient identity", () => {
		const { db, queue } = fixture();
		try {
			for (const id of [
				"delivered",
				"receipt-gap",
				"retry-max",
				"other-lead",
				"runner",
				"external",
				"queued",
				"acked",
				"dead",
			]) {
				enqueue(queue, id, {
					toAgent: id === "other-lead" ? "lead-b" : "lead-a",
					recipientKind: id === "runner" ? "runner" : "lead",
					carrier: id === "external" ? "external" : "inbox",
				});
			}
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = ?,
				   claim_expires_at = ?, batch_id = 'batch-delivered',
				   delivered_at = ?, lease_retry_count = 1, next_retry_at = ?,
				   last_error = 'old'
				 WHERE id = 'delivered'`,
			).run(OWNER, NOW, NOW, NOW);
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = ?,
				   claim_expires_at = ?, batch_id = 'batch-receipt-gap',
				   delivered_at = NULL, lease_retry_count = 2
				 WHERE id = 'receipt-gap'`,
			).run(OWNER, NOW);
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'batch-retry-max',
				   lease_retry_count = 3 WHERE id = 'retry-max'`,
			).run();
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'batch-other'
				 WHERE id = 'other-lead'`,
			).run();
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'batch-runner'
				 WHERE id = 'runner'`,
			).run();
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'batch-external'
				 WHERE id = 'external'`,
			).run();
			db.prepare("UPDATE mailbox SET state = 'ACKED' WHERE id = 'acked'").run();
			db.prepare("UPDATE mailbox SET state = 'DEAD' WHERE id = 'dead'").run();

			expect(
				queue.adoptInflightForRecipient({
					recipientKind: "lead",
					toAgent: "lead-a",
					now: NOW,
				}),
			).toEqual({ requeued: 3 });

			for (const [id, retry] of [
				["delivered", 2],
				["receipt-gap", 3],
				["retry-max", 4],
			] as const) {
				expect(queue.getById(id)).toMatchObject({
					state: "QUEUED",
					lease_retry_count: retry,
					claimed_by: null,
					claim_expires_at: null,
					batch_id: null,
					delivered_at: null,
					next_retry_at: null,
					last_error: "recipient_reborn",
				});
			}
			for (const id of ["other-lead", "runner", "external"]) {
				expect(queue.getById(id)?.batch_id).not.toBeNull();
			}
			expect(queue.getById("queued")?.state).toBe("QUEUED");
			expect(queue.getById("acked")?.state).toBe("ACKED");
			expect(queue.getById("dead")?.state).toBe("DEAD");
			expect(
				(
					db
						.prepare(
							"SELECT COUNT(DISTINCT batch_id) AS n FROM mailbox WHERE state = 'LEASED' AND recipient_kind = 'lead' AND carrier = 'inbox' AND to_agent = 'lead-a' AND batch_id IS NOT NULL",
						)
						.get() as { n: number }
				).n,
			).toBe(0);
			expect(queue.countDeliverable("lead-a")).toBeGreaterThan(0);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("is idempotent and fences the old batch while preserving an ACK that won first", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "adopt-first");
			enqueue(queue, "ack-first");
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = ?,
				 batch_id = 'old-batch', claim_expires_at = ? WHERE id = 'adopt-first'`,
			).run(OWNER, NOW);
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = ?,
				 batch_id = 'acked-batch', claim_expires_at = ? WHERE id = 'ack-first'`,
			).run(OWNER, NOW);
			expect(
				queue.ackBatchByRecipient({
					batchId: "acked-batch",
					fromAgent: "lead-a",
					now: NOW,
				}),
			).toBe("applied");

			expect(
				queue.adoptInflightForRecipient({
					recipientKind: "lead",
					toAgent: "lead-a",
					now: NOW,
				}),
			).toEqual({ requeued: 1 });
			expect(
				queue.adoptInflightForRecipient({
					recipientKind: "lead",
					toAgent: "lead-a",
					now: NOW,
				}),
			).toEqual({ requeued: 0 });
			expect(
				queue.ackBatchByRecipient({
					batchId: "old-batch",
					fromAgent: "lead-a",
					now: NOW,
				}),
			).toBe("ack_late_noop");
			expect(
				queue.recordLeadBatchDelivered({
					batchId: "old-batch",
					ownerEpoch: OWNER,
					now: NOW,
					ackLeaseTtlMs: 30_000,
				}),
			).toBe("lost_race");
			expect(queue.getById("ack-first")?.state).toBe("ACKED");
		} finally {
			queue.close();
			db.close();
		}
	});
});
