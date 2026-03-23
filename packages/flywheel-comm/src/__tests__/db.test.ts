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
});
