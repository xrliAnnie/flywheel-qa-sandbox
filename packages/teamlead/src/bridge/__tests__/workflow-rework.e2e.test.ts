import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import { workflowSeedContentHash } from "../../workflow-template.js";
import type { PhaseLiveness } from "../phase-actor-reentry.js";
import type { IStartDispatcher, StartRequest } from "../retry-dispatcher.js";
import { WorkflowEngineDispatcher } from "../workflow-engine-dispatcher.js";
import { WorkflowReworkCoordinator } from "../workflow-rework-coordinator.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_REWORK_REENTRY: "1",
};
const NOW = new Date("2026-07-23T00:20:00.000Z");
const roots: string[] = [];

function git(worktree: string, ...args: string[]) {
	return execFileSync("git", ["-C", worktree, ...args], {
		encoding: "utf8",
	}).trim();
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function createHarness(
	options: {
		now?: () => Date;
		probeRegistered?: () => Promise<PhaseLiveness>;
		probePersisted?: () => Promise<PhaseLiveness>;
		activateActorForWake?: () => Promise<
			{ ok: true } | { ok: false; error: string }
		>;
		closeActorForReworkSupersession?: () => Promise<
			{ ok: true } | { ok: false; error: string }
		>;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "fly1423-rework-e2e-"));
	roots.push(root);
	const worktree = join(root, "worktree");
	mkdirSync(worktree);
	git(worktree, "init", "-q");
	git(worktree, "config", "user.email", "fly1423@test.invalid");
	git(worktree, "config", "user.name", "FLY-1423");
	writeFileSync(join(worktree, "artifact.txt"), "base\n");
	git(worktree, "add", "artifact.txt");
	git(worktree, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
	const baseHead = git(worktree, "rev-parse", "HEAD");
	const store = await StateStore.create(join(root, "state.db"));
	const comm = new CommDB(join(root, "comm.db"));
	const seed = structuredClone(
		legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		),
	);
	if (!seed) throw new Error("tpl_eng_heavy seed missing");
	const qaSeed = seed.manifest.nodes.find((node) => node.id === "qa");
	if (!qaSeed) throw new Error("tpl_eng_heavy QA node missing");
	delete qaSeed.submissionWindowMinutes;
	seed.contentHash = workflowSeedContentHash(seed);
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-e2e",
		issueId: "FLY-1423-E2E",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "start-e2e",
			selectionDigest: "selection-e2e",
			nodeId: "design",
			attempt: 1,
			executionId: "design-exec",
			createdAt: "2026-07-23T00:00:00.000Z",
		},
	});
	(
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db.run(
		"UPDATE workflow_run SET gate_carrier_epoch = 0 WHERE run_id = 'run-e2e'",
	);
	store.upsertWorkflowRunNode({
		runId: "run-e2e",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-exec",
	});

	const designDone = store.commitWorkflowTransitionTx({
		runId: "run-e2e",
		nodeId: "design",
		attempt: 1,
		executionId: "design-exec",
		outcome: "design_done",
		successorExecutionId: "implement-exec",
		now: "2026-07-23T00:02:00.000Z",
	});
	if (!designDone.ok)
		throw new Error(`design transition failed: ${designDone.reason}`);
	store.upsertWorkflowRunNode({
		runId: "run-e2e",
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId: "implement-exec",
	});
	const implementDone = store.commitWorkflowTransitionTx({
		runId: "run-e2e",
		nodeId: "implement",
		attempt: 1,
		executionId: "implement-exec",
		outcome: "implement_done",
		successorExecutionId: "qa-exec",
		now: "2026-07-23T00:04:00.000Z",
	});
	if (!implementDone.ok) {
		throw new Error(`implement transition failed: ${implementDone.reason}`);
	}
	store.upsertWorkflowRunNode({
		runId: "run-e2e",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: "qa-exec",
	});
	const rawStore = store as unknown as {
		db: { run(sql: string, params?: unknown[]): void };
	};
	rawStore.db.run(
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES ('implement-exec', 'flywheel', 'FLY-1423-E2E', 'implement',
		         '2026-07-23T00:00:00.000Z'),
		        ('qa-exec', 'flywheel', 'FLY-1423-E2E', 'qa',
		         '2026-07-23T00:00:00.000Z')`,
	);

	for (const [executionId, role] of [
		["implement-exec", "implement"],
		["qa-exec", "qa"],
	] as const) {
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-1423-E2E",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: role,
			session_role: role,
			chat_thread_role: role,
			tmux_session: `tmux:${executionId}`,
			worktree_path: worktree,
		});
		store.patchSessionMetadata(executionId, { pr_head_sha: baseHead });
		comm.registerSession(
			executionId,
			`tmux:${executionId}`,
			"flywheel",
			"FLY-1423-E2E",
			"flywheel-eng-lead",
		);
	}
	comm.grantTurn("FLY-1423-E2E", "design-exec", "design", 1);
	comm.grantTurn("FLY-1423-E2E", "implement-exec", "implement", 2);
	comm.grantTurn("FLY-1423-E2E", "qa-exec", "qa", 3);

	const wakes: Array<{
		executionId: string;
		activationId: string;
		epoch: number;
		context: unknown;
	}> = [];
	const supersessions: unknown[] = [];
	const coordinator = new WorkflowReworkCoordinator({
		store,
		ownerId: "e2e-coordinator",
		now: options.now ?? (() => NOW),
		env: WORKFLOW_ON,
		resolveAlertIdentity: () => ({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		}),
		effects: {
			getActorSession: (executionId) => store.getSession(executionId),
			probeRegistered: options.probeRegistered ?? (async () => "alive"),
			probePersisted: options.probePersisted ?? (async () => "alive"),
			assertWorktreeReady: async (session, expectedHeadSha) => {
				if (!session.worktree_path) {
					return { ok: false, reason: "worktree_path_missing" };
				}
				if (git(session.worktree_path, "status", "--porcelain")) {
					return { ok: false, reason: "worktree_dirty" };
				}
				const actual = git(session.worktree_path, "rev-parse", "HEAD");
				return actual === expectedHeadSha
					? { ok: true }
					: { ok: false, reason: `head_mismatch:${actual}:${expectedHeadSha}` };
			},
			grantTurn: async (input) => {
				const grantedAt = NOW.toISOString();
				const epoch = comm.grantTurn(
					input.issueId,
					input.executionId,
					input.nodeId,
					NOW.getTime(),
					{
						project: input.projectName,
						sourceEventId: input.sourceEventId,
						targetRunId: input.runId,
						activation: {
							activationId: input.activationId,
							runId: input.runId,
							nodeId: input.nodeId,
							attempt: input.attempt,
							outputCredential: input.outputCredential,
							submissionCredential: input.submissionCredential,
							context: input.context,
						},
					},
				);
				return { epoch, grantedAt };
			},
			wakeActor: async ({ session, activationId, epoch, context }) => {
				wakes.push({
					executionId: session.execution_id,
					activationId,
					epoch,
					context,
				});
				return { ok: true };
			},
			closeActorForReworkSupersession: async (input) => {
				supersessions.push(input);
				return (
					(await options.closeActorForReworkSupersession?.()) ?? { ok: true }
				);
			},
			...(options.activateActorForWake
				? { activateActorForWake: options.activateActorForWake }
				: {}),
		},
	});

	return {
		store,
		comm,
		coordinator,
		wakes,
		supersessions,
		worktree,
		baseHead,
	};
}

describe("FLY-1423 capability-level rework flow", () => {
	it("closes a legacy terminal implement, then converges through proven-dead replacement", async () => {
		let current = new Date("2026-07-23T00:11:00.000Z");
		let liveness: PhaseLiveness = "alive";
		const { store, comm, coordinator, supersessions, baseHead } =
			await createHarness({
				now: () => current,
				probeRegistered: async () => liveness,
				probePersisted: async () => liveness,
				activateActorForWake: async () => ({
					ok: false,
					error: "state_not_revivable:completed",
				}),
				closeActorForReworkSupersession: async () => {
					liveness = "absent";
					return { ok: true };
				},
			});
		try {
			const failed = store.commitWorkflowTransitionTx({
				runId: "run-e2e",
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: baseHead,
				now: "2026-07-23T00:10:00.000Z",
			});
			if (!failed.ok || !failed.reworkRequestId) {
				throw new Error("QA fail did not create a rework request");
			}
			await expect(
				coordinator.reconcile(failed.reworkRequestId),
			).resolves.toEqual({
				kind: "retryable",
				reason: "holder_activation_failed:state_not_revivable:completed",
			});
			expect(supersessions).toEqual([
				expect.objectContaining({
					requestId: failed.reworkRequestId,
					ownerId: "e2e-coordinator",
					generation: 1,
					routeRevision: 1,
					executionId: "implement-exec",
				}),
			]);
			expect(
				store.getWorkflowReworkDelivery(failed.reworkRequestId),
			).toMatchObject({ state: "pending", hold_count: 1 });
			for (let probe = 0; probe < 20; probe += 1) {
				await coordinator.reconcile(failed.reworkRequestId);
			}
			expect(
				store
					.listWorkflowRunEvents("run-e2e")
					.filter((event) => event.kind === "rework_delivery_claimed"),
			).toHaveLength(1);
			expect(supersessions).toHaveLength(1);
			current = new Date("2026-07-23T00:12:00.000Z");
			for (const intent of store
				.listWorkflowSideEffects("run-e2e")
				.filter((row) => row.state === "intent_recorded")) {
				store.applyWorkflowLedgerBatch({
					projectName: "flywheel",
					issueId: "FLY-1423-E2E",
					runId: "run-e2e",
					ops: [
						{
							op: "side_effect",
							node: intent.node_id,
							attempt: intent.attempt,
							executionId: intent.execution_id,
							to: "started",
						},
					],
				});
			}
			const launches: StartRequest[] = [];
			const startDispatcher = {
				start: async (request: StartRequest) => {
					launches.push(request);
					const generalized = request.generalizedExecution;
					if (!generalized) throw new Error("generalized execution missing");
					const committed = generalized.commitWorkflowLaunch?.();
					if (!committed?.ok) {
						throw new Error(committed?.reason ?? "launch commit failed");
					}
					store.upsertSession({
						execution_id: generalized.executionId,
						issue_id: request.issueId,
						project_name: request.projectName,
						status: "running",
						session_role: request.sessionRole,
						chat_thread_role: request.sessionRole,
					});
					return {
						executionId: generalized.executionId,
						issueId: request.issueId,
					};
				},
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher;
			const stateRoot = mkdtempSync(join(tmpdir(), "fly1707-rescue-e2e-"));
			roots.push(stateRoot);
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher,
				stateRoot,
				env: WORKFLOW_ON,
				now: () => current,
				resolvePredecessorHead: async () => baseHead,
				reconcileWorkflowRework: (requestId) =>
					coordinator.reconcile(requestId),
			});
			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			expect(launches).toHaveLength(1);
			const replacementExecutionId =
				launches[0]!.generalizedExecution!.executionId;
			expect(replacementExecutionId).not.toBe("implement-exec");
			expect(store.getWorkflowRunNode("run-e2e", "implement", 2)).toMatchObject(
				{
					state: "running",
					execution_id: replacementExecutionId,
				},
			);
			expect(
				store.getLatestWorkflowReworkRoute(failed.reworkRequestId),
			).toMatchObject({ preferred_actor_execution_id: replacementExecutionId });
			expect(
				store
					.listWorkflowRunEvents("run-e2e")
					.filter((event) => event.kind === "rework_delivery_claimed"),
			).toHaveLength(2);
			expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
			expect(
				store.getWorkflowReworkDelivery(failed.reworkRequestId),
			).toMatchObject({ state: "wake_delivered", hold_count: 1 });
		} finally {
			store.close();
			comm.close();
		}
	});

	it("spaces dirty-worktree retries at 1/2/4/8 minutes and emits one terminal Lead alert", async () => {
		let current = new Date("2026-07-23T00:11:00.000Z");
		const { store, comm, coordinator, worktree, baseHead } =
			await createHarness({ now: () => current });
		try {
			writeFileSync(join(worktree, "qa-report.md"), "untracked QA residue\n");
			const failed = store.commitWorkflowTransitionTx({
				runId: "run-e2e",
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: baseHead,
				now: "2026-07-23T00:10:00.000Z",
			});
			if (!failed.ok || !failed.reworkRequestId) {
				throw new Error("QA fail did not create a rework request");
			}
			const retryTimes = [11, 12, 14, 18, 26].map(
				(minute) => new Date(`2026-07-23T00:${minute}:00.000Z`),
			);
			for (const [index, now] of retryTimes.entries()) {
				current = now;
				const outcome = await coordinator.reconcile(failed.reworkRequestId);
				expect(outcome).toMatchObject(
					index === 4
						? { kind: "settled", state: "needs_lead" }
						: {
								kind: "retryable",
								reason: "worktree_not_ready:worktree_dirty",
							},
				);
			}
			current = new Date("2026-07-23T00:27:00.000Z");
			await expect(
				coordinator.reconcile(failed.reworkRequestId),
			).resolves.toEqual({ kind: "settled", state: "needs_lead" });
			expect(
				store
					.listWorkflowRunEvents("run-e2e")
					.filter((event) => event.kind === "rework_delivery_claimed"),
			).toHaveLength(5);
			expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
			expect(store.listWorkflowAlertOutbox()[0]?.payload.body).toContain(
				"failed five retryable deliveries",
			);
			expect(
				store
					.listWorkflowAlertOutbox()
					.every(
						(row) => row.payload.eventType === "workflow_engine_escalation",
					),
			).toBe(true);
		} finally {
			store.close();
			comm.close();
		}
	});

	it("re-enters the same implement and QA actors from fail through retest", async () => {
		const { store, comm, coordinator, wakes, worktree, baseHead } =
			await createHarness();
		try {
			const sideEffectsBefore = store.listWorkflowSideEffects("run-e2e");
			const failed = store.commitWorkflowTransitionTx({
				runId: "run-e2e",
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: baseHead,
				now: "2026-07-23T00:10:00.000Z",
			});
			expect(failed).toMatchObject({
				ok: true,
				targetNodeId: "implement",
				targetAttempt: 2,
				reworkRequestId: expect.any(String),
			});
			if (!failed.ok || !failed.reworkRequestId) {
				throw new Error("QA fail did not create a rework request");
			}

			expect(await coordinator.reconcile(failed.reworkRequestId)).toMatchObject(
				{
					kind: "wake_delivered",
					executionId: "implement-exec",
					epoch: 4,
				},
			);
			const implementActivation =
				comm.getCurrentRunnerWorkflowActivation("implement-exec");
			expect(implementActivation).toMatchObject({
				activation_id: `activation:${failed.reworkRequestId}`,
				node_id: "implement",
				attempt: 2,
				epoch: 4,
			});
			expect(JSON.parse(implementActivation!.context_json)).toMatchObject({
				authority: "qa",
				target: {
					nodeId: "implement",
					attempt: 2,
					invalidationScope: ["implement", "qa"],
				},
			});
			expect(
				store.getWorkflowReworkVerificationPath(failed.reworkRequestId),
			).toMatchObject({
				state: "active",
				current_node_id: "implement",
				current_attempt: 2,
			});
			writeFileSync(join(worktree, "artifact.txt"), "fixed\n");
			git(worktree, "add", "artifact.txt");
			git(worktree, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fix");
			const fixHead = git(worktree, "rev-parse", "HEAD");

			const completion = {
				decision: { route: "needs_review" },
				evidence: { commitMessages: ["fix QA regression"] },
			};
			const completed = store.commitEnrolledCompletion({
				executionId: "implement-exec",
				route: "needs_review",
				sourceEventId: "complete-implement-attempt-2",
				completionSubmission: completion,
				subjectDigest: fixHead,
				workflowActivation: {
					activationId: implementActivation!.activation_id,
					runId: implementActivation!.run_id,
					nodeId: implementActivation!.node_id,
					attempt: implementActivation!.attempt,
					turnEpoch: implementActivation!.epoch,
				},
				now: "2026-07-23T00:21:00.000Z",
			});
			expect(completed).toMatchObject({ ok: true, idempotentReplay: false });
			expect(
				store.commitEnrolledCompletion({
					executionId: "implement-exec",
					route: "needs_review",
					sourceEventId: "complete-implement-attempt-2-replay",
					completionSubmission: completion,
					subjectDigest: fixHead,
					workflowActivation: {
						activationId: implementActivation!.activation_id,
						runId: implementActivation!.run_id,
						nodeId: implementActivation!.node_id,
						attempt: implementActivation!.attempt,
						turnEpoch: implementActivation!.epoch,
					},
					now: "2026-07-23T00:22:00.000Z",
				}),
			).toMatchObject({ ok: true, idempotentReplay: true });

			const pending = store.listWorkflowReworkDeliveries({
				states: ["pending"],
			});
			expect(pending).toHaveLength(1);
			const qaRequestId = pending[0]!.request_id;
			expect(store.getWorkflowReworkRequest(qaRequestId)).toMatchObject({
				authority: "qa",
				base_revision: fixHead,
				source_node_id: "implement",
				source_attempt: 2,
			});
			expect(store.getLatestWorkflowReworkRoute(qaRequestId)).toMatchObject({
				target_node_id: "qa",
				target_attempt: 2,
				preferred_actor_execution_id: "qa-exec",
				invalidation_scope: ["qa"],
			});
			expect(
				store.getWorkflowReworkDelivery(failed.reworkRequestId),
			).toMatchObject({
				state: "completed",
			});

			expect(await coordinator.reconcile(qaRequestId)).toMatchObject({
				kind: "wake_delivered",
				executionId: "qa-exec",
				epoch: 5,
			});
			const qaActivation = comm.getCurrentRunnerWorkflowActivation("qa-exec");
			expect(qaActivation).toMatchObject({
				activation_id: `activation:${qaRequestId}`,
				node_id: "qa",
				attempt: 2,
				epoch: 5,
			});
			expect(qaActivation?.submission_credential).toEqual(expect.any(String));
			expect(
				store.getWorkflowSubmissionCredentialByToken(
					qaActivation!.submission_credential!,
				),
			).toMatchObject({
				expires_at: "2026-07-23T06:20:00.000Z",
				absolute_deadline_at: "2026-07-24T00:20:00.000Z",
			});
			const passed = store.commitWorkflowTransitionTx({
				runId: "run-e2e",
				nodeId: "qa",
				attempt: 2,
				executionId: "qa-exec",
				outcome: "qa_pass",
				subjectDigest: fixHead,
				now: "2026-07-23T00:25:00.000Z",
			});
			expect(passed).toMatchObject({
				ok: true,
				targetNodeId: "founder_gate",
				gateOpened: true,
			});
			expect(
				store.commitWorkflowTransitionTx({
					runId: "run-e2e",
					nodeId: "qa",
					attempt: 2,
					executionId: "qa-exec",
					outcome: "qa_pass",
					subjectDigest: fixHead,
					now: "2026-07-23T00:26:00.000Z",
				}),
			).toMatchObject({ ok: true, idempotentReplay: true });

			expect(store.getWorkflowRun("run-e2e")).toMatchObject({
				current_node_id: "founder_gate",
			});
			expect(store.getWorkflowReworkDelivery(qaRequestId)).toMatchObject({
				state: "completed",
			});
			expect(store.listWorkflowSideEffects("run-e2e")).toEqual(
				sideEffectsBefore,
			);
			expect(
				store
					.getPhaseSessionsForIssue("FLY-1423-E2E")
					.filter((session) => session.chat_thread_role === "implement"),
			).toHaveLength(1);
			expect(
				store
					.getPhaseSessionsForIssue("FLY-1423-E2E")
					.filter((session) => session.chat_thread_role === "qa"),
			).toHaveLength(1);
			expect(wakes.map((wake) => wake.executionId)).toEqual([
				"implement-exec",
				"qa-exec",
			]);
		} finally {
			comm.close();
			store.close();
		}
	});
});
