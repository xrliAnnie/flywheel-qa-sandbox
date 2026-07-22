import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadReceiptPatrol } from "../bridge/lead-receipt-patrol.js";

const T0 = Date.parse("2026-07-20T12:00:00.000Z");
const WINDOW_MS = 30 * 60_000;

describe("LeadReceiptPatrol", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-lead-patrol-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-a",
			now: new Date(T0).toISOString(),
			leaseTtlMs: 24 * 60 * 60_000,
		});
	});

	afterEach(() => {
		queue.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seedDeliveredQuestion(): void {
		db.reconcileReceiptActivation({
			enabled: true,
			now: new Date(T0).toISOString(),
			receiptWindowsMs: [WINDOW_MS, WINDOW_MS, WINDOW_MS, WINDOW_MS],
			highWaterMark: String(T0),
		});
		db.registerSession("exec-1", "FLY-1:@0", "flywheel", "issue-1", "lead-a");
		const questionId = db.insertQuestion("exec-1", "lead-a", "please decide");
		queue.enqueue({
			id: "question-row",
			toLead: "lead-a",
			source: "question:1",
			type: "runner_question",
			msgClass: "model",
			priority: 1,
			content: "please decide",
			refMessageId: questionId,
			createdAt: new Date(T0).toISOString(),
		});
		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-a",
			batchId: "batch-a",
			now: new Date(T0).toISOString(),
			claimTtlMs: 60_000,
		});
		queue.markConsumed(
			claimed.map(({ id }) => id),
			{
				ownerEpoch: "epoch-a",
				disposition: "delivered",
				now: new Date(T0).toISOString(),
				receiptWindowMs: WINDOW_MS,
			},
		);
	}

	function deliverReminder(nowMs: number, batchId: string): void {
		const now = new Date(nowMs).toISOString();
		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-a",
			batchId,
			now,
			claimTtlMs: 60_000,
		});
		expect(claimed).toHaveLength(1);
		expect(
			queue.markConsumed(
				claimed.map(({ id }) => id),
				{
					ownerEpoch: "epoch-a",
					disposition: "delivered",
					now,
					receiptWindowsMs: [WINDOW_MS, WINDOW_MS, WINDOW_MS, WINDOW_MS],
				},
			),
		).toBe(1);
	}

	it("runs root-owned resend rounds and marks escalation only after durable Lead notification", async () => {
		seedDeliveredQuestion();
		let nowMs = T0 + WINDOW_MS;
		const notifyUnprocessed = vi.fn(async () => true);
		const patrol = new LeadReceiptPatrol({
			projectNames: ["flywheel"],
			commDbPathForProject: () => dbPath,
			receiptFoundationEnabled: () => true,
			ownerEpoch: () => "epoch-a",
			now: () => nowMs,
			windowMs: WINDOW_MS,
			resendCap: 2,
			notifyUnprocessed,
			notifyAdvisory: vi.fn(async () => true),
		});

		await patrol.pass();
		const episodeId = queue.getById("question-row")?.receipt_episode_id;
		expect(queue.getById(`question-row#r1@${episodeId}`)).toBeDefined();
		deliverReminder(nowMs, "reminder-r1");
		nowMs += WINDOW_MS;
		await patrol.pass();
		expect(queue.getById(`question-row#r2@${episodeId}`)).toBeDefined();
		deliverReminder(nowMs, "reminder-r2");
		nowMs += WINDOW_MS;
		await patrol.pass();

		expect(notifyUnprocessed).toHaveBeenCalledTimes(1);
		expect(notifyUnprocessed).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "flywheel",
				payload: expect.objectContaining({
					rootId: "question-row",
					targetKey: "flywheel:lead-a",
					type: "runner_question",
					resendRound: 2,
				}),
			}),
		);
		expect(
			db.getReceiptAlertOutbox(`unprocessed:question-row@${episodeId}`),
		).toMatchObject({ delivered_at: new Date(nowMs).toISOString() });
		expect(queue.getById("question-row")?.escalated_at).toBe(
			new Date(nowMs).toISOString(),
		);
	});

	it("keeps the outbox retryable when Lead notification is not durably acknowledged", async () => {
		seedDeliveredQuestion();
		let nowMs = T0 + WINDOW_MS;
		const notifyUnprocessed = vi.fn(async () => false);
		const patrol = new LeadReceiptPatrol({
			projectNames: ["flywheel"],
			commDbPathForProject: () => dbPath,
			receiptFoundationEnabled: () => true,
			ownerEpoch: () => "epoch-a",
			now: () => nowMs,
			windowMs: WINDOW_MS,
			resendCap: 2,
			notifyUnprocessed,
			notifyAdvisory: vi.fn(async () => true),
		});

		await patrol.pass();
		deliverReminder(nowMs, "retry-r1");
		nowMs += WINDOW_MS;
		await patrol.pass();
		deliverReminder(nowMs, "retry-r2");
		nowMs += WINDOW_MS;
		await patrol.pass();
		const episodeId = queue.getById("question-row")?.receipt_episode_id;
		expect(
			db.getReceiptAlertOutbox(`unprocessed:question-row@${episodeId}`),
		).toMatchObject({
			delivered_at: null,
		});
		expect(queue.getById("question-row")?.escalated_at).toBeNull();
		await patrol.pass();
		expect(notifyUnprocessed).toHaveBeenCalledTimes(2);
	});

	it("pauses chase while durably recording the disabled episode", async () => {
		const openDb = vi.fn(() => new CommDB(dbPath, false));
		await new LeadReceiptPatrol({
			projectNames: ["flywheel"],
			commDbPathForProject: () => dbPath,
			receiptFoundationEnabled: () => false,
			ownerEpoch: () => "epoch-a",
			windowMs: WINDOW_MS,
			resendCap: 2,
			notifyUnprocessed: vi.fn(async () => true),
			notifyAdvisory: vi.fn(async () => true),
			openDb,
		}).pass();
		expect(openDb).toHaveBeenCalledTimes(1);
		const raw = new Database(dbPath, { readonly: true });
		try {
			expect(
				raw
					.prepare(
						"SELECT status FROM receipt_activation_episodes ORDER BY rowid DESC LIMIT 1",
					)
					.get(),
			).toEqual({ status: "disabled" });
		} finally {
			raw.close();
		}
	});
});
