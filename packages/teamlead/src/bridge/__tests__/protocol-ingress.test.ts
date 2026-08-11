import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	type DeliverySecret,
	deriveLeadEventAckToken,
} from "../lead-event-delivery.js";
import { ProtocolIngress } from "../protocol-ingress.js";

describe("ProtocolIngress mailbox ACK", () => {
	let dir: string;
	let dbPath: string;
	let store: StateStore;
	let queue: MailboxQueue;
	const secret: DeliverySecret = {
		secretId: "secret-1",
		key: Buffer.from("01234567890123456789012345678901"),
	};
	const now = "2026-08-05T20:00:00.000Z";

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1572-protocol-"));
		dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		db.close();
		store = await StateStore.create(":memory:");
		queue = new MailboxQueue(dbPath);
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-1",
			now,
			leaseTtlMs: 60_000,
		});
	});

	afterEach(() => {
		queue.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function appendAckEvent(): number {
		const seq = store.appendLeadEvent(
			"lead-1",
			`event-${Math.random()}`,
			"session_failed",
			JSON.stringify({
				event_type: "session_failed",
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "flywheel",
			}),
		);
		const internal = store as unknown as {
			db: { run(sql: string, params: unknown[]): void };
		};
		internal.db.run(
			`UPDATE lead_events SET ack_required = 1, ack_policy = 'explicit_receipt',
			 ack_protocol_version = 1, ack_owner_lead_id = 'lead-1' WHERE seq = ?`,
			[seq],
		);
		return seq;
	}

	function claim() {
		return queue.claimBridgeProtocol({
			fromAgent: "lead-1",
			ownerEpoch: "epoch-1",
			now,
			claimTtlMs: 60_000,
		})!;
	}

	it("verifies and applies the canonical ACK row without a mirror", async () => {
		const seq = appendAckEvent();
		const event = store.getLeadEventBySeq(seq)!;
		const token = deriveLeadEventAckToken(secret, {
			eventSeq: seq,
			ackOwnerLeadId: event.ack_owner_lead_id!,
			ownerEpoch: event.ack_owner_epoch!,
		});
		const db = new CommDB(dbPath);
		const id = db.insertAckReceipt("lead-1", seq, token);
		db.close();
		const ingress = new ProtocolIngress({
			store,
			queue,
			secretProvider: { getActive: () => secret },
		});
		expect(await ingress.handle(claim())).toEqual({
			disposition: "legacy_ack_applied",
		});
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeTruthy();
		expect(queue.getById(id)).toMatchObject({
			state: "LEASED",
			delivery_id: `ack:lead-1:${id}`,
		});
	});

	it("accepts a late receipt as an idempotent retirement no-op", async () => {
		const seq = appendAckEvent();
		store.retireOpenLeadEventAcks(now, "fly1572_cutover");
		const db = new CommDB(dbPath);
		db.insertAckReceipt("lead-1", seq, "late-token");
		db.close();
		const ingress = new ProtocolIngress({
			store,
			queue,
			secretProvider: { getActive: () => secret },
		});
		expect(await ingress.handle(claim())).toEqual({
			disposition: "legacy_ack_retired_noop",
		});
	});

	it("rejects a receipt from a non-owner Lead", async () => {
		const seq = appendAckEvent();
		const db = new CommDB(dbPath);
		db.insertAckReceipt("lead-2", seq, "forged");
		db.close();
		const forged = queue.claimBridgeProtocol({
			fromAgent: "lead-2",
			ownerEpoch: "epoch-1",
			now,
			claimTtlMs: 60_000,
		})!;
		const ingress = new ProtocolIngress({
			store,
			queue,
			secretProvider: { getActive: () => secret },
		});
		await expect(ingress.handle(forged)).rejects.toThrow(
			"ACK sender does not own the event",
		);
	});

	it("applies a recipient-authorized batch ACK protocol row", async () => {
		queue.enqueue({
			id: "model-1",
			fromAgent: "runner-1",
			toAgent: "lead-1",
			recipientKind: "lead",
			type: "question",
			content: "question",
			createdAt: now,
			senderRef: encodeSenderRef(),
		});
		queue.claimLeadBatchQueue({
			toAgent: "lead-1",
			msgClass: "model",
			ownerEpoch: "epoch-1",
			batchId: "batch-1",
			now,
			transportClaimTtlMs: 10_000,
			batchWindowMs: 60_000,
			batchMaxSize: 5,
			inflightMaxBatches: 3,
		});
		queue.recordLeadBatchDelivered({
			batchId: "batch-1",
			ownerEpoch: "epoch-1",
			now,
			ackLeaseTtlMs: 30_000,
		});
		queue.enqueue({
			id: "ack-batch-1",
			fromAgent: "lead-1",
			toAgent: "bridge",
			recipientKind: "bridge",
			type: "ack_batch",
			msgClass: "protocol",
			content: JSON.stringify({ batch_id: "batch-1" }),
			createdAt: now,
			senderRef: encodeSenderRef(),
		});
		const ingress = new ProtocolIngress({
			store,
			queue,
			secretProvider: { getActive: () => secret },
		});
		expect(await ingress.handle(queue.getById("ack-batch-1")!)).toEqual({
			disposition: "batch_ack_applied",
		});
		expect(queue.getById("model-1")?.state).toBe("ACKED");
	});
});
