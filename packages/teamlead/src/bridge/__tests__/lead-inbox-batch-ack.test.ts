import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { expect, it, vi } from "vitest";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { executeLeadInboxBatchAck } from "../lead-inbox-batch-ack.js";

it("acks only this Lead's real batch and deduplicates UUIDs without replaying the effect", async () => {
	const queue = new MailboxQueue(":memory:");
	const home = mkdtempSync(join(tmpdir(), "inbox-ack-"));
	let receipts = new SqliteOutboundDedupStore(join(home, "receipts.db"));
	const now = new Date().toISOString();
	try {
		queue.acquireOrRenewOwner({
			ownerEpoch: "owner",
			now,
			leaseTtlMs: 3600000,
		});
		for (const lead of ["eng", "design"]) {
			queue.enqueue({
				id: lead,
				fromAgent: "founder",
				toAgent: lead,
				recipientKind: "lead",
				type: "discord_chat",
				content: "hello",
				createdAt: now,
				senderRef: encodeSenderRef(),
			});
			queue.claimLeadBatchQueue({
				toAgent: lead,
				msgClass: "model",
				ownerEpoch: "owner",
				batchId: `${lead}-batch`,
				now,
				transportClaimTtlMs: 60000,
				batchWindowMs: 30000,
				batchMaxSize: 10,
				inflightMaxBatches: 1,
			});
		}
		const ack = vi.spyOn(queue, "ackBatchByRecipient");
		const options = {
			projectName: "demo",
			leadId: "eng",
			activationId: "a1",
			requestId: randomUUID(),
			input: { batchId: "eng-batch" },
			receipts: receipts.operationReceipts,
			signal: new AbortController().signal,
			secrets: [],
			assertCurrent: async () => {},
			queue,
		};
		expect((await executeLeadInboxBatchAck(options)).status).toBe("succeeded");
		expect(queue.getById("eng")?.state).toBe("ACKED");
		receipts.close();
		receipts = new SqliteOutboundDedupStore(join(home, "receipts.db"));
		options.receipts = receipts.operationReceipts;
		expect(
			(await executeLeadInboxBatchAck({ ...options, activationId: "a2" }))
				.status,
		).toBe("succeeded");
		expect(ack).toHaveBeenCalledTimes(1);
		expect(
			(
				await executeLeadInboxBatchAck({
					...options,
					input: { batchId: "design-batch" },
				})
			).status,
		).toBe("rejected");
		expect(
			(
				await executeLeadInboxBatchAck({
					...options,
					requestId: randomUUID(),
					input: { batchId: "design-batch" },
				})
			).status,
		).toBe("rejected");
		expect(queue.getById("design")?.state).toBe("LEASED");
		const count = ack.mock.calls.length;
		expect(
			(await executeLeadInboxBatchAck({ ...options, receiptOnly: true }))
				.status,
		).toBe("succeeded");
		expect(
			(
				await executeLeadInboxBatchAck({
					...options,
					receiptOnly: true,
					requestId: randomUUID(),
				})
			).status,
		).toBe("unknown");
		expect(ack).toHaveBeenCalledTimes(count);
	} finally {
		queue.close();
		receipts.close();
		rmSync(home, { recursive: true, force: true });
	}
});
