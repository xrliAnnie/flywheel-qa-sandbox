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
import {
	canonicalLeadEventDeliveryId,
	enqueueLeadEvent,
} from "../lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "../legacy-lead-event-reconciler.js";
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
	function summaryBatch(
		overrides: {
			fromAgent?: string;
			sourceKind?: string;
			sourceRef?: string;
			type?: string;
			leadId?: string;
		} = {},
	) {
		const seq = store.appendLeadEvent(
			overrides.leadId ?? "lead-1",
			"round-1",
			"summary_absorption_round",
			JSON.stringify({
				event_type: "summary_absorption_round",
				project_name: "flywheel",
			}),
		);
		const event = store.getLeadEventBySeq(seq)!;
		const envelope = {
			...leadEventEnvelopeFromJournalRow(event),
			timestamp: now,
		};
		const deliveryId = canonicalLeadEventDeliveryId(envelope);
		if (!Object.keys(overrides).length)
			enqueueLeadEvent({
				queue,
				envelope,
				content: "review summary",
			});
		if (Object.keys(overrides).length) {
			// Separate malformed source row, claimed by the real recipient.
			queue.enqueue({
				id: deliveryId,
				fromAgent: overrides.fromAgent ?? "bridge",
				toAgent: "lead-1",
				recipientKind: "lead",
				type: overrides.type ?? "summary_absorption_round",
				sourceKind: overrides.sourceKind ?? "lead_event",
				sourceRef: overrides.sourceRef ?? String(seq),
				content: "not authoritative",
				createdAt: now,
				senderRef: encodeSenderRef(),
			});
		}
		queue.claimLeadBatchQueue({
			toAgent: "lead-1",
			msgClass: "model",
			ownerEpoch: "epoch-1",
			batchId: "summary-batch",
			now,
			transportClaimTtlMs: 10_000,
			batchWindowMs: 60_000,
			batchMaxSize: 5,
			inflightMaxBatches: 3,
		});
		const db = new CommDB(dbPath);
		const receiptId = db.insertBatchAckReceipt("lead-1", "summary-batch");
		db.close();
		return { seq, deliveryId, receipt: queue.getById(receiptId)! };
	}

	it("writes a processed absorption round receipt and replays after a cross-store failure", async () => {
		const { seq, deliveryId, receipt } = summaryBatch();
		const ingress = new ProtocolIngress({
			store,
			queue,
			secretProvider: { getActive: () => secret },
		});
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeUndefined();
		// A restart between the two stores must repair the journal on receipt replay.
		queue.ackBatchByRecipient({
			batchId: "summary-batch",
			fromAgent: "lead-1",
			now,
		});
		expect(queue.getById(deliveryId)?.state).toBe("ACKED");
		await ingress.handle(receipt);
		const ackedAt = store.getLeadEventBySeq(seq)?.acked_at;
		expect(ackedAt).toBeTruthy();
		await ingress.handle(receipt);
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBe(ackedAt);
	});

	it("keeps an expiry-settled receipt claimable for the journal mirror after restart", async () => {
		const { seq, deliveryId, receipt } = summaryBatch();
		const later = "2026-08-05T20:00:11.000Z";
		queue.reconcileExpiredLeases({
			ownerEpoch: "epoch-1",
			now: later,
			recipientKind: "lead",
			toAgent: "lead-1",
			leaseRetryMax: 3,
			recipientState: () => "alive",
			maxBatches: 10,
			maxTerminalRows: 0,
		});
		expect(queue.getById(deliveryId)?.state).toBe("ACKED");
		expect(queue.getById(receipt.id)?.state).toBe("QUEUED");
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeUndefined();
		queue.close();
		queue = new MailboxQueue(dbPath);
		const pending = queue.claimBridgeProtocol({
			fromAgent: "lead-1",
			ownerEpoch: "epoch-1",
			now: later,
			claimTtlMs: 60_000,
		});
		expect(pending?.id).toBe(receipt.id);
		const ingress = new ProtocolIngress({
			store,
			queue,
			secretProvider: { getActive: () => secret },
		});
		await ingress.handle(pending!);
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBe(later);
		expect(queue.ack(receipt.id, later)).toBe(true);
		expect(queue.getById(receipt.id)?.state).toBe("ACKED");
	});

	it("writes the journal only after the recipient batch ACK", async () => {
		const { seq, receipt } = summaryBatch();
		const ingress = new ProtocolIngress({
			store,
			queue,
			secretProvider: { getActive: () => secret },
		});
		await expect(
			ingress.handle({ ...receipt, from_agent: "other-lead" }),
		).rejects.toThrow("recipient mismatch");
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeUndefined();
		expect(await ingress.handle(receipt)).toEqual({
			disposition: "batch_ack_applied",
		});
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeTruthy();
	});

	it.each([
		{ fromAgent: "runner-1" },
		{ sourceKind: "question" },
		{ sourceRef: "1e0" },
		{ type: "ordinary" },
		{ leadId: "other-lead" },
	])(
		"does not ACK an event via an unrelated or forged source row: %j",
		async (override) => {
			const { seq, receipt } = summaryBatch(override);
			const ingress = new ProtocolIngress({
				store,
				queue,
				secretProvider: { getActive: () => secret },
			});
			await ingress.handle(receipt);
			expect(store.getLeadEventBySeq(seq)?.acked_at).toBeUndefined();
		},
	);
});
