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
