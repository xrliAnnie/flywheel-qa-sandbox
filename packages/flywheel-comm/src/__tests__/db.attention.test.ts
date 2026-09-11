import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("project attention questions", () => {
	let root: string;
	let db: CommDB;
	let raw: Database.Database;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "attention-comm-"));
		db = new CommDB(join(root, "comm.db"));
		raw = new Database(join(root, "comm.db"));
	});
	afterEach(() => {
		raw.close();
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	it("reads every open question without an Epic or live session, preserves exact identity and hides content", () => {
		const ids = [
			db.insertQuestion("ended-execution", "lead", "SECRET_BODY"),
			db.insertQuestion("ended-execution", "lead", "SECOND_SECRET"),
		];
		raw.prepare("UPDATE mailbox SET created_at = '2026-01-01 09:00:00'").run();
		const result = db.listAttentionQuestions({ limit: 50 });
		expect(result.questions.map((q) => q.id).sort()).toEqual(ids.sort());
		expect(result.questions[0]).toMatchObject({
			execution_id: "ended-execution",
			since: "2026-01-01T09:00:00Z",
			kind: "question",
			recipient_role: "lead",
		});
		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(result.nextCursor).toBeNull();
	});
	it("exports pending attention facts without exposing question transport state", () => {
		const question = db.insertQuestion("exec", "lead", "pending");
		const gate = db.insertQuestion("exec", "lead", "gate", {
			checkpoint: "founder_review",
		});
		db.markQuestionProtected(gate, "event-gate");
		const rows = db.listAttentionQuestions({ limit: 50 }).questions;
		expect(rows.map((row) => row.id).sort()).toEqual([question, gate].sort());
		for (const row of rows) {
			expect(row).toMatchObject({ state: "pending" });
			expect(row).not.toHaveProperty("relay_state");
		}
	});
	it("excludes closed, answered and automatic review questions and trusted stop reports", () => {
		const answered = db.insertQuestion("exec", "lead", "answered");
		db.insertResponse(answered, "lead", "answer");
		const superseded = db.insertQuestion("exec", "lead", "superseded");
		raw
			.prepare(
				"UPDATE mailbox SET superseded_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
			.run(superseded);
		for (const checkpoint of ["review_design", "review_code"]) {
			db.insertQuestion("exec", "lead", "automatic", { checkpoint });
		}
		db.insertQuestion(
			"exec",
			"lead",
			"RUNNER-STOPPED kind=runner_stopped reason=blocked private",
			{
				id: `rstop-${"a".repeat(32)}`,
				kind: "report",
			},
		);
		const live = db.insertQuestion("exec", "lead", "real question");
		expect(
			db.listAttentionQuestions({ limit: 50 }).questions.map((q) => q.id),
		).toEqual([live]);
	});
	it("classifies only allowed founder gates and keeps recipient role as source data", () => {
		const gate = db.insertQuestion("exec", "lead", "PRIVATE", {
			checkpoint: "founder_review",
		});
		const ship = db.insertQuestion("exec", "lead", "PRIVATE", {
			checkpoint: "approve_to_ship",
		});
		const unknown = db.insertQuestion("exec", "lead", "PRIVATE", {
			checkpoint: "unrecognized",
		});
		db.markQuestionProtected(gate, "event-gate");
		db.markQuestionProtected(ship, "event-ship");
		db.markQuestionProtected(unknown, "event-unknown");
		const rows = db.listAttentionQuestions({ limit: 50 }).questions;
		expect(rows.find((q) => q.id === gate)).toMatchObject({
			kind: "founder_gate",
			checkpoint: "founder_review",
			recipient_role: "lead",
		});
		expect(rows.find((q) => q.id === ship)?.kind).toBe("ship");
		expect(rows.find((q) => q.id === unknown)).toMatchObject({
			kind: "question",
			recipient_role: "lead",
		});
	});
	it.each(["question", "design_direction", "toString"])(
		"keeps an unanswered %s gate visible across delivery protection",
		(checkpoint) => {
			const id = db.insertQuestion("exec", "lead", "PRIVATE_APPROACH", {
				checkpoint,
			});
			const before = db.listAttentionQuestions({ limit: 50 }).questions;
			expect(before).toHaveLength(1);
			expect(before[0]).toMatchObject({
				id,
				kind: "question",
				state: "pending",
				recipient_role: "lead",
			});
			db.markQuestionProtected(id, "delivery-event");
			const after = db.listAttentionQuestions({ limit: 50 }).questions;
			expect(after).toEqual(before);
			expect(JSON.stringify(after)).not.toContain("PRIVATE_APPROACH");
			db.insertResponse(id, "lead", "answered");
			expect(db.listAttentionQuestions({ limit: 50 }).questions).toEqual([]);
		},
	);
	it("paginates by raw created_at and full id even when a page contains only excluded reports", () => {
		db.insertQuestion(
			"exec",
			"lead",
			"RUNNER-STOPPED kind=runner_stopped reason=done private",
			{
				id: `rstop-${"b".repeat(32)}`,
				kind: "report",
			},
		);
		const live = db.insertQuestion("exec", "lead", "question");
		raw
			.prepare(
				"UPDATE mailbox SET created_at = '2026-01-01 01:00:00' WHERE id LIKE 'rstop-%'",
			)
			.run();
		raw
			.prepare(
				"UPDATE mailbox SET created_at = '2026-01-01 02:00:00' WHERE id = ?",
			)
			.run(live);
		const first = db.listAttentionQuestions({ limit: 1 });
		expect(first.questions).toEqual([]);
		expect(first.rawCount).toBe(1);
		expect(first.nextCursor).toEqual({
			created_at: "2026-01-01 01:00:00",
			id: `rstop-${"b".repeat(32)}`,
		});
		const second = db.listAttentionQuestions({
			limit: 1,
			cursor: first.nextCursor!,
		});
		expect(second.questions.map((q) => q.id)).toEqual([live]);
		expect(second.nextCursor).toBeNull();
	});
	it("rejects unbounded limits and invalid cursor inputs before SQL", () => {
		for (const limit of [0, -1, 1.5, 1001, NaN]) {
			expect(() => db.listAttentionQuestions({ limit })).toThrow();
		}
		expect(() =>
			db.listAttentionQuestions({
				limit: 5,
				cursor: { id: "", created_at: "" },
			}),
		).toThrow();
	});
	it("preserves uncertainty when spilled stop-like metadata lacks a classification", () => {
		const id = db.insertQuestion("exec", "lead", "opaque", {
			id: `rstop-${"d".repeat(32)}`,
		});
		raw
			.prepare(
				"UPDATE mailbox SET kind = NULL, content_ref = '/must-not-read/private' WHERE id = ?",
			)
			.run(id);
		const row = db.listAttentionQuestions({ limit: 50 }).questions[0];
		expect(row).toMatchObject({ id, classification_unknown: true });
		expect(JSON.stringify(row)).not.toContain("opaque");
		expect(JSON.stringify(row)).not.toContain("private");
	});

	it("does not reintroduce a spilled stop report or read its body from disk", () => {
		const stop = db.insertQuestion("exec", "lead", "spilled", {
			id: `rstop-${"c".repeat(32)}`,
			kind: "report",
		});
		raw
			.prepare(
				"UPDATE mailbox SET content_ref = '/must-not-read/private' WHERE id = ?",
			)
			.run(stop);
		expect(db.listAttentionQuestions({ limit: 50 }).questions).toEqual([]);
	});
});
