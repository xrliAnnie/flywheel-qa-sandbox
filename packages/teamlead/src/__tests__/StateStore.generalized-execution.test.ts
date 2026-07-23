import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";
import {
	loadBundledWorkflowSeeds,
	workflowSeedContentHash,
} from "../workflow-template.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const root of cleanups.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function createRun(store: StateStore, options: { output?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "flywheel-generalized-"));
	cleanups.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const node = {
		id: "execute",
		type: "generic" as const,
		vendor: "codex" as const,
		model: "gpt-5.6-sol",
		effort: "low" as const,
		agent_file: "agents/generic.md",
		...(options.output
			? {
					produces_output: true as const,
					output: { schema: "json_v1" as const, max_bytes: 128 },
				}
			: {}),
	};
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "tpl-test", revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [node, { id: "founder_gate", type: "gate" }],
			edges: [
				{
					id: "done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
			ship_claims: ["founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-X",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	return snapshot;
}

function createAdmittedEngineRun(
	store: StateStore,
	options: { output?: boolean } = {},
): { markerPath: string; outputCredential?: string } {
	createRun(store, options);
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	db.run(
		"UPDATE workflow_run SET engine_owned = 1, claims_read_enrolled = 1 WHERE run_id = 'run-1'",
	);
	db.run(
		`INSERT INTO workflow_side_effect_ledger
		   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state, created_at, updated_at)
		 VALUES ('run-1', 'execute', 1, 'dispatch', 1, 'exec-1', 'intent_recorded',
		         '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`,
	);
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "execute",
		executionId: "exec-1",
		attempt: 1,
		expiresAt: "2026-07-15T01:00:00.000Z",
		absoluteDeadlineAt: "2026-07-16T00:00:00.000Z",
		now: "2026-07-15T00:00:00.000Z",
		env: enabled,
	});
	if (!admitted.ok) throw new Error(`admission failed: ${admitted.reason}`);
	const markerRoot = mkdtempSync(join(tmpdir(), "fly1423-unlaunched-"));
	cleanups.push(markerRoot);
	return {
		markerPath: join(markerRoot, "exec-1"),
		outputCredential: admitted.outputCredential,
	};
}

const enabled = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

describe("generalized execution admission and terminal contracts", () => {
	it.each([
		[1, "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH", "template_dispatch_disabled"],
		[1, "FLYWHEEL_WORKFLOW_CLAIMS_WRITE", "claims_write_disabled"],
		[1, "FLYWHEEL_WORKFLOW_CLAIMS_READ", "claims_read_disabled"],
		[2, "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH", "template_dispatch_disabled"],
		[2, "FLYWHEEL_WORKFLOW_CLAIMS_WRITE", "claims_write_disabled"],
		[2, "FLYWHEEL_WORKFLOW_CLAIMS_READ", "claims_read_disabled"],
		[2, "FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES", "generalized_disabled"],
	] as const)(
		"schema v%s admission rejects without credentials when %s is removed",
		async (schemaVersion, missing, reason) => {
			const store = await StateStore.create(":memory:");
			let runId: string;
			let nodeId: string;
			let executionId: string;
			if (schemaVersion === 1) {
				const seed = loadBundledWorkflowSeeds().find(
					(candidate) => candidate.templateId === "tpl_eng_heavy",
				)!;
				store.importWorkflowTemplateSeed(seed);
				store.materializeWorkflowRun({
					runId: "run-v1-matrix",
					issueId: "FLY-V1-MATRIX",
					projectName: "flywheel",
					taskCategory: "engineering",
					templateId: seed.templateId,
					claimsReadEnrolled: true,
					actor: "test",
					env: enabled,
					startReservation: {
						idempotencyKey: "v1-matrix-start",
						selectionDigest: "selection",
						nodeId: "design",
						attempt: 1,
						executionId: "v1-design",
						createdAt: "2026-07-16T00:00:00.000Z",
					},
				});
				runId = "run-v1-matrix";
				nodeId = "design";
				executionId = "v1-design";
			} else {
				createRun(store);
				runId = "run-1";
				nodeId = "execute";
				executionId = "v2-execute";
			}
			const beforeClaims = store.countWorkflowClaims(runId);
			const beforeEffects = store.listWorkflowSideEffects(runId);
			const env = { ...enabled };
			delete env[missing];

			expect(
				store.admitGeneralizedWorkflowExecution({
					runId,
					nodeId,
					executionId,
					attempt: 1,
					now: "2026-07-16T00:00:00.000Z",
					expiresAt: "2026-07-16T01:00:00.000Z",
					absoluteDeadlineAt: "2026-07-17T00:00:00.000Z",
					env,
				}),
			).toEqual({ ok: false, reason });
			expect(store.getWorkflowExecutionBinding(executionId)).toBeUndefined();
			expect(store.getWorkflowExecutionRuntime(executionId)).toBeUndefined();
			expect(store.countWorkflowClaims(runId)).toBe(beforeClaims);
			expect(store.listWorkflowSideEffects(runId)).toEqual(beforeEffects);
			store.close();
		},
	);

	it("rejects a review node whose direct predecessor is not an output producer", async () => {
		const store = await StateStore.create(":memory:");
		const root = mkdtempSync(join(tmpdir(), "flywheel-review-producer-"));
		cleanups.push(root);
		mkdirSync(join(root, "agents"));
		writeFileSync(join(root, "agents", "generic.md"), "Produce nothing.\n");
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl-review-guard", revision: 1 },
			canonicalRoot: root,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "prepare",
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: "agents/generic.md",
					},
					{
						id: "review",
						type: "review",
						vendor: "claude",
						model: "claude-opus-4-8",
						effort: "high",
					},
					{ id: "founder_gate", type: "gate" },
				],
				edges: [
					{
						id: "prepared",
						from: "prepare",
						to: "review",
						condition: "node_done",
					},
					{
						id: "reviewed",
						from: "review",
						to: "founder_gate",
						condition: "review_pass",
					},
				],
				loops: [
					{
						id: "review_retry",
						from: "review",
						to: "prepare",
						loop_when: "review_fail",
						exit_when: "review_pass",
						max_iterations: 2,
						on_limit: "escalate",
					},
				],
				terminal_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				ship_claims: ["design_review_approved", "founder_approved"],
			},
		});
		store.createWorkflowRun({
			runId: "review-guard-run",
			issueId: "FLY-X",
			projectName: "flywheel",
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: true,
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'prepare' WHERE run_id = 'review-guard-run'",
		);
		store.upsertWorkflowRunNode({
			runId: "review-guard-run",
			nodeId: "prepare",
			attempt: 1,
			state: "running",
			executionId: "prepare-exec",
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "review-guard-run",
				nodeId: "prepare",
				attempt: 1,
				executionId: "prepare-exec",
				outcome: "node_done",
				successorExecutionId: "review-exec",
			}).ok,
		).toBe(true);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "review-guard-run",
				nodeId: "review",
				executionId: "review-exec",
				attempt: 1,
				now: "2026-07-16T00:01:00.000Z",
				expiresAt: "2026-07-16T01:00:00.000Z",
				absoluteDeadlineAt: "2026-07-17T00:00:00.000Z",
				env: enabled,
			}),
		).toEqual({ ok: false, reason: "review_output_producer_required" });
		store.close();
	});

	it("rejects same-vendor review at admission before the claim-layer backstop", async () => {
		const store = await StateStore.create(":memory:");
		const root = mkdtempSync(join(tmpdir(), "flywheel-same-vendor-"));
		cleanups.push(root);
		mkdirSync(join(root, "agents"));
		writeFileSync(join(root, "agents", "generic-executor.md"), "Execute.\n");
		const seed = structuredClone(
			loadBundledWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_product_v1",
			)!,
		);
		seed.templateId = "tpl_product_same_vendor";
		const reviewNode = seed.manifest.nodes.find(
			(node) => node.id === "review",
		)!;
		reviewNode.vendor = "codex";
		reviewNode.model = "gpt-5.6-sol";
		seed.contentHash = workflowSeedContentHash(seed);
		store.importWorkflowTemplateSeed(seed, enabled);
		store.materializeWorkflowRun({
			runId: "same-vendor-run",
			issueId: "FLY-X",
			projectName: "flywheel",
			taskCategory: "product",
			templateId: seed.templateId,
			claimsReadEnrolled: false,
			actor: "lead",
			canonicalRoot: root,
			env: enabled,
			startReservation: {
				idempotencyKey: "same-vendor-start",
				selectionDigest: "selection",
				nodeId: "research",
				attempt: 1,
				executionId: "research",
				createdAt: "2026-07-15T00:00:00.000Z",
			},
		});
		store.upsertWorkflowRunNode({
			runId: "same-vendor-run",
			nodeId: "research",
			attempt: 1,
			state: "running",
			executionId: "research",
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "same-vendor-run",
				nodeId: "research",
				attempt: 1,
				executionId: "research",
				outcome: "node_done",
				successorExecutionId: "produce",
			}).ok,
		).toBe(true);
		expect(
			store.commitWorkflowTransitionTx({
				runId: "same-vendor-run",
				nodeId: "produce",
				attempt: 1,
				executionId: "produce",
				outcome: "node_done",
				successorExecutionId: "review",
			}).ok,
		).toBe(true);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "same-vendor-run",
				nodeId: "review",
				executionId: "review",
				attempt: 1,
				now: "2026-07-15T00:10:00.000Z",
				expiresAt: "2026-07-15T01:10:00.000Z",
				absoluteDeadlineAt: "2026-07-16T00:10:00.000Z",
				env: enabled,
			}),
		).toEqual({ ok: false, reason: "same_vendor_review" });
		store.close();
	});

	it("revokes an older attempt's unconsumed output credential when retrying", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store, { output: true });
		const first = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "execute",
			executionId: "exec-1",
			attempt: 1,
			expiresAt: "2026-07-15T00:20:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:00:00.000Z",
			env: enabled,
		});
		expect(first).toMatchObject({ ok: true });
		const retry = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "execute",
			executionId: "exec-2",
			attempt: 2,
			expiresAt: "2026-07-15T00:25:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:05:00.000Z",
			env: enabled,
		});
		expect(retry).toMatchObject({ ok: true });
		if (
			!first.ok ||
			!first.outputCredential ||
			!retry.ok ||
			!retry.outputCredential
		) {
			throw new Error("output admission failed");
		}
		expect(
			store.submitWorkflowNodeOutput({
				token: first.outputCredential,
				clientRequestId: "stale-output",
				payload: '{"stale":true}',
				now: "2026-07-15T00:06:00.000Z",
			}),
		).toEqual({ ok: false, reason: "credential_revoked" });
		expect(
			store.submitWorkflowNodeOutput({
				token: retry.outputCredential,
				clientRequestId: "retry-output",
				payload: '{"retry":true}',
				now: "2026-07-15T00:06:00.000Z",
			}),
		).toMatchObject({ ok: true });
		store.close();
	});

	it("rotates a lost output credential only under the live pre-commit launch owner", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store, { output: true });
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "execute",
			executionId: "exec-1",
			attempt: 1,
			expiresAt: "2026-07-15T00:20:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:00:00.000Z",
			env: enabled,
		});
		expect(admitted).toMatchObject({ ok: true });
		if (!admitted.ok || !admitted.outputCredential) {
			throw new Error("output admission failed");
		}
		const markerRoot = mkdtempSync(join(tmpdir(), "flywheel-launch-rotate-"));
		cleanups.push(markerRoot);
		const markerPath = join(markerRoot, "exec-1.json");
		const owner = store.recoverOrAcquireWorkflowLaunch({
			executionId: "exec-1",
			ownerId: "dispatcher-a",
			now: "2026-07-15T00:01:00.000Z",
			leaseExpiresAt: "2026-07-15T00:10:00.000Z",
			markerPath,
		});
		expect(owner).toMatchObject({ status: "acquired", generation: 1 });
		if (owner.status !== "acquired") throw new Error("owner not acquired");
		expect(
			store.renewWorkflowLaunchOwner({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: owner.generation,
				now: "2026-07-15T00:02:00.000Z",
				leaseExpiresAt: "2026-07-15T00:12:00.000Z",
			}),
		).toEqual({ ok: true });

		const rotated = store.rotateGeneralizedWorkflowOutputCredential({
			executionId: "exec-1",
			ownerId: "dispatcher-a",
			generation: owner.generation,
			now: "2026-07-15T00:03:00.000Z",
			expiresAt: "2026-07-15T00:23:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
		});
		expect(rotated).toMatchObject({ ok: true });
		if (!rotated.ok) throw new Error("credential rotation failed");
		expect(
			store.submitWorkflowNodeOutput({
				token: admitted.outputCredential,
				clientRequestId: "old-ticket",
				payload: '{"old":true}',
				now: "2026-07-15T00:04:00.000Z",
			}),
		).toEqual({ ok: false, reason: "credential_revoked" });
		expect(
			store.submitWorkflowNodeOutput({
				token: rotated.outputCredential,
				clientRequestId: "new-ticket",
				payload: '{"new":true}',
				now: "2026-07-15T00:04:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: owner.generation,
				deliveryAttempt: owner.deliveryAttempt,
				markerPath,
				now: "2026-07-15T00:05:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.rotateGeneralizedWorkflowOutputCredential({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: owner.generation,
				now: "2026-07-15T00:06:00.000Z",
				expiresAt: "2026-07-15T00:26:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			}),
		).toEqual({ ok: false, reason: "launch_committed" });
		store.close();
	});

	it("installs an append-only cancellation fence that rejects every launch entrance", async () => {
		const store = await StateStore.create(":memory:");
		const { markerPath } = createAdmittedEngineRun(store);
		const fenced = store.beginUnlaunchedWorkflowCancellation({
			runId: "run-1",
			nodeId: "execute",
			attempt: 1,
			executionId: "exec-1",
			launchOrdinal: 1,
			cancellationOwner: "tripwire-a",
			reason: "unlaunched_admission_ttl",
			now: "2026-07-15T02:00:00.000Z",
		});
		expect(fenced).toMatchObject({
			ok: true,
			generation: 1,
			idempotentReplay: false,
		});
		expect(store.getWorkflowLaunchCancellation("exec-1")).toMatchObject({
			execution_id: "exec-1",
			generation: 1,
			reason: "unlaunched_admission_ttl",
			created_at: "2026-07-15T02:00:00.000Z",
		});
		expect(
			store.recoverOrAcquireWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				now: "2026-07-15T02:01:00.000Z",
				leaseExpiresAt: "2026-07-15T03:01:00.000Z",
				markerPath,
			}),
		).toEqual({ status: "cancelled", generation: 1 });
		expect(
			store.renewWorkflowLaunchOwner({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: 1,
				now: "2026-07-15T02:01:00.000Z",
				leaseExpiresAt: "2026-07-15T03:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "launch_cancelled" });
		expect(
			store.claimWorkflowLaunchDeliveryRepair({
				executionId: "exec-1",
				repairOwner: "repair-a",
				now: "2026-07-15T02:01:00.000Z",
				leaseExpiresAt: "2026-07-15T03:01:00.000Z",
			}),
		).toEqual({ status: "cancelled", generation: 1 });
		expect(
			store.commitWorkflowLaunchDeliveryRepair({
				executionId: "exec-1",
				repairOwner: "repair-a",
				generation: 1,
				attempt: 1,
				markerPath,
				now: "2026-07-15T02:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "launch_cancelled" });
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: 1,
				deliveryAttempt: 0,
				markerPath,
				now: "2026-07-15T02:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "launch_cancelled" });
		expect(existsSync(markerPath)).toBe(false);
		store.close();
	});

	it("takes over only an expired pending owner before fencing; a live owner or committed launch wins", async () => {
		const liveStore = await StateStore.create(":memory:");
		const live = createAdmittedEngineRun(liveStore);
		expect(
			liveStore.recoverOrAcquireWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				now: "2026-07-15T00:01:00.000Z",
				leaseExpiresAt: "2026-07-15T00:30:00.000Z",
				markerPath: live.markerPath,
			}),
		).toMatchObject({ status: "acquired", generation: 1 });
		expect(
			liveStore.beginUnlaunchedWorkflowCancellation({
				runId: "run-1",
				nodeId: "execute",
				attempt: 1,
				executionId: "exec-1",
				launchOrdinal: 1,
				cancellationOwner: "tripwire-a",
				reason: "unlaunched_admission_ttl",
				now: "2026-07-15T00:10:00.000Z",
			}),
		).toEqual({ ok: false, reason: "launch_owner_live" });
		expect(liveStore.getWorkflowLaunchCancellation("exec-1")).toBeUndefined();

		const expired = liveStore.beginUnlaunchedWorkflowCancellation({
			runId: "run-1",
			nodeId: "execute",
			attempt: 1,
			executionId: "exec-1",
			launchOrdinal: 1,
			cancellationOwner: "tripwire-a",
			reason: "unlaunched_admission_ttl",
			now: "2026-07-15T00:31:00.000Z",
		});
		expect(expired).toMatchObject({ ok: true, generation: 2 });
		expect(liveStore.getWorkflowLaunchOwner("exec-1")).toMatchObject({
			owner_generation: 2,
			owner_id: "tripwire-a",
			committed_generation: null,
		});
		expect(
			liveStore.fencedCommitWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: 1,
				deliveryAttempt: 0,
				markerPath: live.markerPath,
				now: "2026-07-15T00:32:00.000Z",
			}),
		).toEqual({ ok: false, reason: "launch_cancelled" });
		liveStore.close();

		const committedStore = await StateStore.create(":memory:");
		const committed = createAdmittedEngineRun(committedStore);
		const owner = committedStore.recoverOrAcquireWorkflowLaunch({
			executionId: "exec-1",
			ownerId: "dispatcher-a",
			now: "2026-07-15T00:01:00.000Z",
			leaseExpiresAt: "2026-07-15T01:00:00.000Z",
			markerPath: committed.markerPath,
		});
		if (owner.status !== "acquired") throw new Error("owner not acquired");
		expect(
			committedStore.fencedCommitWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: owner.generation,
				deliveryAttempt: owner.deliveryAttempt,
				markerPath: committed.markerPath,
				now: "2026-07-15T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			committedStore.beginUnlaunchedWorkflowCancellation({
				runId: "run-1",
				nodeId: "execute",
				attempt: 1,
				executionId: "exec-1",
				launchOrdinal: 1,
				cancellationOwner: "tripwire-a",
				reason: "unlaunched_admission_ttl",
				now: "2026-07-15T02:00:00.000Z",
			}),
		).toEqual({ ok: false, reason: "launch_committed" });
		committedStore.close();
	});

	it("rolls back a fenced never-launched admission without rewriting immutable evidence", async () => {
		const store = await StateStore.create(":memory:");
		const { markerPath, outputCredential } = createAdmittedEngineRun(store, {
			output: true,
		});
		const binding = store.getWorkflowExecutionBinding("exec-1");
		const runtime = store.getWorkflowExecutionRuntime("exec-1");
		const fenced = store.beginUnlaunchedWorkflowCancellation({
			runId: "run-1",
			nodeId: "execute",
			attempt: 1,
			executionId: "exec-1",
			launchOrdinal: 1,
			cancellationOwner: "tripwire-a",
			reason: "unlaunched_admission_ttl",
			now: "2026-07-15T02:00:00.000Z",
		});
		if (!fenced.ok) throw new Error(`fence failed: ${fenced.reason}`);
		const first = store.rollbackUnlaunchedWorkflowAdmission({
			runId: "run-1",
			nodeId: "execute",
			attempt: 1,
			executionId: "exec-1",
			launchOrdinal: 1,
			fenceGeneration: fenced.generation,
			markerPath,
			now: "2026-07-15T02:01:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		expect(first).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowExecutionBinding("exec-1")).toEqual(binding);
		expect(store.getWorkflowExecutionRuntime("exec-1")).toEqual(runtime);
		expect(store.getWorkflowRunNode("run-1", "execute", 1)).toMatchObject({
			state: "admitted",
			execution_id: "exec-1",
		});
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.listWorkflowSideEffects("run-1")[0]).toMatchObject({
			state: "abandoned",
			reason: "unlaunched_admission_rolled_back",
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "unlaunched_admission_rolled_back"),
		).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		if (!outputCredential) throw new Error("output credential missing");
		expect(
			store.submitWorkflowNodeOutput({
				token: outputCredential,
				clientRequestId: "rolled-back-output",
				payload: '{"late":true}',
				now: "2026-07-15T02:02:00.000Z",
			}),
		).toEqual({ ok: false, reason: "credential_revoked" });
		expect(
			store.rollbackUnlaunchedWorkflowAdmission({
				runId: "run-1",
				nodeId: "execute",
				attempt: 1,
				executionId: "exec-1",
				launchOrdinal: 1,
				fenceGeneration: fenced.generation,
				markerPath,
				now: "2026-07-15T03:01:00.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		store.close();
	});

	it("refuses rollback when any positive never-launched evidence surface is missing", async () => {
		const cases: Array<{
			name: string;
			arrange: (store: StateStore, markerPath: string) => void;
			reason: string;
		}> = [
			{
				name: "lifecycle claim",
				arrange: (store) =>
					store.insertLaunchClaim({
						executionId: "exec-1",
						rootUuid: "FLY-X",
						project: "flywheel",
						role: "main",
					}),
				reason: "lifecycle_claim_present",
			},
			{
				name: "session row",
				arrange: (store) =>
					store.upsertSession({
						execution_id: "exec-1",
						issue_id: "FLY-X",
						project_name: "flywheel",
						status: "running",
					}),
				reason: "session_present",
			},
			{
				name: "launch marker",
				arrange: (_store, markerPath) => writeFileSync(markerPath, "late"),
				reason: "launch_marker_present",
			},
		];

		for (const testCase of cases) {
			const store = await StateStore.create(":memory:");
			const { markerPath } = createAdmittedEngineRun(store);
			if (testCase.name !== "launch marker")
				testCase.arrange(store, markerPath);
			const fenced = store.beginUnlaunchedWorkflowCancellation({
				runId: "run-1",
				nodeId: "execute",
				attempt: 1,
				executionId: "exec-1",
				launchOrdinal: 1,
				cancellationOwner: "tripwire-a",
				reason: "unlaunched_admission_ttl",
				now: "2026-07-15T02:00:00.000Z",
			});
			if (testCase.name === "launch marker") {
				expect(fenced).toMatchObject({ ok: true });
				testCase.arrange(store, markerPath);
				expect(
					store.rollbackUnlaunchedWorkflowAdmission({
						runId: "run-1",
						nodeId: "execute",
						attempt: 1,
						executionId: "exec-1",
						launchOrdinal: 1,
						fenceGeneration: fenced.ok ? fenced.generation : -1,
						markerPath,
						now: "2026-07-15T02:01:00.000Z",
						alertIdentity: {
							leadId: "flywheel-eng-lead",
							projectName: "flywheel",
							leadResolution: "resolved",
						},
					}),
				).toEqual({ ok: false, reason: testCase.reason });
			} else {
				expect(fenced).toEqual({ ok: false, reason: testCase.reason });
			}
			expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
				"intent_recorded",
			);
			store.close();
		}
	});

	it("repairs marker-after/DB-before crashes before lease takeover", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "execute",
				executionId: "exec-1",
				attempt: 1,
				expiresAt: "2026-07-15T00:05:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				now: "2026-07-15T00:00:00.000Z",
				env: enabled,
			}),
		).toMatchObject({ ok: true });
		const markerRoot = mkdtempSync(join(tmpdir(), "flywheel-launch-owner-"));
		cleanups.push(markerRoot);
		const markerPath = join(markerRoot, "exec-1.json");
		const acquired = store.recoverOrAcquireWorkflowLaunch({
			executionId: "exec-1",
			ownerId: "dispatcher-a",
			now: "2026-07-15T00:00:00.000Z",
			leaseExpiresAt: "2026-07-15T00:10:00.000Z",
			markerPath,
		});
		expect(acquired).toMatchObject({
			status: "acquired",
			generation: 1,
			deliveryAttempt: 0,
		});
		expect(
			store.recoverOrAcquireWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-b",
				now: "2026-07-15T00:01:00.000Z",
				leaseExpiresAt: "2026-07-15T00:11:00.000Z",
				markerPath,
			}),
		).toEqual({ status: "busy", generation: 1 });
		if (acquired.status !== "acquired") throw new Error("owner not acquired");
		expect(() =>
			store.fencedCommitWorkflowLaunch({
				executionId: "exec-1",
				ownerId: "dispatcher-a",
				generation: acquired.generation,
				deliveryAttempt: acquired.deliveryAttempt,
				markerPath,
				now: "2026-07-15T00:02:00.000Z",
				afterMarkerWrite: () => {
					throw new Error("simulated crash after marker");
				},
			}),
		).toThrow(/simulated crash/);
		expect(existsSync(markerPath)).toBe(true);
		expect(
			store.getWorkflowLaunchOwner("exec-1")?.committed_generation,
		).toBeNull();

		const recovered = store.recoverOrAcquireWorkflowLaunch({
			executionId: "exec-1",
			ownerId: "dispatcher-b",
			now: "2026-07-15T00:11:00.000Z",
			leaseExpiresAt: "2026-07-15T00:21:00.000Z",
			markerPath,
		});
		expect(recovered).toMatchObject({ status: "committed", generation: 1 });
		expect(store.getWorkflowLaunchOwner("exec-1")).toMatchObject({
			owner_generation: 1,
			committed_generation: 1,
			delivery_state: "delivered",
		});
		const repairA = store.claimWorkflowLaunchDeliveryRepair({
			executionId: "exec-1",
			repairOwner: "repair-a",
			now: "2026-07-15T00:12:00.000Z",
			leaseExpiresAt: "2026-07-15T00:20:00.000Z",
		});
		expect(repairA).toMatchObject({ status: "claimed", attempt: 1 });
		expect(
			store.claimWorkflowLaunchDeliveryRepair({
				executionId: "exec-1",
				repairOwner: "repair-b",
				now: "2026-07-15T00:13:00.000Z",
				leaseExpiresAt: "2026-07-15T00:21:00.000Z",
			}),
		).toEqual({ status: "busy", attempt: 1 });
		if (repairA.status !== "claimed") throw new Error("repair not claimed");
		expect(
			store.commitWorkflowLaunchDeliveryRepair({
				executionId: "exec-1",
				repairOwner: "repair-a",
				generation: repairA.generation,
				attempt: repairA.attempt,
				markerPath,
				now: "2026-07-15T00:14:00.000Z",
			}),
		).toMatchObject({ ok: true, token: repairA.token });
		const repairB = store.claimWorkflowLaunchDeliveryRepair({
			executionId: "exec-1",
			repairOwner: "repair-b",
			now: "2026-07-15T00:15:00.000Z",
			leaseExpiresAt: "2026-07-15T00:25:00.000Z",
		});
		expect(repairB).toMatchObject({ status: "claimed", attempt: 2 });
		expect(
			store.commitWorkflowLaunchDeliveryRepair({
				executionId: "exec-1",
				repairOwner: "repair-a",
				generation: repairA.generation,
				attempt: repairA.attempt,
				markerPath,
				now: "2026-07-15T00:16:00.000Z",
			}),
		).toEqual({ ok: false, reason: "stale_delivery_owner" });
		store.close();
	});

	it("admits only the start node under the full flag combination and pins immutable runtime", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "execute",
				executionId: "exec-1",
				attempt: 1,
				expiresAt: "2026-07-15T00:05:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				now: "2026-07-15T00:00:00.000Z",
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "template_dispatch_disabled" });
		expect(store.getWorkflowExecutionBinding("exec-1")).toBeUndefined();

		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "execute",
			executionId: "exec-1",
			attempt: 1,
			expiresAt: "2026-07-15T00:05:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:00:00.000Z",
			env: enabled,
		});
		expect(admitted).toMatchObject({ ok: true, outputCredential: undefined });
		expect(store.getWorkflowExecutionBinding("exec-1")).toMatchObject({
			run_id: "run-1",
			node_id: "execute",
			attempt: 1,
		});
		expect(store.getWorkflowExecutionRuntime("exec-1")).toMatchObject({
			vendor: "codex",
			model: "gpt-5.6-sol",
			resolved_family: "codex",
		});
		expect(
			store.getGeneralizedWorkflowNodeForExecution("exec-1"),
		).toMatchObject({
			snapshotDigest: expect.any(String),
			node: { id: "execute", type: "generic" },
		});
		expect(store.listActiveGeneralizedWorkflowExecutions("FLY-X")).toEqual([
			{
				executionId: "exec-1",
				runId: "run-1",
				nodeId: "execute",
				attempt: 1,
			},
		]);
		expect(store.listGeneralizedExecutionsReverseTopology("run-1")).toEqual([
			{ executionId: "exec-1", nodeId: "execute", attempt: 1 },
		]);
		expect(store.holdStrandedGeneralizedExecutions()).toEqual(["exec-1"]);
		expect(store.holdStrandedGeneralizedExecutions()).toEqual(["exec-1"]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "generalized_stranded_hold"),
		).toHaveLength(1);
		expect(store.getWorkflowRun("run-1")?.claims_read_enrolled).toBe(1);
		store.close();
	});

	it("issues an output credential, enforces output-before-completion, and commits terminal receipt once", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store, { output: true });
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "execute",
			executionId: "exec-1",
			attempt: 1,
			expiresAt: "2026-07-15T00:05:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:00:00.000Z",
			env: enabled,
		});
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) throw new Error("admission failed");
		expect(admitted.outputCredential).toBeTypeOf("string");

		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-1",
				completionSubmission: { decision: { route: "no_code" } },
				now: "2026-07-15T00:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "missing_output", retryable: true });

		const submitted = store.submitWorkflowNodeOutput({
			token: admitted.outputCredential!,
			clientRequestId: "output-1",
			payload: '{"ok":true}',
			now: "2026-07-15T00:01:30.000Z",
		});
		expect(submitted).toMatchObject({ ok: true, idempotentReplay: false });
		expect(
			store.submitWorkflowNodeOutput({
				token: admitted.outputCredential!,
				clientRequestId: "output-1",
				payload: '{"ok":true}',
				now: "2026-07-15T00:01:31.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });

		const completed = store.commitEnrolledCompletion({
			executionId: "exec-1",
			route: "no_code",
			sourceEventId: "complete-1",
			completionSubmission: { decision: { route: "no_code" } },
			now: "2026-07-15T00:02:00.000Z",
		});
		expect(completed).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowRunNode("run-1", "execute", 1)?.state).toBe("done");
		expect(store.getSession("exec-1")).toMatchObject({
			status: "completed",
			workflow_node_id: "execute",
		});
		expect(
			store.observeEnrolledTeardown({ executionId: "exec-1" }),
		).toMatchObject({ enrolled: true, receipt: true, held: false });
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-2",
				completionSubmission: { decision: { route: "no_code" } },
				now: "2026-07-15T00:02:01.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
		store.close();
	});

	it("FLY-1434: atomically binds current generalized PR evidence and projects session display fields", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "execute",
				executionId: "exec-1",
				attempt: 1,
				expiresAt: "2026-07-15T00:05:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				now: "2026-07-15T00:00:00.000Z",
				env: enabled,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-X",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "execute",
		});
		const headSha = "a".repeat(40);
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-with-pr-1",
				completionSubmission: { decision: { route: "no_code" } },
				subjectDigest: headSha,
				prBinding: {
					prNumber: 1434,
					headSha,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "geoforge3d/flywheel",
					targetRepoPath: "/tmp/flywheel-FLY-1434",
					worktreeBindingGeneration: "generation-1",
				},
				now: "2026-07-15T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-1", headSha),
		).toEqual({
			run_id: "run-1",
			node_id: "execute",
			attempt: 1,
			pr_number: 1434,
			head_sha: headSha,
			target_repo_identity: "__main__",
			probe_repo_slug: "geoforge3d/flywheel",
			target_repo_path: "/tmp/flywheel-FLY-1434",
			worktree_binding_generation: "generation-1",
			receipt_id: "complete-with-pr-1",
			bound_at: "2026-07-15T00:02:00.000Z",
		});
		expect(store.getSession("exec-1")).toMatchObject({
			pr_number: 1434,
			pr_head_sha: headSha,
		});
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "execute",
			attempt: 2,
			state: "pending",
		});
		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-1", headSha),
		).toBeUndefined();
		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-1", "b".repeat(40)),
		).toBeUndefined();
		store.close();
	});

	it("bumps lifecycle revision only when generalized completion changes status", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "execute",
				executionId: "exec-1",
				attempt: 1,
				expiresAt: "2026-07-15T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				now: "2026-07-15T00:00:00.000Z",
				env: enabled,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-X",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "execute",
		});
		expect(store.getLifecycleRevision("exec-1")).toBe(0);
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-1",
				completionSubmission: { decision: { route: "no_code" } },
				now: "2026-07-15T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(store.getLifecycleRevision("exec-1")).toBe(1);
		expect(
			store.observeEnrolledTeardown({ executionId: "exec-1" }),
		).toMatchObject({ receipt: true });
		expect(store.getLifecycleRevision("exec-1")).toBe(1);
		store.close();
	});

	it("stamps terminal_at when generalized completion enters a terminal status (FLY-1328)", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "execute",
				executionId: "exec-1",
				attempt: 1,
				expiresAt: "2026-07-15T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				now: "2026-07-15T00:00:00.000Z",
				env: enabled,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-X",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "execute",
		});
		// Pre-condition: a live session carries no terminal stamp.
		expect(store.getSession("exec-1")?.terminal_at ?? null).toBeNull();
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-1",
				completionSubmission: { decision: { route: "no_code" } },
				now: "2026-07-15T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true });
		// FLY-1328 HIGH: completing through the generalized path (commitEnrolledCompletion
		// → projectGeneralizedCompletionTx) must leave a canonical terminal_at. Without it
		// the A2 ask sweep's FLY-1257 chronology guard fails CLOSED on the missing stamp
		// and can retire an ask this execution was still owed a human answer for.
		const completedSession = store.getSession("exec-1");
		expect(completedSession?.status).toBe("completed");
		expect(completedSession?.terminal_at).toBeTruthy();
		store.close();
	});

	it("settles a changed resubmission from a superseded attempt with one frozen alert receipt", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "execute",
				executionId: "exec-1",
				attempt: 1,
				activationId: "activation-1",
				expiresAt: "2026-07-15T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				now: "2026-07-15T00:00:00.000Z",
				env: enabled,
			}),
		).toMatchObject({ ok: true });
		expect(
			store.recordWorkflowActivationTurn({
				activationId: "activation-1",
				executionId: "exec-1",
				issueId: "FLY-X",
				epoch: 1,
				sourceEventId: "turn:activation-1:epoch-1",
				grantedAt: "2026-07-15T00:00:30.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		const originalSubmission = {
			decision: { route: "no_code" },
			evidence: { commitMessages: ["initial completion"] },
		};
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-original",
				completionSubmission: originalSubmission,
				now: "2026-07-15T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "execute",
			attempt: 2,
			state: "pending",
			executionId: "exec-2",
		});

		const changedSubmission = {
			decision: { route: "no_code" },
			evidence: { commitMessages: ["fix after QA feedback"] },
		};
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-stale-missing-context",
				completionSubmission: changedSubmission,
				now: "2026-07-15T00:02:30.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toEqual({ ok: false, reason: "workflow_activation_required" });
		const activation1 = {
			activationId: "activation-1",
			runId: "run-1",
			nodeId: "execute",
			attempt: 1,
			turnEpoch: 1,
		};
		const first = store.commitEnrolledCompletion({
			executionId: "exec-1",
			route: "no_code",
			sourceEventId: "complete-stale-1",
			completionSubmission: changedSubmission,
			workflowActivation: activation1,
			now: "2026-07-15T00:03:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		expect(first).toMatchObject({
			ok: false,
			reason: "stale_resubmission",
			idempotentReplay: false,
		});
		const staleEvents = store
			.listWorkflowRunEvents("run-1")
			.filter((event) => event.kind === "stale_completion_resubmission");
		expect(staleEvents).toHaveLength(1);
		expect(staleEvents[0]).toMatchObject({
			execution_id: "exec-1",
			payload: {
				currentAttempt: 2,
				currentState: "pending",
				at: "2026-07-15T00:03:00.000Z",
			},
		});
		const alerts = store.listWorkflowAlertOutbox();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.payload.metadata.workflowEngine).toMatchObject({
			executionId: "exec-1",
			disposition: "stale_resubmission",
		});

		// Classification-time evidence is immutable. A replay after the successor
		// advances must reuse the first event/alert payload rather than recompute it.
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "execute",
			attempt: 2,
			state: "running",
			executionId: "exec-2",
		});
		const replay = store.commitEnrolledCompletion({
			executionId: "exec-1",
			route: "no_code",
			sourceEventId: "complete-stale-2",
			completionSubmission: changedSubmission,
			workflowActivation: activation1,
			now: "2026-07-15T00:04:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		expect(replay).toMatchObject({
			ok: false,
			reason: "stale_resubmission",
			idempotentReplay: true,
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "stale_completion_resubmission"),
		).toEqual(staleEvents);
		expect(store.listWorkflowAlertOutbox()).toEqual(alerts);
		expect(
			store.getWorkflowNodeCompletion("run-1", "execute", 1),
		).toMatchObject({
			execution_id: "exec-1",
			completion_submission_digest: expect.any(String),
		});
		store.close();
	});

	it("completes two attempts on one actor only with exact activation epochs", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		const firstAdmission = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "execute",
			executionId: "exec-1",
			attempt: 1,
			activationId: "activation-1",
			expiresAt: "2026-07-15T00:20:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:00:00.000Z",
			env: enabled,
		});
		expect(firstAdmission).toMatchObject({ ok: true });
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-1",
				completionSubmission: { decision: { route: "no_code" }, round: 1 },
				now: "2026-07-15T00:01:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });

		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "execute",
			attempt: 2,
			state: "pending",
			executionId: "exec-1",
		});
		const secondAdmission = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "execute",
			executionId: "exec-1",
			attempt: 2,
			activationId: "activation-2",
			activationMode: "wake",
			reworkRequestId: "request-1",
			expiresAt: "2026-07-15T00:20:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:02:00.000Z",
			env: enabled,
		});
		expect(secondAdmission).toMatchObject({ ok: true });
		expect(
			store.recordWorkflowActivationTurn({
				activationId: "activation-2",
				executionId: "exec-1",
				issueId: "FLY-X",
				epoch: 2,
				sourceEventId: "turn:activation-2:epoch-2",
				grantedAt: "2026-07-15T00:02:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });

		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-2-missing-context",
				completionSubmission: { decision: { route: "no_code" }, round: 2 },
				now: "2026-07-15T00:03:00.000Z",
			}),
		).toEqual({ ok: false, reason: "workflow_activation_required" });
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-2-wrong-epoch",
				completionSubmission: { decision: { route: "no_code" }, round: 2 },
				workflowActivation: {
					activationId: "activation-2",
					runId: "run-1",
					nodeId: "execute",
					attempt: 2,
					turnEpoch: 1,
				},
				now: "2026-07-15T00:03:00.000Z",
			}),
		).toEqual({ ok: false, reason: "activation_turn_conflict" });

		const activation2 = {
			activationId: "activation-2",
			runId: "run-1",
			nodeId: "execute",
			attempt: 2,
			turnEpoch: 2,
		};
		const secondSubmission = {
			decision: { route: "no_code" },
			round: 2,
		};
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-2",
				completionSubmission: secondSubmission,
				workflowActivation: activation2,
				now: "2026-07-15T00:03:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(
			store.getWorkflowNodeCompletion("run-1", "execute", 2),
		).toMatchObject({
			activation_id: "activation-2",
			execution_id: "exec-1",
		});
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-2-replay",
				completionSubmission: secondSubmission,
				workflowActivation: activation2,
				now: "2026-07-15T00:04:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "no_code",
				sourceEventId: "complete-2-conflict",
				completionSubmission: { ...secondSubmission, changed: true },
				workflowActivation: activation2,
				now: "2026-07-15T00:05:00.000Z",
			}),
		).toEqual({ ok: false, reason: "completion_conflict" });
		store.close();
	});

	it.each([
		["execution", "other-exec"],
		["route", "auto_approve"],
	] as const)(
		"keeps a true %s receipt conflict rejected after a newer attempt exists",
		async (column, conflictingValue) => {
			const store = await StateStore.create(":memory:");
			createRun(store);
			expect(
				store.admitGeneralizedWorkflowExecution({
					runId: "run-1",
					nodeId: "execute",
					executionId: "exec-1",
					attempt: 1,
					expiresAt: "2026-07-15T00:20:00.000Z",
					absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
					now: "2026-07-15T00:00:00.000Z",
					env: enabled,
				}),
			).toMatchObject({ ok: true });
			expect(
				store.commitEnrolledCompletion({
					executionId: "exec-1",
					route: "no_code",
					sourceEventId: "complete-original",
					completionSubmission: { decision: { route: "no_code" } },
					now: "2026-07-15T00:02:00.000Z",
				}),
			).toMatchObject({ ok: true });
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "execute",
				attempt: 2,
				state: "pending",
				executionId: "exec-2",
			});
			const raw = store as unknown as {
				db: { run: (sql: string, params: unknown[]) => void };
			};
			raw.db.run("DROP TRIGGER workflow_node_completion_no_update", []);
			if (column === "execution") raw.db.run("PRAGMA foreign_keys = OFF", []);
			raw.db.run(
				`UPDATE workflow_node_completion SET ${column === "execution" ? "execution_id" : "route"} = ? WHERE run_id = 'run-1' AND node_id = 'execute' AND attempt = 1`,
				[conflictingValue],
			);
			if (column === "execution") raw.db.run("PRAGMA foreign_keys = ON", []);
			raw.db.run(
				"CREATE TRIGGER workflow_node_completion_no_update BEFORE UPDATE ON workflow_node_completion BEGIN SELECT RAISE(ABORT, 'workflow_node_completion is append-only'); END",
				[],
			);

			expect(
				store.commitEnrolledCompletion({
					executionId: "exec-1",
					route: "no_code",
					sourceEventId: "complete-changed",
					completionSubmission: {
						decision: { route: "no_code" },
						evidence: { changed: true },
					},
					now: "2026-07-15T00:03:00.000Z",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
			).toEqual({ ok: false, reason: "completion_conflict" });
			expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
			store.close();
		},
	);

	it("holds teardown without an explicit receipt and rejects non-start/review execution", async () => {
		const store = await StateStore.create(":memory:");
		createRun(store);
		expect(store.observeEnrolledTeardown({ executionId: "legacy" })).toEqual({
			enrolled: false,
			receipt: false,
			held: false,
		});
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "founder_gate",
			executionId: "exec-gate",
			attempt: 1,
			expiresAt: "2026-07-15T00:05:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			now: "2026-07-15T00:00:00.000Z",
			env: enabled,
		});
		expect(admitted).toMatchObject({ ok: false, reason: "not_start_node" });
		store.close();
	});
});
