#!/usr/bin/env tsx
/**
 * FLY-1646: is the replay defect only about migrated history, or standing?
 *
 * Claim under test: on post-FLY-1572 semantics, a receipt that is delivered
 * (`chat-receipt complete`) but not explicitly replied to (`settle`) stays in
 * the `pending` set FOREVER — so fresh traffic re-arms the storm even on a
 * database that was never migrated.
 */
import { CommDB } from "../../../../packages/flywheel-comm/src/db.js";
import {
	beginChatReceipt,
	completeChatReceipt,
	listPendingChatReceipts,
	settleChatReceipt,
} from "../../../../packages/flywheel-comm/src/commands/chat-receipt.js";

const DB = process.argv[2];
if (!DB) throw new Error("usage: fly1646-standing-defect.ts <freshDbPath>");

const LEAD = "fly1646-probe-lead";
const now = "2026-08-06T00:00:00.000Z";
const pending = (): string[] =>
	listPendingChatReceipts({ dbPath: DB, leadId: LEAD }).rows.map((r) => r.id);

// Create a fresh mailbox_v1 database with NO migrated history at all.
new CommDB(DB, true).close();

const mk = (messageId: string) =>
	beginChatReceipt({
		dbPath: DB,
		leadId: LEAD,
		chatId: "111111111111111111",
		originChannelId: "111111111111111111",
		messageId,
		authorId: "222222222222222222",
		authorName: "founder",
		priority: 0,
		ts: now,
		msgKind: "guild",
		attachments: [],
		text: `probe ${messageId}`,
	});

mk("900000000000000001"); // will be delivered, never replied to
mk("900000000000000002"); // will be delivered AND replied to

console.log(JSON.stringify({ step: "after begin x2", pending: pending() }));

completeChatReceipt({ dbPath: DB, leadId: LEAD, messageId: "900000000000000001", now });
completeChatReceipt({ dbPath: DB, leadId: LEAD, messageId: "900000000000000002", now });
console.log(
	JSON.stringify({
		step: "after complete x2 (both delivered to the Lead)",
		pending: pending(),
		expected_before_fix: "BOTH ids (delivered rows stayed pending => replayed forever)",
		expected_after_fix: "[] (delivery retires the row)",
	}),
);

settleChatReceipt({
	dbPath: DB,
	leadId: LEAD,
	messageId: "900000000000000002",
	replyId: "333333333333333333",
	now,
});
console.log(
	JSON.stringify({
		step: "after settle of ...002 only (Lead sent an explicit Discord reply)",
		pending: pending(),
		expected_before_fix: "[...001] — an answered-but-never-replied receipt stuck pending forever",
		expected_after_fix: "[] — answering is tracked by the settlement ledger, not by redelivery",
	}),
);
