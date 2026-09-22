import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import {
	type CloseoutEvidence,
	collectExecutionCloseoutEvidence,
} from "../execution-closeout-evidence.js";
import {
	executeLandOperation,
	type LandMergeDriver,
	resumeHeldLandOperation,
} from "../land-executor.js";
import {
	prepareLandIntent,
	prepareLandRecloseTargets,
} from "../land-intent-targets.js";
import { settleLandOperationWorktrees } from "../post-ship-finalization.js";
import { WorkflowEngineDispatcher } from "../workflow-engine-dispatcher.js";

type Fixture = {
	provenance: { managedSnapshot: boolean; source: string };
	pendingWindow: {
		commSession: {
			execution_id: string;
			tmux_window: string;
			project_name: string;
			issue_id: string;
			lead_id: string;
			status: "running";
			ended_at: null;
		};
	};
	nullTargets: {
		stateSession: {
			execution_id: string;
			issue_id: string;
			issue_identifier: string;
			project_name: string;
			status: string;
			adapter_type: string;
			worktree_binding_path: string;
			worktree_binding_branch: string;
			worktree_binding_generation: string;
		};
		landOperation: {
			operation_id: string;
			run_id: string;
			issue_id: string;
			project_name: string;
			pr_number: number;
			approved_head: string;
			state: "held";
			generation: number;
			current_step: string;
			merge_confirmed_at: string;
			last_error: string;
			retry_count: number;
			resume_generation: number;
			closeout_targets_json: null;
			closeout_targets_digest: null;
			closeout_targets_version: null;
			closeout_attribution_digest: null;
			closeout_targets_observed_at: null;
		};
		workflowRun: {
			run_id: string;
			issue_id: string;
			status: "held";
			current_node_id: "land";
			engine_owned: number;
		};
		workflowRunNode: {
			node_id: "land";
			attempt: number;
			status: "pending";
			execution_id: string;
		};
		workflowSideEffect: {
			node_id: "land";
			attempt: number;
			kind: "dispatch";
			state: "intent_recorded";
			launch_ordinal: number;
		};
	};
};

const fixture = JSON.parse(
	await readFile(
		new URL("./fixtures/fly2662-predeploy/held-closeout.json", import.meta.url),
		"utf8",
	),
) as Fixture;

const roots: string[] = [];
afterEach(async () => {
	while (roots.length > 0) {
		await rm(roots.pop()!, { recursive: true, force: true });
	}
});

function workflowSnapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV1({
			template: { id: "tpl_eng_heavy_land_v1", revision: 1 },
			manifest: {
				schema_version: 1,
				manifest_variant: "land_v1",
				nodes: [
					{
						id: "design",
						type: "design",
						vendor: "claude",
						model: "claude-fable-5",
					},
					{
						id: "implement",
						type: "implement",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "xhigh",
					},
					{
						id: "qa",
						type: "qa",
						vendor: "claude",
						model: "claude-opus-5",
					},
					{ id: "founder_gate", type: "gate" },
					{ id: "land", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "design_done",
						from: "design",
						to: "implement",
						condition: "design_done",
					},
					{
						id: "implement_done",
						from: "implement",
						to: "qa",
						condition: "implement_done",
					},
					{
						id: "qa_pass",
						from: "qa",
						to: "founder_gate",
						condition: "qa_pass",
					},
					{
						id: "founder_approved",
						from: "founder_gate",
						to: "land",
						condition: "founder_approved",
					},
				],
				loops: [
					{
						id: "qa_retry",
						from: "qa",
						to: "implement",
						loop_when: "qa_fail",
						exit_when: "qa_pass",
						max_iterations: 3,
						on_limit: "escalate",
					},
					{
						id: "founder_feedback",
						from: "founder_gate",
						to: "implement",
						loop_when: "founder_feedback_kickback",
						exit_when: "founder_approved",
						max_iterations: 3,
						on_limit: "escalate",
					},
				],
				approval_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				terminal_node: { node: "land" },
				ship_claims: ["qa_passed", "founder_approved"],
			},
		}),
	);
}

function database(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
}

async function pendingEvidence(input: {
	evidenceId: string;
	operationId: string;
	operationGeneration: number;
	attributionDigest: string;
	commIdentityRevision: string;
	liveHost?: boolean;
}): Promise<CloseoutEvidence> {
	const pending = fixture.pendingWindow.commSession;
	return collectExecutionCloseoutEvidence(
		{
			evidenceId: input.evidenceId,
			project: pending.project_name,
			issueUuid: fixture.nullTargets.landOperation.issue_id,
			runId: fixture.nullTargets.landOperation.run_id,
			executionId: pending.execution_id,
			activationId: null,
			operationId: input.operationId,
			operationGeneration: input.operationGeneration,
			lifecycleRevision: null,
			attributionDigest: input.attributionDigest,
			commIdentityRevision: input.commIdentityRevision,
			windowIdentity: pending.tmux_window,
			controllerGeneration: null,
			adapter: "codex-tmux",
		},
		{
			session: {
				status: "completed",
				adapter_type: "codex-tmux",
				heartbeat_at: undefined,
				lifecycle_revision: null,
			},
			launchClaimState: undefined,
		},
		{
			readCommSession: () => ({
				state: "present",
				revision: input.commIdentityRevision,
			}),
			lookupTarget: () => ({
				kind: "found",
				target: {
					tmuxWindow: pending.tmux_window,
					sessionName: "runner-flywheel",
				},
			}),
			listWindows: async () => ({ kind: "ok", windows: [] }),
			probeHostProcess: async () =>
				input.liveHost
					? { verdict: "live" as const, source: "fixture" }
					: { verdict: "absent" as const, source: "fixture" },
			probeCodexDaemon: async () => "absent",
			now: () => new Date("2026-09-17T21:00:00.000Z"),
		},
	);
}

describe("FLY-2662 pre-deployment fixture replay", () => {
	it("FLY-2662 replays NULL targets and :pending through reclose, dispatch, and ordered finalization", async () => {
		// FLY-2748: the fixture lease is 24h from 2026-09-17T21:00:01Z and the land
		// closeout audit reads the real clock, so pin Date inside the fixture window.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-17T21:00:01.500Z"));
		onTestFinished(() => {
			vi.useRealTimers();
		});
		expect(fixture.provenance.managedSnapshot).toBe(false);
		expect(fixture.provenance.source).toContain("read-only sqlite queries");
		const root = await mkdtemp(join(tmpdir(), "fly2662-predeploy-replay-"));
		roots.push(root);
		const projectRoot = join(root, "flywheel");
		await mkdir(projectRoot);
		const canonicalRoot = await realpath(projectRoot);
		const canonicalParent = dirname(canonicalRoot);
		const state = fixture.nullTargets;
		const operationShape = state.landOperation;
		const executionId = state.stateSession.execution_id;
		const worktreePath = state.stateSession.worktree_binding_path.replace(
			"$SANDBOX_PARENT",
			canonicalParent,
		);
		const store = await StateStore.create(":memory:");
		const commPath = join(root, "comm.db");
		const comm = new CommDB(commPath);
		try {
			store.createWorkflowRun({
				runId: state.workflowRun.run_id,
				issueId: state.workflowRun.issue_id,
				projectName: operationShape.project_name,
				snapshotJson: workflowSnapshot(),
				claimsReadEnrolled: true,
			});
			database(store).run(
				"UPDATE workflow_run SET engine_owned = ?, current_node_id = ?, status = ? WHERE run_id = ?",
				[
					state.workflowRun.engine_owned,
					state.workflowRun.current_node_id,
					state.workflowRun.status,
					state.workflowRun.run_id,
				],
			);
			store.upsertWorkflowRunNode({
				runId: state.workflowRun.run_id,
				nodeId: state.workflowRunNode.node_id,
				attempt: state.workflowRunNode.attempt,
				state: state.workflowRunNode.status,
				executionId,
			});
			database(store).run(
				`INSERT INTO workflow_side_effect_ledger
				   (run_id,node_id,attempt,kind,launch_ordinal,execution_id,state,
				    created_at,updated_at,committed_at)
				 VALUES (?,?,?,?,?,?,?, ?,?,NULL)`,
				[
					state.workflowRun.run_id,
					state.workflowSideEffect.node_id,
					state.workflowSideEffect.attempt,
					state.workflowSideEffect.kind,
					state.workflowSideEffect.launch_ordinal,
					executionId,
					state.workflowSideEffect.state,
					operationShape.merge_confirmed_at,
					operationShape.merge_confirmed_at,
				],
			);
			store.upsertSession({
				execution_id: executionId,
				issue_id: state.stateSession.issue_id,
				issue_identifier: state.stateSession.issue_identifier,
				project_name: state.stateSession.project_name,
				status: state.stateSession.status,
				adapter_type: state.stateSession.adapter_type,
			});
			expect(
				store.bindWorktreeOnce(executionId, {
					path: worktreePath,
					branch: state.stateSession.worktree_binding_branch,
					generation: state.stateSession.worktree_binding_generation,
				}),
			).toMatchObject({ bound: true });

			const created = store.ensureLandOperation({
				runId: operationShape.run_id,
				issueId: operationShape.issue_id,
				projectName: operationShape.project_name,
				prNumber: operationShape.pr_number,
				approvedHead: operationShape.approved_head,
				now: operationShape.merge_confirmed_at,
			});
			database(store).run(
				"UPDATE land_operation SET operation_id = ?, generation = ? WHERE operation_id = ?",
				[
					operationShape.operation_id,
					operationShape.generation - 1,
					created.operation_id,
				],
			);
			database(store).run(
				`UPDATE workflow_delivery_attempt
				    SET contract_ref_json = json_set(contract_ref_json, '$.pk', ?)
				  WHERE family = 'land'
				    AND json_extract(contract_ref_json, '$.table') = 'land_operation'
				    AND json_extract(contract_ref_json, '$.pk') = ?`,
				[operationShape.operation_id, created.operation_id],
			);
			const originalClaim = store.claimLandOperation({
				operationId: operationShape.operation_id,
				ownerId: "predeploy-owner",
				now: "2026-09-17T02:11:19.000Z",
				leaseExpiresAt: "2026-09-17T02:12:19.000Z",
			})!;
			expect(originalClaim.generation).toBe(operationShape.generation);
			const mergeSha = "3".repeat(40);
			expect(
				store.recordLandOperationStep({
					operationId: operationShape.operation_id,
					ownerId: originalClaim.ownerId,
					generation: originalClaim.generation,
					step: "merge_confirmed",
					receipt: { headSha: operationShape.approved_head, mergeSha },
					now: operationShape.merge_confirmed_at,
				}),
			).toMatchObject({ ok: true });
			store.setLandOperationDisposition({
				operationId: operationShape.operation_id,
				ownerId: originalClaim.ownerId,
				generation: originalClaim.generation,
				state: operationShape.state,
				error: operationShape.last_error,
				now: operationShape.merge_confirmed_at,
			});
			database(store).run(
				`UPDATE land_operation
				    SET current_step = ?, retry_count = ?, resume_generation = ?,
				        closeout_targets_json = NULL, closeout_targets_digest = NULL,
				        closeout_targets_version = NULL,
				        closeout_attribution_digest = NULL,
				        closeout_targets_observed_at = NULL
				  WHERE operation_id = ?`,
				[
					operationShape.current_step,
					operationShape.retry_count,
					operationShape.resume_generation,
					operationShape.operation_id,
				],
			);
			expect(store.getLandOperation(operationShape.operation_id)).toMatchObject(
				{
					state: "held",
					closeout_targets_json: null,
					closeout_targets_digest: null,
					closeout_targets_version: null,
					closeout_attribution_digest: null,
				},
			);

			const pending = fixture.pendingWindow.commSession;
			comm.registerSession(
				pending.execution_id,
				pending.tmux_window,
				pending.project_name,
				operationShape.issue_id,
				pending.lead_id,
			);
			const mergeDriver = {
				inspectPr: vi.fn().mockResolvedValue({
					state: "MERGED" as const,
					headSha: operationShape.approved_head,
					mergeSha,
				}),
				triggerCool: vi.fn(),
				inspectTriggeredWorkflow: vi.fn(),
			} satisfies LandMergeDriver;
			store.upsertWorkflowRunNode({
				runId: state.workflowRun.run_id,
				nodeId: "implement",
				attempt: 1,
				state: "done",
				executionId,
			});
			database(store).run(
				`INSERT INTO workflow_node_pr_binding
				   (run_id, node_id, attempt, pr_number, head_sha,
				    target_repo_identity, probe_repo_slug, target_repo_path,
				    worktree_binding_generation, receipt_id, bound_at)
				 VALUES (?, 'implement', 1, ?, ?, '__main__',
				         'geoforge3d/flywheel', ?, 'generation-1',
				         'fly2662-pr-binding', '2026-09-17T01:00:00.000Z')`,
				[
					state.workflowRun.run_id,
					operationShape.pr_number,
					operationShape.approved_head,
					canonicalRoot,
				],
			);
			store.upsertSession({
				execution_id: "fly2662-gate-exec",
				issue_id: operationShape.issue_id,
				project_name: operationShape.project_name,
				status: "awaiting_review",
				pr_number: operationShape.pr_number,
				pr_head_sha: operationShape.approved_head,
			});
			store.ensureWorkflowGateHolder({
				runId: state.workflowRun.run_id,
				gateNodeId: "founder_gate",
				attempt: 1,
				headSha: operationShape.approved_head,
				sourceExecutionId: "fly2662-gate-exec",
				questionId: "fly2662-question",
				now: "2026-09-17T01:00:00.000Z",
			});
			store.advanceWorkflowGateHolderMaterialization({
				questionId: "fly2662-question",
				stage: "card_bound",
				cardMessageId: "fly2662-card",
				now: "2026-09-17T01:01:00.000Z",
			});
			database(store).run(
				"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = 'fly2662-question'",
			);
			const requestId = "26620000-0000-4000-8000-000000000001";
			await expect(
				resumeHeldLandOperation(
					{
						operationId: operationShape.operation_id,
						actor: "authenticated-fixture-peer",
						reason: "replay readonly-shaped held closeout",
						mode: "closeout_only",
						expectedResumeGeneration: operationShape.resume_generation,
						expectedApprovedHead: operationShape.approved_head,
						requestId,
					},
					{
						store,
						mergeDriver,
						now: () => new Date("2026-09-17T21:00:00.000Z"),
						prepareRecloseTargets: (input) =>
							prepareLandRecloseTargets(store, input, {
								resolveProjectRoot: () => canonicalRoot,
								getRegisteredWorktree: async () => null,
								readWorktreeGeneration: async () => undefined,
							}),
					},
				),
			).resolves.toMatchObject({
				ok: true,
				operation: {
					state: "partial",
					closeout_targets_version: 2,
					closeout_targets_source: "reclose_migration",
				},
			});

			const effects: string[] = [];
			const landExecutor = vi.fn((operationId: string) =>
				executeLandOperation(operationId, {
					store,
					mergeDriver,
					authorize: () => ({ ok: true }),
					ownerId: "replay-dispatcher",
					leaseMs: 24 * 60 * 60_000,
					now: () => new Date("2026-09-17T21:00:01.000Z"),
					finalize: async (current) => {
						const attributionDigest = current.closeout_attribution_digest!;
						const identity = comm.getSessionCloseoutIdentity(
							pending.execution_id,
						);
						const evidence = await pendingEvidence({
							evidenceId: "26620000-0000-4000-8000-000000000002",
							operationId: current.operation_id,
							operationGeneration: current.generation,
							attributionDigest,
							commIdentityRevision: identity.revision,
						});
						expect(evidence.verdict).toBe("gone");
						effects.push("gone");
						const reservation = store.reserveLandCloseout({
							operationId: current.operation_id,
							ownerId: current.owner_id!,
							ownerInstanceId: current.owner_instance_id ?? undefined,
							generation: current.generation,
							inventoryDigest: canonicalSubmissionDigest([
								pending.execution_id,
							]),
							now: evidence.observedAt,
						});
						expect(reservation).toMatchObject({ ok: true });
						const stored = store.recordCloseoutExecutionEvidence({
							evidenceId: evidence.evidenceId,
							operationId: current.operation_id,
							ownerId: current.owner_id!,
							ownerInstanceId: current.owner_instance_id ?? undefined,
							operationGeneration: current.generation,
							probeSequence: 1,
							projectName: current.project_name,
							issueId: current.issue_id,
							runId: current.run_id,
							executionId: pending.execution_id,
							attributionDigest,
							commIdentityRevision: identity.revision,
							observedStartedAt: evidence.observedAt,
							observedAt: evidence.observedAt,
							expiresAt: evidence.expiresAt,
							evidence,
						});
						expect(stored).toMatchObject({ ok: true });
						const worktrees = await settleLandOperationWorktrees(
							{
								issueId: current.issue_id,
								projectName: current.project_name,
								runId: current.run_id ?? undefined,
								landOperation: {
									operationId: current.operation_id,
									ownerId: current.owner_id!,
									ownerInstanceId: current.owner_instance_id ?? undefined,
									generation: current.generation,
								},
							},
							{
								store,
								removeCleanWorktree: vi.fn(),
								remoteBranchCleanup: vi.fn(),
							},
							true,
						);
						expect(worktrees, JSON.stringify(worktrees)).toMatchObject({
							complete: true,
						});
						effects.push("worktree");
						if (!reservation.ok) throw new Error("reservation_missing");
						const finalized = comm.finalizeProvenGoneSession(
							pending.execution_id,
							{
								reservationId: reservation.reservationId,
								evidenceId: evidence.evidenceId,
								expectedIdentityRevision: identity.revision,
								observedAt: evidence.observedAt,
								expiresAt: evidence.expiresAt,
								now: "2026-09-17T21:00:02.000Z",
							},
						);
						expect(finalized.finalized).toBe(true);
						effects.push("records");
						effects.push("thread");
						expect(
							store.recordLandLinearDoneDisposition({
								operationId: current.operation_id,
								ownerId: current.owner_id!,
								generation: current.generation,
								disposition: "done",
								reason: "fixture_linear_readback",
								executionId,
								now: "2026-09-17T21:00:03.000Z",
							}),
						).toMatchObject({ ok: true });
						effects.push("linear");
						return { complete: true, outcome: "completed" };
					},
				}),
			);
			const prepareLandIntentSpy = vi.fn(
				(input: Parameters<typeof prepareLandIntent>[1]) =>
					prepareLandIntent(store, input, {
						resolveProjectRoot: () => canonicalRoot,
						getRegisteredWorktree: async () => null,
						readWorktreeGeneration: async () => undefined,
					}),
			);
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: {
					start: vi.fn(),
					getInflightCount: () => 0,
					validateAgentName: () => ({ ok: true as const }),
				} as never,
				env: {
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
					FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
				},
				now: () => new Date("2026-09-17T21:00:01.000Z"),
				landExecutor,
				prepareLandIntent: prepareLandIntentSpy,
				resolveRunAlertIdentity: (projectName: string) => ({
					leadId: "flywheel-eng-lead",
					projectName,
					leadResolution: "resolved" as const,
				}),
			} as never);
			expect(await dispatcher.reconcile()).toEqual({
				started: 1,
				held: 0,
			});
			expect(prepareLandIntentSpy).not.toHaveBeenCalled();
			expect(landExecutor).toHaveBeenCalledOnce();
			expect(landExecutor).toHaveBeenCalledWith(operationShape.operation_id);
			expect(effects).toEqual([
				"gone",
				"worktree",
				"records",
				"thread",
				"linear",
			]);
			expect(comm.getSession(pending.execution_id)).toBeUndefined();
			expect(store.getLandOperation(operationShape.operation_id)).toMatchObject(
				{
					state: "completed",
					closeout_targets_version: 2,
					closeout_targets_source: "reclose_migration",
				},
			);
			expect(store.getWorkflowRun(state.workflowRun.run_id)?.status).toBe(
				"completed",
			);
			expect(
				store.listWorkflowRunNodes(state.workflowRun.run_id, "land"),
			).toEqual([
				expect.objectContaining({
					attempt: state.workflowRunNode.attempt,
					state: "done",
				}),
			]);
			expect(mergeDriver.triggerCool).not.toHaveBeenCalled();
		} finally {
			comm.close();
			store.close();
		}
	});

	it("FLY-2662 keeps a pending placeholder fail-closed when its process is live", async () => {
		const root = await mkdtemp(join(tmpdir(), "fly2662-pending-live-"));
		roots.push(root);
		const comm = new CommDB(join(root, "comm.db"));
		const pending = fixture.pendingWindow.commSession;
		try {
			comm.registerSession(
				pending.execution_id,
				pending.tmux_window,
				pending.project_name,
				pending.issue_id,
				pending.lead_id,
			);
			const identity = comm.getSessionCloseoutIdentity(pending.execution_id);
			const evidence = await pendingEvidence({
				evidenceId: "26620000-0000-4000-8000-000000000003",
				operationId: fixture.pendingWindow.commSession.issue_id,
				operationGeneration: 1,
				attributionDigest: "f".repeat(64),
				commIdentityRevision: identity.revision,
				liveHost: true,
			});
			expect(evidence.verdict).toBe("alive");
			expect(evidence.liveVetoes).toContain(
				"hostProcess:execution_process_live",
			);
			expect(comm.getSession(pending.execution_id)).toMatchObject({
				tmux_window: "runner-flywheel:pending",
				status: "running",
			});
		} finally {
			comm.close();
		}
	});
});
