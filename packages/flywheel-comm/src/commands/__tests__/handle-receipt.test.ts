import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../../db.js";
import { LeadInboxQueue } from "../../lead-inbox-queue.js";
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
		const queue = new LeadInboxQueue(dbPath);
		queue.enqueue({
			id: "receipt-1",
			toLead: "lead-a",
			source: "future",
			type: "future_category",
			msgClass: "model",
			content: "handle me",
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
		queue.acquireOrRenewOwner({
			ownerEpoch: "owner-a",
			now: "2026-07-21T11:59:00.000Z",
			leaseTtlMs: 60 * 60_000,
		});
		queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "owner-a",
			batchId: "batch-a",
			now: "2026-07-21T11:59:00.000Z",
			claimTtlMs: 60_000,
		});
		queue.markConsumed(["receipt-1"], {
			ownerEpoch: "owner-a",
			disposition: "delivered",
			now: "2026-07-21T11:59:30.000Z",
			receiptWindowsMs: [1_800_000, 1_800_000, 14_400_000, 86_400_000],
		});
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
		const verify = new LeadInboxQueue(dbPath);
		expect(verify.getById("receipt-1")?.processed_at).toBe(
			"2026-07-21T12:00:00.000Z",
		);
		verify.close();
	});
});
