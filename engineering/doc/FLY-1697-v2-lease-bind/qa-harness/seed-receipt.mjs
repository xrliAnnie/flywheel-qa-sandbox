#!/usr/bin/env node
// QA FLY-1697 — seed one Discord chat receipt into an isolated comm.db and
// drive it to the exact production shape (carrier=inbox, state=ACKED,
// delivered, UNSETTLED) using the real shipped mailbox code paths.
//
// argv: <distDir> <dbPath> <leadId> <messageId> <text>
import { readFileSync } from "node:fs";

const [distDir, dbPath, leadId, messageId, text] = process.argv.slice(2);
if (!distDir || !dbPath || !leadId || !messageId) {
	console.error("usage: seed-receipt.mjs <distDir> <dbPath> <leadId> <messageId> <text>");
	process.exit(2);
}

const { ingestDiscordChat } = await import(`${distDir}/discord-chat-ingest.js`);
const { MailboxQueue } = await import(`${distDir}/mailbox-queue.js`);

const ts = "2026-08-11T18:01:13.855Z";
const ingest = ingestDiscordChat({
	dbPath,
	leadId,
	chatId: "1536630545927245905",
	originChannelId: "1536630545927245905",
	messageId,
	authorId: "1138241636057481306",
	authorName: "xrliannie_96634",
	ts,
	msgKind: "guild",
	attachments: [],
	text: text ?? "QA FLY-1697 positive control message",
	replyChannelId: "1536630545927245905",
});

const receiptId = `chat:${leadId}:${messageId}`;
const queue = new MailboxQueue(dbPath);
const now = new Date().toISOString();
const ownerEpoch = `qa-fly1697-${process.pid}`;
const batchId = `qa-batch-${process.pid}`;

if (!queue.acquireOrRenewOwner({ ownerEpoch, now, leaseTtlMs: 600000 })) {
	throw new Error("could not acquire mailbox loop owner");
}
const claimed = queue.claimLeadBatch({
	toAgent: leadId,
	msgClass: "model",
	ownerEpoch,
	batchId,
	now,
	claimTtlMs: 600000,
});
if (claimed.length === 0) throw new Error("claimLeadBatch returned no rows");
for (const row of claimed) {
	// The Discord ingest already materializes its own delivery payload; only
	// rows the Bridge still has to materialize go through this call.
	if (row.source_ref === null && row.delivery_content === null) {
		queue.materializeForDelivery({
			id: row.id,
			ownerEpoch,
			batchId,
			sourceKind: "discord_chat",
			sourceRef: row.id,
			deliveryContent: row.content,
		});
	}
}
queue.recordLeadBatchDelivered({ batchId, ownerEpoch, now, ackLeaseTtlMs: 600000 });
const ackResult = queue.ackBatchByRecipient({ batchId, fromAgent: leadId, now });

const row = queue.getById(receiptId);
const settlement = queue.getSettlement(receiptId);
queue.close();

console.log(
	JSON.stringify({
		ingestLane: ingest.lane,
		receiptId,
		batchId,
		ackResult,
		state: row?.state,
		carrier: row?.carrier,
		deliveredAt: row?.delivered_at,
		settlement: settlement?.event ?? null,
	}),
);
