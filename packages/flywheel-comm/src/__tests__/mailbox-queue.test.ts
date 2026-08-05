import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";
import { writeContentRef } from "../utils/content-ref.js";

const NOW = "2026-08-05T12:00:00.000Z";
const SENDER_REF = encodeSenderRef();

function enqueueLead(
	queue: MailboxQueue,
	id: string,
	opts: {
		priority?: 0 | 1 | 2 | 3;
		carrier?: "inbox" | "external";
		relayState?: "open" | "protected" | "terminal_disposed";
	} = {},
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
		relayState: opts.relayState,
		senderRef: SENDER_REF,
	});
}

describe("FLY-1572 MailboxQueue", () => {
	it("reserves identities before insert and canonical-compares every replay", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			const terminal = { relayState: "terminal_disposed" as const };
			expect(enqueueLead(queue, "q1", terminal).outcome).toBe("inserted");
			expect(enqueueLead(queue, "q1", terminal).outcome).toBe("active");
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
			expect(
				queue.archiveFamily({
					id: "q1",
					now: "2026-08-08T12:02:00.000Z",
					retentionMs: 72 * 60 * 60_000,
				}),
			).toBe("archived");
			expect(enqueueLead(queue, "q1", terminal).outcome).toBe("archived");
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

	it("archives a whole resolved RPC family only after the retention window", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "question-1");
			queue.enqueue({
				id: "response-1",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "response",
				content: "answer",
				refId: "question-1",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("question-1", "2026-08-05T12:00:00.000Z");
			queue.ack("response-1", "2026-08-05T13:00:00.000Z");

			expect(
				queue.archiveDueFamilies({
					now: "2026-08-08T12:59:59.000Z",
				}),
			).toMatchObject({ archivedFamilies: 0, archivedMessages: 0 });
			expect(queue.getById("question-1")).toBeDefined();
			expect(
				queue.archiveDueFamilies({
					now: "2026-08-08T13:00:00.000Z",
				}),
			).toMatchObject({ archivedFamilies: 1, archivedMessages: 2 });
			expect(queue.getById("question-1")).toBeUndefined();
			expect(queue.getById("response-1")).toBeUndefined();
		} finally {
			queue.close();
		}
	});

	it("never archives an unanswered non-terminal question", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "question-1");
			queue.ack("question-1", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedFamilies: 0 });
			expect(queue.getById("question-1")).toBeDefined();
		} finally {
			queue.close();
		}
	});

	it("archives content-ref bytes before the GC outbox deletes the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-archive-"));
		const dbPath = join(dir, "comm.db");
		const db = new Database(dbPath);
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			const refPath = writeContentRef(dbPath, "instruction-1", "full body");
			queue.enqueue({
				id: "instruction-1",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "[content_ref]",
				contentRef: refPath,
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("instruction-1", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedFamilies: 1, archivedMessages: 1 });
			expect(existsSync(refPath)).toBe(true);
			const archived = db
				.prepare("SELECT row_json FROM mailbox_log WHERE event_id = ?")
				.get("archived:instruction-1") as { row_json: string };
			expect(JSON.parse(archived.row_json).content_ref_archive).toMatchObject({
				path: refPath,
				bytes: 9,
				content_base64: Buffer.from("full body").toString("base64"),
			});
			expect(
				queue.drainContentRefGc({ now: "2026-08-05T00:00:01.000Z" }),
			).toEqual({
				done: 1,
				pending: 0,
			});
			expect(existsSync(refPath)).toBe(false);
			expect(readFileSync(dbPath).length).toBeGreaterThan(0);
		} finally {
			queue.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips oversized families until the explicit maintenance path raises the cap", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			queue.enqueue({
				id: "large",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "x".repeat(2_100_000),
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("large", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedFamilies: 0, skippedOversized: 1 });
			expect(
				queue.archiveFamily({
					id: "large",
					now: "2026-08-05T00:00:00.000Z",
					retentionMs: 72 * 60 * 60_000,
					maxFamilyBytes: Number.POSITIVE_INFINITY,
				}),
			).toBe("archived");
		} finally {
			queue.close();
		}
	});

	it("keeps the row live when its content-ref cannot be captured", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-missing-ref-"));
		const dbPath = join(dir, "comm.db");
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "missing-ref",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "[content_ref]",
				contentRef: join(dir, "refs", "missing-ref.txt"),
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("missing-ref", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({
				archivedFamilies: 0,
				skippedInvalidContentRef: 1,
			});
			expect(queue.getById("missing-ref")).toBeDefined();
		} finally {
			queue.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries GC failures and waits until shared live references are archived", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-gc-retry-"));
		const dbPath = join(dir, "comm.db");
		const queue = new MailboxQueue(dbPath);
		try {
			const refPath = writeContentRef(dbPath, "shared", "shared body");
			for (const id of ["first", "second"]) {
				queue.enqueue({
					id,
					fromAgent: "lead-a",
					toAgent: "runner-a",
					recipientKind: "runner",
					type: "instruction",
					content: "[content_ref]",
					contentRef: refPath,
					createdAt: NOW,
					senderRef: SENDER_REF,
				});
			}
			queue.ack("first", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveFamily({ id: "first", now: "2026-08-05T00:00:00.000Z" }),
			).toBe("archived");
			expect(
				queue.drainContentRefGc({ now: "2026-08-05T00:00:01.000Z" }),
			).toEqual({
				done: 0,
				pending: 1,
			});
			expect(existsSync(refPath)).toBe(true);

			queue.ack("second", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveFamily({ id: "second", now: "2026-08-05T00:00:02.000Z" }),
			).toBe("archived");
			expect(
				queue.drainContentRefGc({
					now: "2026-08-05T00:00:02.000Z",
					removeFile: () => {
						throw new Error("permission denied");
					},
				}),
			).toEqual({ done: 0, pending: 2 });
			expect(
				queue.drainContentRefGc({ now: "2026-08-05T00:00:03.000Z" }),
			).toEqual({
				done: 1,
				pending: 0,
			});
			expect(existsSync(refPath)).toBe(false);
			expect(
				queue.drainContentRefGc({ now: "2026-08-05T00:00:04.000Z" }),
			).toEqual({
				done: 1,
				pending: 0,
			});
		} finally {
			queue.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds automatic open-time maintenance to ten families", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-open-sweep-"));
		const dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		const queue = new MailboxQueue(dbPath);
		try {
			for (let index = 0; index < 12; index++) {
				const id = `old-${index}`;
				queue.enqueue({
					id,
					fromAgent: "lead-a",
					toAgent: "runner-a",
					recipientKind: "runner",
					type: "instruction",
					content: id,
					createdAt: "2026-07-01T00:00:00.000Z",
					senderRef: SENDER_REF,
				});
				queue.ack(id, "2026-07-01T00:01:00.000Z");
			}
		} finally {
			queue.close();
		}
		const opened = new CommDB(dbPath);
		try {
			const raw = new Database(dbPath, { readonly: true });
			try {
				expect(
					(
						raw.prepare("SELECT COUNT(*) AS count FROM mailbox").get() as {
							count: number;
						}
					).count,
				).toBe(2);
			} finally {
				raw.close();
			}
		} finally {
			opened.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
