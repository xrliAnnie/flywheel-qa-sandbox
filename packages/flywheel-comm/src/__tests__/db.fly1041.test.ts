/**
 * FLY-1041 — CommDB primitives for the single-bindable-ship-gate invariant.
 *
 * `retireShipGate` is the retire-on-rebind primitive: expire a SUPERSEDED
 * approve_to_ship gate NOW (resolveGate(qid, 0) semantics — getPendingQuestions
 * filters on `expires_at > now`, NOT resolved_at) so the founder can never bind
 * to a zombie gate after a re-fire. The WHERE is double-guarded: only
 * `checkpoint='approve_to_ship'` AND only while UNANSWERED — an answered gate
 * (a real approval) must never be rewritten.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("CommDB.retireShipGate (FLY-1041)", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-fly1041-db-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("retires an unanswered approve_to_ship gate — drops out of getPendingQuestions immediately", () => {
		const qid = db.insertQuestion("exec-1", "lead-1", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		expect(db.getPendingQuestions("lead-1").map((q) => q.id)).toContain(qid);

		expect(db.retireShipGate(qid)).toBe(true);

		expect(db.getPendingQuestions("lead-1").map((q) => q.id)).not.toContain(
			qid,
		);
		// Row is kept for forensics (not deleted) — only expired + resolved.
		const row = db.getMessageById(qid);
		expect(row).toBeDefined();
		expect(row?.resolved_at).toBeTruthy();
	});

	it("NEVER retires an answered gate (a real approval must survive)", () => {
		const qid = db.insertQuestion("exec-1", "lead-1", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		db.insertResponse(qid, "founder-123", '{"approved": true}');

		expect(db.retireShipGate(qid)).toBe(false);

		const row = db.getMessageById(qid);
		expect(row?.resolved_at).toBeNull();
		expect(db.getResponse(qid)?.content).toBe('{"approved": true}');
	});

	it("refuses to touch a non-ship checkpoint", () => {
		const qid = db.insertQuestion("exec-1", "lead-1", "understanding?", {
			checkpoint: "brainstorm",
		});
		expect(db.retireShipGate(qid)).toBe(false);
		expect(db.getPendingQuestions("lead-1").map((q) => q.id)).toContain(qid);
	});

	it("refuses to touch a checkpoint-less runner question", () => {
		const qid = db.insertQuestion("exec-1", "lead-1", "DONE: report");
		expect(db.retireShipGate(qid)).toBe(false);
		expect(db.getPendingQuestions("lead-1").map((q) => q.id)).toContain(qid);
	});

	it("is a no-op for an unknown question id", () => {
		expect(db.retireShipGate("no-such-id")).toBe(false);
	});

	it("is idempotent — a second retire returns false (already expired)", () => {
		const qid = db.insertQuestion("exec-1", "lead-1", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		expect(db.retireShipGate(qid)).toBe(true);
		// The row is now expired; the UNANSWERED+pending guard no longer matches
		// (expires_at <= now), so a re-retire is a clean no-op.
		expect(db.retireShipGate(qid)).toBe(false);
	});
});

describe("messages.kind column + ask --report (FLY-1041 Chunk 9)", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-fly1041-kind-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("insertQuestion({kind:'report'}) persists kind and getPendingQuestions returns it", () => {
		const qid = db.insertQuestion("exec-1", "lead-1", "DONE: shipped it", {
			kind: "report",
		});
		const pending = db.getPendingQuestions("lead-1");
		expect(pending.find((q) => q.id === qid)?.kind).toBe("report");
	});

	it("an unflagged ask keeps kind NULL (byte-compat — old runners unchanged)", () => {
		const qid = db.insertQuestion("exec-1", "lead-1", "a real question");
		expect(db.getMessageById(qid)?.kind).toBeNull();
	});

	it("a report is still a pending question for the Lead (transport semantics unchanged)", () => {
		db.insertQuestion("exec-1", "lead-1", "DONE: report", { kind: "report" });
		expect(db.getPendingQuestions("lead-1")).toHaveLength(1);
		expect(db.hasPendingQuestionsFrom("exec-1")).toBe(true);
	});

	it("concurrent kind migration swallows the duplicate-column race", () => {
		// A second opener of the SAME file re-runs migrations — must not throw.
		const second = new CommDB(join(tmpDir, "comm.db"));
		second.close();
	});
});
