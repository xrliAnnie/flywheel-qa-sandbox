import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import { drainWorkflowSourceEvents } from "../bridge/founder-approval-projector.js";
import { StateStore } from "../StateStore.js";
import {
	legacyGenericSeed,
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";
import { installSelfHostedWorkflowAgentProject } from "./fixtures/workflow-agent-project.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

const HEAD = "a".repeat(40);

async function freshStore(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1244",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	return store;
}

function founderEvent() {
	const payload = {
		schema_version: 1,
		run_id: "run-1",
		issue_id: "FLY-1244",
		question_id: "question-1",
		response: { approved: true },
		actor: "bridge",
		approved_head: HEAD,
		classification: "dashboard_founder_action",
		authority_id: "question-1",
	};
	return {
		project: "flywheel",
		sourceEventId: "founder-approval:question-1",
		kind: "founder_approval" as const,
		payloadJson: canonicalJsonString(payload),
		payloadDigest: canonicalSubmissionDigest(payload),
		schemaVersion: 1,
	};
}

describe("StateStore.applyWorkflowSourceEvent", () => {
	it("applies founder receipt and claim in one idempotent transaction", async () => {
		const store = await freshStore();
		const first = store.applyWorkflowSourceEvent(founderEvent());
		expect(first).toMatchObject({
			kind: "founder_claim",
			status: "applied",
			claimId: expect.any(Number),
		});

		const replay = store.applyWorkflowSourceEvent(founderEvent());
		expect(replay).toEqual({
			kind: "founder_claim",
			status: "replayed",
			claimId: first.kind === "founder_claim" ? first.claimId : -1,
		});
		expect(store.countWorkflowClaims("run-1")).toBe(1);
		expect(
			store.resolveWorkflowDecisionClaim({
				runId: "run-1",
				decisionKind: "founder_decision",
				subjectKind: "git_head",
				subjectDigest: HEAD,
			}),
		).toMatchObject({ valid: true });
	});

	it("rejects a same-id payload mismatch without writing another claim", async () => {
		const store = await freshStore();
		store.applyWorkflowSourceEvent(founderEvent());
		expect(() =>
			store.applyWorkflowSourceEvent({
				...founderEvent(),
				payloadDigest: "0".repeat(64),
			}),
		).toThrow(/digest|mismatch|poison/i);
		expect(store.countWorkflowClaims("run-1")).toBe(1);
	});

	it("rejects a source project that does not own the frozen workflow run", async () => {
		const store = await freshStore();
		expect(() =>
			store.applyWorkflowSourceEvent({
				...founderEvent(),
				project: "other-project",
			}),
		).toThrow(/source payload invalid/i);
		expect(store.countWorkflowClaims("run-1")).toBe(0);
	});

	it("rejects a malformed optional alert identity before writing the source receipt", async () => {
		const store = await freshStore();

		expect(() =>
			store.applyWorkflowSourceEvent({
				...founderEvent(),
				alertIdentity: {
					leadId: " ",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toThrow(/alert identity/i);
		expect(store.countWorkflowClaims("run-1")).toBe(0);
	});

	it("records project-level TURN disposition without inventing a run event", async () => {
		const store = await freshStore();
		const payload = {
			schema_version: 1,
			issue_id: "FLY-1244",
			old_holder: null,
			new_holder: "exec-design",
			from_role: null,
			to_role: "design",
			resulting_epoch: 1,
			target_run_id: null,
		};
		const result = store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: "turn:1",
			kind: "turn_grant",
			payloadJson: canonicalJsonString(payload),
			payloadDigest: canonicalSubmissionDigest(payload),
			schemaVersion: 1,
		});
		expect(result).toEqual({
			kind: "turn_project_history",
			status: "applied",
		});
		expect(store.listWorkflowRunEvents("run-1")).toHaveLength(0);
	});

	it("projects a run-attributed TURN into the owning engine run atomically", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.materializeWorkflowRun({
			runId: "engine-run",
			issueId: "FLY-1307",
			projectName: "flywheel",
			taskCategory: "code",
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "lead",
			env: WORKFLOW_ON,
			startReservation: {
				idempotencyKey: "start-engine",
				selectionDigest: "selection",
				nodeId: "design",
				attempt: 1,
				executionId: "engine-design",
				createdAt: "2026-07-16T00:00:00.000Z",
			},
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "engine-run",
				nodeId: "design",
				executionId: "engine-design",
				attempt: 1,
				now: "2026-07-16T00:01:00.000Z",
				expiresAt: "2026-07-16T01:01:00.000Z",
				absoluteDeadlineAt: "2026-07-17T00:01:00.000Z",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		const payload = {
			schema_version: 1,
			issue_id: "FLY-1307",
			old_holder: null,
			new_holder: "engine-design",
			from_role: null,
			to_role: "design",
			resulting_epoch: 1,
			target_run_id: "engine-run",
		};
		const result = store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: "turn:engine:design",
			kind: "turn_grant",
			payloadJson: canonicalJsonString(payload),
			payloadDigest: canonicalSubmissionDigest(payload),
			schemaVersion: 1,
		});

		expect(result).toEqual({ kind: "turn_run_event", status: "applied" });
		expect(
			store
				.listWorkflowRunEvents("engine-run")
				.find((event) => event.kind === "turn_granted"),
		).toEqual(
			expect.objectContaining({
				event_uid: "source_turn:flywheel:turn:engine:design",
				kind: "turn_granted",
				execution_id: "engine-design",
			}),
		);
		expect(
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: "turn:engine:design",
				kind: "turn_grant",
				payloadJson: canonicalJsonString(payload),
				payloadDigest: canonicalSubmissionDigest(payload),
				schemaVersion: 1,
			}),
		).toEqual({ kind: "turn_run_event", status: "replayed" });
		const forged = { ...payload, new_holder: "forged-execution" };
		expect(() =>
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: "turn:engine:forged",
				kind: "turn_grant",
				payloadJson: canonicalJsonString(forged),
				payloadDigest: canonicalSubmissionDigest(forged),
				schemaVersion: 1,
			}),
		).toThrow(/source payload invalid/i);
		expect(
			store
				.listWorkflowRunEvents("engine-run")
				.filter((event) => event.kind === "turn_granted"),
		).toHaveLength(1);
		store.close();
	});

	it("FLY-1788: projects generic spawn and rework TURNs addressed by bound node id", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1788-generic-projector-"));
		installSelfHostedWorkflowAgentProject(root);
		const store = await StateStore.create(":memory:");
		try {
			const seed = legacyGenericSeed("tpl-generic-fly1788");
			store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
			store.materializeWorkflowRun({
				runId: "generic-run",
				issueId: "FLY-1788",
				projectName: "flywheel",
				taskCategory: "generic",
				templateId: seed.templateId,
				claimsReadEnrolled: true,
				actor: "lead",
				canonicalRoot: root,
				env: WORKFLOW_ON,
				startReservation: {
					idempotencyKey: "start-generic",
					selectionDigest: "selection",
					nodeId: "execute",
					attempt: 1,
					executionId: "engine-generic",
					createdAt: "2026-08-16T00:00:00.000Z",
				},
			});
			expect(
				store.admitGeneralizedWorkflowExecution({
					runId: "generic-run",
					nodeId: "execute",
					executionId: "engine-generic",
					attempt: 1,
					now: "2026-08-16T00:01:00.000Z",
					expiresAt: "2026-08-16T01:01:00.000Z",
					absoluteDeadlineAt: "2026-08-17T00:01:00.000Z",
					env: WORKFLOW_ON,
				}),
			).toMatchObject({ ok: true });

			const sourceEventIds = [
				"turn:spawn:engine-generic",
				"rework:req-1:activation-generic",
				"ship-carrier:approval-1:activation-generic",
			];
			for (const [index, sourceEventId] of sourceEventIds.entries()) {
				const payload = {
					schema_version: 1,
					issue_id: "FLY-1788",
					old_holder: null,
					new_holder: "engine-generic",
					from_role: null,
					to_role: "execute",
					resulting_epoch: index + 1,
					target_run_id: "generic-run",
				};
				expect(
					store.applyWorkflowSourceEvent({
						project: "flywheel",
						sourceEventId,
						kind: "turn_grant",
						payloadJson: canonicalJsonString(payload),
						payloadDigest: canonicalSubmissionDigest(payload),
						schemaVersion: 1,
					}),
				).toEqual({ kind: "turn_run_event", status: "applied" });
			}
			expect(
				store
					.listWorkflowRunEvents("generic-run")
					.filter((event) => event.kind === "turn_granted"),
			).toHaveLength(3);

			const forged = {
				schema_version: 1,
				issue_id: "FLY-1788",
				old_holder: null,
				new_holder: "engine-generic",
				from_role: null,
				to_role: "qa",
				resulting_epoch: 3,
				target_run_id: "generic-run",
			};
			expect(() =>
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: "turn:forged:engine-generic",
					kind: "turn_grant",
					payloadJson: canonicalJsonString(forged),
					payloadDigest: canonicalSubmissionDigest(forged),
					schemaVersion: 1,
				}),
			).toThrow(/run ownership mismatch/i);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("FLY-1307 hard gate: proves engine TURN authority from CommDB source outbox through the durable projector", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1307-source-outbox-"));
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(join(root, "teamlead.db"));
		try {
			const seed = legacyWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_eng_heavy",
			)!;
			store.importWorkflowTemplateSeed(seed);
			store.materializeWorkflowRun({
				runId: "engine-run",
				issueId: "FLY-1307",
				projectName: "flywheel",
				taskCategory: "code",
				templateId: seed.templateId,
				claimsReadEnrolled: true,
				actor: "lead",
				env: WORKFLOW_ON,
				startReservation: {
					idempotencyKey: "start-engine",
					selectionDigest: "selection",
					nodeId: "design",
					attempt: 1,
					executionId: "engine-design",
					createdAt: "2026-07-16T00:00:00.000Z",
				},
			});
			expect(
				store.admitGeneralizedWorkflowExecution({
					runId: "engine-run",
					nodeId: "design",
					executionId: "engine-design",
					attempt: 1,
					now: "2026-07-16T00:01:00.000Z",
					expiresAt: "2026-07-16T01:01:00.000Z",
					absoluteDeadlineAt: "2026-07-17T00:01:00.000Z",
					env: WORKFLOW_ON,
				}),
			).toMatchObject({ ok: true });

			const comm = new CommDB(commPath);
			comm.grantTurn("FLY-1307", "engine-design", "design", 1, {
				project: "flywheel",
				sourceEventId: "turn:engine:design",
				targetRunId: "engine-run",
			});
			comm.grantTurn("FLY-1307", "forged-implement", "implement", 2, {
				project: "flywheel",
				sourceEventId: "turn:engine:forged",
				targetRunId: "engine-run",
			});
			const sourceRows = comm.listWorkflowSourceEventsAfter(0);
			const historyRows = comm.listTurnSourceHistory("FLY-1307");
			comm.close();

			// Compliance evidence exists in the source database before StateStore is
			// touched. The projector is the only mutation seam used below; this test
			// never calls applyWorkflowSourceEvent to manufacture a passing row.
			expect(sourceRows).toHaveLength(2);
			expect(historyRows).toEqual([
				expect.objectContaining({
					target_run_id: "engine-run",
					source_event_id: "turn:engine:design",
				}),
				expect.objectContaining({
					target_run_id: "engine-run",
					source_event_id: "turn:engine:forged",
				}),
			]);
			expect(
				store
					.listWorkflowRunEvents("engine-run")
					.filter((event) => event.kind === "turn_granted"),
			).toHaveLength(0);

			const drained = await drainWorkflowSourceEvents({
				projects: ["flywheel"],
				openCommDb: () => new CommDB(commPath),
				store,
			});
			expect(drained).toEqual({
				applied: 1,
				replayed: 0,
				deadlettered: 1,
				skipped: 0,
			});
			expect(store.getWorkflowSourceCursor("flywheel")).toBe(
				sourceRows[1]?.row_id,
			);
			expect(
				store.getWorkflowSourceDeadletter("flywheel", "turn:engine:forged"),
			).toMatchObject({ reason: expect.stringMatching(/ownership mismatch/) });
			expect(
				store
					.listWorkflowRunEvents("engine-run")
					.filter((event) => event.kind === "turn_granted"),
			).toEqual([
				expect.objectContaining({
					event_uid: "source_turn:flywheel:turn:engine:design",
					execution_id: "engine-design",
				}),
			]);

			// Cursor replay is a no-op, and the terminal poison is never promoted to
			// a receipt or a run event that could be counted as success.
			expect(
				await drainWorkflowSourceEvents({
					projects: ["flywheel"],
					openCommDb: () => new CommDB(commPath),
					store,
				}),
			).toEqual({ applied: 0, replayed: 0, deadlettered: 0, skipped: 0 });
			expect(
				store.getWorkflowSourceDeadletter("flywheel", "turn:engine:design"),
			).toBeUndefined();
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("advances an approved product v2 run to its terminal land node", async () => {
		const store = await StateStore.create(":memory:");
		const root = mkdtempSync(join(tmpdir(), "fly1307-product-source-"));
		installSelfHostedWorkflowAgentProject(root);
		const seed = pinLegacyWorkflowSeedAgents(
			legacyWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_product_v1",
			)!,
		);
		const flags = WORKFLOW_ON;
		store.importWorkflowTemplateSeed(seed, flags);
		store.materializeWorkflowRun({
			runId: "product-run",
			issueId: "FLY-1307",
			projectName: "flywheel",
			taskCategory: "product",
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "lead",
			canonicalRoot: root,
			env: flags,
			startReservation: {
				idempotencyKey: "product-start",
				selectionDigest: "selection",
				nodeId: "research",
				attempt: 1,
				executionId: "product-research",
				createdAt: "2026-07-16T00:00:00.000Z",
			},
		});
		store.upsertWorkflowRunNode({
			runId: "product-run",
			nodeId: "research",
			attempt: 1,
			state: "running",
			executionId: "product-research",
		});
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "product-run",
				nodeId: "research",
				attempt: 1,
				executionId: "product-research",
				outcome: "node_done",
				successorExecutionId: "product-produce",
			}).ok,
		).toBe(true);
		const produce = store.admitGeneralizedWorkflowExecution({
			runId: "product-run",
			nodeId: "produce",
			executionId: "product-produce",
			attempt: 1,
			now: "2026-07-16T00:05:00.000Z",
			expiresAt: "2027-07-16T00:05:00.000Z",
			absoluteDeadlineAt: "2027-07-17T00:05:00.000Z",
			env: flags,
		});
		if (!produce.ok || !produce.outputCredential) {
			throw new Error("produce admission failed");
		}
		store.upsertSession({
			execution_id: "product-produce",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
			pr_number: 1307,
		});
		const producedOutput = store.submitWorkflowNodeOutput({
			token: produce.outputCredential,
			clientRequestId: "produce-output",
			payload: '{"result":"ready"}',
			now: "2026-07-16T00:06:00.000Z",
		});
		expect(producedOutput.ok).toBe(true);
		if (!producedOutput.ok) throw new Error(producedOutput.reason);
		expect(
			store.commitEnrolledCompletion({
				nodeReuseEnabled: false,
				executionId: "product-produce",
				route: "needs_review",
				sourceEventId: "produce-complete",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: HEAD,
				prBinding: {
					prNumber: 1307,
					headSha: HEAD,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "geoforge3d/flywheel",
					targetRepoPath: root,
					worktreeBindingGeneration: "product-fixture",
				},
				now: "2026-07-16T00:07:00.000Z",
			}).ok,
		).toBe(true);
		const outputRow = store.getWorkflowNodeOutput(producedOutput.outputId);
		if (!outputRow) throw new Error("produce output missing");
		const materialization = store.allocateWorkflowMaterialization({
			runId: "product-run",
			nodeId: "produce",
			attempt: 1,
			outputId: producedOutput.outputId,
			outputDigest: outputRow.output_digest,
			repo: "geoforge3d/flywheel",
			ref: "refs/heads/fly-1307",
			baseHead: HEAD,
		});
		store.adoptWorkflowMaterializationCommit({
			effectId: materialization.effect_id,
			treeHead: HEAD,
			commitHead: HEAD,
		});
		store.confirmWorkflowMaterializationPush({
			effectId: materialization.effect_id,
			remoteHead: HEAD,
			reviewNodeId: "review",
		});
		const reviewExecution = store.getWorkflowRunNode(
			"product-run",
			"review",
			1,
		)?.execution_id;
		if (!reviewExecution) throw new Error("review successor missing");
		const review = store.admitGeneralizedWorkflowExecution({
			runId: "product-run",
			nodeId: "review",
			executionId: reviewExecution,
			attempt: 1,
			now: "2026-07-16T00:10:00.000Z",
			expiresAt: "2027-07-16T00:10:00.000Z",
			absoluteDeadlineAt: "2027-07-17T00:10:00.000Z",
			env: flags,
		});
		if (!review.ok || !review.submissionCredential) {
			throw new Error("review admission failed");
		}
		store.upsertSession({
			execution_id: reviewExecution,
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "review",
		});
		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				credential: review.submissionCredential,
				clientRequestId: "review-pass",
				predicate: "design_review_approved",
				subjectDigest: HEAD,
				issuerVendor: "claude",
				issuerModel: "sonnet",
				subjectProducerExecutionId: "product-produce",
				subjectProducerVendor: "codex",
				claimExpiresAt: "2027-07-16T00:10:00.000Z",
				gateEntryBinding: {
					kind: "materialization_receipt",
					prNumber: 1307,
					headSha: HEAD,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "geoforge3d/flywheel",
					targetRepoPath: root,
					worktreeBindingGeneration: `receipt-v1:${materialization.effect_id}`,
					expectedProducerMirrorHead: HEAD,
					effectId: materialization.effect_id,
					producerNodeId: "produce",
					outputId: producedOutput.outputId,
					outputAttempt: 1,
					repo: "geoforge3d/flywheel",
					ref: "refs/heads/fly-1307",
				},
				now: "2026-07-16T00:11:00.000Z",
			}).ok,
		).toBe(true);
		expect(store.getWorkflowRun("product-run")?.status).toBe("active");
		const holder = store
			.listWorkflowRunEvents("product-run")
			.find((event) => event.kind === "gate_holder_created");
		if (!holder) throw new Error("founder gate holder missing");
		const questionId = (holder.payload as { questionId: string }).questionId;
		store.advanceWorkflowGateHolderMaterialization({
			questionId,
			stage: "card_bound",
			cardMessageId: "product-founder-card",
			now: "2026-07-16T00:11:30.000Z",
		});
		const payload = {
			schema_version: 1,
			run_id: "product-run",
			issue_id: "FLY-1307",
			question_id: questionId,
			response: { approved: true },
			actor: "bridge",
			approved_head: HEAD,
			classification: "dashboard_founder_action",
			authority_id: questionId,
		};
		const forgedAuthority = { ...payload, authority_id: "forged-question" };
		expect(() =>
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: `founder-approval-forged:${questionId}`,
				kind: "founder_approval",
				payloadJson: canonicalJsonString(forgedAuthority),
				payloadDigest: canonicalSubmissionDigest(forgedAuthority),
				schemaVersion: 1,
			}),
		).toThrow(/gate authority/i);
		expect(store.countWorkflowClaims("product-run")).toBe(1);
		store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: `founder-approval:${questionId}`,
			kind: "founder_approval",
			payloadJson: canonicalJsonString(payload),
			payloadDigest: canonicalSubmissionDigest(payload),
			schemaVersion: 1,
		});

		expect(store.getWorkflowRun("product-run")).toMatchObject({
			status: "active",
			current_node_id: "land",
		});
		expect(store.getWorkflowRunNode("product-run", "land", 1)).toMatchObject({
			state: "pending",
		});
		expect(
			store
				.listWorkflowRunEvents("product-run")
				.filter((event) => event.kind === "run_completed"),
		).toHaveLength(0);
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("dead-letters poison terminally and idempotently", async () => {
		const store = await freshStore();
		store.recordWorkflowSourceDeadletter({
			project: "flywheel",
			sourceEventId: "bad:1",
			reason: "malformed_payload",
		});
		store.recordWorkflowSourceDeadletter({
			project: "flywheel",
			sourceEventId: "bad:1",
			reason: "malformed_payload",
		});
		expect(
			store.getWorkflowSourceDeadletter("flywheel", "bad:1"),
		).toMatchObject({ reason: "malformed_payload" });
	});

	it("atomically deadletters a bound founder input and enqueues a Lead alert", async () => {
		const store = await freshStore();
		store.createWorkflowRun({
			runId: "deadletter-run",
			issueId: "FLY-1772",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureWorkflowGateHolder({
			runId: "deadletter-run",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: HEAD,
			sourceExecutionId: "qa-exec",
			questionId: "deadletter-question",
			now: "2026-08-14T20:00:00.000Z",
		});
		const payloadJson = JSON.stringify({
			schema_version: 1,
			run_id: "deadletter-run",
			issue_id: "FLY-1772",
			question_id: "deadletter-question",
		});

		expect(
			store.recordWorkflowSourceDeadletter({
				project: "flywheel",
				sourceEventId: "founder-feedback:deadletter-question",
				reason: "founder feedback source payload invalid: run state",
				founderOrigin: {
					kind: "founder_feedback",
					payloadJson,
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				},
			}),
		).toEqual({ deadlettered: true, alertEnqueued: true });
		expect(
			store.getWorkflowSourceDeadletter(
				"flywheel",
				"founder-feedback:deadletter-question",
			),
		).toBeDefined();
		expect(
			store.getWorkflowAlertOutbox(
				"founder_input_deadletter:founder-feedback:deadletter-question",
			),
		).toMatchObject({
			run_id: "deadletter-run",
			payload: {
				metadata: {
					workflowEngine: {
						disposition: "founder_input_deadletter",
						questionId: "deadletter-question",
					},
				},
			},
		});
		expect(
			store.recordWorkflowSourceDeadletter({
				project: "flywheel",
				sourceEventId: "founder-feedback:deadletter-question",
				reason: "founder feedback source payload invalid: run state",
				founderOrigin: {
					kind: "founder_feedback",
					payloadJson,
					alertIdentity: {
						leadId: "replacement-lead",
						projectName: "flywheel",
						leadResolution: "fallback",
					},
				},
			}),
		).toEqual({ deadlettered: false, alertEnqueued: false });
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
	});
});
