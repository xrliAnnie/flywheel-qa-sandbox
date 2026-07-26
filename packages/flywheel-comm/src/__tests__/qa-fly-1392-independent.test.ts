// Independent QA (FLY-1392 three-stage QA phase). These assertions come from the
// plan's own acceptance list (§1) and from research §10.2's mandated fault
// injections — they are deliberately written against the shipped implementation
// rather than mirroring the implementer's own fixtures.
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

const T0 = "2026-07-20T12:00:00.000Z";
const WINDOW_MS = 30 * 60_000;
const at = (minutes: number) =>
	new Date(Date.parse(T0) + minutes * 60_000).toISOString();

describe("FLY-1392 independent QA — acceptance §1 #4 (answered gates are never nudged)", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1392-"));
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

	/** One runner question that reached the Lead inbox and was delivered. */
	function deliveredQuestionReceipt(receiptId: string): string {
		db.registerSession(
			`exec-${receiptId}`,
			`FLY-1392-QA-${receiptId}:@0`,
			"flywheel",
			"issue-1",
			"lead-a",
		);
		const questionId = db.insertQuestion(
			`exec-${receiptId}`,
			"lead-a",
			`question ${receiptId}`,
		);
		queue.enqueue({
			id: receiptId,
			toLead: "lead-a",
			source: `question:${questionId}`,
			type: "runner_question",
			msgClass: "model",
			priority: 1,
			content: `question ${receiptId}`,
			refMessageId: questionId,
			createdAt: T0,
		});
		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: `batch-${receiptId}`,
			now: T0,
			claimTtlMs: 60_000,
		});
		expect(
			queue.markConsumed(
				claimed.map(({ id }) => id),
				{
					ownerEpoch: "epoch-1",
					disposition: "delivered",
					now: T0,
					receiptWindowMs: WINDOW_MS,
				},
			),
		).toBe(claimed.length);
		return questionId;
	}

	function patrolUntilEscalated(receiptId: string): string[] {
		db.reconcileReceiptActivation({
			enabled: true,
			now: T0,
			receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
			highWaterMark: "1485740000000000000",
		});
		const kinds: string[] = [];
		for (const minutes of [31, 62, 93]) {
			db.deriveProcessedReceipts(at(minutes));
			for (const outcome of db.advanceDueUnprocessedReceipts({
				now: at(minutes),
				windowMs: WINDOW_MS,
				resendCap: 2,
			})) {
				if (outcome.rootId !== receiptId) continue;
				kinds.push(outcome.kind);
				if (outcome.kind === "resent") {
					const child = queue.claimModelBatch({
						toLead: "lead-a",
						ownerEpoch: "epoch-1",
						batchId: `qa-${receiptId}-${outcome.round}`,
						now: at(minutes),
						claimTtlMs: 60_000,
					});
					expect(child).toHaveLength(1);
					queue.markConsumed(
						child.map(({ id }) => id),
						{
							ownerEpoch: "epoch-1",
							disposition: "delivered",
							now: at(minutes),
							receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
						},
					);
				}
			}
		}
		return kinds;
	}

	// Positive control — proves the ruler works before the negative claim below.
	it("positive control: a Lead-answered question derives processed and is never resent", () => {
		const questionId = deliveredQuestionReceipt("answered-by-lead");
		db.insertResponse(questionId, "lead-a", "ack", {
			senderLeaseKey: "lease-a",
			senderGeneration: 7,
			senderHolderPid: 1,
			senderHolderStart: "1",
		});

		expect(patrolUntilEscalated("answered-by-lead")).toEqual([]);
		const root = queue.getById("answered-by-lead");
		expect(root?.processed_at).toBeTruthy();
		expect(JSON.parse(root?.processed_evidence ?? "null")).toMatchObject({
			kind: "response_observed",
			actor: "lead-a",
		});
		expect(queue.getById("answered-by-lead")?.disposed_at).toBeNull();
	});

	// Non-vacuity guard for the disposal predicate added in bd14d7dba: narrowing
	// the eligible-root set must not have silently switched the reminder axis off.
	// A genuinely open, unanswered question still has to be chased and escalated.
	it("non-vacuity: a still-open unanswered question is chased to r1, r2 and escalation", () => {
		deliveredQuestionReceipt("still-open");

		expect(patrolUntilEscalated("still-open")).toEqual([
			"resent",
			"resent",
			"escalation_queued",
		]);
		const episode = queue.getLatestReceiptActivation()?.episode_id;
		expect(queue.getById(`still-open#r1@${episode}`)?.content).toContain(
			"第 1 次重发",
		);
		expect(queue.getById(`still-open#r2@${episode}`)?.content).toContain(
			"第 2 次重发",
		);
		expect(queue.getById(`still-open#r3@${episode}`)).toBeUndefined();
		expect(
			db.revalidateReceiptAlert(
				`unprocessed:still-open@${episode}`,
				Date.parse(at(94)),
			),
		).toBeTruthy();
	});

	// Acceptance §1 #4: "已过门的 gate 不再被催". The founder answering a runner
	// question in the issue thread (branch F-5 — the canonical flow this issue
	// exists to make reliable) writes a response with from_agent='founder' and
	// marks the question terminal_disposed. The gate is closed; nothing may nudge.
	it("a founder-answered (terminal-disposed) question must not be resent or escalated", () => {
		const questionId = deliveredQuestionReceipt("answered-by-founder");
		db.insertResponse(questionId, "founder", "yes go ahead");

		// Sanity: the gate really is closed by the time the patrol runs.
		expect(db.getResponse(questionId)?.from_agent).toBe("founder");

		const outcomes = patrolUntilEscalated("answered-by-founder");
		expect(outcomes).toEqual([]);
		expect(queue.getById("answered-by-founder")?.disposed_at).toBeTruthy();
		// No outbox row was ever created, so this row can never page anyone.
		expect(
			db.getReceiptAlertOutbox(
				`unprocessed:answered-by-founder@${queue.getLatestReceiptActivation()?.episode_id}`,
			),
		).toBeUndefined();
	});

	// The revalidation copy needs its OWN scenario: it only runs its predicate
	// when an outbox row already exists, so asserting `null` on a row that was
	// never queued proves nothing (it short-circuits on `!alert`). Here the
	// alert is queued while the question is still open, and only THEN is the
	// question answered — which is the real race the revalidation guard exists
	// for: a response landing between enqueue and delivery.
	it("authorized disposal derivation cancels an alert queued before the answer", () => {
		const questionId = deliveredQuestionReceipt("answered-after-alert");

		expect(patrolUntilEscalated("answered-after-alert")).toEqual([
			"resent",
			"resent",
			"escalation_queued",
		]);
		const alertId = `unprocessed:answered-after-alert@${queue.getLatestReceiptActivation()?.episode_id}`;
		expect(db.getReceiptAlertOutbox(alertId)?.kind).toBe("receipt_unprocessed");
		// Control: while the question is still open the alert really would page.
		expect(db.revalidateReceiptAlert(alertId, Date.parse(at(94)))).toBeTruthy();

		// The founder answers in the issue thread before the alert is delivered.
		db.insertResponse(questionId, "founder", "answered while queued");
		db.deriveProcessedReceipts(at(95));

		expect(db.revalidateReceiptAlert(alertId, Date.parse(at(95)))).toBeNull();
		expect(db.getReceiptAlertOutbox(alertId)?.cancel_reason).toBe(
			"source_no_longer_unprocessed",
		);
	});

	// The disposal rule lives in four copies (three SQL predicates + the JS set in
	// LeadInboxQueue.markConsumed). The two tests above only reach the patrol and
	// revalidation copies; these two reach the other two, so a partial fix cannot
	// pass this file.
	it("delivery stays category-agnostic, then activation disposes an already-answered question", () => {
		db.registerSession(
			"exec-fast",
			"FLY-1392-QA-fast:@0",
			"flywheel",
			"issue-1",
			"lead-a",
		);
		const questionId = db.insertQuestion("exec-fast", "lead-a", "fast answer");
		queue.enqueue({
			id: "answered-before-delivery",
			toLead: "lead-a",
			source: `question:${questionId}`,
			type: "runner_question",
			msgClass: "model",
			priority: 1,
			content: "fast answer",
			refMessageId: questionId,
			createdAt: T0,
		});
		// The founder answers while the batch is still in flight.
		db.insertResponse(questionId, "founder", "already handled");

		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-1",
			batchId: "batch-fast",
			now: T0,
			claimTtlMs: 60_000,
		});
		queue.markConsumed(
			claimed.map(({ id }) => id),
			{
				ownerEpoch: "epoch-1",
				disposition: "delivered",
				now: T0,
				receiptWindowMs: WINDOW_MS,
			},
		);

		expect(
			queue.getById("answered-before-delivery")?.delivered_at,
		).toBeTruthy();
		expect(
			queue.getById("answered-before-delivery")?.next_unprocessed_at,
		).toBeTruthy();
		expect(patrolUntilEscalated("answered-before-delivery")).toEqual([]);
		expect(queue.getById("answered-before-delivery")?.disposed_at).toBeTruthy();
		expect(
			queue.getById("answered-before-delivery")?.next_unprocessed_at,
		).toBeNull();
	});

	it("bootstrap copy: flag-on backfill never arms an already-answered legacy row", () => {
		const openId = deliveredQuestionReceipt("legacy-open");
		const closedId = deliveredQuestionReceipt("legacy-closed");
		db.insertResponse(closedId, "founder", "answered long ago");
		expect(openId).toBeTruthy();

		// Simulate rows that predate the receipt columns: delivered, but with no
		// window armed — exactly what flag-on backfill is supposed to pick up.
		const raw = new Database(dbPath);
		raw
			.prepare(
				`UPDATE lead_inbox SET next_unprocessed_at = NULL, resend_round = NULL
				  WHERE id IN ('legacy-open', 'legacy-closed')`,
			)
			.run();
		raw.close();

		db.bootstrapUnprocessedReceipts({ now: at(1), windowMs: WINDOW_MS });

		expect(queue.getById("legacy-closed")?.next_unprocessed_at).toBeNull();
		// Control: the still-open legacy row IS armed by the same backfill.
		expect(queue.getById("legacy-open")?.next_unprocessed_at).toBeTruthy();
		// And in one shared patrol run only the open one is actually chased.
		expect(patrolUntilEscalated("legacy-open")).toEqual([
			"resent",
			"resent",
			"escalation_queued",
		]);
		expect(patrolUntilEscalated("legacy-closed")).toEqual([]);
	});
});

describe("FLY-1392 independent QA — research §10.2 mandated fault injections", () => {
	let dir: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1392-wake-"));
		db = new CommDB(join(dir, "comm.db"));
		db.registerSession(
			"exec-wake",
			"FLY-1392-QA-wake:@0",
			"flywheel",
			"issue-1",
			"lead-a",
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function admitWake(queuedAtMs: number) {
		return db.instructionAndIntent({
			instructionId: "instruction-qa",
			fromAgent: "lead-a",
			executionId: "exec-wake",
			content: "QA instruction",
			intentKey: "instruction:instruction-qa",
			envelope: {
				id: "wake-qa",
				to: "exec-wake",
				content: "wake qa",
				metadata: { flywheelId: "instruction-qa", execId: "exec-wake" },
			},
			queuedAtMs,
		});
	}

	// Injection A: a transient T2 refusal is allowed to retire the ladder early,
	// but the refusal itself must be durably visible and must never be recorded
	// as started/processed.
	it("A: a transient T2 refusal leaves a durable wake_failed fact, not a silent success", () => {
		admitWake(1_000);
		const claimed = db.claimRunnerReceiptWakeT2(
			"exec-wake",
			"instruction:instruction-qa",
			1_000 + 5 * 60_000,
			5 * 60_000,
		);
		expect(claimed).toBeTruthy();
		db.completeRunnerReceiptWakeT2(
			"exec-wake",
			"instruction:instruction-qa",
			"forbidden:capture_failed",
		);

		const nowMs = 1_000 + 6 * 60_000;
		const alert = db.enqueueRunnerReceiptWakeEscalation({
			executionId: "exec-wake",
			messageId: "instruction:instruction-qa",
			reason: "wake_pointer_capture_failed",
			firstDetectedAtMs: 1_000,
			nowMs,
		});
		expect(alert?.kind).toBe("wake_failed");
		// Survives revalidation: the failure is real and must actually be paged.
		expect(db.revalidateReceiptAlert(alert?.id ?? "", nowMs)).toBeTruthy();

		const wake = db.listRunnerPhaseWakes("exec-wake")[0];
		expect(wake?.state).toBe("pending");
		expect(wake?.t2_result).toBe("forbidden:capture_failed");
		expect(wake?.escalation_outbox_id).toBe(alert?.id);
	});

	// Injection A, negative half: once the runner really starts, the queued
	// failure alert must cancel rather than page a resolved condition.
	it("A': a started wake cancels its pending wake_failed alert instead of paging", () => {
		admitWake(1_000);
		const nowMs = 1_000 + 6 * 60_000;
		const alert = db.enqueueRunnerReceiptWakeEscalation({
			executionId: "exec-wake",
			messageId: "instruction:instruction-qa",
			reason: "t3_no_started_receipt",
			firstDetectedAtMs: 1_000,
			nowMs,
		});
		expect(alert).toBeTruthy();
		// A real started receipt, with its timestamp — not a half-written row.
		const startedAtMs = nowMs + 500;
		expect(
			db.markRunnerPhaseWakeStarted(
				"exec-wake",
				"instruction:instruction-qa",
				startedAtMs,
			),
		).toBe(true);
		const started = db.listRunnerPhaseWakes("exec-wake")[0];
		expect(started?.state).toBe("started");
		expect(started?.started_at).toBe(startedAtMs);
		expect(started?.started_ack_scope).toBe("message");

		expect(
			db.revalidateReceiptAlert(alert?.id ?? "", nowMs + 1_000),
		).toBeNull();
		expect(db.getReceiptAlertOutbox(alert?.id ?? "")?.cancel_reason).toBe(
			"source_no_longer_pending",
		);
	});
});

// RE-TEST (copy-model head 8da8e8f68) — the founder hub-root forgot path is the
// flagship of Annie's "Lead 忙忘了" concern: a founder message that lands in the
// Lead's ledger but is never handled must resurface (r1, r2) and then escalate,
// while a handled one stays quiet.
describe("FLY-1392 RE-TEST — founder hub-root forgot path (Lead never handles)", () => {
	const T0 = "2026-07-20T12:00:00.000Z";
	const WINDOW = 30 * 60_000;
	const when = (minutes: number) =>
		new Date(Date.parse(T0) + minutes * 60_000).toISOString();
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1392-ff-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-ff",
			now: T0,
			leaseTtlMs: 24 * 60 * 60_000,
		});
	});

	afterEach(() => {
		queue.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function hubRoot(msgId: string): string {
		const id = `founder_msg:lead-a:${msgId}`;
		db.enqueueFounderHubRoot({
			id,
			toLead: "lead-a",
			content: JSON.stringify({ v: 1, answer: "继续" }),
			refMessageId: msgId,
			now: T0,
			nextUnprocessedAt: when(30),
			routingState: "hub_recorded",
		});
		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-ff",
			batchId: `founder-${msgId}`,
			now: T0,
			claimTtlMs: 60_000,
		});
		expect(claimed.map(({ id: claimedId }) => claimedId)).toEqual([id]);
		queue.markConsumed([id], {
			ownerEpoch: "epoch-ff",
			disposition: "delivered",
			now: T0,
			receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
		});
		return id;
	}

	function patrol(rootId: string): string[] {
		db.reconcileReceiptActivation({
			enabled: true,
			now: T0,
			receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
			highWaterMark: "1485740000000000000",
		});
		const kinds: string[] = [];
		for (const minutes of [31, 62, 93]) {
			db.deriveProcessedReceipts(when(minutes));
			for (const outcome of db.advanceDueUnprocessedReceipts({
				now: when(minutes),
				windowMs: WINDOW,
				resendCap: 2,
			})) {
				if (outcome.rootId !== rootId) continue;
				kinds.push(outcome.kind);
				if (outcome.kind === "resent") {
					const child = queue.claimModelBatch({
						toLead: "lead-a",
						ownerEpoch: "epoch-ff",
						batchId: `founder-reminder-${outcome.round}`,
						now: when(minutes),
						claimTtlMs: 60_000,
					});
					expect(child).toHaveLength(1);
					queue.markConsumed(
						child.map(({ id }) => id),
						{
							ownerEpoch: "epoch-ff",
							disposition: "delivered",
							now: when(minutes),
							receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
						},
					);
				}
			}
		}
		return kinds;
	}

	it("an unhandled founder reply is resurfaced twice, then escalated", () => {
		const rootId = hubRoot("forgot-1");
		const root = queue.getById(rootId);
		expect(root?.delivered_at).toBeTruthy();
		expect(root?.processed_at).toBeNull();

		expect(patrol(rootId)).toEqual(["resent", "resent", "escalation_queued"]);
		const episode = queue.getLatestReceiptActivation()?.episode_id;
		expect(queue.getById(`${rootId}#r1@${episode}`)?.content).toContain(
			"第 1 次重发",
		);
		expect(queue.getById(`${rootId}#r2@${episode}`)?.content).toContain(
			"第 2 次重发",
		);
		expect(queue.getById(`${rootId}#r3@${episode}`)).toBeUndefined();
		expect(
			db.getReceiptAlertOutbox(`unprocessed:${rootId}@${episode}`)?.kind,
		).toBe("receipt_unprocessed");
	});

	it("a handled founder reply (processed_at set) is never resurfaced", () => {
		const rootId = hubRoot("handled-1");
		// Simulate the Lead's route action writing the handled receipt.
		expect(
			queue.markProcessed(rootId, {
				now: when(5),
				evidence: {
					v: 1,
					kind: "response_observed",
					ref: "resp-1",
					actor: "lead-a",
					actor_kind: "lead",
					fence: { lease_generation: 3 },
					basis: ["founder-route:handled-1"],
				},
			}),
		).toBe(true);

		expect(patrol(rootId)).toEqual([]);
		expect(
			queue.getById(
				`${rootId}#r1@${queue.getLatestReceiptActivation()?.episode_id}`,
			),
		).toBeUndefined();
	});
});
