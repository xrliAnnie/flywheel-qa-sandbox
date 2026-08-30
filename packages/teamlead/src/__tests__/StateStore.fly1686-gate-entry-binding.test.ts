import { describe, expect, it } from "vitest";
import { resolveLandSourceSession } from "../bridge/land-source-session.js";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const engineFlags = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GATE_CARRIER: "1",
};

async function landRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-fly1686",
		issueId: "FLY-1686",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: engineFlags,
		startReservation: {
			idempotencyKey: "start-fly1686",
			selectionDigest: "selection-fly1686",
			nodeId: "design",
			attempt: 1,
			executionId: "design-fly1686",
			createdAt: "2026-08-11T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-fly1686",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-fly1686",
	});
	return store;
}

describe("FLY-1686 gate-entry PR binding", () => {
	it("binds the gate predecessor head instead of an intermediate completion head", async () => {
		const store = await landRun();
		const reviewedHead = "b".repeat(40);
		const gateEntryHead = "c".repeat(40);

		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-fly1686",
				nodeId: "design",
				attempt: 1,
				executionId: "design-fly1686",
				outcome: "design_done",
				successorExecutionId: "implement-fly1686",
				now: "2026-08-11T00:01:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-fly1686",
				nodeId: "implement",
				executionId: "implement-fly1686",
				attempt: 1,
				expiresAt: "2026-08-11T03:00:00.000Z",
				absoluteDeadlineAt: "2026-08-11T04:00:00.000Z",
				now: "2026-08-11T00:02:00.000Z",
				env: engineFlags,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "implement-fly1686",
			issue_id: "FLY-1686",
			project_name: "flywheel",
			status: "running",
		});
		expect(
			store.commitEnrolledCompletion({
				nodeReuseEnabled: false,
				executionId: "implement-fly1686",
				route: "needs_review",
				sourceEventId: "complete-implement-fly1686",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: reviewedHead,
				prBinding: {
					prNumber: 807,
					headSha: reviewedHead,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliannie/flywheel",
					targetRepoPath: "/tmp/flywheel",
					worktreeBindingGeneration: "generation-implement",
				},
				now: "2026-08-11T00:03:00.000Z",
			}),
		).toMatchObject({ ok: true });

		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-fly1686", reviewedHead),
		).toBeUndefined();
		expect(store.getSession("implement-fly1686")).toMatchObject({
			pr_number: 807,
			pr_head_sha: reviewedHead,
		});
		// Simulate an in-flight run created before FLY-1686, where implement
		// completion already wrote the old authoritative B binding.
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES ('run-fly1686', 'implement', 1, 807, ?, '__main__',
			         'xrliannie/flywheel', '/tmp/flywheel', 'generation-implement',
			         'legacy-implement-binding', '2026-08-11T00:03:30.000Z')`,
			[reviewedHead],
		);

		const qaIntent = store
			.listWorkflowSideEffects("run-fly1686")
			.find((effect) => effect.node_id === "qa");
		expect(qaIntent?.execution_id).toEqual(expect.any(String));
		const qaAdmission = store.admitGeneralizedWorkflowExecution({
			runId: "run-fly1686",
			nodeId: "qa",
			executionId: qaIntent!.execution_id,
			attempt: 1,
			expiresAt: "2026-08-11T03:00:00.000Z",
			absoluteDeadlineAt: "2026-08-11T04:00:00.000Z",
			now: "2026-08-11T00:04:00.000Z",
			env: engineFlags,
		});
		expect(qaAdmission).toMatchObject({
			ok: true,
			submissionCredential: expect.any(String),
		});
		if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
			throw new Error("QA admission failed");
		}
		store.upsertSession({
			execution_id: qaIntent!.execution_id,
			issue_id: "FLY-1686",
			project_name: "flywheel",
			status: "running",
			last_activity_at: "2026-08-11T00:04:30.000Z",
		});

		const missingBindingSubmission = {
			credential: qaAdmission.submissionCredential,
			clientRequestId: "qa-pass-fly1686-missing-binding",
			predicate: "qa_passed",
			subjectDigest: gateEntryHead,
			issuerVendor: "claude",
			issuerModel: "claude-opus-4-8",
			subjectProducerExecutionId: "implement-fly1686",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2026-08-11T03:00:00.000Z",
			now: "2026-08-11T00:04:45.000Z",
		};
		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				...missingBindingSubmission,
				subjectDigest: "d".repeat(40),
				alertIdentity: {
					leadId: "lead-before-restart",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			} as never),
		).toEqual({ ok: false, reason: "land_head_unavailable" });
		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				...missingBindingSubmission,
				alertIdentity: {
					leadId: "lead-after-restart",
					projectName: "flywheel",
					leadResolution: "fallback",
				},
			} as never),
		).toEqual({ ok: false, reason: "land_head_unavailable" });
		expect(
			store.getWorkflowSubmissionCredentialByToken(
				qaAdmission.submissionCredential,
			)?.consumed_at,
		).toBeNull();
		expect(
			store.getCurrentWorkflowGateHolder("run-fly1686", "founder_gate"),
		).toBeUndefined();
		const bindingAlertUid = "land_head_unavailable:run-fly1686:qa:1";
		expect(
			store.getWorkflowAlertOutbox(bindingAlertUid)?.payload,
		).toMatchObject({
			leadId: "lead-before-restart",
			metadata: {
				workflowEngine: {
					runId: "run-fly1686",
					nodeId: "qa",
					disposition: "land_head_unavailable",
				},
			},
		});
		expect(
			store
				.listWorkflowRunEvents("run-fly1686")
				.filter((event) => event.event_uid === bindingAlertUid),
		).toHaveLength(1);
		expect(
			store
				.listWorkflowRunEvents("run-fly1686")
				.filter(
					(event) => event.event_uid === `alert_enqueued:${bindingAlertUid}`,
				),
		).toHaveLength(1);

		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				credential: qaAdmission.submissionCredential,
				clientRequestId: "qa-pass-fly1686",
				predicate: "qa_passed",
				subjectDigest: gateEntryHead,
				issuerVendor: "claude",
				issuerModel: "claude-opus-4-8",
				subjectProducerExecutionId: "implement-fly1686",
				subjectProducerVendor: "codex",
				claimExpiresAt: "2026-08-11T03:00:00.000Z",
				gateEntryBinding: {
					kind: "worktree",
					prNumber: 807,
					headSha: gateEntryHead,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliannie/flywheel",
					targetRepoPath: "/tmp/flywheel",
					worktreeBindingGeneration: "generation-qa",
					expectedProducerMirrorHead: reviewedHead,
				},
				now: "2026-08-11T00:05:00.000Z",
			} as never),
		).toMatchObject({ ok: true });

		expect(
			store.getCurrentWorkflowNodePrBindingForHead(
				"run-fly1686",
				gateEntryHead,
			),
		).toMatchObject({
			node_id: "qa",
			attempt: 1,
			head_sha: gateEntryHead,
		});
		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-fly1686", reviewedHead),
		).toBeUndefined();
		expect(
			store
				.listWorkflowRunEvents("run-fly1686")
				.filter((event) => event.kind === "pr_binding_retired"),
		).toHaveLength(1);
		const holder = store.getCurrentWorkflowGateHolder(
			"run-fly1686",
			"founder_gate",
		);
		expect(holder).toMatchObject({
			head_sha: gateEntryHead,
			authority_mode: "land",
		});
		expect(
			store.getWorkflowShipTargetBinding(holder!.question_id),
		).toMatchObject({ frozen_head_sha: gateEntryHead });
		expect(
			resolveLandSourceSession(store, {
				runId: "run-fly1686",
				issueId: "FLY-1686",
				projectName: "flywheel",
				prNumber: 807,
				approvedHead: gateEntryHead,
			}),
		).toMatchObject({
			execution_id: "implement-fly1686",
			pr_number: 807,
			pr_head_sha: reviewedHead,
		});
		store.close();
	});
});
