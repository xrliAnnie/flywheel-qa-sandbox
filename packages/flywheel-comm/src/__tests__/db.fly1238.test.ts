import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("CommDB.finalizeSession (FLY-1238)", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-fly1238-db-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("retires only unanswered checkpoint gates and deletes the session atomically", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1238", "lead");
		db.registerSession("exec-b", "window-b", "proj", "FLY-OTHER", "lead");
		db.enqueueRunnerPhaseWake(
			"exec-a",
			{ id: "wake-a", to: "exec-a", content: "resume phase" },
			1,
		);
		db.requestRunnerShutdown("exec-a", "shutdown-a", 2);
		const ship = db.insertQuestion("exec-a", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const brainstorm = db.insertQuestion("exec-a", "lead", "design?", {
			checkpoint: "brainstorm",
		});
		const runnerQuestion = db.insertQuestion("exec-a", "lead", "plain ask");
		const answered = db.insertQuestion("exec-a", "lead", "answered ship", {
			checkpoint: "approve_to_ship",
		});
		db.insertResponse(answered, "founder", '{"approved":true}');
		const other = db.insertQuestion("exec-b", "lead", "other ship", {
			checkpoint: "approve_to_ship",
		});

		expect(db.finalizeSession("exec-a")).toEqual({
			retiredQuestionCount: 2,
			deletedSessionCount: 1,
		});
		expect(db.getSession("exec-a")).toBeUndefined();
		expect(db.getSession("exec-b")).toBeDefined();
		expect(db.listRunnerPhaseWakes("exec-a")).toEqual([]);
		expect(db.getRunnerShutdown("exec-a")).toBeNull();
		for (const qid of [ship, brainstorm]) {
			const row = db.getMessageById(qid);
			expect(row?.expires_at).toBeTruthy();
			expect(row?.resolved_at).toBeTruthy();
			expect(row?.read_at).toBeTruthy();
			expect(db.isQuestionPending(qid)).toBe(false);
		}
		expect(db.isQuestionPending(runnerQuestion)).toBe(true);
		expect(db.getMessageById(runnerQuestion)?.resolved_at).toBeNull();
		expect(db.getResponse(answered)?.content).toBe('{"approved":true}');
		expect(db.getMessageById(answered)?.resolved_at).toBeNull();
		expect(db.isQuestionPending(other)).toBe(true);
	});

	it("rolls gate retirement back when session deletion aborts", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1238", "lead");
		db.enqueueRunnerPhaseWake(
			"exec-a",
			{ id: "wake-a", to: "exec-a", content: "resume phase" },
			1,
		);
		db.requestRunnerShutdown("exec-a", "shutdown-a", 2);
		const qid = db.insertQuestion("exec-a", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const before = db.getMessageById(qid);
		(db as unknown as { db: { exec(sql: string): void } }).db.exec(`
			CREATE TRIGGER abort_exec_a_delete
			BEFORE DELETE ON sessions
			WHEN OLD.execution_id = 'exec-a'
			BEGIN
				SELECT RAISE(ABORT, 'forced finalize failure');
			END
		`);

		expect(() => db.finalizeSession("exec-a")).toThrow(
			"forced finalize failure",
		);
		expect(db.getSession("exec-a")).toBeDefined();
		const after = db.getMessageById(qid);
		expect({
			expires_at: after?.expires_at,
			resolved_at: after?.resolved_at,
			read_at: after?.read_at,
		}).toEqual({
			expires_at: before?.expires_at,
			resolved_at: before?.resolved_at,
			read_at: before?.read_at,
		});
		expect(db.listRunnerPhaseWakes("exec-a")).toHaveLength(1);
		expect(db.getRunnerShutdown("exec-a")?.request_id).toBe("shutdown-a");
	});
});
