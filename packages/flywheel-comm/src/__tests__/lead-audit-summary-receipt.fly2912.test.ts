import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { encodeSenderRef } from "../sender-ref.js";

const NOW = "2026-09-26T05:00:00.000Z";
const scope = {
	projectName: "flywheel",
	leadId: "lead-a",
	storeEpoch: "generation-a",
	ownerEpoch: "owner",
	now: NOW,
};
const roots: string[] = [];
const queues: MailboxQueue[] = [];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "fly2912-summary-"));
	roots.push(root);
	const path = join(root, "comm.db");
	const queue = new MailboxQueue(path);
	queues.push(queue);
	queue.acquireOrRenewOwner({
		ownerEpoch: "owner",
		now: NOW,
		leaseTtlMs: 60_000,
	});
	return { queue, path };
}
function claim(queue: MailboxQueue, batchId = "batch", id = "question") {
	queue.enqueue({
		id,
		fromAgent: "runner",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "question",
		content: "real task",
		createdAt: NOW,
		senderRef: encodeSenderRef(),
	});
	queue.claimLeadBatchQueue({
		toAgent: "lead-a",
		msgClass: "model",
		ownerEpoch: "owner",
		batchId,
		now: NOW,
		transportClaimTtlMs: 30_000,
		batchWindowMs: 0,
		batchMaxSize: 5,
		inflightMaxBatches: 3,
	});
	return {
		batchId,
		transportBatchId: `${batchId}#r0`,
		memberIds: [`${id}#r0`],
	};
}
function freeze(
	queue: MailboxQueue,
	batch = claim(queue),
	throughSeq = 15,
	content = "只读账目概览",
) {
	queue.initializeLeadAuditSummaryCursor({
		...scope,
		throughSeq: 10,
		anchorEventId: "event-10",
	});
	return queue.freezeLeadAuditSummaryOffer({
		...scope,
		...batch,
		fromSeq: 10,
		throughSeq,
		anchorEventId: `event-${throughSeq}`,
		content,
	});
}
function receipt(batchId = "batch", id = "question") {
	return {
		batchId,
		ownerEpoch: "owner",
		now: NOW,
		ackLeaseTtlMs: 60_000,
		auditSummaryReceipt: {
			...scope,
			transportBatchId: `${batchId}#r0`,
			memberIds: [`${id}#r0`],
		},
	};
}
afterEach(() => {
	for (const queue of queues.splice(0)) queue.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("FLY-2912 frozen summary delivery receipt", () => {
	it("freezes the first bytes, hash, range and anchor across retry and restart", () => {
		const { queue, path } = setup();
		const first = freeze(queue);
		expect(first).toMatchObject({
			content: "只读账目概览",
			contentSha256: createHash("sha256").update("只读账目概览").digest("hex"),
			fromSeq: 10,
			throughSeq: 15,
			anchorEventId: "event-15",
			acceptedAt: null,
		});
		const reopened = new MailboxQueue(path);
		queues.push(reopened);
		expect(
			reopened.freezeLeadAuditSummaryOffer({
				...scope,
				storeEpoch: "recovered-generation",
				batchId: "batch",
				transportBatchId: "batch#r0",
				memberIds: ["question#r0"],
				fromSeq: 0,
				throughSeq: 100,
				anchorEventId: "different",
				content: "changed",
			}),
		).toEqual(first);
		expect(
			reopened.getLeadAuditSummaryOffer({
				...scope,
				transportBatchId: "batch#r0",
			}),
		).toEqual(first);
		expect(reopened.getLeadAuditSummaryCursor(scope)).toMatchObject({
			offeredThroughSeq: 10,
			anchorEventId: "event-10",
		});
	});
	it("only accepts with an exact receipt and leaves original payload/membership unchanged", () => {
		const { queue } = setup();
		freeze(queue);
		expect(queue.recordLeadBatchDelivered(receipt())).toBe("applied");
		expect(queue.getLeadAuditSummaryCursor(scope)).toMatchObject({
			offeredThroughSeq: 15,
			anchorEventId: "event-15",
		});
		expect(
			queue.getLeadAuditSummaryOffer({ ...scope, transportBatchId: "batch#r0" })
				?.acceptedAt,
		).toBe(NOW);
		expect(queue.getById("question")).toMatchObject({
			content: "real task",
			state: "LEASED",
			batch_id: "batch",
			notified_at: NOW,
		});
	});
	it.each(["before freeze", "after freeze"])(
		"accepts the full batch when a member is ACKED %s",
		(timing) => {
			const { queue } = setup();
			queue.enqueue({
				id: "settled",
				fromAgent: "runner",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: "question",
				content: "settled task",
				createdAt: NOW,
				senderRef: encodeSenderRef(),
			});
			const batch = {
				...claim(queue),
				memberIds: ["settled#r0", "question#r0"],
			};
			if (timing === "after freeze") expect(freeze(queue, batch)).toBeDefined();
			expect(queue.ack("settled", NOW)).toBe(true);
			const settled = queue.getById("settled");
			expect(settled).toMatchObject({ state: "ACKED", claimed_by: null });
			expect(freeze(queue, batch)).toBeDefined();
			const input = receipt();
			input.auditSummaryReceipt.memberIds = batch.memberIds;
			expect(queue.recordLeadBatchDelivered(input)).toBe("applied");
			expect(queue.getById("settled")).toEqual(settled);
			expect(queue.getById("question")).toMatchObject({
				state: "LEASED",
				notified_at: NOW,
			});
			expect(queue.getLeadAuditSummaryCursor(scope)?.offeredThroughSeq).toBe(
				15,
			);
		},
	);
	it("accepts an exact receipt after every member was ACKED in flight", () => {
		const { queue } = setup();
		freeze(queue);
		expect(queue.ack("question", NOW)).toBe(true);
		expect(queue.recordLeadBatchDelivered(receipt())).toBe("already_settled");
		expect(queue.getLeadAuditSummaryCursor(scope)?.offeredThroughSeq).toBe(15);
		expect(
			queue.getLeadAuditSummaryOffer({ ...scope, transportBatchId: "batch#r0" })
				?.acceptedAt,
		).toBe(NOW);
	});
	it.each([
		"owner",
		"state",
		"attempt",
		"class",
		"carrier",
		"disposition",
		"lead",
		"order",
		"missing",
	])(
		"rejects a mixed batch with an invalid %s without recording delivery",
		(mismatch) => {
			const { queue, path } = setup();
			queue.enqueue({
				id: "settled",
				fromAgent: "runner",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: "question",
				content: "settled task",
				createdAt: NOW,
				senderRef: encodeSenderRef(),
			});
			const batch = {
				...claim(queue),
				memberIds: ["settled#r0", "question#r0"],
			};
			freeze(queue, batch);
			queue.ack("settled", NOW);
			const db = new Database(path);
			try {
				const mutations: Record<string, string> = {
					owner: "claimed_by = 'foreign'",
					state: "state = 'DEAD'",
					attempt: "lease_retry_count = 1",
					class: "msg_class = 'protocol'",
					carrier: "carrier = 'external'",
					disposition: "delivery_disposition = 'audit_only'",
					lead: "to_agent = 'foreign'",
				};
				if (mutations[mismatch])
					db.prepare(
						`UPDATE mailbox SET ${mutations[mismatch]} WHERE id = 'question'`,
					).run();
			} finally {
				db.close();
			}
			if (mismatch === "order") batch.memberIds.reverse();
			if (mismatch === "missing") batch.memberIds.shift();
			expect(freeze(queue, batch)).toBeUndefined();
			const input = receipt();
			input.auditSummaryReceipt.memberIds = batch.memberIds;
			expect(queue.recordLeadBatchDelivered(input)).toBe("lost_race");
			expect(queue.getLeadAuditSummaryCursor(scope)?.offeredThroughSeq).toBe(
				10,
			);
			expect(queue.getById("question")?.notified_at).toBeNull();
		},
	);
	it.each(["owner", "batch", "members", "epoch", "lead", "project"])(
		"rejects %s mismatches without advancing or recording queue delivery",
		(mismatch) => {
			const { queue } = setup();
			freeze(queue);
			const input = receipt();
			if (mismatch === "owner") input.ownerEpoch = "stale";
			if (mismatch === "batch")
				input.auditSummaryReceipt.transportBatchId = "batch#r1";
			if (mismatch === "members")
				input.auditSummaryReceipt.memberIds = ["wrong#r0"];
			if (mismatch === "epoch") input.auditSummaryReceipt.storeEpoch = "wrong";
			if (mismatch === "lead") input.auditSummaryReceipt.leadId = "wrong";
			if (mismatch === "project")
				input.auditSummaryReceipt.projectName = "wrong";
			expect(queue.recordLeadBatchDelivered(input)).toBe("lost_race");
			expect(queue.getLeadAuditSummaryCursor(scope)?.offeredThroughSeq).toBe(
				10,
			);
			expect(queue.getById("question")?.notified_at).toBeNull();
		},
	);
	it("does not create offers without a real claimed batch or with a lost owner", () => {
		const { queue } = setup();
		const input = {
			...scope,
			batchId: "missing",
			transportBatchId: "missing#r0",
			memberIds: [],
			fromSeq: 10,
			throughSeq: 15,
			anchorEventId: "event-15",
			content: "summary",
		};
		expect(queue.freezeLeadAuditSummaryOffer(input)).toBeUndefined();
		freeze(queue);
		expect(
			queue.getLeadAuditSummaryCursor({ ...scope, ownerEpoch: "stale" }),
		).toBeUndefined();
		expect(
			queue.getLeadAuditSummaryOffer({
				...scope,
				ownerEpoch: "stale",
				transportBatchId: "batch#r0",
			}),
		).toBeUndefined();
		expect(
			queue.initializeLeadAuditSummaryCursor({
				...scope,
				ownerEpoch: "stale",
				storeEpoch: "other",
				throughSeq: 0,
				anchorEventId: null,
			}),
		).toBeUndefined();
		expect(
			queue.freezeLeadAuditSummaryOffer({ ...input, ownerEpoch: "stale" }),
		).toBeUndefined();
	});
	it("frozen empty failure attachment never advances the cursor", () => {
		const { queue } = setup();
		freeze(queue, claim(queue), 15, "");
		expect(queue.recordLeadBatchDelivered(receipt())).toBe("applied");
		expect(queue.getLeadAuditSummaryCursor(scope)?.offeredThroughSeq).toBe(10);
		expect(
			queue.getLeadAuditSummaryOffer({ ...scope, transportBatchId: "batch#r0" })
				?.acceptedAt,
		).toBeNull();
	});
	it("concurrent older receipt cannot rewind a newer range or its anchor", () => {
		const { queue } = setup();
		freeze(queue);
		// The first transport was delivered; its summary receipt is retried later.
		const { auditSummaryReceipt: _, ...firstDelivered } = receipt();
		expect(queue.recordLeadBatchDelivered(firstDelivered)).toBe("applied");
		freeze(queue, claim(queue, "second", "second-question"), 20);
		expect(
			queue.recordLeadBatchDelivered(receipt("second", "second-question")),
		).toBe("applied");
		expect(queue.recordLeadBatchDelivered(receipt())).toBe("applied");
		expect(queue.getLeadAuditSummaryCursor(scope)).toMatchObject({
			offeredThroughSeq: 20,
			anchorEventId: "event-20",
		});
	});
	it("cannot attach a summary to a protocol-only batch", () => {
		const { queue } = setup();
		queue.enqueue({
			id: "protocol",
			fromAgent: "runner",
			toAgent: "lead-a",
			recipientKind: "lead",
			type: "ack_batch",
			msgClass: "protocol",
			content: "{}",
			createdAt: NOW,
			senderRef: encodeSenderRef(),
		});
		queue.claimLeadBatch({
			toAgent: "lead-a",
			msgClass: "protocol",
			ownerEpoch: "owner",
			batchId: "protocol-batch",
			now: NOW,
			claimTtlMs: 30_000,
		});
		expect(
			freeze(queue, {
				batchId: "protocol-batch",
				transportBatchId: "protocol-batch#r0",
				memberIds: ["protocol#r0"],
			}),
		).toBeUndefined();
	});
	it("upgrades a pre-summary database and repeated opens preserve receipt boundaries", () => {
		const { path } = setup();
		const db = new Database(path);
		db.exec(
			"DROP TABLE lead_audit_summary_offer; DROP TABLE lead_audit_summary_cursor",
		);
		db.close();
		const reopened = new MailboxQueue(path);
		queues.push(reopened);
		reopened.initializeLeadAuditSummaryCursor({
			...scope,
			throughSeq: 10,
			anchorEventId: "event-10",
		});
		const again = new MailboxQueue(path);
		queues.push(again);
		expect(
			again.initializeLeadAuditSummaryCursor({
				...scope,
				throughSeq: 0,
				anchorEventId: null,
			}),
		).toMatchObject({ offeredThroughSeq: 10, anchorEventId: "event-10" });
		expect(
			again.getLeadAuditSummaryOffer({ ...scope, transportBatchId: "missing" }),
		).toBeUndefined();
	});
	it("rejects unverified anchors, unsafe ranges and uncovered gaps", () => {
		const { queue } = setup();
		const batch = claim(queue);
		expect(() =>
			queue.initializeLeadAuditSummaryCursor({
				...scope,
				throughSeq: 10,
				anchorEventId: null,
			}),
		).toThrow("anchor");
		queue.initializeLeadAuditSummaryCursor({
			...scope,
			throughSeq: 10,
			anchorEventId: "event-10",
		});
		const input = {
			...scope,
			...batch,
			fromSeq: 10,
			throughSeq: 15,
			anchorEventId: "event-15",
			content: "summary",
		};
		expect(
			queue.freezeLeadAuditSummaryOffer({ ...input, fromSeq: 11 }),
		).toBeUndefined();
		expect(() =>
			queue.freezeLeadAuditSummaryOffer({
				...input,
				throughSeq: Number.MAX_SAFE_INTEGER + 1,
			}),
		).toThrow("range");
		expect(() =>
			queue.freezeLeadAuditSummaryOffer({ ...input, anchorEventId: null }),
		).toThrow("anchor");
		expect(queue.getLeadAuditSummaryOffer(input)).toBeUndefined();
	});
	it("rolls back queue receipt and acceptance together if cursor persistence fails", () => {
		const { queue, path } = setup();
		freeze(queue);
		const db = new Database(path);
		db.exec(
			"CREATE TRIGGER deny_summary_cursor BEFORE UPDATE ON lead_audit_summary_cursor BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END",
		);
		db.close();
		expect(() => queue.recordLeadBatchDelivered(receipt())).toThrow(
			"injected cursor failure",
		);
		expect(queue.getById("question")?.notified_at).toBeNull();
		expect(
			queue.getLeadAuditSummaryOffer({ ...scope, transportBatchId: "batch#r0" })
				?.acceptedAt,
		).toBeNull();
		expect(queue.getLeadAuditSummaryCursor(scope)?.offeredThroughSeq).toBe(10);
	});
	it("keeps old callers compatible without accepting an unattached offer", () => {
		const { queue } = setup();
		freeze(queue);
		const { auditSummaryReceipt: _, ...input } = receipt();
		expect(queue.recordLeadBatchDelivered(input)).toBe("applied");
		expect(queue.getLeadAuditSummaryCursor(scope)?.offeredThroughSeq).toBe(10);
	});
});
