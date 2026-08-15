import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB, PENDING_PUSH_INSTRUCTIONS_SQL } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processPendingDeliveries } from "../delivery.js";

const T0 = "2026-08-14T12:00:00.000Z";
const at = (seconds: number) =>
	new Date(Date.parse(T0) + seconds * 1_000).toISOString();

describe("FLY-1773 legacy push ownership", () => {
	let testDir: string;
	let db: CommDB;
	const leadId = "test-lead";

	beforeEach(() => {
		testDir = join(tmpdir(), `fly1773-push-${Date.now()}-${Math.random()}`);
		mkdirSync(testDir, { recursive: true });
		db = new CommDB(join(testDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("makes queue-enabled Flow 2 exclusive and never calls the legacy notifier", async () => {
		db.insertInstruction("bridge", leadId, "flow-2-only");
		const notifier = vi.fn().mockResolvedValue(undefined);

		expect(
			await processPendingDeliveries(db, leadId, 30, notifier, {
				queueEnabled: true,
				now: T0,
			}),
		).toEqual({ delivered: [], failed: [] });
		expect(notifier).not.toHaveBeenCalled();
	});

	it("records transport evidence without sealing recipient delivery", async () => {
		const id = db.insertInstruction("bridge", leadId, "legacy receipt");
		const notifier = vi.fn().mockResolvedValue(undefined);

		await processPendingDeliveries(db, leadId, 30, notifier, {
			queueEnabled: false,
			now: T0,
		});
		const raw = (db as any).db
			.prepare(
				"SELECT state, notified_at, delivered_at FROM mailbox WHERE id = ?",
			)
			.get(id) as Record<string, string | null>;
		expect(raw).toMatchObject({
			state: "QUEUED",
			notified_at: T0,
			delivered_at: null,
		});
		const projected = (db as any).db
			.prepare(
				"SELECT delivered_at, read_at FROM mailbox_message_projection WHERE id = ?",
			)
			.get(id) as Record<string, string | null>;
		expect(projected).toEqual({ delivered_at: null, read_at: null });
	});

	it("retries exactly once after the configured window then hides again", async () => {
		const id = db.insertInstruction("bridge", leadId, "retry me");
		const notifier = vi.fn().mockResolvedValue(undefined);

		await processPendingDeliveries(db, leadId, 5, notifier, {
			queueEnabled: false,
			now: T0,
		});
		await processPendingDeliveries(db, leadId, 5, notifier, {
			queueEnabled: false,
			now: at(4),
		});
		await processPendingDeliveries(db, leadId, 5, notifier, {
			queueEnabled: false,
			now: at(6),
		});
		await processPendingDeliveries(db, leadId, 5, notifier, {
			queueEnabled: false,
			now: at(7),
		});

		expect(notifier.mock.calls.map(([message]) => message.id)).toEqual([
			id,
			id,
		]);
		expect(
			(db as any).db
				.prepare("SELECT notified_at FROM mailbox WHERE id = ?")
				.get(id),
		).toEqual({ notified_at: at(6) });
	});

	it("recovers a process crash after claim and a crash after notify before record", async () => {
		const claimCrash = db.insertInstruction("bridge", leadId, "claim crash");
		const firstFence = db.tryClaimInstructionForPush({
			id: claimCrash,
			toAgent: leadId,
			now: T0,
			retryCutoff: at(-30),
			transportClaimTtlMs: 30_000,
		});
		expect(firstFence).toBe(at(30));
		const notifier = vi.fn().mockResolvedValue(undefined);
		await processPendingDeliveries(db, leadId, 30, notifier, {
			queueEnabled: false,
			now: at(31),
		});
		expect(notifier).toHaveBeenCalledOnce();

		const recordCrash = db.insertInstruction("bridge", leadId, "record crash");
		const secondFence = db.tryClaimInstructionForPush({
			id: recordCrash,
			toAgent: leadId,
			now: at(32),
			retryCutoff: at(2),
			transportClaimTtlMs: 30_000,
		});
		expect(secondFence).toBe(at(62));
		// The transport side effect happened, then the process died before record.
		await processPendingDeliveries(db, leadId, 30, notifier, {
			queueEnabled: false,
			now: at(63),
		});
		expect(notifier).toHaveBeenCalledTimes(2);
	});

	it("fences overlapping polls and preserves FIFO until the head settles", async () => {
		const first = db.insertInstruction("bridge", leadId, "first");
		const second = db.insertInstruction("bridge", leadId, "second");
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const notifier = vi.fn().mockImplementation(async () => pending);

		const firstPoll = processPendingDeliveries(db, leadId, 30, notifier, {
			queueEnabled: false,
			now: T0,
		});
		await vi.waitFor(() => expect(notifier).toHaveBeenCalledOnce());
		await processPendingDeliveries(db, leadId, 30, notifier, {
			queueEnabled: false,
			now: at(1),
		});
		expect(notifier.mock.calls.map(([message]) => message.id)).toEqual([first]);
		release();
		await firstPoll;

		await processPendingDeliveries(db, leadId, 30, notifier, {
			queueEnabled: false,
			now: at(2),
		});
		expect(notifier.mock.calls.map(([message]) => message.id)).toEqual([
			first,
			second,
		]);
	});

	it("rejects stale attempt success and failure after a newer attempt owns the row", () => {
		const id = db.insertInstruction("bridge", leadId, "attempt fence");
		const attemptA = db.tryClaimInstructionForPush({
			id,
			toAgent: leadId,
			now: T0,
			retryCutoff: at(-30),
			transportClaimTtlMs: 30_000,
		});
		const attemptB = db.tryClaimInstructionForPush({
			id,
			toAgent: leadId,
			now: at(31),
			retryCutoff: at(1),
			transportClaimTtlMs: 30_000,
		});
		expect(attemptA).toBe(at(30));
		expect(attemptB).toBe(at(61));
		expect(db.recordInstructionNotified(id, attemptA!, at(31))).toBe(false);
		expect(db.releaseInstructionPushClaim(id, attemptA!)).toBe(false);
		expect(
			(db as any).db
				.prepare("SELECT claim_expires_at FROM mailbox WHERE id = ?")
				.get(id),
		).toEqual({
			claim_expires_at: attemptB,
		});
	});

	it("loses the legacy CAS if Flow 2 batch-claims the selected row", async () => {
		const id = db.insertInstruction("bridge", leadId, "batch owns me");
		const candidates = db.getPendingPushInstructions(leadId, at(-30), T0);
		expect(candidates.map((message) => message.id)).toEqual([id]);
		const queue = new MailboxQueue((db as any).db);
		queue.acquireOrRenewOwner({
			ownerEpoch: "batch-owner",
			now: T0,
			leaseTtlMs: 60_000,
		});
		queue.claimLeadBatchQueue({
			toAgent: leadId,
			msgClass: "model",
			ownerEpoch: "batch-owner",
			batchId: "batch-wins",
			now: T0,
			transportClaimTtlMs: 30_000,
			batchWindowMs: 30_000,
			batchMaxSize: 10,
			inflightMaxBatches: 3,
		});

		expect(
			db.tryClaimInstructionForPush({
				id,
				toAgent: leadId,
				now: T0,
				retryCutoff: at(-30),
				transportClaimTtlMs: 30_000,
			}),
		).toBeNull();
	});

	it("uses seq as SELECT/CAS authority and rejects a receipt refreshed after SELECT", () => {
		const first = db.insertInstruction("bridge", leadId, "first by seq");
		const second = db.insertInstruction("bridge", leadId, "second by seq");
		(db as any).db
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run(at(20), first);
		(db as any).db
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run(at(10), second);

		expect(
			db.getPendingPushInstructions(leadId, at(-30), T0).map(({ id }) => id),
		).toEqual([first]);
		(db as any).db
			.prepare("UPDATE mailbox SET notified_at = ? WHERE id = ?")
			.run(T0, first);
		expect(
			db.tryClaimInstructionForPush({
				id: first,
				toAgent: leadId,
				now: at(1),
				retryCutoff: at(-29),
				transportClaimTtlMs: 30_000,
			}),
		).toBeNull();
	});

	it("keeps the FIFO predecessor fence on the mailbox_live index", () => {
		const plan = (db as any).db
			.prepare(`EXPLAIN QUERY PLAN ${PENDING_PUSH_INSTRUCTIONS_SQL}`)
			.all(leadId, T0, at(-30), T0, T0, T0, T0, at(-30)) as Array<{
			detail: string;
		}>;
		expect(plan.map(({ detail }) => detail).join("\n")).toContain(
			"USING INDEX mailbox_live",
		);
	});
});
