/**
 * FLY-869 — the shared ship-eligibility predicate.
 *
 * Proves the two highest-risk pieces of new logic:
 *  - `evaluateQaShipGate` snapshot boundaries (design R2 HIGH-5): required/exempt/
 *    NULL fail-closed-vs-exempt, and the `.env`-live kill-switch.
 *  - `evaluateShipEligibility` INDEPENDENT B/A kill-switches (design R2 HIGH-3):
 *    turning the merge-approval gate off must NOT bypass the QA gate, and vice-versa.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateQaShipGate,
	evaluateShipEligibility,
} from "../ship-eligibility.js";

const EXEC = "exec-fly869";
const HEAD = "a".repeat(40);

describe("FLY-869 ship-eligibility", () => {
	let tmpDir: string;
	let stateDbPath: string;
	let commDbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly869-ship-"));
		stateDbPath = join(tmpDir, "teamlead.db");
		commDbPath = join(tmpDir, "comm.db");
	});
	afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

	/** Minimal StateStore-shaped sessions table + optional passing auto_qa_record. */
	function writeSession(row: {
		qa_required?: number | null;
		decision_route?: string | null;
		pr_number?: number | null;
		qaPassedHead?: string;
		durableQa?: boolean;
	}): void {
		const db = new Database(stateDbPath);
		db.exec(
			`CREATE TABLE IF NOT EXISTS sessions (
				execution_id TEXT PRIMARY KEY,
				status TEXT,
				pr_head_sha TEXT,
				qa_required INTEGER,
				decision_route TEXT,
				pr_number INTEGER,
				session_role TEXT,
				chat_thread_role TEXT
			);
			CREATE TABLE IF NOT EXISTS auto_qa_record (
				parent_execution_id TEXT NOT NULL,
				target_pr_head_sha TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'running',
				PRIMARY KEY (parent_execution_id, target_pr_head_sha)
			);`,
		);
		db.prepare(
			"INSERT OR REPLACE INTO sessions (execution_id, status, pr_head_sha, qa_required, decision_route, pr_number, session_role, chat_thread_role) VALUES (?, 'awaiting_review', ?, ?, ?, ?, ?, ?)",
		).run(
			EXEC,
			HEAD,
			row.qa_required ?? null,
			row.decision_route ?? null,
			row.pr_number ?? null,
			row.durableQa ? "qa" : "implement",
			row.durableQa ? "qa" : "implement",
		);
		if (row.qaPassedHead) {
			db.prepare(
				"INSERT OR REPLACE INTO auto_qa_record (parent_execution_id, target_pr_head_sha, status) VALUES (?, ?, 'passed')",
			).run(EXEC, row.qaPassedHead);
		}
		db.close();
	}

	function enrollQaClaim(
		input: {
			predicate?: "qa_passed" | "qa_failed";
			head?: string;
			executionId?: string;
			issuerExecutionId?: string;
			attempt?: number;
			currentAttempt?: number;
			revoked?: boolean;
			expiresAt?: string | null;
			permanent?: boolean;
			enrolled?: boolean;
			nodeId?: string;
			decisionKind?: string;
			subjectKind?: string;
		} = {},
	): void {
		const db = new Database(stateDbPath);
		db.exec(`
			CREATE TABLE workflow_run (
				run_id TEXT PRIMARY KEY,
				claims_read_enrolled INTEGER NOT NULL DEFAULT 0,
				current_qa_attempt INTEGER
			);
			CREATE TABLE workflow_run_node (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				execution_id TEXT,
				PRIMARY KEY (run_id, node_id, attempt)
			);
			CREATE TABLE workflow_execution_binding (
				execution_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL
			);
			CREATE TABLE workflow_claims (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				server_seq INTEGER NOT NULL UNIQUE,
				workflow_run_id TEXT NOT NULL,
				node_id TEXT,
				decision_kind TEXT NOT NULL,
				attempt INTEGER,
				predicate TEXT NOT NULL,
				issuer_execution_id TEXT,
				subject_kind TEXT NOT NULL,
				subject_digest TEXT NOT NULL,
				expires_at TEXT,
				permanent INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE workflow_claim_revocation (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				claim_id INTEGER NOT NULL
			);
		`);
		const attempt = input.attempt ?? 1;
		const executionId = input.executionId ?? EXEC;
		const nodeId = input.nodeId ?? "qa";
		db.prepare(
			"INSERT INTO workflow_run (run_id, claims_read_enrolled, current_qa_attempt) VALUES ('run-1', ?, ?)",
		).run(input.enrolled === false ? 0 : 1, input.currentAttempt ?? attempt);
		db.prepare(
			"INSERT INTO workflow_run_node (run_id, node_id, attempt, execution_id) VALUES ('run-1', ?, ?, ?)",
		).run(nodeId, attempt, executionId);
		if ((input.currentAttempt ?? attempt) > attempt) {
			db.prepare(
				"INSERT INTO workflow_run_node (run_id, node_id, attempt, execution_id) VALUES ('run-1', ?, ?, ?)",
			).run(
				nodeId,
				input.currentAttempt,
				`${executionId}-attempt-${input.currentAttempt}`,
			);
		}
		db.prepare(
			"INSERT INTO workflow_execution_binding (execution_id, run_id, node_id, attempt) VALUES (?, 'run-1', ?, ?)",
		).run(executionId, nodeId, attempt);
		const claim = db
			.prepare(
				`INSERT INTO workflow_claims
				 (server_seq, workflow_run_id, node_id, decision_kind, attempt, predicate,
				  issuer_execution_id, subject_kind, subject_digest, expires_at, permanent)
				 VALUES (1, 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				nodeId,
				input.decisionKind ?? "qa_verdict",
				attempt,
				input.predicate ?? "qa_passed",
				input.issuerExecutionId ?? executionId,
				input.subjectKind ?? "git_head",
				input.head ?? HEAD,
				input.expiresAt === null
					? null
					: (input.expiresAt ?? "2999-01-01T00:00:00.000Z"),
				input.permanent ? 1 : 0,
			);
		if (input.revoked) {
			db.prepare(
				"INSERT INTO workflow_claim_revocation (claim_id) VALUES (?)",
			).run(claim.lastInsertRowid);
		}
		db.close();
	}

	function markSessionEngineOwned(): void {
		const db = new Database(stateDbPath);
		db.exec(`
			CREATE TABLE workflow_run (
				run_id TEXT PRIMARY KEY,
				engine_owned INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE workflow_execution_binding (
				execution_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL
			);
			INSERT INTO workflow_run (run_id, engine_owned)
			VALUES ('run-engine-owned', 1);
			INSERT INTO workflow_execution_binding (execution_id, run_id, node_id, attempt)
			VALUES ('${EXEC}', 'run-engine-owned', 'implement', 1);
		`);
		db.close();
	}

	describe("evaluateQaShipGate", () => {
		it("FLY-1981 retired env cannot bypass a missing QA pass", () => {
			writeSession({ qa_required: 1, pr_number: 5 }); // required, no passed record
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: { FLYWHEEL_QA_DONE_GATE: "0" } as NodeJS.ProcessEnv,
			});
			expect(r).toEqual({
				passed: false,
				reason: "qa_not_passed",
				qaRequired: 1,
			});
		});

		it("qa_required=1 + passing record for head → qa_ok", () => {
			writeSession({ qa_required: 1, pr_number: 5, qaPassedHead: HEAD });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
			});
			expect(r.passed).toBe(true);
			expect(r.reason).toBe("qa_ok");
		});

		it("qa_required=1 + NO passing record → qa_not_passed (fail-closed)", () => {
			writeSession({ qa_required: 1, pr_number: 5 });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
			});
			expect(r.passed).toBe(false);
			expect(r.reason).toBe("qa_not_passed");
		});

		it("qa_required=1 + passing record for a DIFFERENT head → qa_not_passed", () => {
			writeSession({
				qa_required: 1,
				pr_number: 5,
				qaPassedHead: "b".repeat(40),
			});
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
			});
			expect(r.passed).toBe(false);
			expect(r.reason).toBe("qa_not_passed");
		});

		it("qa_required=0 (exempt snapshot) → qa_not_required", () => {
			writeSession({ qa_required: 0, pr_number: 5 });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
			});
			expect(r).toMatchObject({ passed: true, reason: "qa_not_required" });
		});

		it("durable QA ignores the retired claims READ zero and uses the enrolled claim", () => {
			writeSession({ qa_required: 0, pr_number: 5, durableQa: true });
			enrollQaClaim();
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: {
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "0",
					FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0",
				} as NodeJS.ProcessEnv,
			});
			expect(r).toMatchObject({ passed: true, reason: "qa_claim_ok" });
		});

		it("durable QA + READ on + explicit enrollment + current bound PASS → qa_claim_ok", () => {
			writeSession({ qa_required: 0, pr_number: 5, durableQa: true });
			enrollQaClaim();
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: {
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
					FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0",
				} as NodeJS.ProcessEnv,
			});
			expect(r).toMatchObject({ passed: true, reason: "qa_claim_ok" });
		});

		it.each([
			["wrong head", { head: "b".repeat(40) }],
			["failed verdict", { predicate: "qa_failed" as const }],
			["revoked verdict", { revoked: true }],
			["stale attempt", { currentAttempt: 2 }],
			["wrong issuer", { executionId: "other-qa" }],
			// FLY-1244 QA: the cells below were reachable via the fixture but had no
			// test — each one survived a mutation of its own guard. See
			// qa/mutation-report.md.
			["expired verdict", { expiresAt: "2020-01-01T00:00:00.000Z" }],
			["verdict with no expiry", { expiresAt: null }],
			["verdict with unparseable expiry", { expiresAt: "not-a-date" }],
			["claim for another subject kind", { subjectKind: "doc_digest" }],
			["claim of another decision kind", { decisionKind: "founder_verdict" }],
			["binding on a non-QA node", { nodeId: "implement" }],
			// The pre-existing "wrong issuer" cell moves the execution id on BOTH the
			// binding and the claim, so it actually exercises the binding lookup. This
			// cell keeps the binding intact and only forges the claim's issuer, which
			// is the one thing `c.issuer_execution_id = ?` exists to refuse.
			[
				"a claim issued by another execution",
				{ issuerExecutionId: "ghost-qa" },
			],
		])("durable enrolled QA refuses %s", (_label, claim) => {
			writeSession({ qa_required: 0, pr_number: 5, durableQa: true });
			enrollQaClaim(claim);
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: {
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
					FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0",
				} as NodeJS.ProcessEnv,
			});
			expect(r.passed).toBe(false);
			expect(r.reason).not.toBe("qa_not_required");
		});

		// FLY-1244 QA: truth-table row (e) with READ *on*. Enrollment is a red-lined
		// per-run flag that must never be inferred from ledger contents, so a run
		// carrying a perfectly valid PASS claim still must not ship while
		// unenrolled. Dropping `claims_read_enrolled = 1` from the binding query
		// previously survived mutation — nothing proved this cell.
		it("durable QA + READ on + run NOT enrolled → fail-closed, never inferred from claims", () => {
			writeSession({ qa_required: 0, pr_number: 5, durableQa: true });
			enrollQaClaim({ enrolled: false });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: {
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
					FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0",
				} as NodeJS.ProcessEnv,
			});
			expect(r.passed).toBe(false);
			expect(r.reason).toBe("qa_claim_gate_unenrolled_failclosed");
		});

		// FLY-1244 QA: locks the one case where a missing expiry is legitimate, so
		// the expiry guard above can never be "fixed" by deleting it.
		it("durable enrolled QA accepts a permanent verdict with no expiry", () => {
			writeSession({ qa_required: 0, pr_number: 5, durableQa: true });
			enrollQaClaim({ permanent: true, expiresAt: null });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: {
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
					FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0",
				} as NodeJS.ProcessEnv,
			});
			expect(r).toMatchObject({ passed: true, reason: "qa_claim_ok" });
		});

		it("NULL snapshot + no PR / no-code route → exempt", () => {
			writeSession({
				qa_required: null,
				decision_route: "no_code",
				pr_number: null,
			});
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
			});
			expect(r).toMatchObject({
				passed: true,
				reason: "qa_snapshot_missing_exempt",
			});
		});

		it("NULL snapshot + real code PR → fail-closed (该起没起)", () => {
			writeSession({
				qa_required: null,
				decision_route: "needs_review",
				pr_number: 7,
			});
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
			});
			expect(r.passed).toBe(false);
			expect(r.reason).toBe("qa_snapshot_missing_failclosed");
		});

		it("engine-owned recovery cannot infer a QA exemption from DAG ownership", () => {
			writeSession({
				qa_required: null,
				decision_route: "needs_review",
				pr_number: 7,
			});
			markSessionEngineOwned();
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
			});
			expect(r).toEqual({
				passed: false,
				reason: "qa_snapshot_missing_failclosed",
			});
		});

		it("invalid head → fail-closed", () => {
			writeSession({ qa_required: 0, pr_number: 5 });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: "xyz",
				stateDbPath,
			});
			expect(r).toMatchObject({
				passed: false,
				reason: "invalid_pr_head_format",
			});
		});
	});

	describe("evaluateShipEligibility — merge approval gate is always armed", () => {
		it("ignores the retired zero value and still requires founder approval", () => {
			writeSession({ qa_required: 1, pr_number: 5 }); // QA required, not passed
			const legacyKey = ["FLYWHEEL", "MERGE", "APPROVAL", "GATE"].join("_");
			const d = evaluateShipEligibility({
				execId: EXEC,
				prHead: HEAD,
				commDbPath,
				stateDbPath,
				env: { [legacyKey]: "0" },
			});
			expect(d.mergeApprovalOk).toBe(false);
			expect(d.qaOk).toBe(false);
			expect(d.eligible).toBe(false);
			expect(d.qaReason).toBe("qa_not_passed");
		});
	});
});
