import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";

const T0 = "2026-08-10T12:00:00.000Z";
const OWNER = "owner-1573";
const SENDER_REF = encodeSenderRef();

function at(seconds: number): string {
	return new Date(Date.parse(T0) + seconds * 1_000).toISOString();
}

function fixture(): { db: Database.Database; queue: MailboxQueue } {
	const db = new Database(":memory:");
	db.exec(MAILBOX_SCHEMA);
	const queue = new MailboxQueue(db);
	queue.acquireOrRenewOwner({
		ownerEpoch: OWNER,
		now: T0,
		leaseTtlMs: 3_600_000,
	});
	return { db, queue };
}

function enqueue(
	queue: MailboxQueue,
	id: string,
	input: {
		toAgent?: string;
		fromAgent?: string;
		recipientKind?: "lead" | "runner";
		type?: string;
		createdAt?: string;
		priority?: 0 | 1 | 2 | 3;
	} = {},
): void {
	queue.enqueue({
		id,
		fromAgent: input.fromAgent ?? "runner-a",
		toAgent: input.toAgent ?? "lead-a",
		recipientKind: input.recipientKind ?? "lead",
		type: input.type ?? "question",
		content: `content:${id}`,
		createdAt: input.createdAt ?? T0,
		priority: input.priority,
		senderRef: SENDER_REF,
	});
}

const claimLead = (queue: MailboxQueue, batchId: string, now = T0) =>
	queue.claimLeadBatchQueue({
		toAgent: "lead-a",
		msgClass: "model",
		ownerEpoch: OWNER,
		batchId,
		now,
		transportClaimTtlMs: 30_000,
		batchWindowMs: 60_000,
		batchMaxSize: 5,
		inflightMaxBatches: 3,
	});

describe("FLY-1573 mailbox queue capabilities", () => {
	it("derives uncovered Lead and unroutable-runner dead letters without writing mailbox rows", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "lead-dead-1", { toAgent: "lead-dead" });
			enqueue(queue, "lead-dead-2", {
				toAgent: "lead-dead",
				createdAt: at(1),
			});
			enqueue(queue, "runner-unroutable", {
				toAgent: "exec-orphan",
				recipientKind: "runner",
			});
			enqueue(queue, "runner-routable", {
				toAgent: "exec-owned",
				recipientKind: "runner",
			});
			db.prepare(
				"UPDATE mailbox SET state = 'DEAD', dead_at = ?, dead_reason = 'test'",
			).run(T0);
			const before = (
				db.prepare("SELECT COUNT(*) AS n FROM mailbox").get() as {
					n: number;
				}
			).n;

			const candidates = queue.listUncoveredLeadDeadLetters({
				sinceCursor: [],
				limit: 10,
				maxRowsPerRecipient: 5,
				maxSummaryBytes: 512,
				probeFactsByRecipient: new Map([
					[
						"exec-orphan",
						"StateStore 视图=terminal / 最近心跳=45m（注意：此为登记视图非 pane 直读，处置前仍须人工验活）",
					],
				]),
				resolveOwningLead: (recipient) =>
					recipient === "exec-owned" ? "lead-owner" : undefined,
			});
			expect(
				candidates.map(({ sourceKind, recipient, deadCount }) => ({
					sourceKind,
					recipient,
					deadCount,
				})),
			).toEqual([
				{ sourceKind: "lead_unacked", recipient: "lead-dead", deadCount: 2 },
				{
					sourceKind: "runner_unroutable",
					recipient: "exec-orphan",
					deadCount: 1,
				},
			]);
			expect(candidates[0]?.summary).toContain("探针实况：不可得");
			expect(candidates[1]?.summary).toContain(
				"探针实况：StateStore 视图=terminal",
			);
			const bounded = queue.listUncoveredLeadDeadLetters({
				sinceCursor: [],
				limit: 10,
				maxRowsPerRecipient: 5,
				maxSummaryBytes: 256,
				probeFactsByRecipient: new Map([["exec-orphan", "x".repeat(1_000)]]),
				resolveOwningLead: (recipient) =>
					recipient === "exec-owned" ? "lead-owner" : undefined,
			});
			expect(
				bounded.every(
					({ summary }) => Buffer.byteLength(summary, "utf8") <= 256,
				),
			).toBe(true);
			expect(
				queue
					.listUncoveredLeadDeadLetters({
						sinceCursor: [
							{
								sourceKind: "lead_unacked",
								recipient: "lead-dead",
								throughDeadSeq: candidates[0]!.throughDeadSeq,
							},
						],
						limit: 10,
						maxRowsPerRecipient: 5,
						maxSummaryBytes: 512,
						resolveOwningLead: (recipient) =>
							recipient === "exec-owned" ? "lead-owner" : undefined,
					})
					.map(({ recipient }) => recipient),
			).toEqual(["exec-orphan"]);
			expect(
				(db.prepare("SELECT COUNT(*) AS n FROM mailbox").get() as { n: number })
					.n,
			).toBe(before);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("surfaces delivery-unconfirmed exhaustion through the ordinary dead-letter notice lane", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "lead-ordinary", { toAgent: "lead-dead" });
			enqueue(queue, "lead-excluded", {
				toAgent: "lead-dead",
				createdAt: at(1),
			});
			enqueue(queue, "runner-excluded-routable", {
				toAgent: "exec-owned",
				recipientKind: "runner",
			});
			enqueue(queue, "runner-excluded-unroutable", {
				toAgent: "exec-orphan",
				recipientKind: "runner",
			});
			queue.markDead("lead-ordinary", at(2), "recipient_terminal");
			for (const id of [
				"lead-excluded",
				"runner-excluded-routable",
				"runner-excluded-unroutable",
			]) {
				queue.markDead(id, at(3), "delivery_unconfirmed_exhausted");
			}

			const notices = queue.scanAndInsertDeadLetterNotices({
				ownerEpoch: OWNER,
				now: at(10),
				windowMs: 1_800_000,
				maxRecipients: 10,
				maxDeadRowsPerRecipient: 10,
				maxSummaryBytes: 2_000,
				resolveOwningLead: (recipient) =>
					recipient === "exec-owned" ? "lead-owner" : undefined,
			});
			expect(notices.inserted).toHaveLength(1);
			expect(notices.inserted[0]).toMatch(/^dead_letter:exec-owned:/);
			expect(queue.getById(notices.inserted[0]!)?.content).toContain(
				"runner-excluded-routable",
			);

			const candidates = queue.listUncoveredLeadDeadLetters({
				sinceCursor: [],
				limit: 10,
				maxRowsPerRecipient: 10,
				maxSummaryBytes: 2_000,
				resolveOwningLead: (recipient) =>
					recipient === "exec-owned" ? "lead-owner" : undefined,
			});
			expect(candidates).toEqual([
				expect.objectContaining({
					sourceKind: "lead_unacked",
					recipient: "lead-dead",
					deadCount: 1,
					throughDeadSeq: queue.getById("lead-ordinary")!.seq,
				}),
			]);
			expect(candidates[0]?.summary).toContain("lead-ordinary");
			expect(candidates[0]?.summary).not.toContain("lead-excluded");
			expect(
				(
					db
						.prepare(
							"SELECT COUNT(*) AS n FROM mailbox WHERE type = 'dead_letter_notice'",
						)
						.get() as { n: number }
				).n,
			).toBe(1);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("batches same-source rows in the head's one-sided window without folding rows", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "q1", { createdAt: T0 });
			enqueue(queue, "q2", { createdAt: at(60) });
			enqueue(queue, "q3", { createdAt: at(61) });
			enqueue(queue, "other", { fromAgent: "runner-b", createdAt: at(1) });

			expect(claimLead(queue, "batch-1").map((row) => row.id)).toEqual([
				"q1",
				"q2",
			]);
			expect(
				(db.prepare("SELECT COUNT(*) AS n FROM mailbox").get() as { n: number })
					.n,
			).toBe(4);
			expect(queue.getById("q1")?.batch_id).toBe("batch-1");
			expect(queue.getById("q2")?.batch_id).toBe("batch-1");
			expect(queue.getById("q3")?.state).toBe("QUEUED");
			expect(queue.getById("other")?.state).toBe("QUEUED");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("never mixes retry generations even with identical source and timestamp", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "generation-0");
			enqueue(queue, "generation-1");
			db.prepare(
				"UPDATE mailbox SET lease_retry_count = 1 WHERE id = 'generation-1'",
			).run();

			expect(claimLead(queue, "batch-generation").map(({ id }) => id)).toEqual([
				"generation-0",
			]);
			expect(queue.getById("generation-1")?.state).toBe("QUEUED");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("uses priority to choose the head but never reaches backward before its timestamp", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "older-low-priority", { createdAt: T0, priority: 2 });
			enqueue(queue, "head", { createdAt: at(30), priority: 0 });
			enqueue(queue, "after-head", { createdAt: at(31), priority: 1 });
			expect(claimLead(queue, "batch-priority").map((row) => row.id)).toEqual([
				"head",
				"after-head",
			]);
			expect(queue.getById("older-low-priority")?.state).toBe("QUEUED");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("keeps runner responses as single-item batches", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "r1", {
				toAgent: "exec-a",
				recipientKind: "runner",
				type: "response",
			});
			enqueue(queue, "r2", {
				toAgent: "exec-a",
				recipientKind: "runner",
				type: "response",
				createdAt: at(1),
			});
			const batch = queue.claimRunnerBatch({
				ownerEpoch: OWNER,
				now: T0,
				transportClaimTtlMs: 30_000,
				batchWindowMs: 60_000,
				batchMaxSize: 5,
				inflightMaxBatches: 3,
			});
			expect(batch?.map((row) => row.id)).toEqual(["r1"]);
			expect(queue.getById("r2")?.state).toBe("QUEUED");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("records a Lead transport receipt without sealing delivery until recipient ACK", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "lead-receipt");
			claimLead(queue, "batch-lead-receipt");
			expect(
				queue.recordLeadBatchDelivered({
					batchId: "batch-lead-receipt",
					ownerEpoch: OWNER,
					now: at(1),
					ackLeaseTtlMs: 30_000,
				}),
			).toBe("applied");
			expect(queue.getById("lead-receipt")).toMatchObject({
				notified_at: at(1),
				delivered_at: null,
				acked_at: null,
			});

			expect(
				queue.ackBatchByRecipient({
					batchId: "batch-lead-receipt",
					fromAgent: "lead-a",
					now: at(2),
				}),
			).toBe("applied");
			expect(queue.getById("lead-receipt")).toMatchObject({
				state: "ACKED",
				notified_at: at(1),
				delivered_at: at(2),
				acked_at: at(2),
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("keeps on-consume runner delivery leased while stamping transport evidence", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "runner-receipt", {
				toAgent: "exec-a",
				recipientKind: "runner",
			});
			const batch = queue.claimRunnerBatch({
				ownerEpoch: OWNER,
				now: T0,
				transportClaimTtlMs: 30_000,
				batchWindowMs: 60_000,
				batchMaxSize: 10,
				inflightMaxBatches: 3,
			});
			expect(batch).toHaveLength(1);
			expect(
				queue.recordRunnerBatchDelivered({
					batchId: batch![0]!.batch_id!,
					ownerEpoch: OWNER,
					now: at(1),
					ackLeaseTtlMs: 30_000,
					settlement: "on_consume",
				}),
			).toBe("applied");
			expect(queue.getById("runner-receipt")).toMatchObject({
				state: "LEASED",
				notified_at: at(1),
				delivered_at: at(1),
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("terminally settles an on-delivery runner batch behind the owner fence", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "runner-terminal", {
				toAgent: "exec-a",
				recipientKind: "runner",
			});
			const batch = queue.claimRunnerBatch({
				ownerEpoch: OWNER,
				now: T0,
				transportClaimTtlMs: 30_000,
				batchWindowMs: 60_000,
				batchMaxSize: 10,
				inflightMaxBatches: 3,
			});
			expect(
				queue.recordRunnerBatchDelivered({
					batchId: batch![0]!.batch_id!,
					ownerEpoch: OWNER,
					now: at(1),
					ackLeaseTtlMs: 30_000,
					settlement: "on_delivery",
				}),
			).toBe("applied");
			expect(queue.getById("runner-terminal")).toMatchObject({
				state: "ACKED",
				acked_at: at(1),
				notified_at: at(1),
				delivered_at: at(1),
				claimed_by: null,
				claim_expires_at: null,
				next_retry_at: null,
				last_error: null,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("does not reclaim a successfully notified Lead batch as frozen", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "notified-not-frozen");
			claimLead(queue, "batch-notified");
			db.prepare(
				"UPDATE mailbox SET notified_at = ?, delivered_at = NULL WHERE id = ?",
			).run(at(1), "notified-not-frozen");
			expect(claimLead(queue, "must-not-reclaim", at(2))).toEqual([]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("lease-retries a notified Lead batch instead of treating it as a frozen transport failure", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "notified-expired");
			claimLead(queue, "batch-notified-expired");
			db.prepare(
				`UPDATE mailbox SET notified_at = ?, delivered_at = NULL,
				 claim_expires_at = ? WHERE id = ?`,
			).run(at(1), at(1), "notified-expired");
			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(2),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 0,
			});
			expect(result).toMatchObject({ requeued: 1, frozenResend: [] });
			expect(queue.getById("notified-expired")).toMatchObject({
				state: "QUEUED",
				lease_retry_count: 1,
				notified_at: null,
				delivered_at: null,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("holds an expired Lead batch when the recipient process cannot be judged alive", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "lead-liveness-unknown");
			claimLead(queue, "batch-lead-unknown");
			queue.recordLeadBatchDelivered({
				batchId: "batch-lead-unknown",
				ownerEpoch: OWNER,
				now: T0,
				ackLeaseTtlMs: 1_000,
			});

			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(2),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "unknown",
				maxBatches: 10,
				maxTerminalRows: 0,
			});
			expect(result).toMatchObject({
				requeued: 0,
				dead: 0,
				skippedUnknown: 1,
			});
			expect(queue.getById("lead-liveness-unknown")).toMatchObject({
				state: "LEASED",
				lease_retry_count: 0,
			});
			const recovered = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(3),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 0,
			});
			expect(recovered.requeued).toBe(1);
			expect(queue.getById("lead-liveness-unknown")).toMatchObject({
				state: "QUEUED",
				lease_retry_count: 1,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("hands an expired batchless legacy-push claim back to Flow 2", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "legacy-handoff");
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'legacy-push',
				 claim_expires_at = ?, notified_at = ? WHERE id = ?`,
			).run(at(1), T0, "legacy-handoff");

			expect(
				queue.releaseExpiredLegacyPushClaims({
					toAgent: "lead-a",
					ownerEpoch: OWNER,
					now: at(2),
					maxRows: 10,
				}),
			).toEqual({ requeued: 1, remaining: false });
			expect(
				claimLead(queue, "flow-2-handoff", at(2)).map(({ id }) => id),
			).toEqual(["legacy-handoff"]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("adopts a suffix-free Lead's steady legacy row into Flow 2", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "suffix-free-lead", {
				recipientKind: "runner",
				type: "instruction",
			});
			db.prepare("UPDATE mailbox SET notified_at = ? WHERE id = ?").run(
				T0,
				"suffix-free-lead",
			);

			expect(
				queue.releaseExpiredLegacyPushClaims({
					toAgent: "lead-a",
					ownerEpoch: OWNER,
					now: at(2),
					maxRows: 10,
				}),
			).toEqual({ requeued: 0, remaining: false });
			expect(
				claimLead(queue, "flow-2-suffix-free", at(2)).map(({ id }) => id),
			).toEqual(["suffix-free-lead"]);
			expect(queue.getById("suffix-free-lead")?.recipient_kind).toBe("lead");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("never steals an active legacy retry merely because it has old transport evidence", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "legacy-active", {
				recipientKind: "runner",
				type: "instruction",
			});
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'legacy-push',
				 claim_expires_at = ?, notified_at = ? WHERE id = ?`,
			).run(at(30), T0, "legacy-active");

			expect(
				queue.releaseExpiredLegacyPushClaims({
					toAgent: "lead-a",
					ownerEpoch: OWNER,
					now: at(2),
					maxRows: 10,
				}),
			).toEqual({ requeued: 0, remaining: false });
			expect(claimLead(queue, "must-not-double-deliver", at(2))).toEqual([]);
			expect(queue.getById("legacy-active")).toMatchObject({
				state: "LEASED",
				recipient_kind: "lead",
				claimed_by: "legacy-push",
				claim_expires_at: at(30),
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("terminal-sweeps every queued and leased shape for a retired Lead within a row budget", () => {
		const { db, queue } = fixture();
		try {
			for (const id of ["retired-queued", "retired-future", "retired-null"]) {
				enqueue(queue, id, { toAgent: "retired-lead" });
			}
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'future-batch',
				 claimed_by = ?, claim_expires_at = ?, notified_at = ? WHERE id = ?`,
			).run(OWNER, at(60), T0, "retired-future");
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'failed-batch',
				 claimed_by = NULL, claim_expires_at = NULL, notified_at = NULL,
				 last_error = 'transport failed' WHERE id = ?`,
			).run("retired-null");

			expect(
				queue.sweepRecipientTerminal({
					recipientKind: "lead",
					toAgent: "retired-lead",
					ownerEpoch: OWNER,
					now: at(2),
					maxRows: 2,
				}),
			).toEqual({ dead: 2, remaining: true });
			expect(
				queue.sweepRecipientTerminal({
					recipientKind: "lead",
					toAgent: "retired-lead",
					ownerEpoch: OWNER,
					now: at(3),
					maxRows: 2,
				}),
			).toEqual({ dead: 1, remaining: false });
			expect(
				db
					.prepare(
						"SELECT state, dead_reason FROM mailbox WHERE to_agent = ? ORDER BY seq",
					)
					.all("retired-lead"),
			).toEqual([
				{ state: "DEAD", dead_reason: "recipient_terminal" },
				{ state: "DEAD", dead_reason: "recipient_terminal" },
				{ state: "DEAD", dead_reason: "recipient_terminal" },
			]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("delivers a new founder message despite three notified but unread Lead batches", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 4; index += 1) {
				enqueue(queue, `q${index}`, {
					fromAgent: `runner-${index}`,
					createdAt: at(index),
				});
			}
			for (let index = 0; index < 3; index += 1) {
				const rows = claimLead(queue, `batch-${index}`, at(index));
				expect(rows).toHaveLength(1);
				expect(
					queue.recordLeadBatchDelivered({
						batchId: `batch-${index}`,
						ownerEpoch: OWNER,
						now: at(index),
						ackLeaseTtlMs: 1_800_000,
					}),
				).toBe("applied");
			}
			// Reproduces the 8-13 incident shape: three batches reached the Lead
			// transport, none were read/ACKed, then a founder message arrived.
			expect(claimLead(queue, "batch-3", at(4)).map((row) => row.id)).toEqual([
				"q3",
			]);
			expect(queue.getById("q0")).toMatchObject({
				state: "LEASED",
				notified_at: at(0),
				delivered_at: null,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("caps only batches whose transport handoff is still unfinished", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 4; index += 1) {
				enqueue(queue, `transport-${index}`, {
					fromAgent: `runner-${index}`,
					createdAt: at(index),
				});
			}
			for (let index = 0; index < 3; index += 1) {
				db.prepare(
					`UPDATE mailbox SET state = 'LEASED', batch_id = ?, claimed_by = ?,
					 claim_expires_at = ?, notified_at = NULL, delivered_at = NULL
					 WHERE id = ?`,
				).run(
					`transport-batch-${index}`,
					"other-live-owner",
					at(60),
					`transport-${index}`,
				);
			}

			expect(claimLead(queue, "must-wait", at(4))).toEqual([]);
			db.prepare(
				"UPDATE mailbox SET notified_at = ? WHERE id = 'transport-0'",
			).run(at(5));
			expect(
				claimLead(queue, "slot-released", at(6)).map(({ id }) => id),
			).toEqual(["transport-3"]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("backpressures after three real Lead transport failures and releases a terminal slot", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 4; index += 1) {
				enqueue(queue, `failure-${index}`, {
					fromAgent: `runner-${index}`,
					createdAt: at(index),
				});
			}
			for (let index = 0; index < 3; index += 1) {
				expect(
					claimLead(queue, `failure-batch-${index}`, at(index)),
				).toHaveLength(1);
				expect(
					queue.recordLeadDeliveryFailure({
						batchId: `failure-batch-${index}`,
						ownerEpoch: OWNER,
						now: at(index),
						nextRetryAt: at(100),
						error: "transport failed",
						maxAttempts: 3,
					}),
				).toBe(1);
			}
			expect(claimLead(queue, "blocked-by-transport", at(4))).toEqual([]);
			expect(queue.markDead("failure-0", at(5), "transport_terminal")).toBe(
				true,
			);
			expect(
				claimLead(queue, "released-after-terminal", at(6)).map(({ id }) => id),
			).toEqual(["failure-3"]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("requeues an expired delivered batch in place and increments only lease_retry_count", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "q1");
			claimLead(queue, "batch-1");
			queue.recordLeadBatchDelivered({
				batchId: "batch-1",
				ownerEpoch: OWNER,
				now: T0,
				ackLeaseTtlMs: 10_000,
			});
			const before = (
				db.prepare("SELECT COUNT(*) AS n FROM mailbox").get() as { n: number }
			).n;
			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(11),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(result.requeued).toBe(1);
			expect(
				(db.prepare("SELECT COUNT(*) AS n FROM mailbox").get() as { n: number })
					.n,
			).toBe(before);
			expect(queue.getById("q1")).toMatchObject({
				state: "QUEUED",
				retry_count: 0,
				lease_retry_count: 1,
				batch_id: null,
				delivered_at: null,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("dead-letters an expired delivered batch at the lease retry ceiling without inserting", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "at-ceiling");
			db.prepare(
				"UPDATE mailbox SET lease_retry_count = 3 WHERE id = 'at-ceiling'",
			).run();
			claimLead(queue, "batch-ceiling");
			queue.recordLeadBatchDelivered({
				batchId: "batch-ceiling",
				ownerEpoch: OWNER,
				now: T0,
				ackLeaseTtlMs: 10_000,
			});
			const before = (
				db.prepare("SELECT COUNT(*) AS n FROM mailbox").get() as { n: number }
			).n;
			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(11),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(result).toMatchObject({ dead: 1, requeued: 0 });
			expect(queue.getById("at-ceiling")).toMatchObject({
				state: "DEAD",
				dead_reason: "lease_expired_unacked",
				lease_retry_count: 3,
			});
			expect(
				(db.prepare("SELECT COUNT(*) AS n FROM mailbox").get() as { n: number })
					.n,
			).toBe(before);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("applies the terminal truth table without touching an unexpired lease", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "leased", {
				toAgent: "exec-dead",
				recipientKind: "runner",
				fromAgent: "lead-b",
			});
			enqueue(queue, "queued", {
				toAgent: "exec-dead",
				recipientKind: "runner",
				createdAt: at(1),
			});
			const batch = queue.claimRunnerBatch({
				ownerEpoch: OWNER,
				now: T0,
				transportClaimTtlMs: 30_000,
				batchWindowMs: 60_000,
				batchMaxSize: 1,
				inflightMaxBatches: 3,
			});
			expect(batch).toHaveLength(1);
			const leasedId = batch?.[0]?.id as string;
			queue.recordRunnerBatchDelivered({
				batchId: batch?.[0]?.batch_id as string,
				ownerEpoch: OWNER,
				now: T0,
				ackLeaseTtlMs: 30_000,
				settlement: "on_consume",
			});

			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(1),
				recipientKind: "runner",
				leaseRetryMax: 3,
				recipientState: () => "terminal_or_missing",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(queue.getById("queued")?.state).toBe("DEAD");
			expect(queue.getById(leasedId)?.state).toBe("LEASED");

			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "runner",
				leaseRetryMax: 3,
				recipientState: () => "terminal_or_missing",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(queue.getById(leasedId)).toMatchObject({
				state: "DEAD",
				dead_reason: "recipient_terminal",
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("bounded terminal scans advance past a large live-recipient prefix", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 25; index += 1) {
				enqueue(queue, `alive-${index}`, {
					toAgent: "aaa-live",
					recipientKind: "runner",
					createdAt: at(index),
				});
			}
			enqueue(queue, "terminal-behind-live", {
				toAgent: "zzz-terminal",
				recipientKind: "runner",
				createdAt: at(30),
			});

			for (let tick = 0; tick < 4; tick += 1) {
				queue.reconcileExpiredLeases({
					ownerEpoch: OWNER,
					now: at(40 + tick),
					recipientKind: "runner",
					leaseRetryMax: 3,
					recipientState: (recipient) =>
						recipient === "zzz-terminal" ? "terminal_or_missing" : "alive",
					maxBatches: 10,
					maxTerminalRows: 10,
				});
			}
			expect(queue.getById("terminal-behind-live")?.state).toBe("DEAD");
			expect(queue.getById("alive-0")?.state).toBe("QUEUED");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("bounded expired-batch scans advance past an unknown-recipient prefix", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 4; index += 1) {
				enqueue(queue, `expired-${index}`, {
					toAgent: `exec-${index}`,
					recipientKind: "runner",
					createdAt: at(index),
				});
				db.prepare(
					`UPDATE mailbox SET state = 'LEASED', batch_id = ?, claimed_by = ?,
					   claim_expires_at = ?, delivered_at = ? WHERE id = ?`,
				).run(`batch-${index}`, OWNER, at(1), T0, `expired-${index}`);
			}
			const reconcile = () =>
				queue.reconcileExpiredLeases({
					ownerEpoch: OWNER,
					now: at(2),
					recipientKind: "runner",
					leaseRetryMax: 3,
					recipientState: (recipient) =>
						recipient === "exec-0" || recipient === "exec-1"
							? "unknown"
							: "alive",
					maxBatches: 2,
					maxTerminalRows: 2,
				});

			reconcile();
			reconcile();
			expect(queue.getById("expired-2")?.state).toBe("QUEUED");
			expect(queue.getById("expired-3")?.state).toBe("QUEUED");
			expect(queue.getById("expired-0")?.state).toBe("LEASED");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("advances a frozen marker once per new lease, not once per reconciler tick", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "q1");
			claimLead(queue, "batch-frozen");
			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(result.frozenResend).toEqual(["batch-frozen"]);
			expect(queue.getById("q1")).toMatchObject({
				state: "LEASED",
				batch_id: "batch-frozen",
				retry_count: 0,
				lease_retry_count: 0,
				delivered_at: null,
				claimed_by: null,
				claim_expires_at: null,
				last_error: "delivery_unconfirmed:1",
			});
			for (let tick = 32; tick < 40; tick += 1) {
				queue.reconcileExpiredLeases({
					ownerEpoch: OWNER,
					now: at(tick),
					recipientKind: "lead",
					toAgent: "lead-a",
					leaseRetryMax: 3,
					recipientState: () => "alive",
					maxBatches: 10,
					maxTerminalRows: 10,
				});
			}
			expect(queue.getById("q1")?.last_error).toBe("delivery_unconfirmed:1");
			expect(claimLead(queue, "ignored", at(31)).map((row) => row.id)).toEqual([
				"q1",
			]);
			expect(queue.getById("q1")).toMatchObject({
				last_error: "delivery_unconfirmed:1",
				claim_expires_at: at(61),
			});
			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(62),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(queue.getById("q1")).toMatchObject({
				last_error: "delivery_unconfirmed:2",
				retry_count: 0,
				lease_retry_count: 0,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("does not advance unreclaimed siblings and exits only after four new-lease expiries", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 3; index += 1) {
				enqueue(queue, `frozen-${index}`, {
					fromAgent: `runner-${index}`,
					createdAt: at(index),
				});
				db.prepare(
					`UPDATE mailbox SET state = 'LEASED', batch_id = ?, claimed_by = ?,
					   claim_expires_at = ? WHERE id = ?`,
				).run(`batch-${index}`, OWNER, at(30), `frozen-${index}`);
			}
			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			for (let tick = 32; tick < 50; tick += 1) {
				queue.reconcileExpiredLeases({
					ownerEpoch: OWNER,
					now: at(tick),
					recipientKind: "lead",
					toAgent: "lead-a",
					leaseRetryMax: 3,
					recipientState: () => "alive",
					maxBatches: 10,
					maxTerminalRows: 10,
				});
			}
			for (let index = 0; index < 3; index += 1) {
				expect(queue.getById(`frozen-${index}`)).toMatchObject({
					state: "LEASED",
					last_error: "delivery_unconfirmed:1",
					claim_expires_at: null,
				});
			}

			for (const [claimAt, expireAt, expected] of [
				[50, 81, "delivery_unconfirmed:2"],
				[82, 113, "delivery_unconfirmed:3"],
				[114, 145, "delivery_unconfirmed_exhausted"],
			] as const) {
				claimLead(queue, "ignored", at(claimAt));
				queue.reconcileExpiredLeases({
					ownerEpoch: OWNER,
					now: at(expireAt),
					recipientKind: "lead",
					toAgent: "lead-a",
					leaseRetryMax: 3,
					recipientState: () => "alive",
					maxBatches: 1,
					maxTerminalRows: 10,
				});
				expect(queue.getById("frozen-0")?.last_error).toBe(expected);
			}
			expect(queue.getById("frozen-0")).toMatchObject({
				state: "DEAD",
				dead_reason: "delivery_unconfirmed_exhausted",
				batch_id: null,
				claimed_by: null,
				claim_expires_at: null,
				retry_count: 0,
				lease_retry_count: 0,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("resets the frozen streak after a real delivery failure instead of sharing retry_count", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "mixed-budget");
			claimLead(queue, "batch-mixed");
			db.prepare(
				`UPDATE mailbox SET retry_count = 4, last_error = 'lead restarting'
				 WHERE id = 'mixed-budget'`,
			).run();
			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(result.dead).toBe(0);
			expect(queue.getById("mixed-budget")).toMatchObject({
				state: "LEASED",
				retry_count: 4,
				lease_retry_count: 0,
				last_error: "delivery_unconfirmed:1",
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("treats malformed or inconsistent frozen markers as a fail-open first expiry", () => {
		const { db, queue } = fixture();
		try {
			const invalid = [
				"delivery_unconfirmed:0",
				" delivery_unconfirmed:1",
				"delivery_unconfirmed:1 ",
				"delivery_unconfirmed:1suffix",
				"Delivery_unconfirmed:1",
				"delivery_unconfirmed:9007199254740992",
			];
			invalid.forEach((marker, index) => {
				const id = `invalid-marker-${index}`;
				enqueue(queue, id, { fromAgent: `runner-${index}` });
				db.prepare(
					`UPDATE mailbox SET state = 'LEASED', batch_id = ?, claimed_by = ?,
					   claim_expires_at = ?, last_error = ? WHERE id = ?`,
				).run(`batch-invalid-${index}`, OWNER, at(30), marker, id);
			});
			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 20,
				maxTerminalRows: 20,
			});
			invalid.forEach((_, index) => {
				expect(queue.getById(`invalid-marker-${index}`)?.last_error).toBe(
					"delivery_unconfirmed:1",
				);
			});

			enqueue(queue, "mixed-marker-a");
			enqueue(queue, "mixed-marker-b", { createdAt: at(1) });
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'batch-mixed-marker',
				   claimed_by = ?, claim_expires_at = ?,
				   last_error = CASE id WHEN 'mixed-marker-a'
				     THEN 'delivery_unconfirmed:1' ELSE 'delivery_unconfirmed:2' END
				 WHERE id IN ('mixed-marker-a','mixed-marker-b')`,
			).run(OWNER, at(30));
			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 20,
				maxTerminalRows: 20,
			});
			expect(queue.getById("mixed-marker-a")?.last_error).toBe(
				"delivery_unconfirmed:1",
			);
			expect(queue.getById("mixed-marker-b")?.last_error).toBe(
				"delivery_unconfirmed:1",
			);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("clears the marker fail-open across queue ON to legacy OFF to ON", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "toggle-marker");
			claimLead(queue, "batch-toggle");
			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(queue.getById("toggle-marker")?.last_error).toBe(
				"delivery_unconfirmed:1",
			);

			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: OWNER,
				batchId: "ignored",
				now: at(31),
				claimTtlMs: 30_000,
			});
			expect(queue.getById("toggle-marker")?.last_error).toBeNull();

			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(62),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(queue.getById("toggle-marker")).toMatchObject({
				state: "LEASED",
				last_error: "delivery_unconfirmed:1",
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("dead-letters a frozen runner batch immediately at a zero retry budget", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "runner-zero-budget", {
				toAgent: "exec-zero-budget",
				recipientKind: "runner",
			});
			const batch = queue.claimRunnerBatch({
				ownerEpoch: OWNER,
				now: T0,
				transportClaimTtlMs: 30_000,
				batchWindowMs: 60_000,
				batchMaxSize: 5,
				inflightMaxBatches: 3,
			});
			expect(batch).toHaveLength(1);

			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "runner",
				leaseRetryMax: 0,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(result).toMatchObject({ dead: 1, frozenResend: [] });
			expect(queue.getById("runner-zero-budget")).toMatchObject({
				state: "DEAD",
				dead_reason: "delivery_unconfirmed_exhausted",
				last_error: "delivery_unconfirmed_exhausted",
				batch_id: null,
				claimed_by: null,
				claim_expires_at: null,
				next_retry_at: null,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("keeps gate and current-manifest obligations reachable when the runner session is terminal", () => {
		const { db, queue } = fixture();
		try {
			queue.enqueue({
				id: "review-gate",
				fromAgent: "exec-completed",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: "question",
				checkpoint: "review_design",
				content: "review this plan",
				createdAt: T0,
				senderRef: SENDER_REF,
			});
			queue.enqueue({
				id: "review-gate-response",
				fromAgent: "lead-a",
				toAgent: "exec-completed",
				recipientKind: "runner",
				type: "response",
				refId: "review-gate",
				content: "approved",
				createdAt: at(1),
				senderRef: SENDER_REF,
			});
			enqueue(queue, "design-review-manifest:exec-completed:2", {
				toAgent: "exec-completed",
				recipientKind: "runner",
				type: "instruction",
				createdAt: at(2),
			});
			enqueue(queue, "ordinary-terminal-instruction", {
				toAgent: "exec-completed",
				recipientKind: "runner",
				type: "instruction",
				createdAt: at(3),
			});

			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(4),
				recipientKind: "runner",
				leaseRetryMax: 3,
				recipientState: () => "terminal_or_missing",
				isTerminalDeliveryObligation: (row) =>
					row.id === "design-review-manifest:exec-completed:2",
				maxBatches: 10,
				maxTerminalRows: 10,
			});

			expect(queue.getById("review-gate-response")?.state).toBe("QUEUED");
			expect(
				queue.getById("design-review-manifest:exec-completed:2")?.state,
			).toBe("QUEUED");
			expect(queue.getById("ordinary-terminal-instruction")).toMatchObject({
				state: "DEAD",
				dead_reason: "recipient_terminal",
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("leaves a frozen batch untouched while recipient liveness is unknown", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "frozen-unknown");
			claimLead(queue, "batch-frozen-unknown");
			const result = queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(31),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "unknown",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(result).toMatchObject({
				dead: 0,
				frozenResend: [],
				skippedUnknown: 1,
			});
			expect(queue.getById("frozen-unknown")).toMatchObject({
				state: "LEASED",
				claimed_by: OWNER,
				claim_expires_at: at(30),
				last_error: null,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("keeps frozen exhaustion out of fallback audit queries after the notice lane surfaces it", () => {
		const source = readFileSync(
			new URL("../mailbox-queue.ts", import.meta.url),
			"utf8",
		);
		const scanStart = source.indexOf("\tscanAndInsertDeadLetterNotices(");
		const listStart = source.indexOf("\tlistUncoveredLeadDeadLetters(");
		const listEnd = source.indexOf("\n\tclaimBridgeProtocol(", listStart);
		expect(scanStart).toBeGreaterThan(-1);
		expect(listStart).toBeGreaterThan(scanStart);
		expect(listEnd).toBeGreaterThan(listStart);

		const deadEligibilityQueries = (methodSource: string) =>
			[...methodSource.matchAll(/`SELECT[\s\S]*?`/g)]
				.map(([query]) => query)
				.filter((query) => /state\s*=\s*'DEAD'/.test(query));
		const frozenReasonInterpolation =
			"${" + "FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}";
		const exclusion = `dead_reason IS NOT '${frozenReasonInterpolation}'`;
		const scanQueries = deadEligibilityQueries(
			source.slice(scanStart, listStart),
		);
		const listQueries = deadEligibilityQueries(
			source.slice(listStart, listEnd),
		);
		expect(scanQueries).toHaveLength(4);
		expect(listQueries).toHaveLength(5);
		expect(scanQueries.every((query) => !query.includes(exclusion))).toBe(true);
		expect(listQueries.every((query) => query.includes(exclusion))).toBe(true);
	});

	it("stamps raw delivery on ack and preserves an earlier emission stamp", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "ack-stamps-delivery");
			expect(queue.ack("ack-stamps-delivery", at(1))).toBe(true);
			expect(queue.getById("ack-stamps-delivery")).toMatchObject({
				state: "ACKED",
				acked_at: at(1),
				delivered_at: at(1),
			});

			enqueue(queue, "ack-preserves-delivery");
			db.prepare("UPDATE mailbox SET delivered_at = ? WHERE id = ?").run(
				T0,
				"ack-preserves-delivery",
			);
			expect(queue.ack("ack-preserves-delivery", at(2))).toBe(true);
			expect(queue.getById("ack-preserves-delivery")).toMatchObject({
				state: "ACKED",
				acked_at: at(2),
				delivered_at: T0,
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("treats an ack after requeue as a harmless late noop", () => {
		const { db, queue } = fixture();
		try {
			enqueue(queue, "q1");
			claimLead(queue, "batch-1");
			queue.recordLeadBatchDelivered({
				batchId: "batch-1",
				ownerEpoch: OWNER,
				now: T0,
				ackLeaseTtlMs: 10_000,
			});
			queue.reconcileExpiredLeases({
				ownerEpoch: OWNER,
				now: at(11),
				recipientKind: "lead",
				toAgent: "lead-a",
				leaseRetryMax: 3,
				recipientState: () => "alive",
				maxBatches: 10,
				maxTerminalRows: 10,
			});
			expect(
				queue.ackBatchByRecipient({
					batchId: "batch-1",
					fromAgent: "lead-a",
					now: at(12),
				}),
			).toBe("ack_late_noop");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("emits at most one runner dead-letter notice per window and emits again across windows", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 5; index += 1) {
				enqueue(queue, `dead-${index}`, {
					toAgent: "exec-dead",
					recipientKind: "runner",
					createdAt: at(index),
				});
				queue.markDead(`dead-${index}`, at(index + 1), "recipient_terminal");
			}
			const first = queue.scanAndInsertDeadLetterNotices({
				ownerEpoch: OWNER,
				now: at(10),
				windowMs: 1_800_000,
				maxRecipients: 10,
				maxDeadRowsPerRecipient: 5,
				maxSummaryBytes: 2_000,
				probeFactsByRecipient: new Map([
					[
						"exec-dead",
						"StateStore 视图=alive / 最近心跳=2m（注意：此为登记视图非 pane 直读，处置前仍须人工验活）",
					],
				]),
				resolveOwningLead: (recipient) =>
					recipient === "exec-dead" ? "lead-a" : undefined,
			});
			expect(first.inserted).toHaveLength(1);
			const notice1 = queue.getById(first.inserted[0] as string);
			expect(notice1).toMatchObject({
				from_agent: "bridge",
				to_agent: "lead-a",
				type: "dead_letter_notice",
				source_ref: "exec-dead",
			});
			expect(notice1?.content).toContain("5 封信");
			expect(notice1?.content).toContain("未签收 ≠ 已下线");
			expect(notice1?.content).toContain("探针实况：StateStore 视图=alive");
			expect(notice1?.content).toContain("活着则不要动它");

			enqueue(queue, "dead-5", {
				toAgent: "exec-dead",
				recipientKind: "runner",
				createdAt: at(20),
			});
			queue.markDead("dead-5", at(21), "recipient_terminal");
			const withinWindow = queue.scanAndInsertDeadLetterNotices({
				ownerEpoch: OWNER,
				now: at(30),
				windowMs: 1_800_000,
				maxRecipients: 10,
				maxDeadRowsPerRecipient: 5,
				maxSummaryBytes: 2_000,
				resolveOwningLead: () => "lead-a",
			});
			expect(withinWindow.inserted).toEqual([]);
			expect(withinWindow.rateLimited).toContain("exec-dead");

			const nextWindow = queue.scanAndInsertDeadLetterNotices({
				ownerEpoch: OWNER,
				now: at(1_811),
				windowMs: 1_800_000,
				maxRecipients: 10,
				maxDeadRowsPerRecipient: 5,
				maxSummaryBytes: 2_000,
				resolveOwningLead: () => "lead-a",
			});
			expect(nextWindow.inserted).toHaveLength(1);
			expect(
				queue.getById(nextWindow.inserted[0] as string)?.content,
			).toContain("1 封信");
			expect(
				(
					db
						.prepare(
							"SELECT COUNT(*) AS n FROM mailbox WHERE type = 'dead_letter_notice'",
						)
						.get() as { n: number }
				).n,
			).toBe(2);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("dead-letter notice scans advance past already-covered recipients", () => {
		const { db, queue } = fixture();
		let scanQueue: MailboxQueue | undefined;
		try {
			for (let index = 0; index < 8; index += 1) {
				const recipient = `aaa-covered-${index}`;
				enqueue(queue, `covered-dead-${index}`, {
					toAgent: recipient,
					recipientKind: "runner",
				});
				queue.markDead(`covered-dead-${index}`, at(1), "recipient_terminal");
				expect(
					queue.scanAndInsertDeadLetterNotices({
						ownerEpoch: OWNER,
						now: at(2),
						windowMs: 1_800_000,
						maxRecipients: 20,
						maxDeadRowsPerRecipient: 5,
						maxSummaryBytes: 1_000,
						resolveOwningLead: () => "lead-a",
					}).inserted,
				).toHaveLength(1);
			}
			enqueue(queue, "uncovered-dead", {
				toAgent: "zzz-uncovered",
				recipientKind: "runner",
			});
			queue.markDead("uncovered-dead", at(3), "recipient_terminal");
			scanQueue = new MailboxQueue(db);

			const inserted: string[] = [];
			for (let tick = 0; tick < 3; tick += 1) {
				inserted.push(
					...scanQueue.scanAndInsertDeadLetterNotices({
						ownerEpoch: OWNER,
						now: at(1_900 + tick),
						windowMs: 1_800_000,
						maxRecipients: 4,
						maxDeadRowsPerRecipient: 5,
						maxSummaryBytes: 1_000,
						resolveOwningLead: () => "lead-a",
					}).inserted,
				);
			}
			expect(inserted).toHaveLength(1);
			expect(scanQueue.getById(inserted[0]!)?.source_ref).toBe("zzz-uncovered");
		} finally {
			scanQueue?.close();
			queue.close();
			db.close();
		}
	});

	it("covers the second recipient page when more than 100 runners are dead", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 101; index += 1) {
				const recipient = `exec-${String(index).padStart(3, "0")}`;
				const id = `dead-page-${String(index).padStart(3, "0")}`;
				enqueue(queue, id, { recipientKind: "runner", toAgent: recipient });
				queue.markDead(id, at(1), "recipient_terminal");
			}
			const scan = () =>
				queue.scanAndInsertDeadLetterNotices({
					ownerEpoch: OWNER,
					now: at(10),
					windowMs: 1_800_000,
					maxRecipients: 100,
					maxDeadRowsPerRecipient: 5,
					maxSummaryBytes: 1_000,
					resolveOwningLead: () => "lead-a",
				});

			const first = scan();
			expect(first.inserted).toHaveLength(100);
			expect(first.uncoveredRemaining).toBe(true);
			const second = scan();
			expect(second.inserted).toHaveLength(1);
			expect(queue.getById(second.inserted[0]!)?.source_ref).toBe("exec-100");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("Lead alert scans advance past routable runner dead letters", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 8; index += 1) {
				enqueue(queue, `routable-${index}`, {
					toAgent: `aaa-routable-${index}`,
					recipientKind: "runner",
				});
				queue.markDead(`routable-${index}`, at(1), "recipient_terminal");
			}
			enqueue(queue, "unroutable-last", {
				toAgent: "zzz-unroutable",
				recipientKind: "runner",
			});
			queue.markDead("unroutable-last", at(2), "recipient_terminal");

			const candidates = [];
			let resolveCalls = 0;
			for (let tick = 0; tick < 9; tick += 1) {
				const beforeResolveCalls = resolveCalls;
				candidates.push(
					...queue.listUncoveredLeadDeadLetters({
						sinceCursor: [],
						limit: 1,
						maxRowsPerRecipient: 5,
						maxSummaryBytes: 1_000,
						resolveOwningLead: (recipient) => {
							resolveCalls += 1;
							return recipient.startsWith("aaa-") ? "lead-a" : undefined;
						},
					}),
				);
				expect(resolveCalls - beforeResolveCalls).toBeLessThanOrEqual(1);
			}
			expect(candidates).toEqual([
				expect.objectContaining({
					sourceKind: "runner_unroutable",
					recipient: "zzz-unroutable",
				}),
			]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("bounds dead-letter summaries by rows and bytes while advancing the full high-water mark", () => {
		const { db, queue } = fixture();
		try {
			for (let index = 0; index < 20; index += 1) {
				enqueue(queue, `bulk-${index}`, {
					toAgent: "exec-bulk",
					recipientKind: "runner",
					createdAt: at(index),
				});
				queue.markDead(`bulk-${index}`, at(index + 1), "lease_expired_unacked");
			}
			const result = queue.scanAndInsertDeadLetterNotices({
				ownerEpoch: OWNER,
				now: at(30),
				windowMs: 1_800_000,
				maxRecipients: 10,
				maxDeadRowsPerRecipient: 3,
				maxSummaryBytes: 300,
				resolveOwningLead: () => "lead-a",
			});
			const notice = queue.getById(result.inserted[0] as string);
			expect(notice?.content).toContain("20 封信");
			expect(
				Buffer.byteLength(notice?.content ?? "", "utf8"),
			).toBeLessThanOrEqual(300);
			expect(result.uncoveredRemaining).toBe(false);
			expect(
				queue.scanAndInsertDeadLetterNotices({
					ownerEpoch: OWNER,
					now: at(1_900),
					windowMs: 1_800_000,
					maxRecipients: 10,
					maxDeadRowsPerRecipient: 3,
					maxSummaryBytes: 300,
					resolveOwningLead: () => "lead-a",
				}).inserted,
			).toEqual([]);
		} finally {
			queue.close();
			db.close();
		}
	});
});
