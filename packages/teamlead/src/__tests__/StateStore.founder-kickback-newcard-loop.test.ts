import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWorkflowGateHolder } from "../bridge/gate-materializer.js";
import { createWorkflowDecisionRouter } from "../bridge/workflow-decision-routes.js";
import { voidSupersededWorkflowGateCards } from "../bridge/workflow-gate-card-lifecycle.js";
import { StateStore } from "../StateStore.js";
import { importWorkflowMenuSeeds } from "../workflow-menu.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_GATE_CARRIER: "1",
};

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function gitWorktree(): { path: string; head1: string; head2: string } {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fly1772-route-")));
	roots.push(path);
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
	execFileSync("git", [
		"-C",
		path,
		"remote",
		"add",
		"origin",
		"https://github.com/xrliAnnie/flywheel.git",
	]);
	writeFileSync(join(path, "README.md"), "first\n");
	execFileSync("git", ["-C", path, "add", "README.md"]);
	execFileSync("git", ["-C", path, "commit", "-qm", "first"]);
	const head1 = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	writeFileSync(join(path, "README.md"), "second\n");
	execFileSync("git", ["-C", path, "add", "README.md"]);
	execFileSync("git", ["-C", path, "commit", "-qm", "second"]);
	const head2 = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	return { path, head1, head2 };
}

async function compiledRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	importWorkflowMenuSeeds(store, WORKFLOW_ON);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: "tpl_code",
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1772",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "selection-1",
			nodeId: "eng_design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-08-14T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "eng_design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	return store;
}

function gateEntryBinding(head: string, generation: string) {
	return {
		kind: "worktree" as const,
		prNumber: 1772,
		headSha: head,
		targetRepoIdentity: "__main__",
		probeRepoSlug: "xrliAnnie/flywheel",
		targetRepoPath: "/tmp/flywheel-FLY-1772",
		worktreeBindingGeneration: generation,
		expectedProducerMirrorHead: head,
	};
}

function completeImplement(
	store: StateStore,
	input: {
		attempt: number;
		head: string;
		sourceEventId: string;
		workflowActivation?: {
			activationId: string;
			runId: string;
			nodeId: string;
			attempt: number;
			turnEpoch: number;
		};
	},
) {
	return store.commitEnrolledCompletion({
		nodeReuseEnabled: false,
		executionId: "implement-1",
		route: "needs_review",
		sourceEventId: input.sourceEventId,
		completionSubmission: { decision: { route: "needs_review" } },
		workflowActivation: input.workflowActivation,
		subjectDigest: input.head,
		prBinding: {
			prNumber: 1772,
			headSha: input.head,
			targetRepoIdentity: "__main__",
			probeRepoSlug: "xrliAnnie/flywheel",
			targetRepoPath: "/tmp/flywheel-FLY-1772",
			worktreeBindingGeneration: `generation-${input.attempt}`,
		},
		now: `2026-08-14T0${input.attempt}:10:00.000Z`,
	});
}

function passQa(
	store: StateStore,
	input: { nodeId: "qa" | "qa_retest"; attempt: number; head: string },
) {
	const effect = store
		.listWorkflowSideEffects("run-1")
		.find(
			(candidate) =>
				candidate.node_id === input.nodeId &&
				candidate.attempt === input.attempt,
		);
	if (!effect) {
		throw new Error(
			`${input.nodeId} side effect missing: ${JSON.stringify(store.listWorkflowSideEffects("run-1"))}`,
		);
	}
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: input.nodeId,
		executionId: effect.execution_id,
		attempt: input.attempt,
		expiresAt: "2026-08-14T08:00:00.000Z",
		absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
		now: "2026-08-14T02:00:00.000Z",
		env: WORKFLOW_ON,
	});
	if (!admitted.ok || !admitted.submissionCredential) {
		throw new Error(`${input.nodeId} admission failed`);
	}
	store.upsertSession({
		execution_id: effect.execution_id,
		issue_id: "FLY-1772",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: input.nodeId,
	});
	return submitQa(store, {
		nodeId: input.nodeId,
		attempt: input.attempt,
		head: input.head,
		executionId: effect.execution_id,
		credential: admitted.submissionCredential,
	});
}

function submitQa(
	store: StateStore,
	input: {
		nodeId: "qa" | "qa_retest";
		attempt: number;
		head: string;
		executionId: string;
		credential: string;
	},
) {
	const passed = store.submitWorkflowDecisionByCredential({
		nodeReuseEnabled: false,
		credential: input.credential,
		clientRequestId: `${input.nodeId}-pass-${input.attempt}`,
		predicate: "qa_passed",
		subjectDigest: input.head,
		issuerVendor: "claude",
		issuerModel: "claude-opus-4-8",
		subjectProducerExecutionId: "implement-1",
		subjectProducerVendor: "codex",
		claimExpiresAt: "2026-08-15T00:00:00.000Z",
		gateEntryBinding: gateEntryBinding(
			input.head,
			`generation-${input.attempt}`,
		),
		now: "2026-08-14T02:05:00.000Z",
	});
	expect(passed).toMatchObject({ ok: true });
	return passed;
}

async function materializeCard(
	store: StateStore,
	commDbPath: string,
	questionId: string,
	messageId: string,
) {
	return materializeWorkflowGateHolder(
		{
			store,
			commDbPath,
			leadId: "flywheel-eng-lead",
			threadId: "thread-1",
			preflight: async () => ({ ok: true }),
			postCard: async () => ({ messageId }),
			now: () => "2026-08-14T02:10:00.000Z",
		},
		questionId,
	);
}

function deliverFounderRework(
	store: StateStore,
	input: {
		requestId: string;
		runId: string;
		nodeId: "eng_design" | "implement" | "qa";
		executionId: string;
		attempt: number;
		now: string;
	},
) {
	const activationId = `activation:${input.requestId}`;
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: input.runId,
		nodeId: input.nodeId,
		executionId: input.executionId,
		attempt: input.attempt,
		activationId,
		activationMode: "wake",
		reworkRequestId: input.requestId,
		now: input.now,
		expiresAt: "2026-08-14T23:00:00.000Z",
		absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
		env: WORKFLOW_ON,
	});
	if (!admission.ok) throw new Error(admission.reason);
	expect(
		store.recordWorkflowActivationTurn({
			activationId,
			issueId: "FLY-1772",
			executionId: input.executionId,
			epoch: input.attempt,
			sourceEventId: `turn:${input.nodeId}:${input.attempt}:${input.requestId}`,
			grantedAt: input.now,
		}),
	).toMatchObject({ ok: true });
	const claim = store.claimWorkflowReworkDelivery({
		requestId: input.requestId,
		ownerId: "coordinator",
		now: input.now,
		leaseExpiresAt: "2026-08-14T23:00:00.000Z",
	});
	if (!claim.ok) throw new Error(claim.reason);
	expect(
		store.advanceWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: "coordinator",
			generation: claim.generation,
			from: "pending",
			to: "turn_granted",
			now: input.now,
		}),
	).toMatchObject({ ok: true });
	expect(
		store.advanceWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: "coordinator",
			generation: claim.generation,
			from: "turn_granted",
			to: "awaiting_receipt",
			now: input.now,
			releaseOwner: true,
		}),
	).toEqual({ ok: true });
	expect(
		store.recordWorkflowReworkWakeReceipt({
			activationId,
			executionId: input.executionId,
			epoch: input.attempt,
			ackedAt: input.now,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		}),
	).toMatchObject({ ok: true });
	return { activationId, admission };
}

async function passQaThroughProduction(
	store: StateStore,
	input: {
		executionId: string;
		credential: string;
		worktreePath: string;
		head: string;
		generation: string;
		clientRequestId: string;
		now: string;
	},
): Promise<void> {
	store.upsertSession({
		execution_id: input.executionId,
		issue_id: "FLY-1772",
		project_name: "flywheel",
		status: "running",
		session_role: "qa",
		chat_thread_role: "qa",
		adapter_type: "claude-tmux",
		worktree_path: input.worktreePath,
		branch: "flywheel-FLY-1772",
	});
	expect(
		store.bindWorktreeOnce(input.executionId, {
			path: input.worktreePath,
			branch: "flywheel-FLY-1772",
			generation: input.generation,
		}),
	).toMatchObject({ bound: true });
	const app = express();
	app.use(express.json());
	app.use(
		"/api/workflow",
		createWorkflowDecisionRouter({
			store,
			prProbe: async () => ({
				state: "OPEN",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "flywheel-FLY-1772",
				headRefOid: input.head,
			}),
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
			now: () => input.now,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	try {
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/workflow/decision`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: input.credential,
					client_request_id: input.clientRequestId,
					status: "pass",
				}),
			},
		);
		expect({
			status: response.status,
			body: await response.json(),
		}).toMatchObject({
			status: 200,
			body: { ok: true },
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function prepareCompiledFounderGate(store: StateStore, head: string) {
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "eng_design",
			executionId: "design-1",
			attempt: 1,
			expiresAt: "2026-08-14T02:00:00.000Z",
			absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
			now: "2026-08-14T00:55:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	expect(
		store.commitWorkflowTransitionTx({
			nodeReuseEnabled: false,
			runId: "run-1",
			nodeId: "eng_design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
			now: "2026-08-14T01:00:00.000Z",
		}),
	).toMatchObject({ ok: true });
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "implement",
			executionId: "implement-1",
			attempt: 1,
			expiresAt: "2026-08-14T02:00:00.000Z",
			absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
			now: "2026-08-14T01:05:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1772",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "implement",
	});
	expect(
		completeImplement(store, {
			attempt: 1,
			head,
			sourceEventId: "complete-implement-1",
		}),
	).toMatchObject({ ok: true });
	passQa(store, { nodeId: "qa", attempt: 1, head });
	const holder = store.getCurrentWorkflowGateHolder("run-1", "founder_gate");
	if (!holder) throw new Error("founder gate missing");
	return holder;
}

describe("founder kickback new-card loop", () => {
	it("replays an operator semantic design target against the pinned new node id", async () => {
		const store = await compiledRun();
		try {
			const now = "2026-08-14T00:30:00.000Z";
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "eng_design",
				attempt: 1,
				state: "done",
				executionId: "design-1",
				endedAt: now,
			});
			store.upsertSession({
				execution_id: "design-1",
				issue_id: "FLY-1772",
				project_name: "flywheel",
				status: "completed",
				pr_head_sha: "a".repeat(40),
			});
			store.patchSessionMetadata("design-1", {
				pr_head_sha: "a".repeat(40),
			});
			(
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db.run(
				"UPDATE workflow_run SET status = 'completed', current_node_id = 'eng_design' WHERE run_id = 'run-1'",
			);
			const input = {
				runId: "run-1",
				targetNodeId: "设计",
				feedback: "重新做工程设计",
				clientRequestId: "semantic-design-replay",
				principal: "master",
				evidence: [
					{
						executionId: "design-1",
						sessionStatus: "completed",
						lifecycleRevision: null,
						liveness: "dead" as const,
						observedAt: now,
					},
				],
				now,
			};
			const opened = store.openOperatorRework(input);
			if (!opened.ok) throw new Error(opened.reason);
			expect(opened).toMatchObject({
				ok: true,
				idempotentReplay: false,
				targetNodeId: "eng_design",
			});
			expect(
				store.getLatestWorkflowReworkRoute(opened.requestId),
			).toMatchObject({
				target_node_id: "eng_design",
				invalidation_scope: ["eng_design", "implement", "qa"],
			});
			expect(
				store.openOperatorRework({ ...input, targetNodeId: "design" }),
			).toMatchObject({
				ok: true,
				idempotentReplay: true,
				targetNodeId: "eng_design",
			});
		} finally {
			store.close();
		}
	});

	it("rejects card A, reworks a new head, emits card B, and accepts only card B", async () => {
		const worktree = gitWorktree();
		const head1 = worktree.head1;
		const head2 = worktree.head2;
		const root = mkdtempSync(join(tmpdir(), "fly1772-new-card-loop-"));
		roots.push(root);
		const commDbPath = join(root, "comm.db");
		const store = await compiledRun();
		try {
			expect(
				store.commitWorkflowTransitionTx({
					nodeReuseEnabled: false,
					runId: "run-1",
					nodeId: "eng_design",
					attempt: 1,
					executionId: "design-1",
					outcome: "design_done",
					successorExecutionId: "implement-1",
					now: "2026-08-14T01:00:00.000Z",
				}),
			).toMatchObject({ ok: true });
			expect(
				store.admitGeneralizedWorkflowExecution({
					runId: "run-1",
					nodeId: "implement",
					executionId: "implement-1",
					attempt: 1,
					expiresAt: "2026-08-14T02:00:00.000Z",
					absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
					now: "2026-08-14T01:05:00.000Z",
					env: WORKFLOW_ON,
				}),
			).toMatchObject({ ok: true });
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "FLY-1772",
				project_name: "flywheel",
				status: "running",
				workflow_node_id: "implement",
			});
			expect(
				completeImplement(store, {
					attempt: 1,
					head: head1,
					sourceEventId: "complete-implement-1",
				}),
			).toMatchObject({ ok: true });
			passQa(store, { nodeId: "qa", attempt: 1, head: head1 });
			const holderA = store.getCurrentWorkflowGateHolder(
				"run-1",
				"founder_gate",
			)!;
			expect(store.getWorkflowRun("run-1")).toMatchObject({
				current_node_id: "founder_gate",
			});
			expect(
				await materializeCard(store, commDbPath, holderA.question_id, "card-A"),
			).toMatchObject({ ok: true, cardMessageId: "card-A" });

			const feedback = {
				schema_version: 1,
				run_id: "run-1",
				issue_id: "FLY-1772",
				question_id: holderA.question_id,
				response: { approved: false, feedback: "fix the failure path" },
				actor: "founder",
				approved_head: head1,
				classification: "founder_direct_signal",
				authority_id: holderA.question_id,
			};
			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: `founder-feedback:${holderA.question_id}`,
					kind: "founder_feedback",
					schemaVersion: 1,
					payloadJson: JSON.stringify(feedback),
					payloadDigest: canonicalSubmissionDigest(feedback),
				}),
			).toMatchObject({ status: "applied" });
			expect(
				store.getWorkflowGateHolderByQuestionId(holderA.question_id),
			).toMatchObject({
				state: "superseded",
				card_void_state: "pending",
				superseded_reason: "founder_feedback",
			});

			const delivery = store.listWorkflowReworkDeliveries({
				states: ["pending"],
			})[0]!;
			const activationId = `activation:${delivery.request_id}`;
			expect(
				store.admitGeneralizedWorkflowExecution({
					runId: "run-1",
					nodeId: "implement",
					executionId: "implement-1",
					attempt: 2,
					activationId,
					activationMode: "wake",
					reworkRequestId: delivery.request_id,
					now: "2026-08-14T03:00:00.000Z",
					expiresAt: "2026-08-14T04:00:00.000Z",
					absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
					env: WORKFLOW_ON,
				}),
			).toMatchObject({ ok: true });
			expect(
				store.recordWorkflowActivationTurn({
					activationId,
					issueId: "FLY-1772",
					executionId: "implement-1",
					epoch: 2,
					sourceEventId: "turn:implement-1:epoch-2",
					grantedAt: "2026-08-14T03:00:00.000Z",
				}),
			).toMatchObject({ ok: true });
			const claim = store.claimWorkflowReworkDelivery({
				requestId: delivery.request_id,
				ownerId: "coordinator",
				now: "2026-08-14T03:00:01.000Z",
				leaseExpiresAt: "2026-08-14T03:01:00.000Z",
			});
			if (!claim.ok) throw new Error(claim.reason);
			expect(
				store.advanceWorkflowReworkDelivery({
					requestId: delivery.request_id,
					ownerId: "coordinator",
					generation: claim.generation,
					from: "pending",
					to: "turn_granted",
					now: "2026-08-14T03:00:02.000Z",
				}),
			).toMatchObject({ ok: true });
			expect(
				store.advanceWorkflowReworkDelivery({
					requestId: delivery.request_id,
					ownerId: "coordinator",
					generation: claim.generation,
					from: "turn_granted",
					to: "awaiting_receipt",
					now: "2026-08-14T03:00:03.000Z",
					releaseOwner: true,
				}),
			).toMatchObject({ ok: true });
			expect(
				store.recordWorkflowReworkWakeReceipt({
					activationId,
					executionId: "implement-1",
					epoch: 2,
					ackedAt: "2026-08-14T03:00:04.000Z",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
			).toMatchObject({ ok: true });
			const reworkedCompletion = completeImplement(store, {
				attempt: 2,
				head: head2,
				sourceEventId: "complete-implement-2",
				workflowActivation: {
					activationId,
					runId: "run-1",
					nodeId: "implement",
					attempt: 2,
					turnEpoch: 2,
				},
			});
			if (!reworkedCompletion.ok) {
				throw new Error(
					`reworked completion failed: ${reworkedCompletion.reason}`,
				);
			}
			expect(reworkedCompletion).toMatchObject({ idempotentReplay: false });

			const qaDelivery = store.listWorkflowReworkDeliveries({
				states: ["pending"],
			})[0]!;
			const qaRoute = store.getLatestWorkflowReworkRoute(
				qaDelivery.request_id,
			)!;
			expect(qaRoute).toMatchObject({
				target_node_id: "qa",
				target_attempt: 2,
			});
			const qaActivationId = `activation:${qaDelivery.request_id}`;
			const qaAdmission = store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "qa",
				executionId: qaRoute.preferred_actor_execution_id,
				attempt: 2,
				activationId: qaActivationId,
				activationMode: "wake",
				reworkRequestId: qaDelivery.request_id,
				now: "2026-08-14T03:10:00.000Z",
				expiresAt: "2026-08-14T04:10:00.000Z",
				absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
				env: WORKFLOW_ON,
			});
			if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
				throw new Error(`qa rework admission failed: ${qaAdmission.reason}`);
			}
			expect({
				qa: store.getWorkflowExecutionRuntime(
					qaRoute.preferred_actor_execution_id,
				)?.vendor,
				implement: store.getWorkflowExecutionRuntime("implement-1")?.vendor,
			}).toEqual({ qa: "claude", implement: "codex" });
			expect(
				store.resolveCurrentWorkflowActivation(
					qaRoute.preferred_actor_execution_id,
				),
			).toMatchObject({
				kind: "current",
				run: { engine_owned: 1 },
				node: { id: "qa" },
				binding: { attempt: 2 },
			});
			expect(
				store.recordWorkflowActivationTurn({
					activationId: qaActivationId,
					issueId: "FLY-1772",
					executionId: qaRoute.preferred_actor_execution_id,
					epoch: 2,
					sourceEventId: "turn:qa:epoch-2",
					grantedAt: "2026-08-14T03:10:00.000Z",
				}),
			).toMatchObject({ ok: true });
			const qaClaim = store.claimWorkflowReworkDelivery({
				requestId: qaDelivery.request_id,
				ownerId: "coordinator",
				now: "2026-08-14T03:10:01.000Z",
				leaseExpiresAt: "2026-08-14T03:11:00.000Z",
			});
			if (!qaClaim.ok) throw new Error(qaClaim.reason);
			expect(
				store.advanceWorkflowReworkDelivery({
					requestId: qaDelivery.request_id,
					ownerId: "coordinator",
					generation: qaClaim.generation,
					from: "pending",
					to: "turn_granted",
					now: "2026-08-14T03:10:02.000Z",
				}),
			).toEqual({ ok: true });
			expect(
				store.advanceWorkflowReworkDelivery({
					requestId: qaDelivery.request_id,
					ownerId: "coordinator",
					generation: qaClaim.generation,
					from: "turn_granted",
					to: "awaiting_receipt",
					now: "2026-08-14T03:10:03.000Z",
					releaseOwner: true,
				}),
			).toEqual({ ok: true });
			expect(
				store.recordWorkflowReworkWakeReceipt({
					activationId: qaActivationId,
					executionId: qaRoute.preferred_actor_execution_id,
					epoch: 2,
					ackedAt: "2026-08-14T03:10:04.000Z",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
			).toMatchObject({ ok: true });
			store.upsertSession({
				execution_id: qaRoute.preferred_actor_execution_id,
				issue_id: "FLY-1772",
				project_name: "flywheel",
				status: "running",
				session_role: "qa",
				chat_thread_role: "qa",
				adapter_type: "claude-tmux",
				worktree_path: worktree.path,
				branch: "flywheel-FLY-1772",
			});
			expect(
				store.bindWorktreeOnce(qaRoute.preferred_actor_execution_id, {
					path: worktree.path,
					branch: "flywheel-FLY-1772",
					generation: "generation-qa-attempt-2",
				}),
			).toMatchObject({ bound: true });
			const app = express();
			app.use(express.json());
			app.use(
				"/api/workflow",
				createWorkflowDecisionRouter({
					store,
					prProbe: async () => ({
						state: "OPEN",
						isDraft: false,
						isCrossRepository: false,
						headRefName: "flywheel-FLY-1772",
						headRefOid: head2,
					}),
					resolveAlertIdentity: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					}),
					now: () => "2026-08-14T03:10:04.000Z",
				}),
			);
			const server = app.listen(0, "127.0.0.1");
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("no port");
			try {
				const response = await fetch(
					`http://127.0.0.1:${address.port}/api/workflow/decision`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							credential: qaAdmission.submissionCredential,
							client_request_id: "qa-pass-2-production-route",
							status: "pass",
						}),
					},
				);
				const body = await response.json();
				expect({ status: response.status, body }).toMatchObject({
					status: 200,
					body: { ok: true },
				});
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			expect(
				store.getCurrentWorkflowNodePrBindingForHead("run-1", head2),
			).toMatchObject({ node_id: "qa", attempt: 2, head_sha: head2 });
			const holderB = store.getCurrentWorkflowGateHolder(
				"run-1",
				"founder_gate",
			)!;
			expect(holderB).toMatchObject({
				head_sha: head2,
				state: "materializing",
			});
			expect(holderB.question_id).not.toBe(holderA.question_id);

			const edits: string[] = [];
			await voidSupersededWorkflowGateCards({
				store,
				now: () => "2026-08-14T04:00:00.000Z",
				resolveDelivery: () => ({
					botToken: "lead-token",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
				editCard: async ({ text }) => {
					edits.push(text);
					return { ok: true };
				},
			});
			expect(edits).toEqual([expect.stringContaining("已打回作废")]);
			expect(
				await materializeCard(store, commDbPath, holderB.question_id, "card-B"),
			).toMatchObject({ ok: true, cardMessageId: "card-B" });
			expect(
				store.getWorkflowGateHolderByQuestionId(holderA.question_id),
			).toMatchObject({
				state: "superseded",
				card_void_state: "done",
			});

			const approval = {
				schema_version: 1,
				run_id: "run-1",
				issue_id: "FLY-1772",
				question_id: holderB.question_id,
				response: { approved: true },
				actor: "founder",
				approved_head: head2,
				classification: "founder_reaction",
				authority_id: holderB.question_id,
			};
			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: `founder-approval:${holderB.question_id}`,
					kind: "founder_approval",
					schemaVersion: 1,
					payloadJson: JSON.stringify(approval),
					payloadDigest: canonicalSubmissionDigest(approval),
				}),
			).toMatchObject({ status: "applied" });
			expect(
				store.getWorkflowGateHolderByQuestionId(holderB.question_id),
			).toMatchObject({
				state: "approved",
				head_sha: head2,
			});
			expect(store.getWorkflowRun("run-1")).toMatchObject({
				status: "active",
				current_node_id: "land",
			});
		} finally {
			store.close();
		}
	});

	it("routes a QA-only kickback through a same-head new card and lands from that card", async () => {
		const worktree = gitWorktree();
		const head = worktree.head2;
		const root = mkdtempSync(join(tmpdir(), "fly1772-qa-new-card-loop-"));
		roots.push(root);
		const commDbPath = join(root, "comm.db");
		const store = await compiledRun();
		try {
			const holderA = prepareCompiledFounderGate(store, head);
			expect(
				await materializeCard(
					store,
					commDbPath,
					holderA.question_id,
					"qa-card-A",
				),
			).toMatchObject({ ok: true, cardMessageId: "qa-card-A" });

			const feedback = {
				schema_version: 1,
				run_id: "run-1",
				issue_id: "FLY-1772",
				question_id: holderA.question_id,
				response: {
					approved: false,
					feedback: "qa: 测试没测到位，同一个 head 重跑验收",
				},
				actor: "founder",
				approved_head: head,
				classification: "founder_direct_signal",
				authority_id: holderA.question_id,
				rework: {
					target: "qa",
					invalidation_scope: ["qa"],
					verification_policy: ["qa_retest", "founder_gate"],
					interpreted_by: "founder-reply-prefix",
					interpretation_reason: "matched_prefix:qa",
				},
			};
			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: `founder-feedback:${holderA.question_id}:qa`,
					kind: "founder_feedback",
					schemaVersion: 1,
					payloadJson: JSON.stringify(feedback),
					payloadDigest: canonicalSubmissionDigest(feedback),
				}),
			).toMatchObject({ status: "applied" });
			expect(
				store.getWorkflowGateHolderByQuestionId(holderA.question_id),
			).toMatchObject({ state: "superseded", card_void_state: "pending" });

			const delivery = store.listWorkflowReworkDeliveries({
				states: ["pending"],
			})[0];
			if (!delivery) throw new Error("QA rework delivery missing");
			const route = store.getLatestWorkflowReworkRoute(delivery.request_id);
			if (!route) throw new Error("QA rework route missing");
			expect(route).toMatchObject({
				target_node_id: "qa",
				target_attempt: 2,
				invalidation_scope: ["qa"],
			});
			const { admission } = deliverFounderRework(store, {
				requestId: delivery.request_id,
				runId: "run-1",
				nodeId: "qa",
				executionId: route.preferred_actor_execution_id,
				attempt: 2,
				now: "2026-08-14T04:00:00.000Z",
			});
			if (!admission.submissionCredential) {
				throw new Error("QA submission credential missing");
			}
			await passQaThroughProduction(store, {
				executionId: route.preferred_actor_execution_id,
				credential: admission.submissionCredential,
				worktreePath: worktree.path,
				head,
				generation: "generation-qa-same-head-attempt-2",
				clientRequestId: "qa-same-head-pass-attempt-2",
				now: "2026-08-14T04:00:04.000Z",
			});
			expect(
				store.getCurrentWorkflowNodePrBindingForHead("run-1", head),
			).toMatchObject({ node_id: "qa", attempt: 2, head_sha: head });

			const holderB = store.getCurrentWorkflowGateHolder(
				"run-1",
				"founder_gate",
			);
			if (!holderB) throw new Error("replacement founder gate missing");
			expect(holderB).toMatchObject({ head_sha: head, state: "materializing" });
			expect(holderB.question_id).not.toBe(holderA.question_id);
			const edits: string[] = [];
			await voidSupersededWorkflowGateCards({
				store,
				now: () => "2026-08-14T04:01:00.000Z",
				resolveDelivery: () => ({
					botToken: "lead-token",
					threadId: "thread-1",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
				editCard: async ({ text }) => {
					edits.push(text);
					return { ok: true };
				},
			});
			expect(edits).toEqual([expect.stringContaining("已打回作废")]);
			expect(
				await materializeCard(
					store,
					commDbPath,
					holderB.question_id,
					"qa-card-B",
				),
			).toMatchObject({ ok: true, cardMessageId: "qa-card-B" });

			const approval = {
				schema_version: 1,
				run_id: "run-1",
				issue_id: "FLY-1772",
				question_id: holderB.question_id,
				response: { approved: true },
				actor: "founder",
				approved_head: head,
				classification: "founder_reaction",
				authority_id: holderB.question_id,
			};
			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: `founder-approval:${holderB.question_id}`,
					kind: "founder_approval",
					schemaVersion: 1,
					payloadJson: JSON.stringify(approval),
					payloadDigest: canonicalSubmissionDigest(approval),
				}),
			).toMatchObject({ status: "applied" });
			expect(store.getWorkflowRun("run-1")).toMatchObject({
				status: "active",
				current_node_id: "land",
			});
			expect(
				store.getWorkflowGateHolderByQuestionId(holderA.question_id),
			).toMatchObject({ state: "superseded", card_void_state: "done" });
			expect(
				store.getWorkflowGateHolderByQuestionId(holderB.question_id),
			).toMatchObject({ state: "approved", head_sha: head });
		} finally {
			store.close();
		}
	});

	it("routes a design kickback through design, implement, and QA before issuing the new-head card", async () => {
		const worktree = gitWorktree();
		const root = mkdtempSync(join(tmpdir(), "fly1772-design-new-card-loop-"));
		roots.push(root);
		const commDbPath = join(root, "comm.db");
		const store = await compiledRun();
		try {
			const holderA = prepareCompiledFounderGate(store, worktree.head1);
			expect(
				await materializeCard(
					store,
					commDbPath,
					holderA.question_id,
					"design-card-A",
				),
			).toMatchObject({ ok: true });
			const feedback = {
				schema_version: 1,
				run_id: "run-1",
				issue_id: "FLY-1772",
				question_id: holderA.question_id,
				response: { approved: false, feedback: "设计: 方向不对，整链重做" },
				actor: "founder",
				approved_head: worktree.head1,
				classification: "founder_direct_signal",
				authority_id: holderA.question_id,
				rework: {
					target: "design",
					invalidation_scope: ["design", "implement", "qa"],
					verification_policy: [
						"design_review",
						"code_review",
						"qa_retest",
						"founder_gate",
					],
					interpreted_by: "founder-reply-prefix",
					interpretation_reason: "matched_prefix:设计",
				},
			};
			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: `founder-feedback:${holderA.question_id}:design`,
					kind: "founder_feedback",
					schemaVersion: 1,
					payloadJson: JSON.stringify(feedback),
					payloadDigest: canonicalSubmissionDigest(feedback),
				}),
			).toMatchObject({ status: "applied" });

			const designDelivery = store.listWorkflowReworkDeliveries({
				states: ["pending"],
			})[0];
			if (!designDelivery) throw new Error("design delivery missing");
			const designRoute = store.getLatestWorkflowReworkRoute(
				designDelivery.request_id,
			);
			if (!designRoute) throw new Error("design route missing");
			expect(designRoute).toMatchObject({
				target_node_id: "eng_design",
				target_attempt: 2,
				invalidation_scope: ["eng_design", "implement", "qa"],
			});
			deliverFounderRework(store, {
				requestId: designDelivery.request_id,
				runId: "run-1",
				nodeId: "eng_design",
				executionId: designRoute.preferred_actor_execution_id,
				attempt: 2,
				now: "2026-08-14T05:00:00.000Z",
			});
			const design = store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "eng_design",
				attempt: 2,
				executionId: designRoute.preferred_actor_execution_id,
				outcome: "design_done",
				subjectDigest: worktree.head1,
				now: "2026-08-14T05:01:00.000Z",
			});
			expect(design).toMatchObject({
				ok: true,
				targetNodeId: "implement",
				targetAttempt: 3,
				reworkRequestId: expect.any(String),
			});
			if (!design.ok || !design.reworkRequestId) {
				throw new Error("implement verification delivery missing");
			}
			const implementRoute = store.getLatestWorkflowReworkRoute(
				design.reworkRequestId,
			);
			if (!implementRoute) throw new Error("implement route missing");
			expect(implementRoute).toMatchObject({
				target_node_id: "implement",
				target_attempt: design.targetAttempt,
				invalidation_scope: ["implement", "qa"],
			});
			const implementDelivery = deliverFounderRework(store, {
				requestId: design.reworkRequestId,
				runId: "run-1",
				nodeId: "implement",
				executionId: implementRoute.preferred_actor_execution_id,
				attempt: implementRoute.target_attempt,
				now: "2026-08-14T05:02:00.000Z",
			});
			expect(implementRoute.preferred_actor_execution_id).toBe("implement-1");
			const implemented = completeImplement(store, {
				attempt: implementRoute.target_attempt,
				head: worktree.head2,
				sourceEventId: "complete-design-chain-implement-2",
				workflowActivation: {
					activationId: implementDelivery.activationId,
					runId: "run-1",
					nodeId: "implement",
					attempt: implementRoute.target_attempt,
					turnEpoch: implementRoute.target_attempt,
				},
			});
			expect(implemented).toMatchObject({ ok: true });

			const qaDelivery = store.listWorkflowReworkDeliveries({
				states: ["pending"],
			})[0];
			if (!qaDelivery) throw new Error("QA verification delivery missing");
			const qaRoute = store.getLatestWorkflowReworkRoute(qaDelivery.request_id);
			if (!qaRoute) throw new Error("QA route missing");
			expect(qaRoute).toMatchObject({
				target_node_id: "qa",
				invalidation_scope: ["qa"],
			});
			const qa = deliverFounderRework(store, {
				requestId: qaDelivery.request_id,
				runId: "run-1",
				nodeId: "qa",
				executionId: qaRoute.preferred_actor_execution_id,
				attempt: qaRoute.target_attempt,
				now: "2026-08-14T05:03:00.000Z",
			});
			if (!qa.admission.submissionCredential) {
				throw new Error("QA submission credential missing");
			}
			await passQaThroughProduction(store, {
				executionId: qaRoute.preferred_actor_execution_id,
				credential: qa.admission.submissionCredential,
				worktreePath: worktree.path,
				head: worktree.head2,
				generation: `generation-design-chain-qa-${qaRoute.target_attempt}`,
				clientRequestId: `design-chain-qa-pass-${qaRoute.target_attempt}`,
				now: "2026-08-14T05:03:04.000Z",
			});
			expect(
				store.getCurrentWorkflowNodePrBindingForHead("run-1", worktree.head2),
			).toMatchObject({ node_id: "qa", attempt: qaRoute.target_attempt });
			const holderB = store.getCurrentWorkflowGateHolder(
				"run-1",
				"founder_gate",
			);
			if (!holderB) throw new Error("design replacement card missing");
			expect(holderB).toMatchObject({
				state: "materializing",
				head_sha: worktree.head2,
			});
			expect(holderB.question_id).not.toBe(holderA.question_id);
			expect(
				store.getWorkflowGateHolderByQuestionId(holderA.question_id),
			).toMatchObject({ state: "superseded", card_void_state: "pending" });
		} finally {
			store.close();
		}
	});
});
