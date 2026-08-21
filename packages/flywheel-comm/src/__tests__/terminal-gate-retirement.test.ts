import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const LEAD_ID = "flywheel-eng-lead";
const NOW = "2026-07-24T00:01:00.000Z";

describe("terminal gate retirement", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1645-gate-retirement-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"session",
			"flywheel",
			"FLY-1645",
			LEAD_ID,
			"codex",
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("retires an unanswered ship gate with the authority timestamp and reason", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "ship?", {
			checkpoint: "approve_to_ship",
		});

		expect(
			db.retireGateForTerminalAuthority({
				questionId,
				reason: "superseded_session_terminal",
				now: NOW,
			}),
		).toEqual({ kind: "retired" });
		expect(db.getPendingQuestions(LEAD_ID)).toEqual([]);

		const raw = new Database(dbPath, { readonly: true });
		try {
			expect(
				raw
					.prepare(
						`SELECT state, acked_at, expires_at, relay_state, resolved_at,
						        resolved_via, superseded_at
						   FROM mailbox WHERE id = ?`,
					)
					.get(questionId),
			).toEqual({
				state: "ACKED",
				acked_at: NOW,
				expires_at: NOW,
				relay_state: "terminal_disposed",
				resolved_at: NOW,
				resolved_via: "superseded_session_terminal",
				superseded_at: NOW,
			});
			expect(
				raw
					.prepare(
						"SELECT count(*) AS count FROM mailbox_log WHERE event IN ('processed','disposed')",
					)
					.get(),
			).toEqual({ count: 0 });
		} finally {
			raw.close();
		}
	});

	it("lets a concurrent response win without mutating the gate", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.insertResponse(questionId, LEAD_ID, "approved");

		expect(
			db.retireGateForTerminalAuthority({
				questionId,
				reason: "superseded_session_terminal",
				now: NOW,
			}),
		).toEqual({ kind: "response_won" });
		expect(db.getMessageById(questionId)).toMatchObject({
			resolved_at: null,
			superseded_at: null,
		});
	});

	it("is idempotent only for the same completed retirement", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.retireGateForTerminalAuthority({
			questionId,
			reason: "superseded_issue_done",
			now: NOW,
		});

		expect(
			db.retireGateForTerminalAuthority({
				questionId,
				reason: "superseded_issue_done",
				now: "2026-07-24T00:02:00.000Z",
			}),
		).toEqual({ kind: "already_retired" });
		expect(
			db.retireGateForTerminalAuthority({
				questionId,
				reason: "superseded_merged",
				now: "2026-07-24T00:03:00.000Z",
			}),
		).toEqual({ kind: "missing" });
	});

	it("does not retire non-ship or missing questions", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "help");
		expect(
			db.retireGateForTerminalAuthority({
				questionId,
				reason: "superseded_issue_done",
				now: NOW,
			}),
		).toEqual({ kind: "missing" });
		expect(
			db.retireGateForTerminalAuthority({
				questionId: "missing",
				reason: "superseded_issue_done",
				now: NOW,
			}),
		).toEqual({ kind: "missing" });
	});

	it("retires founder review through the same response-wins primitive", () => {
		const questionId = db.insertQuestion("exec-1", LEAD_ID, "founder review?", {
			checkpoint: "founder_review",
		});
		expect(
			db.retireGateForTerminalAuthority({
				questionId,
				reason: "superseded_issue_done",
				now: NOW,
			}),
		).toEqual({ kind: "retired" });
		expect(db.getMessageById(questionId)).toMatchObject({
			relay_state: "terminal_disposed",
			resolved_via: "superseded_issue_done",
			superseded_at: NOW,
		});
	});
});
