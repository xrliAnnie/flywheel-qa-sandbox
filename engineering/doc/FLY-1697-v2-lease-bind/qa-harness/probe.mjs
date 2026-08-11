#!/usr/bin/env node
// QA FLY-1697 — read-only probe of an isolated comm.db receipt.
// argv: <distDir> <dbPath> <leadId> <receiptId>
const [distDir, dbPath, leadId, receiptId] = process.argv.slice(2);
const { MailboxQueue } = await import(`${distDir}/mailbox-queue.js`);
const { CommDB } = await import(`${distDir}/db.js`);

const queue = new MailboxQueue(dbPath);
const row = queue.getById(receiptId);
const settlement = queue.getSettlement(receiptId);
queue.close();

// The shipped redelivery selector for chat receipts. A settled receipt must
// never appear here again.
const db = new CommDB(dbPath, false);
const pending = db.listChatReceiptPending({ toLead: leadId });
db.close();

console.log(
	JSON.stringify({
		receiptId,
		state: row?.state ?? null,
		carrier: row?.carrier ?? null,
		deliveredAt: row?.delivered_at ?? null,
		settlement: settlement?.event ?? null,
		settlementEvidence: settlement?.evidence ?? null,
		pendingRedeliverySelected: pending.some((r) => r.id === receiptId),
		pendingCount: pending.length,
	}),
);
