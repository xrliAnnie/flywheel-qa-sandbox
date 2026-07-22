import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import {
	DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
	LeadInboxQueue,
} from "../lead-inbox-queue.js";

const T0 = "2026-07-21T12:00:00.000Z";
const T1 = "2026-07-21T12:01:00.000Z";

describe("FLY-1392 v2 capability harness", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-v2-capability-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		expect(
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-capability",
				now: T0,
				leaseTtlMs: 24 * 60 * 60_000,
			}),
		).toBe(true);
	});

	afterEach(() => {
		queue.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		["founder", "founder_reply", "founder_reply", 0],
		["runner question", "question:q-1", "runner_question", 1],
		["report", "report:r-1", "session_report", 2],
		["progress telemetry", "progress:p-1", "progress", 3],
	] as const)(
		"records, delivers, and handles the %s lane without a category rule",
		(_label, source, type, priority) => {
			const receiptId = `capability-${priority}`;
			queue.enqueue({
				id: receiptId,
				toLead: "lead-a",
				source,
				type,
				msgClass: "model",
				priority,
				content: `payload ${type}`,
				createdAt: T0,
			});
			const claimed = queue.claimModelBatch({
				toLead: "lead-a",
				ownerEpoch: "epoch-capability",
				batchId: `batch-${priority}`,
				now: T0,
				claimTtlMs: 60_000,
			});
			expect(claimed.map(({ id }) => id)).toEqual([receiptId]);
			expect(
				queue.markConsumed([receiptId], {
					ownerEpoch: "epoch-capability",
					disposition: "delivered",
					now: T0,
					receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
				}),
			).toBe(1);
			expect(queue.getById(receiptId)).toMatchObject({
				delivered_at: T0,
				processed_at: null,
				disposed_at: null,
			});

			expect(
				db.handleReceipt({
					requestId: `ack-${priority}`,
					receiptId,
					authenticatedLead: "lead-a",
					action: "ack",
					reason: "handled in capability harness",
					now: T1,
					provenance: {
						senderLeaseKey: "lead-lease-a",
						senderGeneration: 17,
					},
				}),
			).toMatchObject({
				kind: "handled",
				receiptId,
				action: "ack",
			});
			expect(queue.getById(receiptId)).toMatchObject({
				processed_at: T1,
				disposed_at: null,
				next_unprocessed_at: null,
			});
		},
	);

	it("chases an unknown future category and persists capacity dry-run evidence", () => {
		queue.enqueue({
			id: "future-category",
			toLead: "lead-a",
			source: "future:widget-1",
			type: "future_widget_v99",
			msgClass: "model",
			content: "a category that did not exist when the receipt code shipped",
			createdAt: T0,
		});
		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-capability",
			batchId: "batch-future",
			now: T0,
			claimTtlMs: 60_000,
		});
		queue.markConsumed(
			claimed.map(({ id }) => id),
			{
				ownerEpoch: "epoch-capability",
				disposition: "delivered",
				now: T0,
				receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
			},
		);

		const dryRun = db.reconcileReceiptActivation({
			enabled: true,
			dryRun: true,
			now: T1,
			receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
			highWaterMark: "1485740000000000000",
		});
		expect(dryRun).toMatchObject({
			status: "dry_run",
			dryRunCounts: {
				eligible: 1,
				pending: 1,
				byPriority: { 0: 0, 1: 0, 2: 1, 3: 0 },
				estimated: { t1: 1, t2: 1, t3: 1, outboxPeak: 1 },
			},
		});

		const raw = new Database(dbPath, { readonly: true });
		try {
			const persisted = raw
				.prepare(
					"SELECT dry_run_counts FROM receipt_activation_episodes WHERE episode_id = ?",
				)
				.get(dryRun.episodeId) as { dry_run_counts: string };
			expect(JSON.parse(persisted.dry_run_counts)).toEqual(dryRun.dryRunCounts);
		} finally {
			raw.close();
		}

		db.reconcileReceiptActivation({
			enabled: true,
			now: T1,
			receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
			highWaterMark: "1485740000000000000",
		});
		const due = new Date(
			Date.parse(T1) + DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS[2] + 1,
		).toISOString();
		expect(
			db.advanceDueUnprocessedReceipts({
				now: due,
				windowMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS[2],
				resendCap: 2,
			}),
		).toEqual([
			expect.objectContaining({
				kind: "resent",
				rootId: "future-category",
				round: 1,
			}),
		]);
	});
});
