import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("FLY-1374 CommDB holder activation", () => {
	let dir: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1374-holder-"));
		db = new CommDB(join(dir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("re-registers a missing holder with the proven wake identity", () => {
		expect(
			db.activateSessionForWake({
				executionId: "exec-1",
				tmuxWindow: "flywheel:@42",
				projectName: "flywheel",
				issueId: "FLY-1374",
				leadId: "flywheel-eng-lead",
				vendor: "codex",
			}),
		).toEqual({ ok: true, inserted: true, previousStatus: null });
		expect(db.getSession("exec-1")).toMatchObject({
			status: "running",
			tmux_window: "flywheel:@42",
			lead_id: "flywheel-eng-lead",
			vendor: "codex",
		});
	});

	it("revives a terminal row in place without deleting its durable gate", () => {
		db.registerSession(
			"exec-1",
			"flywheel:@42",
			"flywheel",
			"FLY-1374",
			"flywheel-eng-lead",
			"codex",
		);
		const questionId = db.insertQuestion(
			"exec-1",
			"flywheel-eng-lead",
			"still there?",
		);
		db.updateSessionStatus("exec-1", "completed");

		expect(
			db.activateSessionForWake({
				executionId: "exec-1",
				tmuxWindow: "ignored-stale-target",
				projectName: "flywheel",
				issueId: "FLY-1374",
				leadId: "flywheel-eng-lead",
				vendor: "codex",
			}),
		).toEqual({
			ok: true,
			inserted: false,
			previousStatus: "completed",
		});
		expect(db.getSession("exec-1")).toMatchObject({
			status: "running",
			tmux_window: "flywheel:@42",
			ended_at: null,
		});
		expect(db.isQuestionPending(questionId)).toBe(true);
	});

	it("replaces an explicitly pending target with the proven immutable identity", () => {
		db.registerSession(
			"exec-1",
			"flywheel:pending",
			"flywheel",
			"FLY-1944",
			"flywheel-eng-lead",
			"codex",
		);
		db.updateSessionStatus("exec-1", "completed");

		expect(
			db.activateSessionForWake({
				executionId: "exec-1",
				tmuxWindow: "flywheel:@42",
				projectName: "flywheel",
				issueId: "FLY-1944",
				leadId: "flywheel-eng-lead",
				vendor: "codex",
			}),
		).toEqual({
			ok: true,
			inserted: false,
			previousStatus: "completed",
		});
		expect(db.getSession("exec-1")?.tmux_window).toBe("flywheel:@42");
	});

	it("rejects incomplete identity instead of synthesizing a session", () => {
		expect(
			db.activateSessionForWake({
				executionId: "exec-1",
				tmuxWindow: "",
				projectName: "flywheel",
				issueId: "FLY-1374",
				leadId: "flywheel-eng-lead",
				vendor: "codex",
			}),
		).toEqual({ ok: false, reason: "invalid_wake_identity" });
		expect(db.getSession("exec-1")).toBeUndefined();
	});
});
