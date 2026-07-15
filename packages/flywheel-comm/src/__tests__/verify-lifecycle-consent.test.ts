/**
 * FLY-245 Phase D-c — verifyLifecycleConsent security matrix. Every
 * ambiguous/missing/forged/stale input fails closed; the ONE approving
 * combination is a fresh, founder-signed, fully-bound confirmation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type VerifyLifecycleConsentArgs,
	verifyLifecycleConsent,
} from "../commands/verify-lifecycle-consent.js";
import { CommDB } from "../db.js";

const EXEC = "exec-fly245";
const LEAD = "joycon-lead";
const FOUNDER = "discord-user-annie-123";
const PROJECT = "joycon";
const NONCE = "nonce-abcdef";
const ACTION = "terminate";
const CHECKPOINT = `runner_lifecycle:${ACTION}`;
const REV = 5;

describe("verifyLifecycleConsent (FLY-245 D-c)", () => {
	let tmpDir: string;
	let dbPath: string;
	let stateDbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly245-lifecycle-"));
		dbPath = join(tmpDir, "comm.db");
		stateDbPath = join(tmpDir, "teamlead.db");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function writeStateSession(
		revision: number | null,
		execId = EXEC,
		project = PROJECT,
	): void {
		const db = new Database(stateDbPath);
		db.exec(
			`CREATE TABLE IF NOT EXISTS sessions (
				execution_id TEXT PRIMARY KEY,
				project_name TEXT,
				status TEXT,
				lifecycle_revision INTEGER
			)`,
		);
		db.prepare(
			"INSERT OR REPLACE INTO sessions (execution_id, project_name, status, lifecycle_revision) VALUES (?, ?, 'running', ?)",
		).run(execId, project, revision);
		db.close();
	}

	function binding(over: Record<string, unknown> = {}): string {
		return JSON.stringify({
			target_execution_id: EXEC,
			action: ACTION,
			lifecycle_revision: REV,
			nonce: NONCE,
			project: PROJECT,
			...over,
		});
	}

	function createQuestion(opts?: {
		content?: string;
		from?: string;
		to?: string;
		checkpoint?: string;
	}): string {
		const db = new CommDB(dbPath);
		try {
			return db.insertQuestion(
				opts?.from ?? LEAD,
				opts?.to ?? FOUNDER,
				opts?.content ?? binding(),
				{ checkpoint: opts?.checkpoint ?? CHECKPOINT, ttlSeconds: 600 },
			);
		} finally {
			db.close();
		}
	}

	function answer(questionId: string, content: string, from = FOUNDER): void {
		const db = new CommDB(dbPath);
		try {
			db.insertResponse(questionId, from, content);
		} finally {
			db.close();
		}
	}

	function goodResponse(over: Record<string, unknown> = {}): string {
		return JSON.stringify({
			approved: true,
			action: ACTION,
			execId: EXEC,
			revision: REV,
			...over,
		});
	}

	function args(
		over: Partial<VerifyLifecycleConsentArgs>,
	): VerifyLifecycleConsentArgs {
		return {
			questionId: "Q",
			execId: EXEC,
			action: ACTION,
			nonce: NONCE,
			leadId: LEAD,
			founderId: FOUNDER,
			project: PROJECT,
			dbPath,
			stateDbPath,
			...over,
		};
	}

	it("APPROVES a fresh, founder-signed, fully-bound confirmation", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q }))).toEqual({
			allowed: true,
			reason: "approved",
		});
	});

	it("invalid_args on a missing runtime field", () => {
		writeStateSession(REV);
		expect(verifyLifecycleConsent(args({ questionId: "" })).reason).toBe(
			"invalid_args",
		);
		expect(verifyLifecycleConsent(args({ founderId: "" })).reason).toBe(
			"invalid_args",
		);
	});

	it("state_db_unreadable when StateStore is absent", () => {
		const q = createQuestion();
		expect(
			verifyLifecycleConsent(
				args({ questionId: q, stateDbPath: join(tmpDir, "nope.db") }),
			).reason,
		).toBe("state_db_unreadable");
	});

	it("session_not_found when the target session row is absent", () => {
		writeStateSession(REV, "other-exec");
		const q = createQuestion();
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"session_not_found",
		);
	});

	// Codex code-review R1 MED-8: the verifier itself (not just the later atomic
	// claim) must reject expired / consumed credentials and verify the SESSION's
	// actual project — not only the question-binding copy of it.
	it("session_project_mismatch when the target session belongs to another project", () => {
		writeStateSession(REV, EXEC, "other-project");
		const q = createQuestion();
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"session_project_mismatch",
		);
	});

	it("question_expired when the question TTL has elapsed", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse());
		const db = new Database(dbPath);
		db.prepare(
			"UPDATE messages SET expires_at = datetime('now', '-1 minute') WHERE id = ?",
		).run(q);
		db.close();
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"question_expired",
		);
	});

	it("question_expired (fail-closed) when expires_at is unparsable", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse());
		const db = new Database(dbPath);
		db.prepare("UPDATE messages SET expires_at = 'garbage' WHERE id = ?").run(
			q,
		);
		db.close();
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"question_expired",
		);
	});

	it("question_consumed when the question was already claimed (resolved_at set)", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse());
		const db = new Database(dbPath);
		db.prepare(
			"UPDATE messages SET resolved_at = datetime('now') WHERE id = ?",
		).run(q);
		db.close();
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"question_consumed",
		);
	});

	it("question_missing for an unknown question id (db exists)", () => {
		writeStateSession(REV);
		createQuestion(); // materialize comm.db, then query a different id
		expect(verifyLifecycleConsent(args({ questionId: "no-such" })).reason).toBe(
			"question_missing",
		);
	});

	it("commdb_unreadable when the CommDB file does not exist (fail-closed)", () => {
		writeStateSession(REV);
		// no comm.db created → openReadonly throws → fail-closed
		expect(verifyLifecycleConsent(args({ questionId: "Q" })).reason).toBe(
			"commdb_unreadable",
		);
	});

	it("question_invalid on a checkpoint/action mismatch", () => {
		writeStateSession(REV);
		const q = createQuestion({ checkpoint: "runner_lifecycle:defer" });
		answer(q, goodResponse());
		// args.action is 'terminate' → expected checkpoint runner_lifecycle:terminate
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"question_invalid",
		);
	});

	it("question_invalid when from_agent is not the requesting Lead", () => {
		writeStateSession(REV);
		const q = createQuestion({ from: "someone-else" });
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"question_invalid",
		);
	});

	it("question_invalid when to_agent is not the founder", () => {
		writeStateSession(REV);
		const q = createQuestion({ to: "not-founder" });
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"question_invalid",
		);
	});

	it("binding_mismatch on a cross-target replay (binding execId ≠ requested)", () => {
		writeStateSession(REV);
		const q = createQuestion({
			content: binding({ target_execution_id: "other" }),
		});
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"binding_mismatch",
		);
	});

	it("binding_mismatch on a nonce mismatch", () => {
		writeStateSession(REV);
		const q = createQuestion({ content: binding({ nonce: "wrong" }) });
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"binding_mismatch",
		);
	});

	it("revision_stale when the session transitioned since the request", () => {
		writeStateSession(REV + 1); // session moved on; binding snapshot is REV
		const q = createQuestion();
		answer(q, goodResponse());
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"revision_stale",
		);
	});

	it("gate_not_answered when there is no founder response", () => {
		writeStateSession(REV);
		const q = createQuestion();
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"gate_not_answered",
		);
	});

	it("response_wrong_writer when the response is not from the founder", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse(), "impostor");
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"response_wrong_writer",
		);
	});

	it("response_not_structured_approval on a plain-text response", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, "yeah go ahead kill it");
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"response_not_structured_approval",
		);
	});

	it("response_not_approved on {approved:false}", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse({ approved: false }));
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"response_not_approved",
		);
	});

	it("response_binding_mismatch on a cross-action confirmation (approve defer used for terminate)", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse({ action: "defer" }));
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"response_binding_mismatch",
		);
	});

	it("response_binding_mismatch on a stale-revision confirmation body", () => {
		writeStateSession(REV);
		const q = createQuestion();
		answer(q, goodResponse({ revision: REV - 1 }));
		expect(verifyLifecycleConsent(args({ questionId: q })).reason).toBe(
			"response_binding_mismatch",
		);
	});
});
