import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../../db.js";
import { MailboxQueue } from "../../mailbox-queue.js";
import { encodeSenderRef } from "../../sender-ref.js";
import { handleReceipt } from "../handle-receipt.js";

describe("handle-receipt command", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("authorizes the Lead and acknowledges an arbitrary receipt", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1392-handle-command-"));
		dirs.push(dir);
		const dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		const queue = new MailboxQueue(dbPath);
		queue.enqueue({
			id: "receipt-1",
			fromAgent: "future-agent",
			toAgent: "lead-a",
			recipientKind: "lead",
			sourceKind: "future",
			type: "future_category",
			msgClass: "model",
			content: "handle me",
			senderRef: encodeSenderRef(),
		});
		expect(() =>
			handleReceipt({
				dbPath,
				requestId: "request-before-delivery",
				receiptId: "receipt-1",
				leadId: "lead-a",
				action: "ack",
				now: () => new Date("2026-07-21T12:00:00.000Z"),
				authorize: () => ({
					disposition: "lease_validated",
					provenance: {
						senderLeaseKey: "lease-a",
						senderGeneration: 17,
					},
				}),
			}),
		).toThrow(/receipt_not_delivered/);
		queue.ack("receipt-1", "2026-07-21T11:59:30.000Z");
		queue.close();

		const result = handleReceipt({
			dbPath,
			requestId: "request-1",
			receiptId: "receipt-1",
			leadId: "lead-a",
			action: "ack",
			reason: "read and handled",
			now: () => new Date("2026-07-21T12:00:00.000Z"),
			authorize: () => ({
				disposition: "lease_validated",
				provenance: {
					senderLeaseKey: "lease-a",
					senderGeneration: 17,
				},
			}),
		});

		expect(result).toMatchObject({ kind: "handled", action: "ack" });
		const verify = new MailboxQueue(dbPath);
		expect(verify.getSettlement("receipt-1")).toMatchObject({
			event: "processed",
			at: "2026-07-21T12:00:00.000Z",
		});
		verify.close();
	});
});
