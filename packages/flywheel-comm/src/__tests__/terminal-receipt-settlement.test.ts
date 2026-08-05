import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { MailboxQueue } from "../mailbox-queue.js";

const LEAD_ID = "flywheel-eng-lead";
const NOW = "2026-07-24T00:01:00.000Z";

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
			LEAD_ID,
			"codex",
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const receiptId = (questionId: string) => `question:${LEAD_ID}:${questionId}`;

	it("supersedes an unanswered ship gate and its unified receipt in one transaction", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "ship?", {
			checkpoint: "approve_to_ship",
		});

		expect(
			db.supersedeShipGateAndReceiptFamily({
				questionId,
				reason: "superseded_session_terminal",
				now: NOW,
			}),
		).toEqual({ kind: "settled", receiptIds: [receiptId(questionId)] });
		expect(db.getPendingQuestions(LEAD_ID)).toEqual([]);

		const queue = new MailboxQueue(dbPath);
		try {
			expect(queue.getSettlement(receiptId(questionId))).toMatchObject({
				event: "disposed",
				at: NOW,
			});
		} finally {
			queue.close();
		}
	});

	it("lets a concurrent response win without settling the receipt", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.insertResponse(questionId, LEAD_ID, "approved");

		expect(
			db.supersedeShipGateAndReceiptFamily({
				questionId,
				reason: "superseded_session_terminal",
				now: NOW,
			}),
		).toEqual({ kind: "response_won", receiptIds: [] });
		const queue = new MailboxQueue(dbPath);
		try {
			expect(queue.getSettlement(receiptId(questionId))).toBeUndefined();
		} finally {
			queue.close();
		}
	});

	it("settles a leased receipt and preserves an already-delivered alert", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "help");
		const raw = new Database(dbPath);
		try {
			raw
				.prepare("UPDATE mailbox SET state = 'LEASED' WHERE id = ?")
				.run(questionId);
			raw
				.prepare(
					`INSERT INTO receipt_alert_outbox
				   (id, kind, payload, created_at, delivered_at)
				 VALUES (?, 'receipt_unprocessed', '{}', ?, ?)`,
				)
				.run(
					`unprocessed:${receiptId(questionId)}`,
					"2026-07-24T00:00:20.000Z",
					"2026-07-24T00:00:30.000Z",
				);
		} finally {
			raw.close();
		}

		expect(
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: receiptId(questionId),
				expectedExecutionId: "exec-1",
				reason: "session_terminal",
				now: NOW,
			}),
		).toEqual({ kind: "disposed", receiptId: receiptId(questionId) });
		expect(
			db.getReceiptAlertOutbox(`unprocessed:${receiptId(questionId)}`),
		).toMatchObject({
			delivered_at: "2026-07-24T00:00:30.000Z",
			canceled_at: null,
		});
	});

	it("treats a second terminal authority as the same idempotent settlement", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "help");
		const id = receiptId(questionId);
		expect(
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: id,
				expectedExecutionId: "exec-1",
				reason: "session_terminal",
				now: NOW,
			}),
		).toEqual({ kind: "disposed", receiptId: id });
		expect(
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: id,
				expectedExecutionId: "exec-1",
				reason: "issue_done",
				now: "2026-07-24T00:02:00.000Z",
			}),
		).toEqual({ kind: "already_disposed", receiptId: id });
	});

	it("recognizes an exact ship settlement from another terminal authority", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "ship?", {
			checkpoint: "approve_to_ship",
		});
		const id = receiptId(questionId);
		db.supersedeShipGateAndReceiptFamily({
			questionId,
			reason: "superseded_session_terminal",
			now: NOW,
		});
		expect(
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: id,
				expectedExecutionId: "exec-1",
				reason: "pr_merged",
				now: "2026-07-24T00:02:00.000Z",
			}),
		).toEqual({ kind: "already_disposed", receiptId: id });
	});

	it("rejects disposal evidence from a different authority family", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "help");
		const id = receiptId(questionId);
		const queue = new MailboxQueue(dbPath);
		try {
			queue.settle({
				messageOrDeliveryId: id,
				event: "disposed",
				now: NOW,
				evidence: {
					v: 1,
					kind: "manual_operator_disposal",
					ref: id,
					actor: "operator",
					actor_kind: "lead",
					fence: { question_id: questionId },
				},
			});
		} finally {
			queue.close();
		}

		expect(() =>
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: id,
				expectedExecutionId: "exec-1",
				reason: "session_terminal",
				now: "2026-07-24T00:02:00.000Z",
			}),
		).toThrow(/conflicting disposed evidence/);
	});

	it("rejects lineage that belongs to a different execution", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "help");
		expect(() =>
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: receiptId(questionId),
				expectedExecutionId: "other-exec",
				reason: "session_terminal",
				now: NOW,
			}),
		).toThrow(/lineage/i);
	});

	it("resolves permanent lineage after the live mailbox row was archived", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "help");
		const id = receiptId(questionId);
		const queue = new MailboxQueue(dbPath);
		try {
			queue.ack(questionId, NOW);
			const raw = new Database(dbPath);
			try {
				raw
					.prepare(
						"UPDATE mailbox SET relay_state = 'terminal_disposed' WHERE id = ?",
					)
					.run(questionId);
			} finally {
				raw.close();
			}
			expect(
				queue.archiveFamily({
					id: questionId,
					now: "2026-07-28T00:02:00.000Z",
				}),
			).toBe("archived");
		} finally {
			queue.close();
		}

		expect(db.listReceiptRootsForExecution("exec-1")).toEqual([id]);
		expect(db.getReceiptSettlementLineage(id)).toMatchObject({
			receiptId: id,
			executionId: "exec-1",
			questionId,
		});
		expect(
			db.settleReceiptFamilyForTerminalSubject({
				receiptId: id,
				expectedExecutionId: "exec-1",
				reason: "session_terminal",
				now: "2026-07-28T00:03:00.000Z",
			}),
		).toEqual({ kind: "disposed", receiptId: id });
	});
});
