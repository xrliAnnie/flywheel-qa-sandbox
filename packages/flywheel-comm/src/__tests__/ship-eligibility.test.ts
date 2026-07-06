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
	}): void {
		const db = new Database(stateDbPath);
		db.exec(
			`CREATE TABLE IF NOT EXISTS sessions (
				execution_id TEXT PRIMARY KEY,
				status TEXT,
				pr_head_sha TEXT,
				qa_required INTEGER,
				decision_route TEXT,
				pr_number INTEGER
			);
			CREATE TABLE IF NOT EXISTS auto_qa_record (
				parent_execution_id TEXT NOT NULL,
				target_pr_head_sha TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'running',
				PRIMARY KEY (parent_execution_id, target_pr_head_sha)
			);`,
		);
		db.prepare(
			"INSERT OR REPLACE INTO sessions (execution_id, status, pr_head_sha, qa_required, decision_route, pr_number) VALUES (?, 'awaiting_review', ?, ?, ?, ?)",
		).run(
			EXEC,
			HEAD,
			row.qa_required ?? null,
			row.decision_route ?? null,
			row.pr_number ?? null,
		);
		if (row.qaPassedHead) {
			db.prepare(
				"INSERT OR REPLACE INTO auto_qa_record (parent_execution_id, target_pr_head_sha, status) VALUES (?, ?, 'passed')",
			).run(EXEC, row.qaPassedHead);
		}
		db.close();
	}

	const on = { FLYWHEEL_QA_DONE_GATE: "1" } as NodeJS.ProcessEnv;

	describe("evaluateQaShipGate", () => {
		it("kill-switch off → passes regardless of snapshot", () => {
			writeSession({ qa_required: 1, pr_number: 5 }); // required, no passed record
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: { FLYWHEEL_QA_DONE_GATE: "0" } as NodeJS.ProcessEnv,
			});
			expect(r).toEqual({ passed: true, reason: "qa_gate_off" });
		});

		it("qa_required=1 + passing record for head → qa_ok", () => {
			writeSession({ qa_required: 1, pr_number: 5, qaPassedHead: HEAD });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: HEAD,
				stateDbPath,
				env: on,
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
				env: on,
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
				env: on,
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
				env: on,
			});
			expect(r).toMatchObject({ passed: true, reason: "qa_not_required" });
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
				env: on,
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
				env: on,
			});
			expect(r.passed).toBe(false);
			expect(r.reason).toBe("qa_snapshot_missing_failclosed");
		});

		it("invalid head → fail-closed", () => {
			writeSession({ qa_required: 0, pr_number: 5 });
			const r = evaluateQaShipGate({
				execId: EXEC,
				prHead: "xyz",
				stateDbPath,
				env: on,
			});
			expect(r).toMatchObject({
				passed: false,
				reason: "invalid_pr_head_format",
			});
		});
	});

	describe("evaluateShipEligibility — independent kill-switches (R2 HIGH-3)", () => {
		it("merge gate OFF must NOT bypass the QA gate", () => {
			writeSession({ qa_required: 1, pr_number: 5 }); // QA required, not passed
			const d = evaluateShipEligibility({
				execId: EXEC,
				prHead: HEAD,
				commDbPath,
				stateDbPath,
				env: {
					FLYWHEEL_MERGE_APPROVAL_GATE: "0", // B off
					FLYWHEEL_QA_DONE_GATE: "1", // A on
				} as NodeJS.ProcessEnv,
			});
			expect(d.mergeApprovalOk).toBe(true); // B bypassed
			expect(d.qaOk).toBe(false); // A still enforced
			expect(d.eligible).toBe(false); // → still blocked
			expect(d.qaReason).toBe("qa_not_passed");
		});

		it("both gates OFF → eligible", () => {
			writeSession({ qa_required: 1, pr_number: 5 });
			const d = evaluateShipEligibility({
				execId: EXEC,
				prHead: HEAD,
				commDbPath,
				stateDbPath,
				env: {
					FLYWHEEL_MERGE_APPROVAL_GATE: "0",
					FLYWHEEL_QA_DONE_GATE: "0",
				} as NodeJS.ProcessEnv,
			});
			expect(d.eligible).toBe(true);
			expect(d.mergeApprovalOk).toBe(true);
			expect(d.qaOk).toBe(true);
		});
	});
});
