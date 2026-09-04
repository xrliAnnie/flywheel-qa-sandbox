import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { installSelfHostedWorkflowAgentProject } from "../../__tests__/fixtures/workflow-agent-project.js";
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
		probeRegistered?: (session: {
			execution_id: string;
		}) => Promise<PhaseLiveness>;
		probePersisted?: () => Promise<PhaseLiveness>;
		activateActorForWake?: () => Promise<
			{ ok: true } | { ok: false; error: string }
		>;
		closeActorForReworkSupersession?: () => Promise<
			{ ok: true } | { ok: false; error: string }
		>;
		failGrantOnceFor?: string;
		failWakeOnceFor?: string;
		implementProducesOutput?: boolean;
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
	const canonicalRoot = join(root, "project");
	mkdirSync(canonicalRoot);
	installSelfHostedWorkflowAgentProject(canonicalRoot);
	const legacySeed = structuredClone(
		legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		),
	);
	if (!legacySeed) throw new Error("tpl_eng_heavy seed missing");
	const seed = pinLegacyWorkflowSeedAgents(legacySeed);
	const qaSeed = seed.manifest.nodes.find((node) => node.id === "qa");
	if (!qaSeed) throw new Error("tpl_eng_heavy QA node missing");
	delete qaSeed.submissionWindowMinutes;
	if (options.implementProducesOutput) {
		const implementSeed = seed.manifest.nodes.find(
			(node) => node.id === "implement",
		);
		if (!implementSeed) throw new Error("tpl_eng_heavy implement node missing");
		Object.assign(implementSeed, {
			type: "generic",
			produces_output: true,
			output: { schema: "json_v1", max_bytes: 262_144 },
		});
		const implementEdge = seed.manifest.edges.find(
			(edge) => edge.from === "implement",
		);
		if (!implementEdge) throw new Error("tpl_eng_heavy implement edge missing");
		implementEdge.condition = "node_done";
	}
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
		canonicalRoot,
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
		nodeReuseEnabled: false,
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
		nodeReuseEnabled: false,
		runId: "run-e2e",
		nodeId: "implement",
		attempt: 1,
		executionId: "implement-exec",
		outcome: options.implementProducesOutput ? "node_done" : "implement_done",
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
	const failedGrantExecutions = new Set(
		options.failGrantOnceFor ? [options.failGrantOnceFor] : [],
	);
	const failedWakeExecutions = new Set(
		options.failWakeOnceFor ? [options.failWakeOnceFor] : [],
	);
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
			hasTurnSource: async ({ issueId, sourceEventId }) =>
				comm
					.listTurnSourceHistory(issueId)
					.some((source) => source.source_event_id === sourceEventId),
			grantTurn: async (input) => {
				if (failedGrantExecutions.delete(input.executionId)) {
					throw new Error("execution mutation lease refused: lease_held");
				}
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
				if (failedWakeExecutions.delete(session.execution_id)) {
					return { ok: false, error: "wake_pipe_closed" };
				}
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
	it("preserves an already-granted submission credential across a wake retry", async () => {
		let current = new Date("2026-07-23T00:20:00.000Z");
		const { store, comm, coordinator, baseHead } = await createHarness({
			now: () => current,
			failWakeOnceFor: "qa-exec",
		});
		const rawStore = store as unknown as {
			db: {
				run(sql: string, params?: unknown[]): void;
				exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
			};
		};
		try {
			store.upsertWorkflowRunNode({
				runId: "run-e2e",
				nodeId: "qa",
				attempt: 2,
				state: "pending",
				executionId: "qa-exec",
			});
			rawStore.db.run(
				`INSERT INTO workflow_rework_request
				   (request_id, run_id, source_event_id, authority, source_node_id,
				    source_attempt, base_revision, authority_context_json,
				    authority_context_digest, requested_at)
				 VALUES ('rework-qa-wake', 'run-e2e', 'implement-done-wake', 'qa',
				         'implement', 1, ?, '{"authority":"qa"}', 'digest-qa-wake', ?)`,
				[baseHead, current.toISOString()],
			);
			rawStore.db.run(
				`INSERT INTO workflow_rework_route_revision
				   (request_id, revision, target_node_id, target_attempt,
				    preferred_actor_execution_id, invalidation_scope_json,
				    verification_policy_json, interpreted_by,
				    interpretation_reason, created_at)
				 VALUES ('rework-qa-wake', 1, 'qa', 2, 'qa-exec', '["qa"]',
				         '["qa_retest"]', 'engine:test', 'wake failure', ?)`,
				[current.toISOString()],
			);
			rawStore.db.run(
				`INSERT INTO workflow_rework_delivery
				   (request_id, route_revision, state, updated_at)
				 VALUES ('rework-qa-wake', 1, 'pending', ?)`,
				[current.toISOString()],
			);

			await expect(coordinator.reconcile("rework-qa-wake")).resolves.toEqual({
				kind: "retryable",
				reason: "wake_failed:wake_pipe_closed",
			});
			const firstActivation =
				comm.getCurrentRunnerWorkflowActivation("qa-exec");
			expect(firstActivation?.submission_credential).toEqual(
				expect.any(String),
			);
			expect(
				store.getWorkflowSubmissionCredentialByToken(
					firstActivation!.submission_credential!,
				),
			).toMatchObject({ revoked: 0 });

			current = new Date("2026-07-23T00:21:00.000Z");
			await expect(
				coordinator.reconcile("rework-qa-wake"),
			).resolves.toMatchObject({
				kind: "awaiting_receipt",
				executionId: "qa-exec",
			});

			const replayedActivation =
				comm.getCurrentRunnerWorkflowActivation("qa-exec");
			expect(replayedActivation?.submission_credential).toBe(
				firstActivation!.submission_credential,
			);
			const credentialHash = createHash("sha256")
				.update(replayedActivation!.submission_credential!)
				.digest("hex");
			expect(
				store.getWorkflowSubmissionCredentialByToken(
					replayedActivation!.submission_credential!,
				),
			).toMatchObject({ credential_hash: credentialHash, revoked: 0 });
			expect(
				rawStore.db.exec(
					`SELECT credential_hash, revoked
					   FROM workflow_submission_credential
					  WHERE execution_id = 'qa-exec'
					  ORDER BY id DESC`,
				)[0]?.values,
			).toEqual([[credentialHash, 0]]);
		} finally {
			comm.close();
			store.close();
		}
	});

	it("rotates submission credential after a lease-held replay", async () => {
		let current = new Date("2026-07-23T00:20:00.000Z");
		const { store, comm, coordinator, baseHead } = await createHarness({
			now: () => current,
			failGrantOnceFor: "qa-exec",
		});
		const rawStore = store as unknown as {
			db: {
				run(sql: string, params?: unknown[]): void;
				exec(sql: string): Array<{
					columns: string[];
					values: unknown[][];
				}>;
			};
		};
		try {
			const staleAdmission = store.admitGeneralizedWorkflowExecution({
				runId: "run-e2e",
				nodeId: "qa",
				executionId: "qa-exec",
				attempt: 1,
				activationId: "activation:qa-stale",
				expiresAt: "2026-07-20T01:00:00.000Z",
				absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
				now: "2026-07-20T00:00:00.000Z",
				env: WORKFLOW_ON,
			});
			expect(staleAdmission).toMatchObject({ ok: true });
			rawStore.db.run(
				`UPDATE workflow_submission_credential
				    SET revoked = 1, revoked_reason = 'superseded_attempt'
				  WHERE activation_id = 'activation:qa-stale'`,
			);
			store.upsertWorkflowRunNode({
				runId: "run-e2e",
				nodeId: "qa",
				attempt: 2,
				state: "pending",
				executionId: "qa-exec",
			});
			rawStore.db.run(
				`INSERT INTO workflow_rework_request
				   (request_id, run_id, source_event_id, authority, source_node_id,
				    source_attempt, base_revision, authority_context_json,
				    authority_context_digest, requested_at)
				 VALUES ('rework-qa-replay', 'run-e2e', 'implement-done-replay', 'qa',
				         'implement', 1, ?, '{"authority":"qa"}', 'digest-qa-replay', ?)`,
				[baseHead, current.toISOString()],
			);
			rawStore.db.run(
				`INSERT INTO workflow_rework_route_revision
				   (request_id, revision, target_node_id, target_attempt,
				    preferred_actor_execution_id, invalidation_scope_json,
				    verification_policy_json, interpreted_by,
				    interpretation_reason, created_at)
				 VALUES ('rework-qa-replay', 1, 'qa', 2, 'qa-exec', '["qa"]',
				         '["qa_retest"]', 'engine:test', 'lease-held replay', ?)`,
				[current.toISOString()],
			);
			rawStore.db.run(
				`INSERT INTO workflow_rework_delivery
				   (request_id, route_revision, state, updated_at)
				 VALUES ('rework-qa-replay', 1, 'pending', ?)`,
				[current.toISOString()],
			);

			await expect(coordinator.reconcile("rework-qa-replay")).resolves.toEqual({
				kind: "retryable",
				reason:
					"turn_grant_failed:execution mutation lease refused: lease_held",
			});
			expect(
				store.rotateGeneralizedWorkflowSubmissionCredential({
					executionId: "qa-exec",
					activationId: "activation:rework-qa-replay",
					ownerId: "stale-coordinator",
					generation: 1,
					now: current.toISOString(),
					expiresAt: "2026-07-23T06:20:00.000Z",
					absoluteDeadlineAt: "2026-07-24T00:20:00.000Z",
				}),
			).toEqual({ ok: false, reason: "stale_rework_owner" });

			current = new Date("2026-07-23T00:21:00.000Z");
			await expect(
				coordinator.reconcile("rework-qa-replay"),
			).resolves.toMatchObject({
				kind: "awaiting_receipt",
				executionId: "qa-exec",
			});

			const activation = comm.getCurrentRunnerWorkflowActivation("qa-exec");
			expect(activation).toMatchObject({
				activation_id: "activation:rework-qa-replay",
				node_id: "qa",
				attempt: 2,
			});
			expect(activation?.submission_credential).toEqual(expect.any(String));
			const credentialHash = createHash("sha256")
				.update(activation!.submission_credential!)
				.digest("hex");
			const rows = rawStore.db.exec(
				`SELECT credential_hash, revoked
				   FROM workflow_submission_credential
				  WHERE execution_id = 'qa-exec'
				  ORDER BY id DESC`,
			)[0]?.values;
			expect(rows).toEqual([
				[credentialHash, 0],
				[expect.any(String), 1],
				[expect.any(String), 1],
			]);
			expect(
				store.getWorkflowSubmissionCredentialByToken(
					activation!.submission_credential!,
				),
			).toMatchObject({
				activation_id: activation!.activation_id,
				credential_hash: credentialHash,
				revoked: 0,
			});
		} finally {
			comm.close();
			store.close();
		}
	});

	it("rotates output credential after a lease-held replay", async () => {
		let current = new Date("2026-07-23T00:11:00.000Z");
		const { store, comm, coordinator, baseHead } = await createHarness({
			now: () => current,
			failGrantOnceFor: "implement-exec",
			implementProducesOutput: true,
		});
		const rawStore = store as unknown as {
			db: {
				exec(sql: string): Array<{
					columns: string[];
					values: unknown[][];
				}>;
			};
		};
		try {
			const failed = store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
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
				reason:
					"turn_grant_failed:execution mutation lease refused: lease_held",
			});
			expect(
				store.rotateGeneralizedWorkflowOutputCredential({
					executionId: "implement-exec",
					activationId: `activation:${failed.reworkRequestId}`,
					ownerId: "stale-coordinator",
					generation: 1,
					now: current.toISOString(),
					expiresAt: "2026-07-23T06:11:00.000Z",
					absoluteDeadlineAt: "2026-07-24T00:11:00.000Z",
				}),
			).toEqual({ ok: false, reason: "stale_rework_owner" });

			current = new Date("2026-07-23T00:12:00.000Z");
			await expect(
				coordinator.reconcile(failed.reworkRequestId),
			).resolves.toMatchObject({
				kind: "awaiting_receipt",
				executionId: "implement-exec",
			});

			const activation =
				comm.getCurrentRunnerWorkflowActivation("implement-exec");
			expect(activation).toMatchObject({
				activation_id: `activation:${failed.reworkRequestId}`,
				node_id: "implement",
				attempt: 2,
			});
			expect(activation?.output_credential).toEqual(expect.any(String));
			const credentialHash = createHash("sha256")
				.update(activation!.output_credential!)
				.digest("hex");
			const rows = rawStore.db.exec(
				`SELECT credential_hash, revoked
				   FROM workflow_output_credential
				  WHERE execution_id = 'implement-exec'
				  ORDER BY id DESC`,
			)[0]?.values;
			expect(rows).toEqual([
				[credentialHash, 0],
				[expect.any(String), 1],
			]);
		} finally {
			comm.close();
			store.close();
		}
	});

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
				nodeReuseEnabled: false,
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
				nodeReuseEnabled: false,
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

	it("converges a zombie writer replacement that raced the rework coordinator", async () => {
		let current = new Date("2026-07-23T00:11:00.000Z");
		const { store, comm, coordinator, baseHead } = await createHarness({
			now: () => current,
		});
		try {
			const failed = store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
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

			store.upsertWorkflowRunNode({
				runId: "run-e2e",
				nodeId: "implement",
				attempt: 2,
				state: "running",
				executionId: "implement-exec",
			});
			store.upsertSession({
				execution_id: "implement-exec",
				issue_id: "FLY-1423-E2E",
				project_name: "flywheel",
				status: "failed",
				workflow_node_id: "implement",
				session_role: "implement",
				chat_thread_role: "implement",
				tmux_session: "tmux:implement-exec",
			});
			const writerReplacement = store.rollbackDeadWorkflowNodeExecution({
				runId: "run-e2e",
				nodeId: "implement",
				attempt: 2,
				deadExecutionId: "implement-exec",
				newExecutionId: "implement-replacement",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-23T00:11:00.000Z",
				},
				now: "2026-07-23T00:11:00.000Z",
			});
			expect(writerReplacement).toMatchObject({
				ok: true,
				idempotentReplay: false,
			});
			expect(store.getWorkflowRunNode("run-e2e", "implement", 2)).toMatchObject(
				{
					state: "pending",
					execution_id: "implement-replacement",
				},
			);
			expect(
				store.getLatestWorkflowReworkRoute(failed.reworkRequestId),
			).toMatchObject({ preferred_actor_execution_id: "implement-exec" });
			expect(store.getWorkflowActor("implement-replacement")).toBeUndefined();

			await expect(
				coordinator.reconcile(failed.reworkRequestId),
			).resolves.toEqual({
				kind: "replacement_converged",
				executionId: "implement-replacement",
			});
			expect(
				store.getLatestWorkflowReworkRoute(failed.reworkRequestId),
			).toMatchObject({
				revision: 2,
				preferred_actor_execution_id: "implement-replacement",
				interpreted_by: "engine:writer_replacement_convergence",
			});
			expect(
				store.getWorkflowReworkDelivery(failed.reworkRequestId),
			).toMatchObject({ state: "replacement_pending", route_revision: 2 });
			expect(store.getWorkflowActor("implement-replacement")).toMatchObject({
				role: "implement",
			});
			expect(
				store
					.listWorkflowSideEffects("run-e2e")
					.find((row) => row.execution_id === "implement-replacement"),
			).toMatchObject({
				state: "intent_recorded",
				reason: `rework_replacement:${failed.reworkRequestId}`,
			});

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
			const stateRoot = mkdtempSync(join(tmpdir(), "fly2152-converge-e2e-"));
			roots.push(stateRoot);
			current = new Date("2026-07-23T00:12:00.000Z");
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
			expect(await dispatcher.reconcile()).toEqual({ started: 3, held: 0 });
			expect(launches).toHaveLength(1);
			expect(launches[0]?.generalizedExecution?.executionId).toBe(
				"implement-replacement",
			);
			expect(
				store.getWorkflowReworkDelivery(failed.reworkRequestId),
			).toMatchObject({ state: "wake_delivered", route_revision: 2 });
		} finally {
			comm.close();
			store.close();
		}
	});

	it("keeps implement and QA context through an account-switch probe wave", async () => {
		let current = NOW;
		const switchingAccounts = new Set(["implement-exec", "qa-exec"]);
		const { store, comm, coordinator, wakes, worktree, baseHead } =
			await createHarness({
				now: () => current,
				probeRegistered: async (session) => {
					if (switchingAccounts.delete(session.execution_id)) {
						return "indeterminate";
					}
					return "alive";
				},
			});
		try {
			const sideEffectsBefore = store.listWorkflowSideEffects("run-e2e");
			const failed = store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
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
					kind: "retryable",
					reason: "registered_liveness_indeterminate",
				},
			);
			expect(store.getSession("implement-exec")?.status).toBe("running");
			expect(store.getWorkflowRun("run-e2e")?.status).toBe("active");
			current = new Date("2026-07-23T00:21:00.000Z");
			expect(await coordinator.reconcile(failed.reworkRequestId)).toMatchObject(
				{
					kind: "awaiting_receipt",
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
				store.recordWorkflowReworkWakeReceipt({
					activationId: implementActivation!.activation_id,
					executionId: "implement-exec",
					epoch: implementActivation!.epoch,
					ackedAt: "2026-07-23T00:20:01.000Z",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
			).toEqual({ ok: true, idempotentReplay: false });
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
				nodeReuseEnabled: true,
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
					nodeReuseEnabled: false,
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
				kind: "retryable",
				reason: "registered_liveness_indeterminate",
			});
			expect(store.getSession("qa-exec")?.status).toBe("running");
			expect(store.getWorkflowRun("run-e2e")?.status).toBe("active");
			current = new Date("2026-07-23T00:22:00.000Z");
			expect(await coordinator.reconcile(qaRequestId)).toMatchObject({
				kind: "awaiting_receipt",
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
				store.recordWorkflowReworkWakeReceipt({
					activationId: qaActivation!.activation_id,
					executionId: "qa-exec",
					epoch: qaActivation!.epoch,
					ackedAt: "2026-07-23T00:24:01.000Z",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
			).toEqual({ ok: true, idempotentReplay: false });
			expect(
				store.getWorkflowSubmissionCredentialByToken(
					qaActivation!.submission_credential!,
				),
			).toMatchObject({
				expires_at: "2026-07-23T06:22:00.000Z",
				absolute_deadline_at: "2026-07-24T00:22:00.000Z",
			});
			const passed = store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
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
					nodeReuseEnabled: false,
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
				status: "active",
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
			expect(switchingAccounts).toEqual(new Set());
		} finally {
			comm.close();
			store.close();
		}
	});
});
