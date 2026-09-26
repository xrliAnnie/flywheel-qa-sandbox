/**
 * FLY-109 — inbox-mcp push delivery + ack state machine.
 *
 * Verifies the at-least-once semantics introduced by Direction B:
 *   1. First poll: instruction is undelivered → notify → markDelivered
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
import { handleAck, processPendingDeliveries } from "../delivery.js";

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

	it("first poll delivers message and marks delivered_at (not read_at)", async () => {
		const id = db.insertInstruction("bridge", leadId, "hello");
		const notifier = vi.fn().mockResolvedValue(undefined);

		const result = await processPendingDeliveries(db, leadId, 30, notifier);

		expect(notifier).toHaveBeenCalledOnce();
		expect(notifier.mock.calls[0]![0].id).toBe(id);
		expect(result.delivered).toContain(id);

		const row = (db as any).db
			.prepare("SELECT delivered_at, read_at FROM messages WHERE id = ?")
			.get(id) as { delivered_at: string | null; read_at: string | null };
		expect(row.delivered_at).not.toBeNull();
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
				"UPDATE messages SET delivered_at = datetime('now', '-60 seconds') WHERE id = ?",
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
				"UPDATE messages SET delivered_at = datetime('now', '-600 seconds') WHERE id = ?",
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
			.prepare("SELECT read_at FROM messages WHERE id = ?")
			.get(id) as { read_at: string };

		const r2 = handleAck(db, id, leadId);
		expect(r2.ok).toBe(true);

		const secondReadAt = (db as any).db
			.prepare("SELECT read_at FROM messages WHERE id = ?")
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
			.prepare("SELECT read_at FROM messages WHERE id = ?")
			.get(idForOther) as { read_at: string | null };
		expect(row.read_at).toBeNull();
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
		expect(seen).toEqual([id1, id2, id3]);
	});

	it("stops batch on notifier failure and preserves undelivered state", async () => {
		const id1 = db.insertInstruction("bridge", leadId, "ok");
		const id2 = db.insertInstruction("bridge", leadId, "fails");
		db.insertInstruction("bridge", leadId, "after-fail");

		let callCount = 0;
		const notifier = vi.fn().mockImplementation(async () => {
			callCount++;
			if (callCount === 2) {
				throw new Error("transport broken");
			}
		});

		const result = await processPendingDeliveries(db, leadId, 30, notifier);

		expect(result.delivered).toContain(id1);
		expect(result.failed).toContain(id2);

		// After failure, subsequent calls (still within retry window) should NOT
		// redeliver id1 but SHOULD retry id2 and the untouched id3 on the next pass
		// (since id2 was never marked delivered).
		const id1Row = (db as any).db
			.prepare("SELECT delivered_at FROM messages WHERE id = ?")
			.get(id1) as { delivered_at: string | null };
		expect(id1Row.delivered_at).not.toBeNull();

		const id2Row = (db as any).db
			.prepare("SELECT delivered_at FROM messages WHERE id = ?")
			.get(id2) as { delivered_at: string | null };
		expect(id2Row.delivered_at).toBeNull();
	});

	it("supports custom retry window (short)", async () => {
		const id = db.insertInstruction("bridge", leadId, "fast-retry");
		const notifier = vi.fn().mockResolvedValue(undefined);

		await processPendingDeliveries(db, leadId, 5, notifier);

		// Backdate by 6s → beyond 5s window
		(db as any).db
			.prepare(
				"UPDATE messages SET delivered_at = datetime('now', '-6 seconds') WHERE id = ?",
			)
			.run(id);

		notifier.mockClear();
		await processPendingDeliveries(db, leadId, 5, notifier);
		expect(notifier).toHaveBeenCalledOnce();
	});
});
