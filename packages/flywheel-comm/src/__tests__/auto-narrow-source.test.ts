import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoNarrowVerdictId } from "../auto-narrow-contract.js";
import { CommDB } from "../db.js";

const HEAD = "a".repeat(40);

function envelope(questionId: string) {
	return {
		schema_version: 1,
		policy_version: 1,
		run_id: "run-2453",
		issue_id: "FLY-2453",
		question_id: questionId,
		gate_node_id: "founder_gate",
		attempt: 1,
		source_execution_id: "implement-2453",
		repo_identity: "__main__",
		repo_slug: "xrliAnnie/flywheel",
		pr_number: 1140,
		head_sha: HEAD,
		response: { approved: true },
		actor: "bridge-auto-narrow-gate",
		decision_source: "auto_narrow_gate",
		control: {
			event_id: "11111111-1111-4111-8111-111111111111",
			opening_event_id: "11111111-1111-4111-8111-111111111111",
			flag_revision: 1,
			opening_at: "2026-09-09T03:00:00.000Z",
			founder_message_id: "1517000000000000001",
		},
		declaration: {
			declaration_id: "33333333-3333-4333-8333-333333333333",
			declaration_seq: 1,
		},
		strength_two: {
			basis_record_id: "44444444-4444-4444-8444-444444444444",
		},
		observation: {
			verdict_id: autoNarrowVerdictId(questionId),
			run_id: "run-2453",
			question_id: questionId,
			gate_execution_id: "implement-2453",
			repo_identity: "__main__",
			pr_number: 1140,
			head_sha: HEAD,
			observed_at: "2026-09-09T03:01:00.000Z",
			machine_class: "docs_only",
			machine_reason: null,
			machine_file_count: 2,
			machine_candidate_count: 1,
			machine_declared_projected_count: 0,
			machine_primary_snapshot_age_ms: 1000,
			machine_declared_max_snapshot_age_ms: null,
			machine_basis_json:
				'{"schemaVersion":1,"prs":[],"nestedReviews":{"entries":[]}}',
			s2_ran_status: "satisfied",
			s2_ran_reason: "ok",
			s2_record_status: "satisfied",
			s2_record_reason: "ok",
			s2_verdict: "satisfied",
			s2_basis_record_id: "44444444-4444-4444-8444-444444444444",
			s2_row_count: 1,
			s2_other_head_row_count: 0,
			shadow_version: 1,
		},
		decision_at: "2026-09-09T03:01:00.000Z",
	};
}

describe("CommDB auto narrow source writer", () => {
	let root: string;
	let path: string;
	let db: CommDB;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2453-source-"));
		path = join(root, "comm.db");
		db = new CommDB(path);
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("commits one synthetic response and strict source in the same transaction", () => {
		const questionId = db.insertQuestion("implement-2453", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		expect(
			db.insertAutoNarrowApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2453",
				projectedThroughSourceRowId: 0,
				envelope: envelope(questionId),
			}),
		).toEqual({ written: true, replayed: false });
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: "bridge-auto-narrow-gate",
		});
		expect(db.listWorkflowSourceEvents()).toMatchObject([
			{
				source_event_id: `auto-narrow:${questionId}`,
				kind: "founder_approval",
			},
		]);
		expect(
			db.insertAutoNarrowApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2453",
				projectedThroughSourceRowId: 0,
				envelope: envelope(questionId),
			}),
		).toEqual({ written: true, replayed: true });
	});

	it("rolls the response back if the source append fails", () => {
		const questionId = db.insertQuestion("implement-2453", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const raw = new Database(path);
		raw.exec(`CREATE TRIGGER fail_auto_source BEFORE INSERT ON workflow_source_event
			WHEN NEW.source_event_id LIKE 'auto-narrow:%'
			BEGIN SELECT RAISE(ABORT, 'fixture source failure'); END;`);
		raw.close();
		expect(() =>
			db.insertAutoNarrowApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2453",
				projectedThroughSourceRowId: 0,
				envelope: envelope(questionId),
			}),
		).toThrow(/source failure/);
		expect(db.getResponse(questionId)).toBeUndefined();
	});

	it("generic founder source writer refuses the reserved auto actor", () => {
		const questionId = db.insertQuestion("implement-2453", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		expect(() =>
			db.insertFounderApprovalResponseWithSource({
				project: "flywheel",
				sourceEventId: `auto-narrow:${questionId}`,
				questionId,
				fromAgent: "bridge-auto-narrow-gate",
				content: '{"approved":true}',
				expectedOwner: "implement-2453",
				payload: envelope(questionId),
			}),
		).toThrow(/reserved/i);
		expect(db.getResponse(questionId)).toBeUndefined();
	});

	it("fails fast on a CommDB writer lock and restores the prior busy timeout", () => {
		const questionId = db.insertQuestion("implement-2453", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const internal = (db as unknown as { db: Database.Database }).db;
		internal.pragma("busy_timeout = 777");
		const locker = new Database(path);
		locker.pragma("busy_timeout = 0");
		locker.exec("BEGIN IMMEDIATE");
		const started = Date.now();
		expect(() =>
			db.insertAutoNarrowApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2453",
				projectedThroughSourceRowId: 0,
				envelope: envelope(questionId),
			}),
		).toThrow(/busy|locked/i);
		expect(Date.now() - started).toBeLessThan(250);
		expect(internal.pragma("busy_timeout", { simple: true })).toBe(777);
		locker.exec("ROLLBACK");
		locker.close();
		expect(
			db.insertAutoNarrowApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2453",
				projectedThroughSourceRowId: 0,
				envelope: envelope(questionId),
			}),
		).toEqual({ written: true, replayed: false });
	});

	it("blocks an unprojected related founder feedback source inside the CommDB lock", () => {
		const questionId = db.insertQuestion("implement-2453", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const internal = (db as unknown as { db: Database.Database }).db;
		internal
			.prepare(
				`INSERT INTO workflow_source_event
				 (project, source_event_id, kind, payload, payload_digest, schema_version, at)
				 VALUES ('flywheel', 'founder-feedback:older-card', 'founder_feedback',
				         ?, 'digest', 1, '2026-09-09T03:00:59.000Z')`,
			)
			.run(JSON.stringify({ run_id: "run-2453", issue_id: "FLY-2453" }));
		expect(
			db.insertAutoNarrowApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2453",
				projectedThroughSourceRowId: 0,
				envelope: envelope(questionId),
			}),
		).toEqual({ written: false, replayed: false });
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(
			db.insertAutoNarrowApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2453",
				projectedThroughSourceRowId: 1,
				envelope: envelope(questionId),
			}),
		).toEqual({ written: true, replayed: false });
	});
});
