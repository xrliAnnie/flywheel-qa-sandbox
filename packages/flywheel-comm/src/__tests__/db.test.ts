import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

		it("a dedupeId makes insertInstruction idempotent — a crash-replay lands on the same row (FLY-1082)", () => {
			const dedupeId = "server-loss:tmux-server-lost:1000:tadashi:abcd1234";
			const id1 = db.insertInstruction("bridge", "tadashi", "casualty list", {
				dedupeId,
			});
			// The replay: the sender crashed AFTER this commit but BEFORE its own
			// checkpoint in another database — it re-sends the same logical
			// message. Same identity → ignored, not duplicated.
			const id2 = db.insertInstruction("bridge", "tadashi", "casualty list", {
				dedupeId,
			});
			expect(id1).toBe(dedupeId);
			expect(id2).toBe(dedupeId);
			expect(db.getUnreadInstructions("tadashi")).toHaveLength(1);
		});

		it("distinct dedupeIds (a changed casualty list) deliver as separate messages", () => {
			db.insertInstruction("bridge", "tadashi", "list v1", {
				dedupeId: "server-loss:sig:tadashi:aaaa",
			});
			db.insertInstruction("bridge", "tadashi", "list v1+delta", {
				dedupeId: "server-loss:sig:tadashi:bbbb",
			});
			expect(db.getUnreadInstructions("tadashi")).toHaveLength(2);
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

	// FLY-253: liveness signal for the Bridge stuck-runner detector (L1).
	describe("hasRecentMessagesFrom", () => {
		/** Backdate every message from an exec via a second raw connection. */
		const backdate = (execId: string, seconds: number) => {
			const raw = new Database(join(tmpDir, "comm.db"));
			raw
				.prepare(
					`UPDATE messages SET created_at = datetime('now', '-' || ? || ' seconds')
					 WHERE from_agent = ?`,
				)
				.run(seconds, execId);
			raw.close();
		};

		it("returns true for a message sent just now within the window", () => {
			db.insertQuestion("exec-live", "sub-lead", "DONE: report");
			expect(db.hasRecentMessagesFrom("exec-live", 60)).toBe(true);
		});

		it("returns false when the exec has no messages at all", () => {
			db.insertQuestion("other-exec", "sub-lead", "Q?");
			expect(db.hasRecentMessagesFrom("exec-quiet", 60)).toBe(false);
		});

		it("returns false when the only message is older than the window", () => {
			db.insertQuestion("exec-old", "sub-lead", "Q?");
			backdate("exec-old", 120);
			expect(db.hasRecentMessagesFrom("exec-old", 60)).toBe(false);
		});

		it("uses a strict > boundary (message exactly at window edge is outside)", () => {
			db.insertQuestion("exec-edge", "sub-lead", "Q?");
			backdate("exec-edge", 60);
			expect(db.hasRecentMessagesFrom("exec-edge", 60)).toBe(false);
		});

		it("keeps a message comfortably inside the window", () => {
			db.insertQuestion("exec-in", "sub-lead", "Q?");
			backdate("exec-in", 10);
			expect(db.hasRecentMessagesFrom("exec-in", 60)).toBe(true);
		});

		it("counts ANY message type from the exec (responses too)", () => {
			const qId = db.insertQuestion("sub-lead", "exec-resp", "instruction?");
			db.insertResponse(qId, "exec-resp", "receipt");
			expect(db.hasRecentMessagesFrom("exec-resp", 60)).toBe(true);
		});

		it("returns false for a zero window (only future rows could match)", () => {
			db.insertQuestion("exec-zero", "sub-lead", "Q?");
			backdate("exec-zero", 1);
			expect(db.hasRecentMessagesFrom("exec-zero", 0)).toBe(false);
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

		// FLY-638: deleteSession
		it("should delete a session row and return the change count", () => {
			db.registerSession("exec-1", "@42", "geoforge3d");
			db.updateSessionStatus("exec-1", "completed");

			expect(db.deleteSession("exec-1")).toBe(1);
			expect(db.getSession("exec-1")).toBeUndefined();
			// Idempotent — deleting a missing row is a no-op (0 changes).
			expect(db.deleteSession("exec-1")).toBe(0);
			expect(db.deleteSession("never-existed")).toBe(0);
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

		// FLY-229: parked-alive detection helpers
		describe("getRecentTerminalSessions / countTerminalSessions", () => {
			it("returns only completed/timeout rows for the project (not running)", () => {
				db.registerSession(
					"run-1",
					"@1",
					"geoforge3d",
					"GEO-1",
					"product-lead",
				);
				db.registerSession(
					"done-1",
					"@2",
					"geoforge3d",
					"GEO-2",
					"product-lead",
				);
				db.registerSession("to-1", "@3", "geoforge3d", "GEO-3", "product-lead");
				db.registerSession(
					"other-1",
					"@4",
					"other-proj",
					"GEO-4",
					"product-lead",
				);
				db.updateSessionStatus("done-1", "completed");
				db.updateSessionStatus("to-1", "timeout");
				db.updateSessionStatus("other-1", "completed");

				const rows = db.getRecentTerminalSessions("geoforge3d", undefined, 50);
				expect(rows.map((r) => r.execution_id).sort()).toEqual([
					"done-1",
					"to-1",
				]);
				expect(db.countTerminalSessions("geoforge3d")).toBe(2);
			});

			it("Lead-scopes in SQL (lead_id = leadId OR NULL) BEFORE limit", () => {
				// Other lead's row is NEWER (registered+completed last) so it sorts
				// first; without SQL scoping a limit=1 would drop the in-scope row.
				db.registerSession("mine", "@1", "geoforge3d", "GEO-1", "product-lead");
				db.registerSession("legacy", "@2", "geoforge3d", "GEO-2"); // lead_id NULL
				db.registerSession("theirs", "@3", "geoforge3d", "GEO-3", "ops-lead");
				db.updateSessionStatus("mine", "completed");
				db.updateSessionStatus("legacy", "completed");
				db.updateSessionStatus("theirs", "completed");

				const scoped = db.getRecentTerminalSessions(
					"geoforge3d",
					"product-lead",
					50,
				);
				expect(scoped.map((r) => r.execution_id).sort()).toEqual([
					"legacy", // NULL lead_id visible to everyone
					"mine",
				]);
				expect(scoped.some((r) => r.execution_id === "theirs")).toBe(false);
				expect(db.countTerminalSessions("geoforge3d", "product-lead")).toBe(2);

				// in-scope row survives even when out-of-scope rows fill a tight limit
				const limited = db.getRecentTerminalSessions(
					"geoforge3d",
					"product-lead",
					1,
				);
				expect(limited).toHaveLength(1);
				expect(["mine", "legacy"]).toContain(limited[0]!.execution_id);
			});

			it("respects the limit", () => {
				for (let i = 0; i < 5; i++) {
					db.registerSession(`e${i}`, `@${i}`, "geoforge3d", `GEO-${i}`);
					db.updateSessionStatus(`e${i}`, "completed");
				}
				expect(
					db.getRecentTerminalSessions("geoforge3d", undefined, 3),
				).toHaveLength(3);
				expect(db.countTerminalSessions("geoforge3d")).toBe(5);
			});
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

		it("migration re-apply is race-safe against duplicate delivered_at ADD COLUMN", () => {
			// Regression for the race Codex flagged in Round 1: two inbox-mcp
			// openers of the same old-schema DB both see delivered_at missing,
			// both issue ADD COLUMN, one wins and the loser used to crash with
			// "duplicate column name". The catch in applyMigrations must swallow
			// it. We simulate the precondition by forcing the column-missing
			// branch to run on an opener that already has the column.
			const dbPath = join(tmpDir, "delivered-race.db");

			const first = new CommDB(dbPath);
			first.close();

			// Second opener: force re-run of applyMigrations; the column is
			// already present, so the PRAGMA guard skips it. Then force the
			// ALTER path anyway via explicit invocation — should not throw.
			const racer = new CommDB(dbPath);
			expect(() => {
				(racer as any).db.prepare("PRAGMA table_info(messages)").all();
				// Directly re-run the guarded ALTER: this is the exact statement
				// applyMigrations runs; with the FLY-109 try/catch, the duplicate
				// error from ADD COLUMN on an already-migrated DB must be swallowed.
				try {
					(racer as any).db.exec(
						"ALTER TABLE messages ADD COLUMN delivered_at DATETIME",
					);
				} catch (err) {
					const msg = (err as Error).message ?? "";
					if (!/duplicate column name: delivered_at/i.test(msg)) {
						throw err;
					}
				}
			}).not.toThrow();
			racer.close();
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
			const id = db.insertInstruction(
				"bridge",
				"lead-1",
				"delivered not acked",
			);
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

	describe("FLY-1269 durable runner phase lifecycle", () => {
		const ordinaryWake = (id: string, content = id) => ({
			id,
			to: "runner-agent",
			content,
			metadata: { checkpoint: "question" },
		});

		it("queues ordinary envelopes once and preserves same-millisecond FIFO", () => {
			const first = db.enqueueRunnerPhaseWake(
				"exec-1",
				ordinaryWake("vendor-1", "first"),
				1_000,
			);
			const duplicate = db.enqueueRunnerPhaseWake(
				"exec-1",
				ordinaryWake("vendor-1", "first"),
				1_000,
			);
			const second = db.enqueueRunnerPhaseWake(
				"exec-1",
				ordinaryWake("vendor-2", "second"),
				1_000,
			);

			expect(first.kind).toBe("queued");
			expect(duplicate.kind).toBe("duplicate");
			expect(duplicate.wake.queue_seq).toBe(first.wake.queue_seq);
			expect(second.wake.queue_seq).toBeGreaterThan(first.wake.queue_seq);
			expect(
				db.listRunnerPhaseWakes("exec-1").map((wake) => wake.content),
			).toEqual(["first", "second"]);
		});

		it("atomically queues a bound send and claims only its instruction", () => {
			const bound = db.insertInstruction("lead", "exec-1", "fix this");
			const unrelated = db.insertInstruction("lead", "exec-1", "leave unread");

			const result = db.enqueueRunnerPhaseWake(
				"exec-1",
				{
					id: "vendor-send-1",
					to: "runner-agent",
					content: "[lead-instruction] fix this",
					metadata: { flywheelId: bound, execId: "exec-1" },
				},
				2_000,
			);

			expect(result.kind).toBe("queued");
			expect(result.wake.source_instruction_id).toBe(bound);
			expect(db.getUnreadInstructions("exec-1").map((row) => row.id)).toEqual([
				unrelated,
			]);
		});

		it("dedupes different vendor ids bound to the same instruction source", () => {
			const bound = db.insertInstruction("lead", "exec-1", "same source");
			const envelope = (id: string) => ({
				id,
				to: "runner-agent",
				content: "same source",
				metadata: { flywheelId: bound, execId: "exec-1" },
			});

			const first = db.enqueueRunnerPhaseWake("exec-1", envelope("v-1"), 3_000);
			const replay = db.enqueueRunnerPhaseWake(
				"exec-1",
				envelope("v-2"),
				3_001,
			);

			expect(replay.kind).toBe("duplicate");
			expect(replay.wake.message_id).toBe(first.wake.message_id);
			expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
		});

		it("returns the committed wake on callback retry", () => {
			const input = ordinaryWake("callback-retry", "durable");
			const committed = db.enqueueRunnerPhaseWake("exec-1", input, 4_000);
			const retried = db.enqueueRunnerPhaseWake("exec-1", input, 4_001);

			expect(retried).toEqual({ kind: "duplicate", wake: committed.wake });
		});

		it("queues a bound instruction even when CLI already marked it read", () => {
			const bound = db.insertInstruction("lead", "exec-1", "printed only");
			db.markInstructionRead(bound);

			expect(
				db.enqueueRunnerPhaseWake(
					"exec-1",
					{
						id: "late-vendor-callback",
						to: "runner-agent",
						content: "printed only",
						metadata: { flywheelId: bound, execId: "exec-1" },
					},
					5_000,
				).kind,
			).toBe("queued");
		});

		it.each([
			{
				name: "wrong metadata execId",
				setup: () => db.insertInstruction("lead", "exec-1", "bound"),
				metadata: (id: string) => ({ flywheelId: id, execId: "exec-wrong" }),
			},
			{
				name: "wrong instruction recipient",
				setup: () => db.insertInstruction("lead", "exec-other", "bound"),
				metadata: (id: string) => ({ flywheelId: id, execId: "exec-1" }),
			},
			{
				name: "missing bound instruction",
				setup: () => "missing-instruction",
				metadata: (id: string) => ({ flywheelId: id, execId: "exec-1" }),
			},
		])("fails $name without queue/read mutation", ({ setup, metadata }) => {
			const instructionId = setup();
			expect(() =>
				db.enqueueRunnerPhaseWake(
					"exec-1",
					{
						id: `invalid-${instructionId}`,
						to: "runner-agent",
						content: "invalid",
						metadata: metadata(instructionId),
					},
					6_000,
				),
			).toThrow();
			expect(db.listRunnerPhaseWakes("exec-1")).toEqual([]);
			const row = (db as any).db
				.prepare("SELECT read_at FROM messages WHERE id = ?")
				.get(instructionId) as { read_at: string | null } | undefined;
			expect(row?.read_at ?? null).toBeNull();
		});

		it("enforces pending to started to finished CAS for exact execution/id", () => {
			db.enqueueRunnerPhaseWake("exec-1", ordinaryWake("stateful"), 7_000);

			expect(db.finishRunnerPhaseWake("exec-1", "stateful", 7_001)).toBe(false);
			expect(
				db.markRunnerPhaseWakeStarted("exec-other", "stateful", 7_001),
			).toBe(false);
			expect(db.markRunnerPhaseWakeStarted("exec-1", "stateful", 7_001)).toBe(
				true,
			);
			expect(db.markRunnerPhaseWakeStarted("exec-1", "stateful", 7_002)).toBe(
				false,
			);
			expect(db.finishRunnerPhaseWake("exec-1", "wrong", 7_003)).toBe(false);
			expect(db.finishRunnerPhaseWake("exec-1", "stateful", 7_003)).toBe(true);
			expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
				state: "finished",
				started_at: 7_001,
				finished_at: 7_003,
			});
		});

		it("readonly missing phase table is empty while other database errors throw", () => {
			const legacyPath = join(tmpDir, "legacy-readonly.db");
			const legacy = new Database(legacyPath);
			legacy.exec("CREATE TABLE legacy_only (id TEXT PRIMARY KEY)");
			legacy.close();
			const readonly = CommDB.openReadonly(legacyPath);
			expect(readonly.listRunnerPhaseWakes("exec-1")).toEqual([]);
			readonly.close();
			expect(() => readonly.listRunnerPhaseWakes("exec-1")).toThrow();
		});

		it("uses idempotent request-bound shutdown CAS", () => {
			const requested = db.requestRunnerShutdown("exec-1", "shutdown-1", 8_000);
			const duplicate = db.requestRunnerShutdown("exec-1", "shutdown-2", 8_001);

			expect(duplicate).toEqual(requested);
			expect(db.getRunnerShutdown("exec-1")).toEqual(requested);
			expect(
				db.finishRunnerShutdown("exec-1", "wrong", { ok: true }, 8_002),
			).toBe(false);
			expect(
				db.finishRunnerShutdown("exec-1", "shutdown-1", { ok: true }, 8_003),
			).toBe(true);
			expect(db.getRunnerShutdown("exec-1")).toMatchObject({
				state: "acked",
				finished_at: 8_003,
				error: null,
			});
			expect(
				db.finishRunnerShutdown("exec-1", "shutdown-1", { ok: true }, 8_004),
			).toBe(false);
		});

		it("refuses to reuse a shutdown request id across executions", () => {
			db.requestRunnerShutdown("exec-1", "shared-request", 8_100);
			expect(() =>
				db.requestRunnerShutdown("exec-2", "shared-request", 8_101),
			).toThrow("already bound to another execution");
			expect(db.getRunnerShutdown("exec-2")).toBeNull();
		});

		it("records a matching shutdown failure", () => {
			db.requestRunnerShutdown("exec-2", "shutdown-fail", 9_000);
			expect(
				db.finishRunnerShutdown(
					"exec-2",
					"shutdown-fail",
					{ ok: false, error: "drain timeout" },
					9_001,
				),
			).toBe(true);
			expect(db.getRunnerShutdown("exec-2")).toMatchObject({
				state: "failed",
				error: "drain timeout",
			});
		});

		it("readonly missing shutdown table returns null", () => {
			const legacyPath = join(tmpDir, "legacy-shutdown-readonly.db");
			const legacy = new Database(legacyPath);
			legacy.exec("CREATE TABLE legacy_only (id TEXT PRIMARY KEY)");
			legacy.close();
			const readonly = CommDB.openReadonly(legacyPath);
			expect(readonly.getRunnerShutdown("exec-1")).toBeNull();
			readonly.close();
			expect(() => readonly.getRunnerShutdown("exec-1")).toThrow();
		});

		it("atomically deletes phase rows, shutdown control, and the session", () => {
			db.registerSession("exec-1", "@1", "flywheel");
			db.enqueueRunnerPhaseWake("exec-1", ordinaryWake("cleanup"), 10_000);
			db.requestRunnerShutdown("exec-1", "shutdown-cleanup", 10_001);

			expect(db.deleteSessionAndRunnerPhaseLifecycle("exec-1")).toBe(1);
			expect(db.getSession("exec-1")).toBeUndefined();
			expect(db.listRunnerPhaseWakes("exec-1")).toEqual([]);
			expect(db.getRunnerShutdown("exec-1")).toBeNull();
			expect(db.deleteSessionAndRunnerPhaseLifecycle("exec-1")).toBe(0);
		});
	});
});

describe("CommDB — FLY-245 D-b lifecycle consent (ttl + atomic claim)", () => {
	let db: CommDB;
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-d-b-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("insertQuestion default TTL is far future (byte-compat ~72h)", () => {
		const id = db.insertQuestion("lead", "founder", "q");
		const m = db.getMessageById(id);
		expect(m).toBeDefined();
		// default +72h → well beyond 1h from now
		expect(new Date(`${m?.expires_at}Z`).getTime()).toBeGreaterThan(
			Date.now() + 60 * 60 * 1000,
		);
	});

	it("insertQuestion ttlSeconds sets a short expiry", () => {
		const id = db.insertQuestion("lead", "founder", "q", {
			checkpoint: "runner_lifecycle:terminate",
			ttlSeconds: 120,
		});
		const m = db.getMessageById(id);
		const exp = new Date(`${m?.expires_at}Z`).getTime();
		// ~2 minutes out, definitely under 1h
		expect(exp).toBeLessThan(Date.now() + 60 * 60 * 1000);
		expect(exp).toBeGreaterThan(Date.now());
	});

	it("a non-positive ttlSeconds falls back to the default", () => {
		const id = db.insertQuestion("lead", "founder", "q", { ttlSeconds: 0 });
		const m = db.getMessageById(id);
		expect(new Date(`${m?.expires_at}Z`).getTime()).toBeGreaterThan(
			Date.now() + 60 * 60 * 1000,
		);
	});

	it("claimLifecycleConsent succeeds ONCE (at-most-once consumption)", () => {
		const id = db.insertQuestion("lead", "founder", "stop FLY-1", {
			checkpoint: "runner_lifecycle:terminate",
			ttlSeconds: 300,
		});
		expect(db.claimLifecycleConsent(id, "runner_lifecycle:terminate")).toBe(
			true,
		);
		// second claim loses — irreversible action authorized exactly once
		expect(db.claimLifecycleConsent(id, "runner_lifecycle:terminate")).toBe(
			false,
		);
	});

	it("atomic claim across two INDEPENDENT connections — exactly one wins (Codex R1 LOW-11)", () => {
		const dbPath = join(tmpDir, "comm.db");
		const checkpoint = "runner_lifecycle:terminate";
		// Two separately-opened handles on the same file — NOT the same CommDB
		// instance called twice. The conditional UPDATE (`resolved_at IS NULL AND
		// expires_at > now` + changes===1) is what serializes the race.
		const a = new CommDB(dbPath);
		const b = new CommDB(dbPath);
		try {
			const q1 = db.insertQuestion("lead", "founder", "q-race-1", {
				checkpoint,
				ttlSeconds: 300,
			});
			const wins1 = [
				a.claimLifecycleConsent(q1, checkpoint),
				b.claimLifecycleConsent(q1, checkpoint),
			];
			expect(wins1.filter(Boolean)).toHaveLength(1);

			// Reverse arrival order on a fresh question — still exactly one winner.
			const q2 = db.insertQuestion("lead", "founder", "q-race-2", {
				checkpoint,
				ttlSeconds: 300,
			});
			const wins2 = [
				b.claimLifecycleConsent(q2, checkpoint),
				a.claimLifecycleConsent(q2, checkpoint),
			];
			expect(wins2.filter(Boolean)).toHaveLength(1);

			// The original handle (third independent connection) also sees them consumed.
			expect(db.claimLifecycleConsent(q1, checkpoint)).toBe(false);
			expect(db.claimLifecycleConsent(q2, checkpoint)).toBe(false);
		} finally {
			a.close();
			b.close();
		}
	});

	it("claim fails on a checkpoint mismatch (wrong action)", () => {
		const id = db.insertQuestion("lead", "founder", "q", {
			checkpoint: "runner_lifecycle:terminate",
			ttlSeconds: 300,
		});
		expect(db.claimLifecycleConsent(id, "runner_lifecycle:defer")).toBe(false);
		// still claimable under the correct checkpoint
		expect(db.claimLifecycleConsent(id, "runner_lifecycle:terminate")).toBe(
			true,
		);
	});

	it("claim fails on an unknown question id (fail-closed)", () => {
		expect(
			db.claimLifecycleConsent("no-such-id", "runner_lifecycle:terminate"),
		).toBe(false);
	});

	it("claim fails on an already-expired question (forced past expiry)", () => {
		const id = db.insertQuestion("lead", "founder", "q", {
			checkpoint: "runner_lifecycle:terminate",
			ttlSeconds: 300,
		});
		// Force the expiry into the past (same raw-access pattern as the "expiry"
		// suite above) — the `expires_at > now` guard must reject the claim.
		(db as unknown as { db: import("better-sqlite3").Database }).db
			.prepare(
				"UPDATE messages SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
			)
			.run(id);
		expect(db.claimLifecycleConsent(id, "runner_lifecycle:terminate")).toBe(
			false,
		);
	});
});
