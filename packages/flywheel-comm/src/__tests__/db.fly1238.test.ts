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

	it("machine-proven terminal finalization disposes checkpoint gates even with protection on", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1238", "lead");
		const ship = db.insertQuestion("exec-a", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const brainstorm = db.insertQuestion("exec-a", "lead", "design?", {
			checkpoint: "brainstorm",
		});

		expect(db.finalizeSession("exec-a")).toEqual({
			retiredQuestionCount: 2,
			// FLY-1328: no checkpoint-less asks on this session to cascade.
			retiredAskCount: 0,
			deletedSessionCount: 1,
		});
		expect(db.getSession("exec-a")).toBeUndefined();
		for (const qid of [ship, brainstorm]) {
			expect(db.getMessageById(qid)?.resolved_at).toBeTruthy();
			expect(db.getMessageById(qid)?.relay_state).toBe("terminal_disposed");
			expect(db.isQuestionPending(qid)).toBe(false);
		}
	});

	it("retires only unanswered checkpoint gates and preserves fresh asks", () => {
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
			// FLY-1328: `runnerQuestion` is checkpoint-less but seconds old, so the
			// cascade's grace window spares it — the FLY-161 survive-completion
			// assertion below still holds for a freshly-written ask.
			retiredAskCount: 0,
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

	// FLY-1257 defect ④ path-3 (Codex code review HIGH-2). finalizeSession is a
	// THIRD gate-swallow path beyond the GatePoller eviction (path-2) and the
	// zombie-hygiene chronology guard: on session teardown it retired EVERY
	// unanswered checkpoint gate, including `review_design`/`review_code`. Those
	// are binding credentials the reviewer/coordinator answers, not the author
	// runner — retiring one on the author's teardown makes the coordinator drop a
	// still-valid verdict. They must survive the author's finalize; only non-review
	// gates are retired. Mirrors the GatePoller path-2 exemption.
	for (const reviewCheckpoint of ["review_code", "review_design"] as const) {
		it(`does NOT retire a ${reviewCheckpoint} gate on finalize — the reviewer, not the author, consumes it`, () => {
			db.registerSession("exec-a", "window-a", "proj", "FLY-1257", "lead");
			const review = db.insertQuestion("exec-a", "lead", "review requested", {
				checkpoint: reviewCheckpoint,
			});
			// Control: a normal author-owned gate on the SAME session is still retired.
			const ship = db.insertQuestion("exec-a", "lead", "ship?", {
				checkpoint: "approve_to_ship",
			});

			expect(db.finalizeSession("exec-a")).toEqual({
				retiredQuestionCount: 1, // ship only — the review gate is exempt
				retiredAskCount: 0,
				deletedSessionCount: 1,
			});

			// The review gate SURVIVES, still pending + answerable by the reviewer.
			const reviewRow = db.getMessageById(review);
			expect(reviewRow?.resolved_at).toBeNull();
			expect(db.isQuestionPending(review)).toBe(true);
			// The control gate was retired.
			expect(db.isQuestionPending(ship)).toBe(false);
			expect(db.getMessageById(ship)?.resolved_at).toBeTruthy();
			// Session registry row is still removed (teardown proceeds as before).
			expect(db.getSession("exec-a")).toBeUndefined();
		});
	}

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
