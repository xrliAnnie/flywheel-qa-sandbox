/**
 * FLY-109 — inbox-mcp push delivery + ack state machine.
 *
 * Verifies the at-least-once semantics introduced by Direction B:
 *   1. First poll: instruction is unnotified → claim → notify → record receipt
 *   2. Subsequent polls within retry window: instruction hidden
 *   3. After retry window: re-delivered if still unacked
 *   4. After ack: hidden permanently regardless of retry window
 *   5. ack is idempotent + safe for unknown ids
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleAck,
	handleBatchAck,
	handleEventAck,
	processPendingDeliveries,
} from "../delivery.js";

describe("inbox-mcp delivery + ack state machine", () => {
	let testDir: string;
	let db: CommDB;
	const leadId = "test-lead";

	beforeEach(() => {
		testDir = join(tmpdir(), `inbox-mcp-ack-${Date.now()}-${Math.random()}`);
		mkdirSync(testDir, { recursive: true });
		db = new CommDB(join(testDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("first poll records notified_at while delivered_at stays unset until ack", async () => {
		const id = db.insertInstruction("bridge", leadId, "hello");
		const notifier = vi.fn().mockResolvedValue(undefined);

		const result = await processPendingDeliveries(db, leadId, 30, notifier);

		expect(notifier).toHaveBeenCalledOnce();
		expect(notifier.mock.calls[0]![0].id).toBe(id);
		expect(result.delivered).toContain(id);

		const row = (db as any).db
			.prepare(
				`SELECT m.notified_at, p.delivered_at, p.read_at
				 FROM mailbox m JOIN mailbox_message_projection p ON p.id = m.id
				 WHERE m.id = ?`,
			)
			.get(id) as {
			notified_at: string | null;
			delivered_at: string | null;
			read_at: string | null;
		};
		expect(row.notified_at).not.toBeNull();
		expect(row.delivered_at).toBeNull();
		expect(row.read_at).toBeNull();
	});

	it("second poll within retry window does NOT redeliver", async () => {
		db.insertInstruction("bridge", leadId, "hello");
		const notifier = vi.fn().mockResolvedValue(undefined);

		await processPendingDeliveries(db, leadId, 30, notifier);
		notifier.mockClear();

		await processPendingDeliveries(db, leadId, 30, notifier);
		expect(notifier).not.toHaveBeenCalled();
	});

	it("after retry window expires, message is redelivered", async () => {
		const id = db.insertInstruction("bridge", leadId, "stale");
		const notifier = vi.fn().mockResolvedValue(undefined);

		await processPendingDeliveries(db, leadId, 30, notifier);

		// Simulate time passing past retry window
		(db as any).db
			.prepare(
				"UPDATE mailbox SET notified_at = '1970-01-01T00:00:00.000Z' WHERE id = ?",
			)
			.run(id);

		notifier.mockClear();
		await processPendingDeliveries(db, leadId, 30, notifier);

		expect(notifier).toHaveBeenCalledOnce();
		expect(notifier.mock.calls[0]![0].id).toBe(id);
	});

	it("after ack, message is NOT redelivered even past retry window", async () => {
		const id = db.insertInstruction("bridge", leadId, "acked");
		const notifier = vi.fn().mockResolvedValue(undefined);

		await processPendingDeliveries(db, leadId, 30, notifier);
		handleAck(db, id, leadId);

		(db as any).db
			.prepare(
				"UPDATE mailbox SET notified_at = '1970-01-01T00:00:00.000Z' WHERE id = ?",
			)
			.run(id);

		notifier.mockClear();
		await processPendingDeliveries(db, leadId, 30, notifier);
		expect(notifier).not.toHaveBeenCalled();
	});

	it("ack is idempotent — double ack returns ok without changing read_at", async () => {
		const id = db.insertInstruction("bridge", leadId, "dup-ack");
		const notifier = vi.fn().mockResolvedValue(undefined);
		await processPendingDeliveries(db, leadId, 30, notifier);

		const r1 = handleAck(db, id, leadId);
		expect(r1.ok).toBe(true);

		const firstReadAt = (db as any).db
			.prepare("SELECT read_at FROM mailbox_message_projection WHERE id = ?")
			.get(id) as { read_at: string };

		const r2 = handleAck(db, id, leadId);
		expect(r2.ok).toBe(true);

		const secondReadAt = (db as any).db
			.prepare("SELECT read_at FROM mailbox_message_projection WHERE id = ?")
			.get(id) as { read_at: string };
		expect(secondReadAt.read_at).toBe(firstReadAt.read_at);
	});

	it("ack returns structured error for unknown message_id", () => {
		const result = handleAck(db, "does-not-exist", leadId);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/unknown|not found/i);
		}
	});

	it("ack cannot cross-ack another lead's message", async () => {
		const otherLead = "other-lead";
		const idForOther = db.insertInstruction("bridge", otherLead, "not mine");
		const notifier = vi.fn().mockResolvedValue(undefined);
		await processPendingDeliveries(db, otherLead, 30, notifier);

		const result = handleAck(db, idForOther, leadId);
		expect(result.ok).toBe(false);

		const row = (db as any).db
			.prepare("SELECT read_at FROM mailbox_message_projection WHERE id = ?")
			.get(idForOther) as { read_at: string | null };
		expect(row.read_at).toBeNull();
	});

	it("event ack writes a backend-neutral receipt without returning the bearer", () => {
		const result = handleEventAck(db, {
			leadId,
			eventSeq: 42,
			ackToken: "mcp-bearer-secret",
			project: "flywheel",
			expectedProject: "flywheel",
		});

		expect(result).toEqual({ ok: true, eventSeq: 42 });
		expect(JSON.stringify(result)).not.toContain("mcp-bearer-secret");
		expect(db.getPendingAckReceipts()).toMatchObject([
			{
				from_agent: leadId,
				to_agent: "bridge",
				type: "ack_receipt",
				content: JSON.stringify({
					event_seq: 42,
					ack_token: "mcp-bearer-secret",
				}),
			},
		]);
	});

	it("event ack rejects a project mismatch before writing a receipt", () => {
		const result = handleEventAck(db, {
			leadId,
			eventSeq: 42,
			ackToken: "wrong-project-bearer",
			project: "another-project",
			expectedProject: "flywheel",
		});

		expect(result).toMatchObject({ ok: false });
		expect(db.getPendingAckReceipts()).toEqual([]);
	});

	it("batch ack writes the backend-neutral protocol row for the calling Lead", () => {
		const result = handleBatchAck(db, {
			leadId,
			batchId: "mailbox-batch:durable-1",
		});

		expect(result).toEqual({ ok: true, batchId: "mailbox-batch:durable-1" });
		const row = (db as any).db
			.prepare("SELECT * FROM mailbox WHERE type = 'ack_batch'")
			.get() as Record<string, unknown>;
		expect(row).toMatchObject({
			from_agent: leadId,
			to_agent: "bridge",
			recipient_kind: "bridge",
			msg_class: "protocol",
			content: JSON.stringify({ batch_id: "mailbox-batch:durable-1" }),
		});
	});

	it("batch ack rejects an empty id without writing", () => {
		expect(handleBatchAck(db, { leadId, batchId: "  " })).toMatchObject({
			ok: false,
		});
		const count = (db as any).db
			.prepare("SELECT COUNT(*) AS count FROM mailbox WHERE type = 'ack_batch'")
			.get() as { count: number };
		expect(count.count).toBe(0);
	});

	it("delivery preserves FIFO order", async () => {
		const id1 = db.insertInstruction("bridge", leadId, "first");
		const id2 = db.insertInstruction("bridge", leadId, "second");
		const id3 = db.insertInstruction("bridge", leadId, "third");

		const seen: string[] = [];
		const notifier = vi.fn().mockImplementation(async (msg) => {
			seen.push(msg.id);
		});

		await processPendingDeliveries(db, leadId, 30, notifier);
		await processPendingDeliveries(db, leadId, 30, notifier);
		await processPendingDeliveries(db, leadId, 30, notifier);
		expect(seen).toEqual([id1, id2, id3]);
	});

	it("stops batch on notifier failure and preserves undelivered state", async () => {
		const id1 = db.insertInstruction("bridge", leadId, "ok");
		const id2 = db.insertInstruction("bridge", leadId, "fails");
		const id3 = db.insertInstruction("bridge", leadId, "after-fail");

		let callCount = 0;
		const notifier = vi.fn().mockImplementation(async () => {
			callCount++;
			if (callCount === 2) {
				throw new Error("transport broken");
			}
		});

		const firstResult = await processPendingDeliveries(
			db,
			leadId,
			30,
			notifier,
		);
		const result = await processPendingDeliveries(db, leadId, 30, notifier);

		expect(firstResult.delivered).toContain(id1);
		expect(result.failed).toContain(id2);

		// After failure, subsequent calls (still within retry window) should NOT
		// redeliver id1 but SHOULD retry id2 and the untouched id3 on the next pass
		// (since id2 was never marked delivered).
		const id1Row = (db as any).db
			.prepare("SELECT notified_at FROM mailbox WHERE id = ?")
			.get(id1) as { notified_at: string | null };
		expect(id1Row.notified_at).not.toBeNull();

		const id2Row = (db as any).db
			.prepare("SELECT notified_at FROM mailbox WHERE id = ?")
			.get(id2) as { notified_at: string | null };
		expect(id2Row.notified_at).toBeNull();

		await processPendingDeliveries(db, leadId, 30, notifier);
		await processPendingDeliveries(db, leadId, 30, notifier);
		expect(notifier.mock.calls.map(([message]) => message.id)).toEqual([
			id1,
			id2,
			id2,
			id3,
		]);
	});

	it("supports custom retry window (short)", async () => {
		const id = db.insertInstruction("bridge", leadId, "fast-retry");
		const notifier = vi.fn().mockResolvedValue(undefined);

		await processPendingDeliveries(db, leadId, 5, notifier);

		// Backdate by 6s → beyond 5s window
		(db as any).db
			.prepare(
				"UPDATE mailbox SET notified_at = '1970-01-01T00:00:00.000Z' WHERE id = ?",
			)
			.run(id);

		notifier.mockClear();
		await processPendingDeliveries(db, leadId, 5, notifier);
		expect(notifier).toHaveBeenCalledOnce();
	});
});
