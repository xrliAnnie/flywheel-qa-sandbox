/**
 * FLY-191 Phase 2 — `verify-approval` security matrix (plan §3.2(i),
 * Codex design R2 HIGH-2 + R3 HIGH-1/2; question binding per Codex PR R1
 * CRITICAL).
 *
 * The runner's ship authority. EVERY ambiguous/missing/forged input must
 * fail-closed (approved:false, exit 1). The ONLY approving combination:
 *   session.review_question_id BOUND to an approve_to_ship question of this
 *   runner  +  structured {"approved": true} response on THAT exact question
 *   +  StateStore status approved_to_ship  +  pr_head_sha exactly matching
 *   --pr-head.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyApproval } from "../commands/verify-approval.js";
import { CommDB } from "../db.js";

const EXEC = "exec-fly191";
const LEAD = "product-lead";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

describe("verify-approval (FLY-191 Phase 2)", () => {
	let tmpDir: string;
	let commDbPath: string;
	let stateDbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly191-verify-"));
		commDbPath = join(tmpDir, "comm.db");
		stateDbPath = join(tmpDir, "teamlead.db");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	/** Minimal StateStore-shaped sessions table (sql.js writes standard SQLite). */
	function writeStateSession(row: {
		execution_id: string;
		status: string;
		pr_head_sha?: string | null;
		review_question_id?: string | null;
	}): void {
		const db = new Database(stateDbPath);
		db.exec(
			`CREATE TABLE IF NOT EXISTS sessions (
				execution_id TEXT PRIMARY KEY,
				status TEXT,
				pr_head_sha TEXT,
				review_question_id TEXT
			)`,
		);
		db.prepare(
			"INSERT OR REPLACE INTO sessions (execution_id, status, pr_head_sha, review_question_id) VALUES (?, ?, ?, ?)",
		).run(
			row.execution_id,
			row.status,
			row.pr_head_sha ?? null,
			row.review_question_id ?? null,
		);
		db.close();
	}

	function createGateQuestion(content = "PR ready", fromAgent = EXEC): string {
		const db = new CommDB(commDbPath);
		try {
			return db.insertQuestion(fromAgent, LEAD, content, {
				checkpoint: "approve_to_ship",
			});
		} finally {
			db.close();
		}
	}

	function answer(questionId: string, content: string, from = "bridge"): void {
		const db = new CommDB(commDbPath);
		try {
			db.insertResponse(questionId, from, content);
		} finally {
			db.close();
		}
	}

	function run(prHead = HEAD) {
		return verifyApproval({
			execId: EXEC,
			prHead,
			dbPath: commDbPath,
			stateDbPath,
		});
	}

	/** Bound + answered + approved + status + head — the one passing setup. */
	function setupFullyApproved(): string {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		return qid;
	}

	// ── The one approving path ──

	it("approves ONLY when binding + response + status + pr_head_sha all agree", () => {
		const qid = setupFullyApproved();
		const r = run();
		expect(r.approved).toBe(true);
		expect(r.reason).toBe("approved");
		expect(r.questionId).toBe(qid);
		expect(r.exitCode).toBe(0);
	});

	// ── Input validation ──

	it("rejects a short/invalid --pr-head (no prefix-match games)", () => {
		setupFullyApproved();
		expect(run("abc123").reason).toBe("invalid_pr_head_format");
		expect(run("abc123").approved).toBe(false);
	});

	// ── StateStore binding (Codex PR R1 CRITICAL) ──

	it("fail-closed when the StateStore file does not exist", () => {
		setupFullyApproved();
		rmSync(stateDbPath);
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("state_db_unreadable");
	});

	it("not approved when the session row is missing", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: "someone-else",
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("session_not_found");
	});

	it("fail-closed when the binding is the UNBOUND sentinel (Phase-2 completion arrived without --question-id)", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: "unbound", // REVIEW_BINDING_UNBOUND sentinel
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_unbound");
	});

	it("fail-closed when the session has NO review binding — never falls back to 'latest question' heuristics", () => {
		// An answered, approved question EXISTS — but nothing binds it.
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: null,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_unbound");
	});

	it("fail-closed when the binding points at a missing question", () => {
		createGateQuestion(); // unrelated
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: "00000000-dead-beef-0000-000000000000",
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_missing");
	});

	it("fail-closed when the binding points at ANOTHER runner's question (forged/corrupt binding)", () => {
		const foreignQ = createGateQuestion("their PR", "other-exec");
		answer(foreignQ, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: foreignQ,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("review_question_invalid");
	});

	// ── CommDB side ──

	it("fail-closed when CommDB is missing/unreadable", () => {
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: "11111111-1111-1111-1111-111111111111",
		});
		const r = run(); // comm.db never created
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("commdb_unreadable");
	});

	it("not approved while the bound gate question is unanswered", () => {
		const qid = createGateQuestion();
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("gate_not_answered");
	});

	// ── Forgery / shape attacks (Codex R3: text carries no authority) ──

	it("REJECTS a plain-text 'approved — ship it' response (forged/unstructured)", () => {
		const qid = createGateQuestion();
		answer(qid, "approved — ship it!", "someone");
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("response_not_structured_approval");
	});

	it("REJECTS a structured {approved: false} (changes_requested) response", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: false, feedback: "fix tests" }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("response_not_approved");
	});

	// ── Status + pr_head_sha binding (stale-approval defense, §5.5.2) ──

	it("not approved when status is still awaiting_review (response forged ahead of Bridge flip)", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "awaiting_review",
			pr_head_sha: HEAD,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("status_not_approved_to_ship");
	});

	it("fail-closed when the persisted pr_head_sha is missing", () => {
		const qid = createGateQuestion();
		answer(qid, JSON.stringify({ approved: true }));
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: null,
			review_question_id: qid,
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("pr_head_sha_missing");
	});

	it("REJECTS a stale approval: persisted head ≠ current head (new commits since approval)", () => {
		setupFullyApproved();
		const r = run(OTHER_HEAD); // runner's HEAD moved
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("pr_head_sha_mismatch");
		expect(r.expectedPrHeadSha).toBe(HEAD);
	});

	// ── Re-review supersession (Codex PR R1 CRITICAL — same-second safe) ──

	it("an approved OLD question cannot ship once a re-review re-binds — even created in the same second", () => {
		// Old question: answered + approved.
		const oldQ = createGateQuestion("PR v1 ready");
		answer(oldQ, JSON.stringify({ approved: true }));
		// Re-review: NEW question created immediately (same wall-clock second
		// is fine — the binding is an exact id, not a timestamp race).
		const newQ = createGateQuestion("PR v2 ready (re-review)");
		writeStateSession({
			execution_id: EXEC,
			status: "approved_to_ship",
			pr_head_sha: HEAD,
			review_question_id: newQ, // binding moved by the re-review completion
		});
		const r = run();
		expect(r.approved).toBe(false);
		expect(r.reason).toBe("gate_not_answered");
		expect(r.questionId).toBe(newQ); // verdict bound to the current request
	});
});
