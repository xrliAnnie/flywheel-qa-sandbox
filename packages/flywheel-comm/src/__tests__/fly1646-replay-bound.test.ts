import { describe, expect, it } from "vitest";
import {
	beginChatReceipt,
	completeChatReceipt,
	listPendingChatReceipts,
	settleChatReceipt,
} from "../commands/chat-receipt.js";
import { CommDB } from "../db.js";
import {
	CHAT_DELIVERY_UNCONFIRMED_REASON,
	MailboxQueue,
} from "../mailbox-queue.js";
import { encodeSenderRef } from "../sender-ref.js";

/**
 * FLY-1646 — the FLY-1572 mailbox merge dropped the `delivered_at IS NULL`
 * guard from the external-receipt pending predicate. The Discord plugin's
 * ChatReceiptRuntime.reconcilePendingPass() replays every row this predicate
 * returns with a `[redelivery]` prefix and then calls `complete`; with the
 * guard gone, `complete` could no longer retire a row, so the worker loop's
 * two break conditions (`!workRemains`, `!progress`) both stayed false and the
 * loop re-notified the same receipts without bound.
 *
 * The predicate must return only receipts that are still AWAITING DELIVERY.
 * "Delivered but not yet answered" is a settlement-ledger concern and must
 * never drive redelivery.
 */

const NOW = "2026-08-06T00:00:00.000Z";
const LEAD = "fly1646-lead";

function begin(dbPath: string, messageId: string): void {
	beginChatReceipt({
		dbPath,
		leadId: LEAD,
		chatId: "111111111111111111",
		originChannelId: "111111111111111111",
		messageId,
		authorId: "222222222222222222",
		authorName: "founder",
		priority: 0,
		ts: NOW,
		msgKind: "guild",
		attachments: [],
		text: `probe ${messageId}`,
	});
}

function pendingIds(dbPath: string): string[] {
	return listPendingChatReceipts({ dbPath, leadId: LEAD }).rows.map(
		(r) => r.id,
	);
}

function enqueueExternal(queue: MailboxQueue, id: string): void {
	queue.enqueue({
		id,
		fromAgent: "founder",
		toAgent: LEAD,
		recipientKind: "lead",
		sourceKind: "discord_chat",
		sourceRef: id,
		type: "external_delivery",
		msgClass: "model",
		priority: 0,
		content: "raw",
		refId: null,
		createdAt: NOW,
		carrier: "external",
		senderRef: encodeSenderRef(),
	});
}

function freshDb(name: string): string {
	const path = `${process.env.TMPDIR ?? "/tmp"}/fly1646-${name}-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
	new CommDB(path, true).close();
	return path;
}

describe("FLY-1646 external-receipt replay must stay bounded", () => {
	it("retires a receipt from the pending set once it is delivered", () => {
		const dbPath = freshDb("delivered");
		begin(dbPath, "900000000000000001");
		expect(pendingIds(dbPath)).toEqual([`chat:${LEAD}:900000000000000001`]);

		completeChatReceipt({
			dbPath,
			leadId: LEAD,
			messageId: "900000000000000001",
			now: NOW,
		});

		// Before the fix this still returned the row, so every recovery pass
		// re-emitted it with `[redelivery]` forever.
		expect(pendingIds(dbPath)).toEqual([]);
	});

	it("keeps replaying a receipt that was never delivered", () => {
		const dbPath = freshDb("undelivered");
		begin(dbPath, "900000000000000002");
		// No complete() — delivery genuinely failed, so redelivery is correct.
		expect(pendingIds(dbPath)).toEqual([`chat:${LEAD}:900000000000000002`]);
	});

	it("does not resurrect a delivered receipt just because it was never answered", () => {
		const dbPath = freshDb("unanswered");
		begin(dbPath, "900000000000000003");
		begin(dbPath, "900000000000000004");
		completeChatReceipt({
			dbPath,
			leadId: LEAD,
			messageId: "900000000000000003",
			now: NOW,
		});
		completeChatReceipt({
			dbPath,
			leadId: LEAD,
			messageId: "900000000000000004",
			now: NOW,
		});
		// Only ...004 gets an explicit Discord reply.
		settleChatReceipt({
			dbPath,
			leadId: LEAD,
			messageId: "900000000000000004",
			replyId: "333333333333333333",
			now: NOW,
		});

		// The unanswered-but-delivered receipt (...003) must NOT be replayed.
		// Answer-tracking lives in the settlement ledger, not in redelivery.
		expect(pendingIds(dbPath)).toEqual([]);
	});

	it("keeps a quarantined receipt redeliverable — DEAD is not terminal here", () => {
		// Quarantine is visibility, not disposal: the legacy lane set only
		// `disposition`, never `delivered_at`, so a quarantined-but-undelivered
		// receipt stayed replayable. Excluding DEAD would trade the storm for
		// silent message loss (ExternalReceiptSaga also marks rows dead for
		// recoverable reasons such as a temporarily unavailable journal).
		const dbPath = freshDb("quarantined");
		const id = `chat:${LEAD}:900000000000000005`;
		const queue = new MailboxQueue(dbPath);
		try {
			enqueueExternal(queue, id);
			expect(pendingIds(dbPath)).toEqual([id]);
			queue.markDead(id, NOW, CHAT_DELIVERY_UNCONFIRMED_REASON);
		} finally {
			queue.close();
		}
		expect(pendingIds(dbPath)).toEqual([id]);
	});

	it("drops a genuinely disposed receipt (settlement ledger, not state)", () => {
		const dbPath = freshDb("disposed");
		const id = `chat:${LEAD}:900000000000000007`;
		const queue = new MailboxQueue(dbPath);
		try {
			enqueueExternal(queue, id);
			queue.settle({
				messageOrDeliveryId: id,
				event: "disposed",
				now: NOW,
				evidence: {
					v: 1,
					kind: "operator_disposal",
					ref: "fly1646",
					actor: LEAD,
					actor_kind: "lead",
					fence: { leadId: LEAD },
				},
			});
		} finally {
			queue.close();
		}
		expect(pendingIds(dbPath)).toEqual([]);
	});

	it("lets delivery retire a quarantined receipt so the loop converges", () => {
		// The dual of the predicate: anything listExternalPending can hand out
		// must be retirable by complete(). Otherwise a quarantined row is
		// re-notified forever (it can never be marked delivered) and
		// ExternalReceiptSaga.complete() throws on a recovered xdept receipt.
		const dbPath = freshDb("converge");
		const id = `chat:${LEAD}:900000000000000009`;
		const queue = new MailboxQueue(dbPath);
		try {
			enqueueExternal(queue, id);
			queue.markDead(id, NOW, CHAT_DELIVERY_UNCONFIRMED_REASON);
			expect(pendingIds(dbPath)).toEqual([id]);
			expect(queue.markExternalDelivered(id, NOW)).toBe(true);
		} finally {
			queue.close();
		}
		expect(pendingIds(dbPath)).toEqual([]);
	});

	it("excludeQuarantined also matches the migrated legacy dead_reason", () => {
		// Migrated rows carry the old lead_inbox.disposition verbatim, so the
		// opt-in must match that spelling too or it misses every pre-cutover row.
		const dbPath = freshDb("legacy-reason");
		const id = `chat:${LEAD}:900000000000000010`;
		const queue = new MailboxQueue(dbPath);
		try {
			enqueueExternal(queue, id);
			queue.markDead(id, NOW, "delivery_quarantined");
		} finally {
			queue.close();
		}
		expect(pendingIds(dbPath)).toEqual([id]);
		expect(
			listPendingChatReceipts({
				dbPath,
				leadId: LEAD,
				excludeQuarantined: true,
			}).rows,
		).toEqual([]);
	});

	it("honors excludeQuarantined as a caller opt-in", () => {
		const dbPath = freshDb("flag");
		const quarantined = `chat:${LEAD}:900000000000000006`;
		const awaiting = `chat:${LEAD}:900000000000000008`;
		const queue = new MailboxQueue(dbPath);
		try {
			enqueueExternal(queue, quarantined);
			enqueueExternal(queue, awaiting);
			queue.markDead(quarantined, NOW, CHAT_DELIVERY_UNCONFIRMED_REASON);
		} finally {
			queue.close();
		}
		// default: quarantined rows stay visible
		expect(pendingIds(dbPath)).toEqual([quarantined, awaiting]);
		// opt-in: caller drops them
		expect(
			listPendingChatReceipts({
				dbPath,
				leadId: LEAD,
				excludeQuarantined: true,
			}).rows.map((r) => r.id),
		).toEqual([awaiting]);
	});
});
