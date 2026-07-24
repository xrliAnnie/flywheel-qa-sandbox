import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

describe("FLY-1448 terminal receipt settlement primitives", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1448-receipt-settlement-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"session",
			"flywheel",
			"FLY-1448",
			"flywheel-eng-lead",
			"codex",
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function enqueueRoot(refMessageId: string, id = "receipt-root") {
		const queue = new LeadInboxQueue(dbPath);
		try {
			return queue.enqueue({
				id,
				toLead: "flywheel-eng-lead",
				source: "runner",
				type: "runner_question",
				msgClass: "protocol",
				content: "needs attention",
				refMessageId,
				createdAt: "2026-07-24T00:00:00.000Z",
			});
		} finally {
			queue.close();
		}
	}

	it("supersedes an unanswered ship gate and its exact receipt family in one transaction", () => {
		const questionId = db.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ship?",
			{
				checkpoint: "approve_to_ship",
			},
		);
		enqueueRoot(questionId);

		const result = db.supersedeShipGateAndReceiptFamily({
			questionId,
			reason: "superseded_session_terminal",
			now: "2026-07-24T00:01:00.000Z",
		});

		expect(result).toMatchObject({
			kind: "settled",
			receiptIds: ["receipt-root"],
		});
		expect(db.getPendingQuestions("exec-1")).toEqual([]);
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(queue.getById("receipt-root")).toMatchObject({
				disposed_at: "2026-07-24T00:01:00.000Z",
				processed_at: null,
			});
		} finally {
			queue.close();
		}
	});

	it("lets a concurrent response win without mutating the gate or root", () => {
		const questionId = db.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"ship?",
			{
				checkpoint: "approve_to_ship",
			},
		);
		enqueueRoot(questionId);
		db.insertResponse(questionId, "flywheel-eng-lead", "approved");

		expect(
			db.supersedeShipGateAndReceiptFamily({
				questionId,
				reason: "superseded_session_terminal",
				now: "2026-07-24T00:01:00.000Z",
			}),
		).toEqual({ kind: "response_won", receiptIds: [] });
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(queue.getById("receipt-root")?.disposed_at).toBeNull();
		} finally {
			queue.close();
		}
	});

	it("disposes a delivered generic root, closes its family, and preserves an already-delivered alert", () => {
		const questionId = db.insertQuestion("exec-1", "flywheel-eng-lead", "help");
		enqueueRoot(questionId);
		const raw = new Database(dbPath);
		try {
			raw
				.prepare(
					"UPDATE lead_inbox SET delivered_at = ? WHERE id = 'receipt-root'",
				)
				.run("2026-07-24T00:00:10.000Z");
			raw
				.prepare(
					`INSERT INTO receipt_alert_outbox
				   (id, kind, payload, created_at, delivered_at)
				 VALUES ('unprocessed:receipt-root', 'receipt_unprocessed', '{}', ?, ?)`,
				)
				.run("2026-07-24T00:00:20.000Z", "2026-07-24T00:00:30.000Z");
		} finally {
			raw.close();
		}

		const result = db.settleReceiptFamilyForTerminalSubject({
			receiptId: "receipt-root",
			expectedExecutionId: "exec-1",
			reason: "session_terminal",
			now: "2026-07-24T00:01:00.000Z",
		});

		expect(result).toEqual({ kind: "disposed", receiptId: "receipt-root" });
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(queue.getById("receipt-root")).toMatchObject({
				delivered_at: "2026-07-24T00:00:10.000Z",
				disposed_at: "2026-07-24T00:01:00.000Z",
			});
		} finally {
			queue.close();
		}
		expect(db.getReceiptAlertOutbox("unprocessed:receipt-root")).toMatchObject({
			delivered_at: "2026-07-24T00:00:30.000Z",
			canceled_at: null,
		});
	});

	it("rejects lineage that belongs to a different execution", () => {
		const questionId = db.insertQuestion("exec-1", "flywheel-eng-lead", "help");
		enqueueRoot(questionId);
		expect(() =>
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: "receipt-root",
				expectedExecutionId: "other-exec",
				reason: "session_terminal",
				now: "2026-07-24T00:01:00.000Z",
			}),
		).toThrow(/lineage/i);
	});
});
