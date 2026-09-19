import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import {
	SHIP_JUDGMENT_APPROVAL_ACTOR,
	SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
} from "../ship-judgment-approval-contract.js";

function envelope(questionId: string) {
	return {
		schema_version: 1,
		policy: "three-point-auto-v1",
		judgment_policy: "ship-judgment-v1",
		project_name: "flywheel",
		run_id: "run-2737",
		issue_id: "FLY-2737",
		question_id: questionId,
		gate_node_id: "founder_gate",
		attempt: 1,
		source_execution_id: "implement-2737",
		card: {
			message_id: "123456789012345678",
			thread_id: "123456789012345679",
			channel_id: "123456789012345680",
		},
		primary: {
			repo_identity: "__main__",
			repo_slug: "owner/repo",
			pr_number: 2737,
			head_sha: "a".repeat(40),
		},
		targets: [
			{
				repo_identity: "__main__",
				repo_slug: "owner/repo",
				pr_number: 2737,
				head_sha: "a".repeat(40),
			},
		],
		manifest: { revision: 1, digest: "b".repeat(64) },
		judgment: {
			opinion_id: "opinion-1",
			input_id: "input-1",
			evaluation_id: "evaluation-1",
			semantic_digest: "c".repeat(64),
			model_snapshot_digest: "d".repeat(64),
			evidence_policy: "ship-judgment-evidence-v2",
			evidence_digest: "e".repeat(64),
			mechanical_digest: "f".repeat(64),
			mechanical_checked_at: "2026-09-18T16:30:00.000Z",
			presentation_digest: "1".repeat(64),
			delivered_message_id: "123456789012345681",
		},
		control: {
			event_id: "11111111-1111-4111-8111-111111111111",
			opening_event_id: "22222222-2222-4222-8222-222222222222",
			flag_revision: 3,
		},
		policy_provenance: {
			id: "33333333-3333-4333-8333-333333333333",
			original_message_digest: "2".repeat(64),
		},
		decision_at: "2026-09-18T16:30:01.000Z",
		response: { approved: true as const },
		actor: SHIP_JUDGMENT_APPROVAL_ACTOR,
		decision_source: SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
	};
}

describe("CommDB ship judgment approval source writer", () => {
	let root: string;
	let path: string;
	let db: CommDB;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2737-source-"));
		path = join(root, "comm.db");
		db = new CommDB(path);
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("atomically writes one byte-stable machine response and source", () => {
		const questionId = db.insertQuestion("implement-2737", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const input = {
			project: "flywheel",
			expectedOwner: "implement-2737",
			projectedThroughSourceRowId: 0,
			envelope: envelope(questionId),
		};
		expect(db.insertShipJudgmentApprovalWithSource(input)).toEqual({
			written: true,
			replayed: false,
		});
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: SHIP_JUDGMENT_APPROVAL_ACTOR,
		});
		expect(db.listWorkflowSourceEvents()).toMatchObject([
			{
				source_event_id: `ship-judgment-auto:${questionId}`,
				kind: "founder_approval",
			},
		]);
		expect(db.insertShipJudgmentApprovalWithSource(input)).toEqual({
			written: true,
			replayed: true,
		});
	});

	it("rolls back its response when the source append fails", () => {
		const questionId = db.insertQuestion("implement-2737", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const raw = new Database(path);
		raw.exec(`CREATE TRIGGER fail_ship_judgment_source BEFORE INSERT ON workflow_source_event
			WHEN NEW.source_event_id LIKE 'ship-judgment-auto:%'
			BEGIN SELECT RAISE(ABORT, 'fixture source failure'); END;`);
		raw.close();
		expect(() =>
			db.insertShipJudgmentApprovalWithSource({
				project: "flywheel",
				expectedOwner: "implement-2737",
				projectedThroughSourceRowId: 0,
				envelope: envelope(questionId),
			}),
		).toThrow(/source failure/);
		expect(db.getResponse(questionId)).toBeUndefined();
	});

	it("rejects the machine identity through the generic founder writer", () => {
		const questionId = db.insertQuestion("implement-2737", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		expect(() =>
			db.insertFounderApprovalResponseWithSource({
				project: "flywheel",
				sourceEventId: `ship-judgment-auto:${questionId}`,
				questionId,
				fromAgent: SHIP_JUDGMENT_APPROVAL_ACTOR,
				content: '{"approved":true}',
				expectedOwner: "implement-2737",
				payload: envelope(questionId),
			}),
		).toThrow(/reserved/i);
	});
});
