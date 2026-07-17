import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const RUN = "run-materialize-1";
const ISSUE = "FLY-1307";
const PRODUCER = "produce";
const REVIEW = "review";
const OUTPUT_DIGEST = "d".repeat(64);
const BASE_HEAD = "a".repeat(40);
const TREE_HEAD = "b".repeat(40);
const COMMIT_HEAD = "c".repeat(40);
const REPO = "xrliAnnie/flywheel";
const REF = "refs/heads/flywheel/docs/flywheel/FLY-1307";

type InternalDb = {
	run(sql: string, params?: unknown[]): void;
};

async function seededStore(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: RUN,
		issueId: ISSUE,
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertWorkflowRunNode({
		runId: RUN,
		nodeId: PRODUCER,
		attempt: 1,
		state: "done",
		executionId: "exec-produce-1",
	});
	const db = (store as unknown as { db: InternalDb }).db;
	db.run(
		`INSERT INTO workflow_execution_binding
		   (execution_id, run_id, node_id, attempt, bound_at)
		 VALUES ('exec-produce-1', ?, ?, 1, '2026-07-16T00:00:00.000Z')`,
		[RUN, PRODUCER],
	);
	db.run(
		`INSERT INTO workflow_node_outputs
		   (id, run_id, node_id, attempt, execution_id, payload, output_digest,
		    output_schema, byte_size, client_request_id, submission_digest, written_at)
		 VALUES (1, ?, ?, 1, 'exec-produce-1', ?, ?, 'json_v1', 64, 'req-1',
		         'submission-1', '2026-07-16T00:00:00.000Z')`,
		[
			RUN,
			PRODUCER,
			JSON.stringify({
				kind: "docs_v1",
				operations: [
					{ op: "write", path: "product/doc/prd.md", content: "PRD\n" },
				],
			}),
			OUTPUT_DIGEST,
		],
	);
	db.run(
		`INSERT INTO workflow_node_output_current
		   (run_id, node_id, output_id, attempt, execution_id, promoted_at)
		 VALUES (?, ?, 1, 1, 'exec-produce-1', '2026-07-16T00:00:00.000Z')`,
		[RUN, PRODUCER],
	);
	return store;
}

function allocate(store: StateStore) {
	return store.allocateWorkflowMaterialization({
		runId: RUN,
		nodeId: PRODUCER,
		attempt: 1,
		outputId: 1,
		outputDigest: OUTPUT_DIGEST,
		repo: REPO,
		ref: REF,
		baseHead: BASE_HEAD,
	});
}

describe("workflow materialization ledger and receipts", () => {
	it("allocates the materialize intent and pinned receipt atomically and idempotently", async () => {
		const store = await seededStore();
		const first = allocate(store);
		const replay = allocate(store);

		expect(first.effect_id).toMatch(/^mat:[0-9a-f]{64}$/);
		expect(replay).toEqual(first);
		expect(store.listWorkflowSideEffects(RUN)).toEqual([
			expect.objectContaining({
				kind: "materialize",
				execution_id: first.effect_id,
				state: "intent_recorded",
			}),
		]);
		expect(store.getWorkflowMaterializationReceipts(first.effect_id)).toEqual([
			expect.objectContaining({
				stage: "intent_pinned",
				output_id: 1,
				output_digest: OUTPUT_DIGEST,
				repo: REPO,
				ref: REF,
				base_head: BASE_HEAD,
			}),
		]);
		expect(store.listNonTerminalWorkflowSideEffects()).toEqual([]);
		expect(store.listNonTerminalWorkflowMaterializations()).toHaveLength(1);
	});

	it("rolls back the ledger row when the intent receipt insert fails", async () => {
		const store = await seededStore();
		const db = (store as unknown as { db: InternalDb }).db;
		const originalRun = db.run.bind(db);
		db.run = (sql, params) => {
			if (sql.includes("INSERT INTO workflow_materialization_receipt")) {
				throw new Error("injected receipt failure");
			}
			originalRun(sql, params);
		};
		expect(() => allocate(store)).toThrow(/injected receipt failure/);
		db.run = originalRun;
		expect(store.listWorkflowSideEffects(RUN)).toEqual([]);
	});

	it("rejects a current output whose execution binding no longer matches", async () => {
		const store = await seededStore();
		const db = (store as unknown as { db: InternalDb }).db;
		db.run(
			`INSERT INTO workflow_execution_binding
			   (execution_id, run_id, node_id, attempt, bound_at)
			 VALUES ('exec-produce-other', ?, ?, 1, '2026-07-16T00:01:00.000Z')`,
			[RUN, PRODUCER],
		);
		db.run(
			`UPDATE workflow_node_output_current
			    SET execution_id = 'exec-produce-other'
			  WHERE run_id = ? AND node_id = ?`,
			[RUN, PRODUCER],
		);

		expect(() => allocate(store)).toThrow(/current accepted output/i);
		expect(store.listWorkflowSideEffects(RUN)).toEqual([]);
	});

	it("adopts a commit and confirms a matching remote head in the same state transitions", async () => {
		const store = await seededStore();
		const intent = allocate(store);
		store.adoptWorkflowMaterializationCommit({
			effectId: intent.effect_id,
			treeHead: TREE_HEAD,
			commitHead: COMMIT_HEAD,
		});
		expect(store.listWorkflowSideEffects(RUN)[0]?.state).toBe(
			"launch_committed",
		);

		expect(() =>
			store.confirmWorkflowMaterializationPush({
				effectId: intent.effect_id,
				remoteHead: "e".repeat(40),
				reviewNodeId: REVIEW,
			}),
		).toThrow(/remote head/i);
		const db = (store as unknown as { db: InternalDb }).db;
		db.run(
			`INSERT INTO workflow_claims
			   (server_seq, issue_id, workflow_run_id, node_id, decision_kind, attempt,
			    predicate, issuer_kind, subject_kind, subject_digest, permanent, authority_id)
			 VALUES (1, ?, ?, ?, 'review_verdict', 1, 'design_review_approved',
			         'bridge_policy', 'git_head', ?, 1, 'old-review')`,
			[ISSUE, RUN, REVIEW, "f".repeat(40)],
		);

		store.confirmWorkflowMaterializationPush({
			effectId: intent.effect_id,
			remoteHead: COMMIT_HEAD,
			reviewNodeId: REVIEW,
		});
		expect(store.listWorkflowSideEffects(RUN)[0]?.state).toBe("started");
		expect(
			store
				.getWorkflowMaterializationReceipts(intent.effect_id)
				.map((row) => row.stage),
		).toEqual(["intent_pinned", "commit_adopted", "push_confirmed"]);
		expect(store.getWorkflowMaterializedHead(RUN, PRODUCER)).toEqual({
			head: COMMIT_HEAD,
			outputId: 1,
			attempt: 1,
		});
		expect(
			store.resolveWorkflowDecisionClaim({
				runId: RUN,
				nodeId: REVIEW,
				decisionKind: "review_verdict",
				subjectKind: "git_head",
				subjectDigest: "f".repeat(40),
			}),
		).toEqual({ valid: false, reason: "revoked" });
	});

	it("fails closed when the durable receipt no longer matches the current output pointer", async () => {
		const store = await seededStore();
		const intent = allocate(store);
		store.adoptWorkflowMaterializationCommit({
			effectId: intent.effect_id,
			treeHead: TREE_HEAD,
			commitHead: COMMIT_HEAD,
		});
		store.confirmWorkflowMaterializationPush({
			effectId: intent.effect_id,
			remoteHead: COMMIT_HEAD,
			reviewNodeId: REVIEW,
		});

		const db = (store as unknown as { db: InternalDb }).db;
		db.run(
			`INSERT INTO workflow_execution_binding
			   (execution_id, run_id, node_id, attempt, bound_at)
			 VALUES ('exec-produce-2', ?, ?, 2, '2026-07-16T01:00:00.000Z')`,
			[RUN, PRODUCER],
		);
		db.run(
			`INSERT INTO workflow_node_outputs
			   (id, run_id, node_id, attempt, execution_id, payload, output_digest,
			    output_schema, byte_size, client_request_id, submission_digest, written_at)
			 SELECT 2, run_id, node_id, 2, 'exec-produce-2', payload, ?, output_schema,
			        byte_size, 'req-2', 'submission-2', '2026-07-16T01:00:00.000Z'
			   FROM workflow_node_outputs WHERE id = 1`,
			["e".repeat(64)],
		);
		db.run(
			`UPDATE workflow_node_output_current
			    SET output_id = 2, attempt = 2, execution_id = 'exec-produce-2'
			  WHERE run_id = ? AND node_id = ?`,
			[RUN, PRODUCER],
		);
		expect(store.getWorkflowMaterializedHead(RUN, PRODUCER)).toBeUndefined();
	});

	it("keeps materialize effects out of all dispatch attribution queries", async () => {
		const store = await seededStore();
		const intent = allocate(store);
		store.insertEvent({
			event_id: "mat-fix",
			execution_id: intent.effect_id,
			issue_id: ISSUE,
			project_name: "flywheel",
			event_type: "three_stage_fix_round",
			payload: { round: 9 },
			source: "test",
		});
		store.insertEvent({
			event_id: "mat-ship",
			execution_id: intent.effect_id,
			issue_id: ISSUE,
			project_name: "flywheel",
			event_type: "post_ship_finalization_claim",
			source: "test",
		});

		expect(
			store.isExecutionAttributedToWorkflowRun(RUN, intent.effect_id),
		).toBe(false);
		expect(store.listWorkflowRunAttributedFixRounds(RUN, ISSUE)).toEqual([]);
		expect(store.hasWorkflowRunAttributedShipClaim(RUN, ISSUE)).toBe(false);
	});

	it("enforces append-only receipts", async () => {
		const store = await seededStore();
		allocate(store);
		const db = (store as unknown as { db: InternalDb }).db;
		expect(() =>
			db.run(
				"UPDATE workflow_materialization_receipt SET base_head = 'forged'",
			),
		).toThrow(/append-only/i);
		expect(() =>
			db.run("DELETE FROM workflow_materialization_receipt"),
		).toThrow(/append-only/i);
	});
});
