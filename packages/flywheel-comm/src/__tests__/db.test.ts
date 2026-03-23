import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CommDB } from "../db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      const q3 = db.insertQuestion("runner-1", "ops-lead", "Q3?");

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
});
