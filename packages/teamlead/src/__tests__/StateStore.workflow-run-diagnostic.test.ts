import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

const HEAD = "a".repeat(40);
const NOW = "2026-07-23T12:00:00.000Z";

async function fixture() {
	const store = await StateStore.create(":memory:");
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
	)!;
	store.createWorkflowRun({
		runId: "run-diagnostic",
		issueId: "FLY-1434",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(
			buildWorkflowRunSnapshotV1({
				template: { id: seed.templateId, revision: 1 },
				manifest: seed.manifest,
			}),
		),
		claimsReadEnrolled: true,
	});
	const db = (
		store as unknown as {
			db: {
				run(sql: string, params?: unknown[]): void;
				raw: {
					prepare(sql: string): {
						get(...params: unknown[]): Record<string, unknown>;
					};
				};
			};
		}
	).db;
	db.run(
		`UPDATE workflow_run
		    SET engine_owned = 1, entry_kind = 'pipeline_dag_v1',
		        current_node_id = 'land'
		  WHERE run_id = 'run-diagnostic'`,
	);
	store.upsertWorkflowRunNode({
		runId: "run-diagnostic",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-diagnostic",
	});
	store.upsertWorkflowRunNode({
		runId: "run-diagnostic",
		nodeId: "land",
		attempt: 1,
		state: "pending",
		executionId: "land-diagnostic",
	});
	db.run(
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha,
		    target_repo_identity, probe_repo_slug, target_repo_path,
		    worktree_binding_generation, receipt_id, bound_at)
		 VALUES ('run-diagnostic', 'implement', 1, 1434, ?, '__main__',
		         'geoforge3d/flywheel', '/private/tmp/flywheel',
		         'generation-secret-path', 'diagnostic-pr', ?)`,
		[HEAD, NOW],
	);
	store.ensureWorkflowGateHolder({
		runId: "run-diagnostic",
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: HEAD,
		sourceExecutionId: "qa-diagnostic",
		questionId: "approve-diagnostic",
		now: NOW,
	});
	db.run(
		"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = 'approve-diagnostic'",
	);
	db.run(
		`INSERT INTO workflow_claims
		   (server_seq, issue_id, workflow_run_id, node_id, decision_kind,
		    attempt, predicate, issuer_kind, subject_kind, subject_digest,
		    expires_at, permanent, evidence, authority_id)
		 VALUES (1, 'FLY-1434', 'run-diagnostic', 'qa', 'qa_verdict', 1,
		         'qa_passed', 'bridge_policy', 'git_head', ?, NULL, 1,
		         '{"secret":"SECRET_SENTINEL"}', 'qa-authority')`,
		[HEAD],
	);
	db.run(
		`INSERT INTO workflow_start_reservation
		   (idempotency_key, selection_digest, run_id, node_id, attempt,
		    execution_id, created_at)
		 VALUES ('RAW_IDEMPOTENCY_SECRET', 'selection', 'run-diagnostic',
		         'design', 1, 'start-diagnostic', ?)`,
		[NOW],
	);
	db.run(
		`INSERT INTO workflow_start_stage
		   (idempotency_key, stage, updated_at)
		 VALUES ('RAW_IDEMPOTENCY_SECRET', 'responded', ?)`,
		[NOW],
	);
	return { store, db };
}

describe("workflow run diagnostic DTO", () => {
	it("is read-only, allowlisted, stable, and exposes exact authority heads", async () => {
		const { store, db } = await fixture();
		const before = Number(
			db.raw.prepare("SELECT total_changes() AS n").get().n,
		);
		const result = store.getWorkflowRunDiagnostic({
			runId: "run-diagnostic",
			evidence: [
				{
					executionId: "implement-diagnostic",
					sessionStatus: null,
					lifecycleRevision: null,
					liveness: "dead",
					observedAt: NOW,
				},
				{
					executionId: "land-diagnostic",
					sessionStatus: null,
					lifecycleRevision: null,
					liveness: "dead",
					observedAt: NOW,
				},
			],
			now: NOW,
		});
		const after = Number(db.raw.prepare("SELECT total_changes() AS n").get().n);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(after).toBe(before);
		expect(result.dto).toMatchObject({
			schema_version: 1,
			run: {
				run_id: "run-diagnostic",
				issue_id: "FLY-1434",
				status: "active",
				entry_kind: "pipeline_dag_v1",
				current_node_id: "land",
			},
			ship_target_binding: {
				approve_question_id: "approve-diagnostic",
				target_repo_identity: "__main__",
				probe_repo_slug: "geoforge3d/flywheel",
				frozen_head_sha: HEAD,
				superseded: false,
			},
			single_closeout_target: {
				pr_number: 1434,
				frozen_head_sha: HEAD,
			},
			quiescence: { live_executions: 0, quiescent: true },
		});
		expect(result.dto.claims[0]).toMatchObject({
			subject_digest: HEAD,
			revoked: false,
		});
		expect(result.dto.start_reservation?.idempotency_key_digest).toMatch(
			/^[0-9a-f]{64}$/,
		);
		expect(result.dto.closeout_invariant_digest).toMatch(/^[0-9a-f]{64}$/);
		const serialized = JSON.stringify(result.dto);
		expect(serialized).not.toContain("SECRET_SENTINEL");
		expect(serialized).not.toContain("RAW_IDEMPOTENCY_SECRET");
		expect(serialized).not.toContain("generation-secret-path");
		expect(serialized).not.toContain("/private/tmp/flywheel");
		expect(serialized).not.toContain("token_hash");
		expect(serialized).toContain(HEAD);
		store.close();
	});

	it("fails closed when two current ship targets conflict", async () => {
		const { store, db } = await fixture();
		db.run(
			`INSERT INTO workflow_ship_target_binding
			   (approve_question_id, run_id, target_repo_path,
			    target_repo_identity, probe_repo_slug, frozen_head_sha,
			    worktree_binding_generation)
			 VALUES ('approve-conflict', 'run-diagnostic', '/private/tmp/other',
			         '__main__', 'geoforge3d/flywheel', ?,
			         'generation-conflict')`,
			[HEAD],
		);
		expect(
			store.getWorkflowRunDiagnostic({
				runId: "run-diagnostic",
				evidence: [],
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "diagnostic_data_conflict" });
		store.close();
	});

	it("counts run-attributed merge receipts outside the sealed PR set", async () => {
		const { store, db } = await fixture();
		store.openWorkflowPrManifest({
			runId: "run-diagnostic",
			expectedCount: 1,
			now: NOW,
		});
		expect(
			store.sealWorkflowPrManifestFromBindings({
				runId: "run-diagnostic",
				now: NOW,
			}).ok,
		).toBe(true);
		const operation = store.ensureLandOperation({
			runId: "run-diagnostic",
			issueId: "FLY-1434",
			projectName: "flywheel",
			prNumber: 999,
			approvedHead: "b".repeat(40),
			now: NOW,
		});
		db.run(
			"UPDATE land_operation SET merge_confirmed_at = ? WHERE operation_id = ?",
			[NOW, operation.operation_id],
		);
		const diagnostic = store.getWorkflowRunDiagnostic({
			runId: "run-diagnostic",
			evidence: [
				{
					executionId: "implement-diagnostic",
					sessionStatus: null,
					lifecycleRevision: null,
					liveness: "dead",
					observedAt: NOW,
				},
				{
					executionId: "land-diagnostic",
					sessionStatus: null,
					lifecycleRevision: null,
					liveness: "dead",
					observedAt: NOW,
				},
			],
			now: NOW,
		});
		if (!diagnostic.ok) throw new Error(diagnostic.reason);
		expect(diagnostic.dto.receipts).toEqual({
			attributed_in_set: 0,
			attributed_out_of_set: 1,
		});
		store.close();
	});

	it("binds nested manual termination to the diagnostic digest and exact merge proof", async () => {
		const { store, db } = await fixture();
		db.run(
			`UPDATE workflow_node_pr_binding
			    SET target_repo_identity = 'geoforge3d/nested',
			        probe_repo_slug = 'geoforge3d/nested'
			  WHERE run_id = 'run-diagnostic'`,
		);
		db.run(
			`UPDATE workflow_ship_target_binding
			    SET target_repo_identity = 'geoforge3d/nested',
			        probe_repo_slug = 'geoforge3d/nested'
			  WHERE run_id = 'run-diagnostic'`,
		);
		db.run(
			`INSERT INTO workflow_run_event
			   (run_id, seq, event_uid, kind, node_id, execution_id, payload, at)
			 VALUES ('run-diagnostic', 1, 'nested-land-held', 'land_held',
			         'land', 'land-diagnostic',
			         '{"reason":"nested_land_unsupported"}', ?)`,
			[NOW],
		);
		db.run(
			"UPDATE workflow_run SET status = 'held' WHERE run_id = 'run-diagnostic'",
		);
		const evidence = [
			{
				executionId: "implement-diagnostic",
				sessionStatus: null,
				lifecycleRevision: null,
				liveness: "dead" as const,
				observedAt: NOW,
			},
			{
				executionId: "land-diagnostic",
				sessionStatus: null,
				lifecycleRevision: null,
				liveness: "dead" as const,
				observedAt: NOW,
			},
		];
		const diagnostic = store.getWorkflowRunDiagnostic({
			runId: "run-diagnostic",
			evidence,
			now: NOW,
		});
		if (!diagnostic.ok) throw new Error(diagnostic.reason);
		expect(diagnostic.dto.single_closeout_target).toMatchObject({
			target_repo_identity: "geoforge3d/nested",
			probe_repo_slug: "geoforge3d/nested",
			pr_number: 1434,
			frozen_head_sha: HEAD,
		});

		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-diagnostic",
				reason: "nested PR merged; close manually",
				clientRequestId: "nested-closeout",
				principal: "master",
				evidence,
				now: NOW,
			}),
		).toEqual({
			ok: false,
			reason: "closeout_invariant_required",
		});
		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-diagnostic",
				reason: "nested PR merged; close manually",
				clientRequestId: "nested-closeout",
				principal: "master",
				evidence,
				now: NOW,
				closeoutInvariantDigest: "e".repeat(64),
				closeoutKind: "nested_manual",
			}),
		).toEqual({
			ok: false,
			reason: "closeout_invariant_changed",
		});
		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-diagnostic",
				reason: "nested PR merged; close manually",
				clientRequestId: "nested-closeout",
				principal: "master",
				evidence,
				now: NOW,
				closeoutInvariantDigest: diagnostic.dto.closeout_invariant_digest,
				closeoutKind: "nested_manual",
				mergeProof: {
					probeRepoSlug: "geoforge3d/nested",
					prNumber: 1434,
					headSha: "b".repeat(40),
					state: "MERGED",
				},
			}),
		).toEqual({
			ok: false,
			reason: "nested_closeout_merge_unproven",
		});
		const request = {
			runId: "run-diagnostic",
			reason: "nested PR merged; close manually",
			clientRequestId: "nested-closeout",
			principal: "master",
			evidence,
			now: NOW,
			closeoutInvariantDigest: diagnostic.dto.closeout_invariant_digest,
			closeoutKind: "nested_manual" as const,
			mergeProof: {
				probeRepoSlug: "geoforge3d/nested",
				prNumber: 1434,
				headSha: HEAD,
				state: "MERGED" as const,
			},
		};
		expect(store.terminateWorkflowRunByOperator(request)).toEqual({
			ok: true,
			status: "terminated",
			idempotentReplay: false,
		});
		expect(store.terminateWorkflowRunByOperator(request)).toEqual({
			ok: true,
			status: "terminated",
			idempotentReplay: true,
		});
		expect(
			store.openWorkflowPrManifest({
				runId: "run-diagnostic",
				expectedCount: 1,
				now: NOW,
			}),
		).toMatchObject({
			ok: false,
			reason: "run_terminal_authority_frozen",
		});
		const post = store.getWorkflowRunDiagnostic({
			runId: "run-diagnostic",
			evidence,
			now: NOW,
		});
		if (!post.ok) throw new Error(post.reason);
		expect(post.dto.latest_termination).toMatchObject({
			client_request_id: "nested-closeout",
			closeout_invariant_digest: diagnostic.dto.closeout_invariant_digest,
			closeout_kind: "nested_manual",
		});
		store.close();
	});
});
