import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	type DeliverySecret,
	deriveLeadEventAckToken,
} from "../lead-event-delivery.js";
import { ProtocolIngress } from "../protocol-ingress.js";

describe("FLY-1373 ProtocolIngress", () => {
	let dir: string;
	let dbPath: string;
	let store: StateStore;
	let queue: LeadInboxQueue;
	const secret: DeliverySecret = {
		secretId: "secret-1",
		key: Buffer.from("01234567890123456789012345678901"),
	};
	const now = "2026-07-19T20:00:00.000Z";

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1373-protocol-"));
		dbPath = join(dir, "comm.db");
		store = await StateStore.create(":memory:");
		queue = new LeadInboxQueue(dbPath);
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

	it("materializes, verifies, applies, then allows the loop to consume a receipt", async () => {
		const seq = appendAckEvent();
		const row = store.getLeadEventBySeq(seq)!;
		const token = deriveLeadEventAckToken(secret, {
			eventSeq: seq,
			ackOwnerLeadId: row.ack_owner_lead_id!,
			ownerEpoch: row.ack_owner_epoch!,
		});
		const db = new CommDB(dbPath);
		const receiptId = db.insertAckReceipt("lead-1", seq, token);
		db.close();

		const ingress = new ProtocolIngress({
			queue,
			dbPath,
			store,
			secretProvider: { getActive: () => secret },
		});
		expect(ingress.materializePending("lead-1")).toBe(1);
		const protocol = queue.claimProtocol({
			toLead: "lead-1",
			ownerEpoch: "epoch-1",
			now,
			claimTtlMs: 60_000,
		})!;
		expect(protocol.id).toBe(`ack:lead-1:${receiptId}`);
		expect(await ingress.handle(protocol)).toEqual({
			disposition: "legacy_ack_applied",
		});
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeTruthy();
		const verifyDb = new CommDB(dbPath);
		try {
			expect(verifyDb.getPendingAckReceipts()).toEqual([]);
		} finally {
			verifyDb.close();
		}
	});

	it("consumes a late receipt as an idempotent no-op after cutover retirement", async () => {
		const seq = appendAckEvent();
		store.retireOpenLeadEventAcks(now, "fly1373_cutover");
		const db = new CommDB(dbPath);
		db.insertAckReceipt("lead-1", seq, "late-token");
		db.close();
		const ingress = new ProtocolIngress({
			queue,
			dbPath,
			store,
			secretProvider: { getActive: () => secret },
		});
		ingress.materializePending("lead-1");
		const protocol = queue.claimProtocol({
			toLead: "lead-1",
			ownerEpoch: "epoch-1",
			now,
			claimTtlMs: 60_000,
		})!;
		expect(await ingress.handle(protocol)).toEqual({
			disposition: "legacy_ack_retired_noop",
		});
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeUndefined();
	});

	it("rejects an ACK sent by a different Lead", async () => {
		const seq = appendAckEvent();
		const db = new CommDB(dbPath);
		db.insertAckReceipt("lead-2", seq, "forged");
		db.close();
		const ingress = new ProtocolIngress({
			queue,
			dbPath,
			store,
			secretProvider: { getActive: () => secret },
		});
		ingress.materializePending("lead-1");
		const protocol = queue.claimProtocol({
			toLead: "lead-1",
			ownerEpoch: "epoch-1",
			now,
			claimTtlMs: 60_000,
		})!;
		await expect(ingress.handle(protocol)).rejects.toThrow(
			"ACK sender does not own the event",
		);
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeUndefined();
	});
});
