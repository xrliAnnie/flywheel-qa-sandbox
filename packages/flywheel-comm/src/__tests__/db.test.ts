import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("CommDB", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-test-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("schema creation", () => {
		it("should create database with WAL mode", () => {
			// If we got here without error, schema was created successfully
			expect(db).toBeDefined();
		});
	});

	describe("ask/check round-trip", () => {
		it("should insert a question and retrieve response", () => {
			const questionId = db.insertQuestion(
				"runner-1",
				"product-lead",
				"Should I use REST or GraphQL?",
			);
			expect(questionId).toBeTruthy();

			// No response yet
			const noResponse = db.getResponse(questionId);
			expect(noResponse).toBeUndefined();

			// Insert response
			db.insertResponse(questionId, "product-lead", "Use REST for simplicity.");

			// Now response should exist
			const response = db.getResponse(questionId);
			expect(response).toBeDefined();
			expect(response!.content).toBe("Use REST for simplicity.");
			expect(response!.from_agent).toBe("product-lead");
			expect(response!.to_agent).toBe("runner-1");
			expect(response!.parent_id).toBe(questionId);
		});

		it("should prevent duplicate responses (UNIQUE index)", () => {
			const questionId = db.insertQuestion(
				"runner-1",
				"product-lead",
				"Question?",
			);
			db.insertResponse(questionId, "product-lead", "Answer 1");
			expect(() =>
				db.insertResponse(questionId, "product-lead", "Answer 2"),
			).toThrow();
		});
	});

	describe("pending questions", () => {
		it("should list unanswered questions for a lead", () => {
			const q1 = db.insertQuestion("runner-1", "product-lead", "Q1?");
			const q2 = db.insertQuestion("runner-2", "product-lead", "Q2?");
			const _q3 = db.insertQuestion("runner-1", "ops-lead", "Q3?");

			// All pending for product-lead
			let pending = db.getPendingQuestions("product-lead");
			expect(pending).toHaveLength(2);
			expect(pending[0]!.id).toBe(q1);
			expect(pending[1]!.id).toBe(q2);

			// Answer q1
			db.insertResponse(q1, "product-lead", "A1");
			pending = db.getPendingQuestions("product-lead");
			expect(pending).toHaveLength(1);
			expect(pending[0]!.id).toBe(q2);

			// ops-lead has 1 pending
			expect(db.getPendingQuestions("ops-lead")).toHaveLength(1);
		});
	});

	describe("expiry", () => {
		it("should purge expired messages", () => {
			// Insert a question, then manually set expires_at to past
			const qId = db.insertQuestion("runner-1", "product-lead", "Old Q?");
			// Access internal db to force expire
			(db as any).db
				.prepare(
					"UPDATE messages SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
				)
				.run(qId);

			const purged = db.purgeExpired();
			expect(purged).toBe(1);

			// Should not appear in pending
			expect(db.getPendingQuestions("product-lead")).toHaveLength(0);
		});
	});

	describe("error handling", () => {
		it("should throw when responding to non-existent question", () => {
			expect(() =>
				db.insertResponse("non-existent-id", "product-lead", "Answer"),
			).toThrow("Question non-existent-id not found");
		});
	});

	describe("concurrent access (WAL)", () => {
		it("should allow concurrent read/write via separate connections", () => {
			const dbPath = join(tmpDir, "concurrent.db");
			const db1 = new CommDB(dbPath);
			const db2 = new CommDB(dbPath);

			const qId = db1.insertQuestion("runner-1", "product-lead", "Q?");
			// db2 should see it immediately (WAL)
			const pending = db2.getPendingQuestions("product-lead");
			expect(pending).toHaveLength(1);
			expect(pending[0]!.id).toBe(qId);

			db1.close();
			db2.close();
		});
	});

	describe("schema migration", () => {
		it("should add read_at column to existing database on reopen", () => {
			const dbPath = join(tmpDir, "migrate.db");
			const db1 = new CommDB(dbPath);
			const qId = db1.insertQuestion("runner-1", "lead", "Q?");
			db1.close();

			// Reopen — migration should run
			const db2 = new CommDB(dbPath);
			const columns = (db2 as any).db
				.prepare("PRAGMA table_info(messages)")
				.all() as Array<{ name: string }>;
			expect(columns.some((c: { name: string }) => c.name === "read_at")).toBe(
				true,
			);

			// Existing data intact
			const pending = db2.getPendingQuestions("lead");
			expect(pending).toHaveLength(1);
			expect(pending[0]!.id).toBe(qId);
			db2.close();
		});

		it("should create sessions table on new database", () => {
			const tables = (db as any).db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all() as Array<{ name: string }>;
			expect(tables.some((t: { name: string }) => t.name === "sessions")).toBe(
				true,
			);
		});
	});

	describe("instruction CRUD", () => {
		it("should insert and retrieve unread instructions", () => {
			const instId = db.insertInstruction(
				"product-lead",
				"exec-123",
				"Stop current work",
			);
			expect(instId).toBeTruthy();

			const unread = db.getUnreadInstructions("exec-123");
			expect(unread).toHaveLength(1);
			expect(unread[0]!.id).toBe(instId);
			expect(unread[0]!.content).toBe("Stop current work");
			expect(unread[0]!.from_agent).toBe("product-lead");
			expect(unread[0]!.type).toBe("instruction");
			expect(unread[0]!.read_at).toBeNull();
		});

		it("should mark instruction as read", () => {
			const instId = db.insertInstruction("product-lead", "exec-123", "Do X");
			db.markInstructionRead(instId);

			const unread = db.getUnreadInstructions("exec-123");
			expect(unread).toHaveLength(0);
		});

		it("should handle multiple instructions for different runners", () => {
			db.insertInstruction("product-lead", "exec-1", "Instruction for 1");
			db.insertInstruction("product-lead", "exec-2", "Instruction for 2");
			db.insertInstruction("ops-lead", "exec-1", "Another for 1");

			expect(db.getUnreadInstructions("exec-1")).toHaveLength(2);
			expect(db.getUnreadInstructions("exec-2")).toHaveLength(1);
		});
	});

	describe("hasPendingQuestionsFrom", () => {
		it("should return true when runner has unanswered questions", () => {
			db.insertQuestion("exec-abc", "product-lead", "Q?");
			expect(db.hasPendingQuestionsFrom("exec-abc")).toBe(true);
		});

		it("should return false when all questions are answered", () => {
			const qId = db.insertQuestion("exec-abc", "product-lead", "Q?");
			db.insertResponse(qId, "product-lead", "A");
			expect(db.hasPendingQuestionsFrom("exec-abc")).toBe(false);
		});

		it("should not be affected by other runners questions", () => {
			db.insertQuestion("other-exec", "product-lead", "Q from other?");
			expect(db.hasPendingQuestionsFrom("my-exec")).toBe(false);
		});
	});

	describe("session CRUD", () => {
		it("should register and retrieve a session", () => {
			db.registerSession(
				"exec-1",
				"@42",
				"geoforge3d",
				"GEO-208",
				"product-lead",
			);

			const session = db.getSession("exec-1");
			expect(session).toBeDefined();
			expect(session!.tmux_window).toBe("@42");
			expect(session!.project_name).toBe("geoforge3d");
			expect(session!.issue_id).toBe("GEO-208");
			expect(session!.lead_id).toBe("product-lead");
			expect(session!.status).toBe("running");
			expect(session!.ended_at).toBeNull();
		});

		it("should list active sessions", () => {
			db.registerSession("exec-1", "@42", "geoforge3d", "GEO-208");
			db.registerSession("exec-2", "@43", "geoforge3d", "GEO-209");
			db.registerSession("exec-3", "@44", "other-project", "GEO-210");

			expect(db.getActiveSessions("geoforge3d")).toHaveLength(2);
			expect(db.getActiveSessions("other-project")).toHaveLength(1);
			expect(db.getActiveSessions()).toHaveLength(3);
		});

		it("should update session status", () => {
			db.registerSession("exec-1", "@42", "geoforge3d");
			db.updateSessionStatus("exec-1", "completed");

			const session = db.getSession("exec-1");
			expect(session!.status).toBe("completed");
			expect(session!.ended_at).not.toBeNull();

			// No longer active
			expect(db.getActiveSessions()).toHaveLength(0);
		});

		it("should list sessions with filters", () => {
			db.registerSession("exec-1", "@42", "geoforge3d");
			db.registerSession("exec-2", "@43", "geoforge3d");
			db.updateSessionStatus("exec-1", "timeout");

			// All for project
			expect(db.listSessions("geoforge3d")).toHaveLength(2);

			// Filter by status
			expect(db.listSessions(undefined, ["running"])).toHaveLength(1);
			expect(db.listSessions(undefined, ["timeout"])).toHaveLength(1);
			expect(
				db.listSessions("geoforge3d", ["running", "timeout"]),
			).toHaveLength(2);
		});
	});

	describe("cleanupReadMessages", () => {
		it("should delete read messages older than TTL", () => {
			const instId = db.insertInstruction(
				"product-lead",
				"exec-123",
				"Old instruction",
			);
			db.markInstructionRead(instId);
			// Backdate created_at to 25 hours ago
			(db as any).db
				.prepare(
					"UPDATE messages SET created_at = datetime('now', '-25 hours') WHERE id = ?",
				)
				.run(instId);

			const cleaned = db.cleanupReadMessages(24);
			expect(cleaned).toBe(1);
		});

		it("should NOT delete read messages within TTL window", () => {
			const instId = db.insertInstruction(
				"product-lead",
				"exec-123",
				"Recent instruction",
			);
			db.markInstructionRead(instId);
			// created_at is now — within 24h window

			const cleaned = db.cleanupReadMessages(24);
			expect(cleaned).toBe(0);
		});

		it("should NOT delete unread messages regardless of age", () => {
			const instId = db.insertInstruction(
				"product-lead",
				"exec-123",
				"Unread old instruction",
			);
			// Backdate but do NOT mark as read
			(db as any).db
				.prepare(
					"UPDATE messages SET created_at = datetime('now', '-48 hours') WHERE id = ?",
				)
				.run(instId);

			const cleaned = db.cleanupReadMessages(24);
			expect(cleaned).toBe(0);

			// Message should still exist
			const unread = db.getUnreadInstructions("exec-123");
			expect(unread).toHaveLength(1);
		});

		it("should use 24h default TTL when no argument provided", () => {
			const instId = db.insertInstruction(
				"product-lead",
				"exec-123",
				"Default TTL test",
			);
			db.markInstructionRead(instId);
			(db as any).db
				.prepare(
					"UPDATE messages SET created_at = datetime('now', '-25 hours') WHERE id = ?",
				)
				.run(instId);

			const cleaned = db.cleanupReadMessages();
			expect(cleaned).toBe(1);
		});

		it("should clean up read questions and responses too", () => {
			const qId = db.insertQuestion("runner-1", "product-lead", "Q?");
			db.insertResponse(qId, "product-lead", "A");

			// Mark both as read and backdate
			(db as any).db
				.prepare(
					"UPDATE messages SET read_at = datetime('now', '-25 hours'), created_at = datetime('now', '-25 hours')",
				)
				.run();

			const cleaned = db.cleanupReadMessages(24);
			expect(cleaned).toBe(2); // question + response
		});

		it("should return 0 when no messages to clean", () => {
			const cleaned = db.cleanupReadMessages(24);
			expect(cleaned).toBe(0);
		});
	});

	describe("openReadonly", () => {
		it("should open database without running schema or purge", () => {
			const dbPath = join(tmpDir, "readonly-test.db");
			// First create with normal constructor
			const dbWrite = new CommDB(dbPath);
			dbWrite.insertQuestion("runner-1", "lead", "Q?");
			dbWrite.close();

			// Open readonly
			const dbRead = CommDB.openReadonly(dbPath);
			expect(dbRead.hasPendingQuestionsFrom("runner-1")).toBe(true);
			dbRead.close();
		});

		it("should allow read while writer is open", () => {
			const dbPath = join(tmpDir, "readonly-concurrent.db");
			const dbWrite = new CommDB(dbPath);
			const qId = dbWrite.insertQuestion("runner-1", "lead", "Q?");

			const dbRead = CommDB.openReadonly(dbPath);
			expect(dbRead.hasPendingQuestionsFrom("runner-1")).toBe(true);

			// Writer responds — reader should see it
			dbWrite.insertResponse(qId, "lead", "A");
			expect(dbRead.hasPendingQuestionsFrom("runner-1")).toBe(false);

			dbRead.close();
			dbWrite.close();
		});
	});

	// ── FLY-109: push-path helpers (delivered_at + ack semantics) ──

	describe("FLY-109 push-path helpers", () => {
		it("should add delivered_at column via migration", () => {
			const dbPath = join(tmpDir, "delivered-migrate.db");
			const db1 = new CommDB(dbPath);
			db1.close();

			const db2 = new CommDB(dbPath);
			const columns = (db2 as any).db
				.prepare("PRAGMA table_info(messages)")
				.all() as Array<{ name: string }>;
			expect(
				columns.some((c: { name: string }) => c.name === "delivered_at"),
			).toBe(true);
			db2.close();
		});

		it("should be idempotent when migration runs multiple times", () => {
			const dbPath = join(tmpDir, "delivered-idempotent.db");
			const db1 = new CommDB(dbPath);
			db1.close();
			const db2 = new CommDB(dbPath);
			db2.close();
			// Third open should not throw
			expect(() => {
				const db3 = new CommDB(dbPath);
				db3.close();
			}).not.toThrow();
		});

		it("getPendingPushInstructions returns undelivered instructions", () => {
			const id1 = db.insertInstruction("bridge", "lead-1", "msg 1");
			db.insertInstruction("bridge", "lead-1", "msg 2");

			const pending = db.getPendingPushInstructions("lead-1", 30);
			expect(pending).toHaveLength(2);
			expect(pending[0]!.id).toBe(id1);
			expect(pending[0]!.delivered_at).toBeNull();
		});

		it("getPendingPushInstructions hides delivered messages within retry window", () => {
			const id = db.insertInstruction("bridge", "lead-1", "msg");
			db.markInstructionDelivered(id);

			const pending = db.getPendingPushInstructions("lead-1", 30);
			expect(pending).toHaveLength(0);
		});

		it("getPendingPushInstructions re-surfaces messages after retry window", () => {
			const id = db.insertInstruction("bridge", "lead-1", "stale");
			db.markInstructionDelivered(id);
			// Backdate delivered_at 60s ago
			(db as any).db
				.prepare(
					"UPDATE messages SET delivered_at = datetime('now', '-60 seconds') WHERE id = ?",
				)
				.run(id);

			const pending = db.getPendingPushInstructions("lead-1", 30);
			expect(pending).toHaveLength(1);
			expect(pending[0]!.id).toBe(id);
			expect(pending[0]!.delivered_at).not.toBeNull();
		});

		it("getPendingPushInstructions hides acked messages regardless of retry window", () => {
			const id = db.insertInstruction("bridge", "lead-1", "acked");
			db.markInstructionDelivered(id);
			db.ackInstructionRead(id);
			// Backdate delivered_at far past retry window
			(db as any).db
				.prepare(
					"UPDATE messages SET delivered_at = datetime('now', '-600 seconds') WHERE id = ?",
				)
				.run(id);

			const pending = db.getPendingPushInstructions("lead-1", 30);
			expect(pending).toHaveLength(0);
		});

		it("markInstructionDelivered sets delivered_at to now", () => {
			const id = db.insertInstruction("bridge", "lead-1", "msg");
			db.markInstructionDelivered(id);

			const row = (db as any).db
				.prepare("SELECT delivered_at FROM messages WHERE id = ?")
				.get(id) as { delivered_at: string | null };
			expect(row.delivered_at).not.toBeNull();
		});

		it("markInstructionDelivered is idempotent — refreshes delivered_at on repeat", () => {
			const id = db.insertInstruction("bridge", "lead-1", "msg");
			db.markInstructionDelivered(id);
			// Backdate delivered_at
			(db as any).db
				.prepare(
					"UPDATE messages SET delivered_at = datetime('now', '-60 seconds') WHERE id = ?",
				)
				.run(id);
			const before = (db as any).db
				.prepare("SELECT delivered_at FROM messages WHERE id = ?")
				.get(id) as { delivered_at: string };

			// Re-deliver
			db.markInstructionDelivered(id);
			const after = (db as any).db
				.prepare("SELECT delivered_at FROM messages WHERE id = ?")
				.get(id) as { delivered_at: string };
			expect(after.delivered_at > before.delivered_at).toBe(true);
		});

		it("ackInstructionRead sets read_at", () => {
			const id = db.insertInstruction("bridge", "lead-1", "msg");
			db.markInstructionDelivered(id);
			db.ackInstructionRead(id);

			const row = (db as any).db
				.prepare("SELECT read_at FROM messages WHERE id = ?")
				.get(id) as { read_at: string | null };
			expect(row.read_at).not.toBeNull();
		});

		it("ackInstructionRead is idempotent — preserves original read_at on repeat", () => {
			const id = db.insertInstruction("bridge", "lead-1", "msg");
			db.markInstructionDelivered(id);
			db.ackInstructionRead(id);

			const first = (db as any).db
				.prepare("SELECT read_at FROM messages WHERE id = ?")
				.get(id) as { read_at: string };

			db.ackInstructionRead(id);

			const second = (db as any).db
				.prepare("SELECT read_at FROM messages WHERE id = ?")
				.get(id) as { read_at: string };
			expect(second.read_at).toBe(first.read_at);
		});

		it("ackInstructionRead is a no-op for unknown id (no throw)", () => {
			expect(() => db.ackInstructionRead("nonexistent-id")).not.toThrow();
		});

		it("does NOT change getUnreadInstructions semantics — CLI pull path unaffected by delivered_at", () => {
			// Instruction marked delivered but NOT acked — CLI pull should still see it
			const id = db.insertInstruction("bridge", "lead-1", "delivered not acked");
			db.markInstructionDelivered(id);

			const unread = db.getUnreadInstructions("lead-1");
			expect(unread).toHaveLength(1);
			expect(unread[0]!.id).toBe(id);
		});

		it("markInstructionRead (CLI pull path) still hides from getUnreadInstructions", () => {
			const id = db.insertInstruction("bridge", "lead-1", "cli path");
			db.markInstructionRead(id);

			expect(db.getUnreadInstructions("lead-1")).toHaveLength(0);
		});

		it("getPendingPushInstructions filters out expired instructions", () => {
			const id = db.insertInstruction("bridge", "lead-1", "expired");
			(db as any).db
				.prepare(
					"UPDATE messages SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
				)
				.run(id);

			expect(db.getPendingPushInstructions("lead-1", 30)).toHaveLength(0);
		});

		it("getPendingPushInstructions returns FIFO by created_at", () => {
			const id1 = db.insertInstruction("bridge", "lead-1", "first");
			const id2 = db.insertInstruction("bridge", "lead-1", "second");

			const pending = db.getPendingPushInstructions("lead-1", 30);
			expect(pending[0]!.id).toBe(id1);
			expect(pending[1]!.id).toBe(id2);
		});
	});
});
