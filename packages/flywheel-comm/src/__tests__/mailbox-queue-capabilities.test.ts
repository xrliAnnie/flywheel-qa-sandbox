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

	it("stops at three delivered batches and resumes immediately after one batch ack", () => {
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
			expect(claimLead(queue, "batch-3", at(4))).toEqual([]);
			expect(
				queue.ackBatchByRecipient({
					batchId: "batch-0",
					fromAgent: "lead-a",
					now: at(5),
				}),
			).toBe("applied");
			expect(claimLead(queue, "batch-3", at(6)).map((row) => row.id)).toEqual([
				"q3",
			]);
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

	it("keeps an expired undelivered orphan frozen on the same batch and attempt", () => {
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
				lease_retry_count: 0,
				delivered_at: null,
			});
			expect(claimLead(queue, "ignored", at(31)).map((row) => row.id)).toEqual([
				"q1",
			]);
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
