import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { founderMessageRootId } from "../founder-reply-routing.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

const T0 = "2026-07-20T12:00:00.000Z";
const T1 = "2026-07-20T12:30:00.000Z";
const T2 = "2026-07-20T13:00:00.000Z";
const T3 = "2026-07-20T13:30:00.000Z";
const WINDOW_MS = 30 * 60_000;
const PRIORITY_WINDOWS_MS = [
	30 * 60_000,
	30 * 60_000,
	240 * 60_000,
	24 * 60 * 60_000,
] as const;

describe("FLY-1392 unprocessed receipt state machine", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-unprocessed-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		expect(
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
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

	function admitQuestion(input: {
		id: string;
		checkpoint?: string;
		kind?: "report";
		type?: "gate_question" | "runner_question";
	}): string {
		db.registerSession(
			`exec-${input.id}`,
			`FLY-${input.id}:@0`,
			"flywheel",
			"issue-1",
			"lead-a",
		);
		const questionId = db.insertQuestion(
			`exec-${input.id}`,
			"lead-a",
			`question ${input.id}`,
			{
				...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
				...(input.kind ? { kind: input.kind } : {}),
			},
		);
		queue.enqueue({
			id: input.id,
			toLead: "lead-a",
			source: `question:${input.id}`,
			type: input.type ?? "runner_question",
			msgClass: "model",
			priority: 1,
			content: `question ${input.id}`,
			refMessageId: questionId,
			createdAt: T0,
		});
		return questionId;
	}

	function deliverAll(receiptWindowMs?: number): void {
		const rows = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: "batch-1",
			now: T0,
			claimTtlMs: 60_000,
		});
		expect(rows.length).toBeGreaterThan(0);
		expect(
			queue.markConsumed(
				rows.map(({ id }) => id),
				{
					ownerEpoch: "epoch-1",
					disposition: "delivered",
					now: T0,
					...(receiptWindowMs !== undefined ? { receiptWindowMs } : {}),
				},
			),
		).toBe(rows.length);
		if (receiptWindowMs !== undefined) {
			db.reconcileReceiptActivation({
				enabled: true,
				now: T0,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
				highWaterMark: String(Date.parse(T0)),
			});
		}
	}

	function deliverPendingAt(now: string, batchId: string): string[] {
		const rows = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId,
			now,
			claimTtlMs: 60_000,
		});
		expect(
			queue.markConsumed(
				rows.map(({ id }) => id),
				{
					ownerEpoch: "epoch-1",
					disposition: "delivered",
					now,
					receiptWindowsMs: PRIORITY_WINDOWS_MS,
				},
			),
		).toBe(rows.length);
		return rows.map(({ id }) => id);
	}

	it("uses restart-durable activation episodes and generation-scoped resend ids", () => {
		admitQuestion({ id: "episode-root" });
		deliverAll();

		const first = db.reconcileReceiptActivation({
			enabled: true,
			now: T1,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: String(Date.parse(T1)),
		});
		expect(first).toMatchObject({
			status: "active",
			activatedAt: T1,
			initialized: 1,
		});
		expect(queue.getById("episode-root")).toMatchObject({
			receipt_episode_id: first.episodeId,
			next_unprocessed_at: T2,
			delivered_rounds: 0,
		});

		const [resent] = db.advanceDueUnprocessedReceipts({
			now: T2,
			windowMs: WINDOW_MS,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			resendCap: 2,
		});
		expect(resent).toEqual({
			kind: "resent",
			rootId: "episode-root",
			round: 1,
			resendId: `episode-root#r1@${first.episodeId}`,
		});
		expect(queue.getById("episode-root")).toMatchObject({
			delivered_rounds: 0,
			next_unprocessed_at: null,
		});

		const childId = `episode-root#r1@${first.episodeId}`;
		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: "resend-batch",
			now: T2,
			claimTtlMs: 60_000,
		});
		expect(claimed.map(({ id }) => id)).toEqual([childId]);
		expect(
			queue.markConsumed([childId], {
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T2,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
			}),
		).toBe(1);
		expect(queue.getById("episode-root")).toMatchObject({
			delivered_rounds: 1,
			next_unprocessed_at: T3,
		});
		expect(
			queue.markConsumed([childId], {
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T2,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
			}),
		).toBe(0);
		expect(queue.getById("episode-root")?.delivered_rounds).toBe(1);

		expect(
			db.reconcileReceiptActivation({
				enabled: false,
				now: "2026-07-20T13:00:01.000Z",
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
				highWaterMark: String(Date.parse("2026-07-20T13:00:01.000Z")),
			}),
		).toMatchObject({ status: "disabled" });
		const second = db.reconcileReceiptActivation({
			enabled: true,
			now: T3,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: String(Date.parse(T3)),
		});
		expect(second.episodeId).not.toBe(first.episodeId);
		expect(queue.getById("episode-root")).toMatchObject({
			receipt_episode_id: second.episodeId,
			next_unprocessed_at: "2026-07-20T14:00:00.000Z",
			delivered_rounds: 1,
		});
	});

	it("keeps resend child accounting atomic across all three R6 crash seams", () => {
		admitQuestion({ id: "crash-root" });
		deliverAll();
		const activation = db.reconcileReceiptActivation({
			enabled: true,
			now: T1,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: String(Date.parse(T1)),
		});
		db.advanceDueUnprocessedReceipts({
			now: T2,
			windowMs: WINDOW_MS,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			resendCap: 2,
		});
		const childId = `crash-root#r1@${activation.episodeId}`;
		queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: "crash-batch",
			now: T2,
			claimTtlMs: 60_000,
		});

		// Adapter durable receipt exists, process dies before the comm.db child CAS.
		expect(() =>
			queue.markConsumed([childId], {
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T2,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
				testCrashAfter: "before_child_cas",
			}),
		).toThrow(/before child CAS/);
		expect(queue.getById(childId)?.consumed_at).toBeNull();
		expect(queue.getById("crash-root")).toMatchObject({
			delivered_rounds: 0,
			next_unprocessed_at: null,
		});

		// Child-id ledger/root CAS ran, but the full next window did not commit.
		expect(() =>
			queue.markConsumed([childId], {
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T2,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
				testCrashAfter: "round_recorded",
			}),
		).toThrow(/round accounting/);
		expect(queue.getById(childId)?.consumed_at).toBeNull();
		expect(queue.getById("crash-root")?.delivered_rounds).toBe(0);

		// Full commit: exactly one child ledger row, one round, one complete window.
		expect(
			queue.markConsumed([childId], {
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T2,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
			}),
		).toBe(1);
		expect(queue.getById("crash-root")).toMatchObject({
			delivered_rounds: 1,
			next_unprocessed_at: T3,
		});
		const raw = new Database(dbPath, { readonly: true });
		try {
			expect(
				(
					raw
						.prepare(
							"SELECT COUNT(*) count FROM receipt_resend_deliveries WHERE child_id = ?",
						)
						.get(childId) as { count: number }
				).count,
			).toBe(1);
		} finally {
			raw.close();
		}
	});

	it("migrates legacy reminder fixtures from durable delivery evidence only", () => {
		for (const id of [
			"legacy-unmaterialized",
			"legacy-delivered",
			"legacy-mixed",
		]) {
			admitQuestion({ id });
		}
		deliverAll();
		const raw = new Database(dbPath);
		try {
			const insert = raw.prepare(
				`INSERT INTO lead_inbox
				 (id, to_lead, source, type, msg_class, priority, content, created_at,
				  resend_of, resend_round, delivered_at, consumed_at, disposition)
				 VALUES (?, 'lead-a', 'legacy-reminder', 'runner_question', 'model', 1,
				  'legacy', ?, ?, ?, ?, ?, ?)`,
			);
			insert.run(
				"legacy-unmaterialized#r1",
				T0,
				"legacy-unmaterialized",
				1,
				null,
				null,
				null,
			);
			insert.run(
				"legacy-delivered#r1",
				T0,
				"legacy-delivered",
				1,
				T0,
				T0,
				"delivered",
			);
			insert.run("legacy-mixed#r1", T0, "legacy-mixed", 1, T0, T0, "delivered");
			insert.run("legacy-mixed#r2", T0, "legacy-mixed", 2, null, null, null);
		} finally {
			raw.close();
		}

		const activation = db.reconcileReceiptActivation({
			enabled: true,
			now: T1,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: String(Date.parse(T1)),
		});
		expect(queue.getById("legacy-unmaterialized")?.delivered_rounds).toBe(0);
		expect(queue.getById("legacy-delivered")?.delivered_rounds).toBe(1);
		expect(queue.getById("legacy-mixed")?.delivered_rounds).toBe(1);
		expect(queue.getById("legacy-unmaterialized#r1")).toMatchObject({
			consumed_at: T1,
			disposition: "superseded",
		});
		expect(queue.getById("legacy-mixed#r2")).toMatchObject({
			consumed_at: T1,
			disposition: "superseded",
		});

		db.advanceDueUnprocessedReceipts({
			now: T2,
			windowMs: WINDOW_MS,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			resendCap: 2,
		});
		expect(
			queue.getById(`legacy-unmaterialized#r1@${activation.episodeId}`),
		).toBeDefined();
		expect(
			queue.getById(`legacy-delivered#r2@${activation.episodeId}`),
		).toBeDefined();
		expect(
			queue.getById(`legacy-mixed#r2@${activation.episodeId}`),
		).toBeDefined();
	});

	it("keeps dry-run non-mutating, then commits the same episode cohort", () => {
		admitQuestion({ id: "dry-run-root" });
		deliverAll();
		const dryRun = db.reconcileReceiptActivation({
			enabled: true,
			now: T1,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: "2000000000000000000",
			dryRun: true,
		});
		expect(dryRun).toMatchObject({
			status: "dry_run",
			initialized: 0,
			dryRunCounts: {
				eligible: 1,
				byPriority: { 0: 0, 1: 1, 2: 0, 3: 0 },
				estimated: { t1: 1, t2: 1, t3: 1, outboxPeak: 1 },
			},
		});
		expect(queue.getById("dry-run-root")?.next_unprocessed_at).toBeNull();

		const committed = db.reconcileReceiptActivation({
			enabled: true,
			now: T1,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: "2000000000000000000",
		});
		expect(committed).toMatchObject({
			episodeId: dryRun.episodeId,
			status: "active",
			initialized: 1,
		});
		expect(queue.getById("dry-run-root")?.next_unprocessed_at).toBe(T2);
	});

	it("fences pending children and outboxes across flag-off/on episodes", () => {
		admitQuestion({ id: "episode-fence-root" });
		deliverAll();
		const first = db.reconcileReceiptActivation({
			enabled: true,
			now: T0,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: "2000000000000000000",
		});
		db.advanceDueUnprocessedReceipts({
			now: T1,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		const oldR1 = `episode-fence-root#r1@${first.episodeId}`;
		expect(queue.getById(oldR1)?.consumed_at).toBeNull();

		db.reconcileReceiptActivation({
			enabled: false,
			now: "2026-07-20T12:30:01.000Z",
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: "2000000000000000001",
		});
		expect(queue.getById(oldR1)).toMatchObject({
			consumed_at: "2026-07-20T12:30:01.000Z",
			disposition: "superseded",
		});
		const second = db.reconcileReceiptActivation({
			enabled: true,
			now: T2,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: "2000000000000000002",
		});
		expect(
			db.advanceDueUnprocessedReceipts({
				now: "2026-07-20T13:29:59.000Z",
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toEqual([]);
		expect(
			db.advanceDueUnprocessedReceipts({
				now: T3,
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toMatchObject([{ kind: "resent", round: 1 }]);
		const newR1 = `episode-fence-root#r1@${second.episodeId}`;
		expect(queue.getById(newR1)).toBeDefined();
		expect(queue.getById("episode-fence-root")?.delivered_rounds).toBe(0);

		deliverPendingAt(T3, "fenced-r1");
		db.advanceDueUnprocessedReceipts({
			now: "2026-07-20T14:00:00.000Z",
			windowMs: WINDOW_MS,
			resendCap: 1,
		});
		const oldOutbox = `unprocessed:episode-fence-root@${second.episodeId}`;
		expect(db.getReceiptAlertOutbox(oldOutbox)).toMatchObject({
			delivered_at: null,
			canceled_at: null,
		});
		db.reconcileReceiptActivation({
			enabled: false,
			now: "2026-07-20T14:00:01.000Z",
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: "2000000000000000003",
		});
		expect(db.getReceiptAlertOutbox(oldOutbox)?.cancel_reason).toBe(
			"receipt_foundation_disabled",
		);
		const third = db.reconcileReceiptActivation({
			enabled: true,
			now: "2026-07-20T14:30:00.000Z",
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: "2000000000000000004",
		});
		expect(
			db.advanceDueUnprocessedReceipts({
				now: "2026-07-20T15:00:00.000Z",
				windowMs: WINDOW_MS,
				resendCap: 1,
			}),
		).toMatchObject([
			{
				kind: "escalation_queued",
				outboxId: `unprocessed:episode-fence-root@${third.episodeId}`,
			},
		]);
	});

	it("starts a priority window for every delivered category, including reports, telemetry, and unknown types", () => {
		admitQuestion({ id: "eligible" });
		admitQuestion({
			id: "ship",
			checkpoint: "approve_to_ship",
			type: "gate_question",
		});
		admitQuestion({ id: "report", kind: "report" });
		queue.enqueue({
			id: "telemetry",
			toLead: "lead-a",
			source: "progress:1",
			type: "progress",
			msgClass: "model",
			priority: 3,
			content: "50%",
			createdAt: T0,
		});
		queue.enqueue({
			id: "future-category",
			toLead: "lead-a",
			source: "future:1",
			type: "not_in_any_receipt_registry",
			msgClass: "model",
			priority: 2,
			content: "future category",
			createdAt: T0,
		});
		const rows = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: "batch-category-agnostic",
			now: T0,
			claimTtlMs: 60_000,
		});
		expect(
			queue.markConsumed(
				rows.map(({ id }) => id),
				{
					ownerEpoch: "epoch-1",
					disposition: "delivered",
					now: T0,
					receiptWindowsMs: PRIORITY_WINDOWS_MS,
				},
			),
		).toBe(rows.length);

		expect(queue.getById("eligible")).toMatchObject({
			delivered_at: T0,
			next_unprocessed_at: T1,
			resend_round: 0,
		});
		expect(queue.getById("ship")?.next_unprocessed_at).toBe(T1);
		expect(queue.getById("report")?.next_unprocessed_at).toBe(T1);
		expect(queue.getById("future-category")?.next_unprocessed_at).toBe(
			"2026-07-20T16:00:00.000Z",
		);
		expect(queue.getById("telemetry")?.next_unprocessed_at).toBe(
			"2026-07-21T12:00:00.000Z",
		);
	});

	it("derives strong response evidence before patrol, so an answered gate is never resent", () => {
		const questionId = admitQuestion({
			id: "answered-gate",
			checkpoint: "brainstorm",
			type: "gate_question",
		});
		deliverAll(WINDOW_MS);
		expect(
			db.insertResponse(questionId, "lead-a", "approved", {
				senderLeaseKey: "lease-a",
				senderGeneration: 7,
				writerPid: 42,
				writerStart: "writer-start",
			}),
		).toEqual({ written: true });

		expect(db.deriveProcessedReceipts(T1)).toBe(1);
		expect(
			db.advanceDueUnprocessedReceipts({
				now: T1,
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toEqual([]);
		const row = queue.getById("answered-gate");
		expect(row?.processed_at).toBe(T1);
		expect(row?.next_unprocessed_at).toBeNull();
		expect(JSON.parse(row?.processed_evidence ?? "null")).toMatchObject({
			kind: "response_observed",
			actor: "lead-a",
			actor_kind: "lead",
			fence: { lease_generation: 7, lease_key: "lease-a" },
		});
	});

	it("resends a delivered future category without adding it to a type registry", () => {
		queue.enqueue({
			id: "future-due",
			toLead: "lead-a",
			source: "future",
			type: "invented_after_fly_1392",
			msgClass: "model",
			priority: 2,
			content: "new category payload",
			createdAt: T0,
		});
		const rows = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: "future-batch",
			now: T0,
			claimTtlMs: 60_000,
		});
		queue.markConsumed(
			rows.map(({ id }) => id),
			{
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T0,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
			},
		);
		db.reconcileReceiptActivation({
			enabled: true,
			now: T0,
			receiptWindowsMs: PRIORITY_WINDOWS_MS,
			highWaterMark: String(Date.parse(T0)),
		});

		expect(
			db.advanceDueUnprocessedReceipts({
				now: "2026-07-20T16:00:00.000Z",
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toMatchObject([{ kind: "resent", rootId: "future-due", round: 1 }]);
	});

	it("does not forge processed for another actor and disposes the closed question", () => {
		const questionId = admitQuestion({ id: "wrong-actor" });
		deliverAll(WINDOW_MS);
		db.insertResponse(questionId, "different-lead", "pretend handled", {
			senderLeaseKey: "lease-other",
			senderGeneration: 9,
		});

		expect(db.deriveProcessedReceipts(T1)).toBe(0);
		expect(queue.getById("wrong-actor")).toMatchObject({
			processed_at: null,
			processed_evidence: null,
			disposed_at: T1,
			disposed_evidence: expect.any(String),
			next_unprocessed_at: null,
		});
		expect(
			db.advanceDueUnprocessedReceipts({
				now: T1,
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toEqual([]);
		expect(queue.getById("wrong-actor")?.processed_at).toBeNull();
		expect(queue.getById("wrong-actor#r1")).toBeUndefined();
	});

	it("does not start the delivery window when the question was already answered", () => {
		const questionId = admitQuestion({ id: "answered-before-delivery" });
		db.insertResponse(questionId, "founder", "already done");

		deliverAll(WINDOW_MS);

		expect(queue.getById("answered-before-delivery")).toMatchObject({
			delivered_at: T0,
			processed_at: null,
			next_unprocessed_at: null,
		});
	});

	it("does not bootstrap a closed question when its response cannot mint strong evidence", () => {
		const questionId = admitQuestion({ id: "answered-before-bootstrap" });
		deliverAll();
		db.insertResponse(questionId, "founder", "already done");

		expect(
			db.bootstrapUnprocessedReceipts({ now: T1, windowMs: WINDOW_MS }),
		).toEqual({ activationAt: T1, derived: 0, initialized: 0 });
		expect(queue.getById("answered-before-bootstrap")).toMatchObject({
			processed_at: null,
			processed_evidence: null,
			next_unprocessed_at: null,
		});
	});

	it("emits exactly two root-owned resends, then one deterministic outbox alert", () => {
		expect(
			db.bootstrapUnprocessedReceipts({ now: T0, windowMs: WINDOW_MS }),
		).toMatchObject({ initialized: 0 });
		admitQuestion({ id: "unanswered" });
		deliverAll(WINDOW_MS);

		const r1 = db.advanceDueUnprocessedReceipts({
			now: T1,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		expect(r1).toMatchObject([
			{ kind: "resent", rootId: "unanswered", round: 1 },
		]);
		const episodeId = queue.getById("unanswered")?.receipt_episode_id;
		expect(episodeId).toBeTruthy();
		const r1Id = `unanswered#r1@${episodeId}`;
		expect(queue.getById(r1Id)).toMatchObject({
			resend_of: "unanswered",
			resend_round: 1,
			ref_message_id: null,
		});
		expect(queue.getById(r1Id)?.content).toContain("第 1 次重发");
		expect(
			db.advanceDueUnprocessedReceipts({
				now: T1,
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toEqual([]);
		expect(deliverPendingAt(T1, "resend-r1")).toEqual([r1Id]);

		const r2 = db.advanceDueUnprocessedReceipts({
			now: T2,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		expect(r2).toMatchObject([
			{ kind: "resent", rootId: "unanswered", round: 2 },
		]);
		const r2Id = `unanswered#r2@${episodeId}`;
		expect(deliverPendingAt(T2, "resend-r2")).toEqual([r2Id]);

		expect(
			db.advanceDueUnprocessedReceipts({
				now: T3,
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toMatchObject([
			{
				kind: "escalation_queued",
				rootId: "unanswered",
				outboxId: `unprocessed:unanswered@${episodeId}`,
			},
		]);
		expect(queue.getById(`unanswered#r3@${episodeId}`)).toBeUndefined();
		expect(
			db.getReceiptAlertOutbox(`unprocessed:unanswered@${episodeId}`),
		).toMatchObject({
			kind: "receipt_unprocessed",
			delivered_at: null,
		});

		db.close();
		db = new CommDB(dbPath, false);
		expect(
			db.bootstrapUnprocessedReceipts({
				now: "2026-07-20T14:00:00.000Z",
				windowMs: WINDOW_MS,
			}),
		).toMatchObject({ initialized: 0 });
		const raw = new Database(dbPath);
		raw
			.prepare("UPDATE lead_inbox SET next_unprocessed_at = ? WHERE id = ?")
			.run("2026-07-20T14:00:00.000Z", "unanswered");
		raw.close();
		expect(
			db.advanceDueUnprocessedReceipts({
				now: "2026-07-20T14:00:00.000Z",
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toEqual([]);
		expect(queue.getById("unanswered")?.next_unprocessed_at).toBeNull();
	});

	it("routes founder hub-root resends through the model lane", () => {
		db.bootstrapUnprocessedReceipts({ now: T0, windowMs: WINDOW_MS });
		const rootId = founderMessageRootId("lead-a", "discord-resend");
		db.enqueueFounderHubRoot({
			id: rootId,
			toLead: "lead-a",
			content: JSON.stringify({
				v: 1,
				msgId: "discord-resend",
				answer: "please handle",
				projectName: "flywheel",
				issueId: "issue-1",
				threadId: "thread-1",
				isReply: false,
			}),
			refMessageId: "discord-resend",
			now: T0,
			nextUnprocessedAt: T1,
		});
		deliverPendingAt(T0, "founder-root-batch");

		expect(
			db.advanceDueUnprocessedReceipts({
				now: T1,
				windowMs: WINDOW_MS,
				resendCap: 2,
			}),
		).toMatchObject([{ kind: "resent", rootId, round: 1 }]);
		const episodeId = queue.getById(rootId)?.receipt_episode_id;
		expect(queue.getById(`${rootId}#r1@${episodeId}`)).toMatchObject({
			msg_class: "model",
			type: "founder_reply",
			resend_of: rootId,
		});
	});

	it("closes every resend and cancels a pending escalation when evidence arrives", () => {
		const questionId = admitQuestion({ id: "late-answer" });
		deliverAll(WINDOW_MS);
		const episodeId = queue.getById("late-answer")?.receipt_episode_id;
		db.advanceDueUnprocessedReceipts({
			now: T1,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		deliverPendingAt(T1, "late-r1");
		db.advanceDueUnprocessedReceipts({
			now: T2,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		deliverPendingAt(T2, "late-r2");
		db.advanceDueUnprocessedReceipts({
			now: T3,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		db.insertResponse(questionId, "lead-a", "done", {
			senderLeaseKey: "lease-a",
			senderGeneration: 8,
		});
		expect(db.deriveProcessedReceipts("2026-07-20T13:31:00.000Z")).toBe(1);

		for (const id of [
			`late-answer#r1@${episodeId}`,
			`late-answer#r2@${episodeId}`,
		]) {
			expect(queue.getById(id)?.disposition).toBe("superseded_by_evidence");
		}
		const outboxId = `unprocessed:late-answer@${episodeId}`;
		expect(
			db.revalidateReceiptAlert(
				outboxId,
				Date.parse("2026-07-20T13:31:00.000Z"),
			),
		).toBeNull();
		expect(db.getReceiptAlertOutbox(outboxId)).toMatchObject({
			canceled_at: "2026-07-20T13:31:00.000Z",
			cancel_reason: "source_no_longer_unprocessed",
		});
	});

	it("cancels a pending escalation when a founder closes the question without strong receipt evidence", () => {
		const questionId = admitQuestion({ id: "founder-late-answer" });
		deliverAll(WINDOW_MS);
		const episodeId = queue.getById("founder-late-answer")?.receipt_episode_id;
		db.advanceDueUnprocessedReceipts({
			now: T1,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		deliverPendingAt(T1, "founder-late-r1");
		db.advanceDueUnprocessedReceipts({
			now: T2,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		deliverPendingAt(T2, "founder-late-r2");
		db.advanceDueUnprocessedReceipts({
			now: T3,
			windowMs: WINDOW_MS,
			resendCap: 2,
		});
		const outboxId = `unprocessed:founder-late-answer@${episodeId}`;
		expect(db.getReceiptAlertOutbox(outboxId)).toMatchObject({
			delivered_at: null,
			canceled_at: null,
		});

		db.insertResponse(questionId, "founder", "done by founder");
		expect(db.deriveProcessedReceipts("2026-07-20T13:31:00.000Z")).toBe(0);
		expect(
			db.revalidateReceiptAlert(
				outboxId,
				Date.parse("2026-07-20T13:31:00.000Z"),
			),
		).toBeNull();
		expect(queue.getById("founder-late-answer")?.processed_at).toBeNull();
		expect(db.getReceiptAlertOutbox(outboxId)).toMatchObject({
			canceled_at: "2026-07-20T13:31:00.000Z",
			cancel_reason: "source_no_longer_unprocessed",
		});
	});

	it("bootstraps old eligible rows from one durable activation time after deriving answers", () => {
		const answeredQuestion = admitQuestion({ id: "old-answered" });
		admitQuestion({ id: "old-pending" });
		deliverAll();
		db.insertResponse(answeredQuestion, "lead-a", "done", {
			senderLeaseKey: "lease-a",
			senderGeneration: 9,
		});

		expect(
			db.bootstrapUnprocessedReceipts({ now: T1, windowMs: WINDOW_MS }),
		).toEqual({ activationAt: T1, derived: 1, initialized: 1 });
		expect(queue.getById("old-answered")?.next_unprocessed_at).toBeNull();
		expect(queue.getById("old-pending")?.next_unprocessed_at).toBe(T2);
		expect(
			db.bootstrapUnprocessedReceipts({ now: T3, windowMs: WINDOW_MS }),
		).toEqual({ activationAt: T1, derived: 0, initialized: 0 });
		expect(queue.getById("old-pending")?.next_unprocessed_at).toBe(T2);
	});

	it("bootstraps every delivered non-exempt category with its priority window", () => {
		queue.enqueue({
			id: "bootstrap-future",
			toLead: "lead-a",
			source: "future",
			type: "category_added_next_year",
			msgClass: "model",
			priority: 3,
			content: "low urgency but real",
		});
		const rows = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: "bootstrap-future-batch",
			now: T0,
			claimTtlMs: 60_000,
		});
		queue.markConsumed(
			rows.map(({ id }) => id),
			{
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T0,
			},
		);

		expect(
			db.bootstrapUnprocessedReceipts({
				now: T1,
				windowMs: WINDOW_MS,
				receiptWindowsMs: PRIORITY_WINDOWS_MS,
			}),
		).toMatchObject({ initialized: 1 });
		expect(queue.getById("bootstrap-future")?.next_unprocessed_at).toBe(
			"2026-07-21T12:30:00.000Z",
		);
	});

	it("never lets Bridge promote or classify a founder message", () => {
		db.bootstrapUnprocessedReceipts({ now: T0, windowMs: WINDOW_MS });
		const rootId = founderMessageRootId("lead-a", "discord-1");
		db.enqueueFounderHubRoot({
			id: rootId,
			toLead: "lead-a",
			content: JSON.stringify({
				v: 1,
				msgId: "discord-1",
				answer: "please handle",
				projectName: "flywheel",
				issueId: "issue-1",
				threadId: "thread-1",
				isReply: false,
			}),
			refMessageId: "discord-1",
			now: T0,
			nextUnprocessedAt: T1,
			routingState: "hub_recorded",
		});

		expect(
			db.promoteDueFounderRebinds({ ownerEpoch: "epoch-1", now: T1 }),
		).toEqual([]);
		expect(queue.getById(rootId)).toMatchObject({
			msg_class: "model",
			routing_state: "hub_recorded",
			consumed_at: null,
		});
	});
});
