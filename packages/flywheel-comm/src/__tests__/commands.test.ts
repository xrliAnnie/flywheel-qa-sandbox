import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ask } from "../commands/ask.js";
import { check } from "../commands/check.js";
import { pending } from "../commands/pending.js";
import { respond } from "../commands/respond.js";

describe("commands round-trip", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-cmd-"));
    dbPath = join(tmpDir, "comm.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should complete a full ask → pending → respond → check cycle", () => {
    // Runner asks a question
    const questionId = ask({
      lead: "product-lead",
      execId: "exec-123",
      question: "Should I use REST or GraphQL?",
      dbPath,
    });
    expect(questionId).toBeTruthy();

    // Check: not yet answered
    const beforeAnswer = check({ questionId, dbPath });
    expect(beforeAnswer.status).toBe("pending");
    expect(beforeAnswer.content).toBeUndefined();

    // Lead sees pending question
    const pendingQs = pending({ lead: "product-lead", dbPath });
    expect(pendingQs).toHaveLength(1);
    expect(pendingQs[0]!.id).toBe(questionId);
    expect(pendingQs[0]!.from_agent).toBe("exec-123");
    expect(pendingQs[0]!.content).toBe("Should I use REST or GraphQL?");

    // Lead responds
    respond({
      questionId,
      fromAgent: "product-lead",
      answer: "Use REST for simplicity.",
      dbPath,
    });

    // Check: now answered
    const afterAnswer = check({ questionId, dbPath });
    expect(afterAnswer.status).toBe("answered");
    expect(afterAnswer.content).toBe("Use REST for simplicity.");

    // No more pending
    expect(pending({ lead: "product-lead", dbPath })).toHaveLength(0);
  });

  it("should handle multiple runners asking different leads", () => {
    const q1 = ask({
      lead: "product-lead",
      question: "Q1 from runner-1",
      dbPath,
    });
    const q2 = ask({
      lead: "product-lead",
      question: "Q2 from runner-2",
      dbPath,
    });
    const q3 = ask({
      lead: "ops-lead",
      question: "Q3 from runner-1",
      dbPath,
    });

    expect(pending({ lead: "product-lead", dbPath })).toHaveLength(2);
    expect(pending({ lead: "ops-lead", dbPath })).toHaveLength(1);

    respond({ questionId: q1, fromAgent: "product-lead", answer: "A1", dbPath });
    expect(pending({ lead: "product-lead", dbPath })).toHaveLength(1);
  });

  it("should use 'runner' as default from_agent when execId not provided", () => {
    const qId = ask({
      lead: "product-lead",
      question: "A question",
      dbPath,
    });

    const pendingQs = pending({ lead: "product-lead", dbPath });
    expect(pendingQs[0]!.from_agent).toBe("runner");
  });

  it("should throw when responding to non-existent question", () => {
    expect(() =>
      respond({
        questionId: "non-existent",
        fromAgent: "product-lead",
        answer: "Answer",
        dbPath,
      }),
    ).toThrow("not found");
  });
});
