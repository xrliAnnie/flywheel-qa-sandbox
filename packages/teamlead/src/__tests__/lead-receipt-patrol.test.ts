import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LeadReceiptPatrol,
	normalizeUnprocessedReceiptAlertProject,
} from "../bridge/lead-receipt-patrol.js";

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

	it("repairs only an unknown receipt payload project from patrol authority", () => {
		const unknown = {
			rootId: "chat:lead-a:1001",
			episodeId: "episode-1",
			targetKey: "unknown:lead-a",
			toLead: "lead-a",
			type: "external_delivery",
			projectName: "unknown",
			issueId: "unknown",
			executionId: "lead-a:receipt",
			firstDeliveredAt: new Date(T0).toISOString(),
			resendRound: 2,
			contentSummary: "founder task",
		};
		expect(
			normalizeUnprocessedReceiptAlertProject(unknown, "flywheel"),
		).toMatchObject({
			projectName: "flywheel",
			targetKey: "flywheel:lead-a",
		});
		expect(
			normalizeUnprocessedReceiptAlertProject(
				{ ...unknown, projectName: "geoforge", targetKey: "geoforge:lead-a" },
				"flywheel",
			),
		).toMatchObject({
			projectName: "geoforge",
			targetKey: "geoforge:lead-a",
		});
		expect(
			normalizeUnprocessedReceiptAlertProject(unknown, "unknown"),
		).toBeNull();
	});

	it("quarantines stale chat pending rows fairly per Lead across bounded passes", async () => {
		const createdAt = new Date(T0 - 2 * 60 * 60_000).toISOString();
		for (let i = 1; i <= 5; i++) {
			queue.enqueue({
				id: `chat:lead-a:${1000 + i}`,
				toLead: "lead-a",
				source: "discord_chat",
				type: "external_delivery",
				msgClass: "model",
				priority: 1,
				content: `lead-a-${i}`,
				createdAt,
				carrier: "external",
			});
		}
		queue.enqueue({
			id: "chat:lead-b:2001",
			toLead: "lead-b",
			source: "discord_chat",
			type: "external_delivery",
			msgClass: "model",
			priority: 1,
			content: "lead-b-1",
			createdAt,
			carrier: "external",
		});
		const notifyAdvisory = vi.fn(async () => true);
		const patrol = new LeadReceiptPatrol({
			projectNames: ["flywheel"],
			leadIdsForProject: () => ["lead-a", "lead-b"],
			commDbPathForProject: () => dbPath,
			receiptFoundationEnabled: () => true,
			ownerEpoch: () => "epoch-a",
			now: () => T0,
			windowMs: WINDOW_MS,
			resendCap: 2,
			chatPendingQuarantineAfterMs: 60 * 60_000,
			chatPendingQuarantineLimitPerLead: 2,
			notifyUnprocessed: vi.fn(async () => true),
			notifyAdvisory,
		});

		await patrol.pass();
		expect(queue.getById("chat:lead-a:1001")?.disposition).toBe(
			"delivery_quarantined",
		);
		expect(queue.getById("chat:lead-a:1002")?.disposition).toBe(
			"delivery_quarantined",
		);
		expect(queue.getById("chat:lead-a:1003")?.disposition).toBeNull();
		// lead-a's backlog cannot consume lead-b's independent share.
		expect(queue.getById("chat:lead-b:2001")?.disposition).toBe(
			"delivery_quarantined",
		);

		await patrol.pass();
		expect(queue.getById("chat:lead-a:1003")?.disposition).toBe(
			"delivery_quarantined",
		);
		expect(queue.getById("chat:lead-a:1004")?.disposition).toBe(
			"delivery_quarantined",
		);
		expect(queue.getById("chat:lead-a:1005")?.disposition).toBeNull();

		await patrol.pass();
		expect(queue.getById("chat:lead-a:1005")?.disposition).toBe(
			"delivery_quarantined",
		);
		expect(notifyAdvisory).toHaveBeenCalledTimes(6);
	});
});
