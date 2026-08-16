import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import type { WorkflowShipReadyArm } from "../../workflow-ship-ready.js";
import type { IStartDispatcher } from "../retry-dispatcher.js";
import { WorkflowEngineDispatcher } from "../workflow-engine-dispatcher.js";
import { createWorkflowRunnerShipMergedClassifier } from "../workflow-ship-ready-arm.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const NOW = "2026-08-03T12:00:00.000Z";
const engineFlags = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GATE_CARRIER: "1",
};

async function engineRun(dbPath = ":memory:"): Promise<StateStore> {
	const store = await StateStore.create(dbPath);
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1624",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: engineFlags,
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "selection-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-08-03T10:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	return store;
}

async function openRunnerShipGate(store: StateStore) {
	store.commitWorkflowTransitionTx({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		executionId: "design-1",
		outcome: "design_done",
		successorExecutionId: "implement-1",
		now: "2026-08-03T10:10:00.000Z",
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "implement",
			executionId: "implement-1",
			attempt: 1,
			expiresAt: "2026-08-03T13:00:00.000Z",
			absoluteDeadlineAt: "2026-08-04T10:00:00.000Z",
			now: "2026-08-03T10:11:00.000Z",
			env: engineFlags,
		}),
	).toMatchObject({ ok: true });
	expect(
		store.commitEnrolledCompletion({
			executionId: "implement-1",
			route: "needs_review",
			sourceEventId: "implement-complete",
			completionSubmission: { decision: { route: "needs_review" } },
			subjectDigest: HEAD_A,
			now: "2026-08-03T10:20:00.000Z",
		}),
	).toMatchObject({ ok: true });
	const qaIntent = store
		.listWorkflowSideEffects("run-1")
		.find((effect) => effect.node_id === "qa")!;
	const qaAdmission = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "qa",
		executionId: qaIntent.execution_id,
		attempt: 1,
		expiresAt: "2026-08-03T13:00:00.000Z",
		absoluteDeadlineAt: "2026-08-04T10:00:00.000Z",
		now: "2026-08-03T10:21:00.000Z",
		env: engineFlags,
	});
	if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
		throw new Error("QA admission failed");
	}
	expect(
		store.submitWorkflowDecisionByCredential({
			credential: qaAdmission.submissionCredential,
			clientRequestId: "qa-pass",
			predicate: "qa_passed",
			subjectDigest: HEAD_A,
			issuerVendor: "claude",
			issuerModel: "claude-opus-4-8",
			subjectProducerExecutionId: "implement-1",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2026-08-03T13:00:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-08-03T10:25:00.000Z",
		}),
	).toMatchObject({ ok: true });
	return store.getCurrentWorkflowGateHolder("run-1", "founder_gate")!;
}

function bindAuthority(
	store: StateStore,
	holder: { question_id: string },
): void {
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1624",
		project_name: "flywheel",
		status: "awaiting_review",
		pr_number: 1624,
	});
	store.setReviewBinding("implement-1", {
		questionId: holder.question_id,
		prHeadSha: HEAD_A,
		shipTarget: {
			runId: "run-1",
			targetRepoPath: "/tmp/flywheel",
			targetRepoIdentity: "__main__",
			probeRepoSlug: "xrliAnnie/flywheel",
			worktreeBindingGeneration: "generation-1",
		},
	});
}

function approve(store: StateStore, holder: { question_id: string }): void {
	for (const [stage, cardMessageId] of [
		["question_written"],
		["session_bound"],
		["card_posted", "card-1"],
		["card_bound", "card-1"],
		["completed", "card-1"],
	] as const) {
		store.advanceWorkflowGateHolderMaterialization({
			questionId: holder.question_id,
			stage,
			...(cardMessageId ? { cardMessageId } : {}),
			now: "2026-08-03T10:30:00.000Z",
		});
	}
	const payload = {
		schema_version: 1,
		run_id: "run-1",
		issue_id: "FLY-1624",
		question_id: holder.question_id,
		response: { approved: true },
		actor: "founder",
		approved_head: HEAD_A,
		classification: "founder_direct_signal",
		authority_id: holder.question_id,
	};
	store.applyWorkflowSourceEvent({
		project: "flywheel",
		sourceEventId: `founder-approves-${holder.question_id}`,
		kind: "founder_approval",
		schemaVersion: 1,
		payloadJson: JSON.stringify(payload),
		payloadDigest: canonicalSubmissionDigest(payload),
	});
}

function arm(input: {
	checkPrMerge: Parameters<
		typeof createWorkflowRunnerShipMergedClassifier
	>[0]["checkPrMerge"];
	enrichPrHead: Parameters<
		typeof createWorkflowRunnerShipMergedClassifier
	>[0]["enrichPrHead"];
	now?: () => number;
}): WorkflowShipReadyArm {
	return {
		queueLeadNotice: vi.fn(),
		postFounderCard: vi.fn(),
		classifyShipHandled: vi.fn(async () => new Map()),
		classifyRunnerShipMerged: createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: input.checkPrMerge,
			enrichPrHead: input.enrichPrHead,
			now: input.now ?? (() => Date.parse(NOW)),
		}),
	};
}

function dispatcher(store: StateStore, shipReadyArm: WorkflowShipReadyArm) {
	return new WorkflowEngineDispatcher({
		store,
		startDispatcher: {
			start: vi.fn(),
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as unknown as IStartDispatcher,
		stateRoot: mkdtempSync(join(tmpdir(), "fly1624-dispatcher-")),
		env: {
			...engineFlags,
			FLYWHEEL_SHIP_READY_NOTIFY: "0",
		},
		now: () => new Date(NOW),
		resolveRunAlertIdentity: (projectName) => ({
			leadId: "flywheel-eng-lead",
			projectName,
			leadResolution: "resolved",
		}),
		shipReadyArm,
	});
}

describe("runner-ship merge probe production composition", () => {
	it("memoizes a mismatched merged head and stops probing on later passes", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			headRefOid: HEAD_B,
			rawHeadRefOid: HEAD_B,
		}));
		const runner = dispatcher(
			store,
			arm({ checkPrMerge, enrichPrHead: vi.fn() }),
		);

		await runner.reconcile();
		await runner.reconcile();

		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.listRunnerShipHoldersForMergeProbe()).toEqual([]);
		expect(
			store
				.listWorkflowAlertOutbox()
				.map((row) => row.payload.metadata.workflowEngine.disposition),
		).toEqual(["runner_ship_merged_head_mismatch"]);
		store.close();
	});

	it("re-arms a rogue merged head after approval without another GraphQL probe", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			headRefOid: HEAD_A,
			rawHeadRefOid: HEAD_A,
		}));
		const enrichPrHead = vi.fn(async () => ({
			ok: true as const,
			headSha: HEAD_A,
			mergedAt: NOW,
		}));
		const runner = dispatcher(store, arm({ checkPrMerge, enrichPrHead }));

		await runner.reconcile();
		await runner.reconcile();
		expect(store.listRunnerShipHoldersForMergeProbe()).toEqual([]);
		approve(store, holder);
		await runner.reconcile();

		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(enrichPrHead).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
		expect(
			store
				.listWorkflowAlertOutbox()
				.map((row) => row.payload.metadata.workflowEngine.disposition),
		).toEqual(["runner_ship_merged_before_approval"]);
		store.close();
	});

	it("persists current merge evidence before completing an approved run", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		approve(store, holder);
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			headRefOid: HEAD_A,
			rawHeadRefOid: HEAD_A,
		}));
		const listCandidates = vi.spyOn(
			store,
			"listRunnerShipHoldersForMergeProbe",
		);
		await dispatcher(
			store,
			arm({ checkPrMerge, enrichPrHead: vi.fn() }),
		).reconcile();

		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(listCandidates).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
		expect(store.listWorkflowRunEvents("run-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "runner_ship_merged_observed" }),
				expect.objectContaining({ kind: "run_completed" }),
			]),
		);
		store.close();
	});

	it("records and backs off a thrown completion transaction instead of retrying every tick", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		approve(store, holder);
		const candidate = store.listRunnerShipHoldersForMergeProbe(NOW)[0]!;
		if (candidate.authority.status !== "resolved") {
			throw new Error("authority");
		}
		expect(
			store.recordRunnerShipMergedObserved({
				questionId: holder.question_id,
				expectedHolderState: "approved",
				expectedHolderHead: HEAD_A,
				expectedAuthority: candidate.authority,
				mergedHead: HEAD_A,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-08-03T11:00:00.000Z",
			}),
		).toEqual({ status: "persisted" });
		const original = store.completeWorkflowGateRunAfterShip.bind(store);
		const complete = vi
			.spyOn(store, "completeWorkflowGateRunAfterShip")
			.mockImplementationOnce(() => {
				throw new Error("synthetic completion transaction crash");
			})
			.mockImplementation(original);
		const recordException = vi.spyOn(
			store,
			"recordRunnerShipCompletionException",
		);
		const enrichPrHead = vi.fn(async () => ({
			ok: true as const,
			headSha: HEAD_A,
			mergedAt: NOW,
		}));
		const runner = dispatcher(
			store,
			arm({ checkPrMerge: vi.fn(), enrichPrHead }),
		);

		await runner.reconcile();
		await runner.reconcile();

		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(complete).toHaveBeenCalledOnce();
		expect(recordException).toHaveBeenCalledOnce();
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "runner_ship_completion_attempt"),
		).toHaveLength(1);
		expect(enrichPrHead).toHaveBeenCalledOnce();
		store.close();
	});

	it("retries a failed base observation write without another GraphQL probe", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		approve(store, holder);
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			headRefOid: HEAD_A,
			rawHeadRefOid: HEAD_A,
		}));
		const original = store.recordRunnerShipMergedObserved.bind(store);
		vi.spyOn(store, "recordRunnerShipMergedObserved")
			.mockImplementationOnce(() => {
				throw new Error("simulated base write crash");
			})
			.mockImplementation(original);
		const runner = dispatcher(
			store,
			arm({ checkPrMerge, enrichPrHead: vi.fn() }),
		);
		await runner.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		await runner.reconcile();
		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
		store.close();
	});

	it("retries a failed null-to-head upgrade with zero additional REST or GraphQL", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		const candidate = store.listRunnerShipHoldersForMergeProbe()[0]!;
		if (candidate.authority.status !== "resolved") throw new Error("authority");
		store.recordRunnerShipMergedObserved({
			questionId: holder.question_id,
			expectedHolderState: "materializing",
			expectedHolderHead: HEAD_A,
			expectedAuthority: candidate.authority,
			mergedHead: null,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-08-03T11:00:00.000Z",
		});
		approve(store, holder);
		const enrichPrHead = vi.fn(async () => ({
			ok: true as const,
			headSha: HEAD_A,
			mergedAt: NOW,
		}));
		const original = store.recordRunnerShipMergedObserved.bind(store);
		vi.spyOn(store, "recordRunnerShipMergedObserved")
			.mockImplementationOnce(() => {
				throw new Error("simulated upgrade write crash");
			})
			.mockImplementation(original);
		const runner = dispatcher(
			store,
			arm({ checkPrMerge: vi.fn(), enrichPrHead }),
		);
		await runner.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		await runner.reconcile();
		expect(enrichPrHead).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
		store.close();
	});

	it("hydrates a persisted observation after restart with zero GraphQL and one REST revalidation", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1624-restart-"));
		const dbPath = join(root, "teamlead.db");
		try {
			let store = await engineRun(dbPath);
			const holder = await openRunnerShipGate(store);
			bindAuthority(store, holder);
			approve(store, holder);
			const candidate = store.listRunnerShipHoldersForMergeProbe()[0]!;
			if (candidate.authority.status !== "resolved")
				throw new Error("authority");
			store.recordRunnerShipMergedObserved({
				questionId: holder.question_id,
				expectedHolderState: "approved",
				expectedHolderHead: HEAD_A,
				expectedAuthority: candidate.authority,
				mergedHead: HEAD_A,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-08-03T11:00:00.000Z",
			});
			store.close();

			store = await StateStore.create(dbPath);
			const checkPrMerge = vi.fn();
			const enrichPrHead = vi.fn(async () => ({
				ok: true as const,
				headSha: HEAD_A,
				mergedAt: NOW,
			}));
			await dispatcher(store, arm({ checkPrMerge, enrichPrHead })).reconcile();
			expect(checkPrMerge).not.toHaveBeenCalled();
			expect(enrichPrHead).toHaveBeenCalledOnce();
			expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
			store.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("quarantines a different REST head after restart and takes no irreversible action", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1624-conflict-restart-"));
		const dbPath = join(root, "teamlead.db");
		try {
			let store = await engineRun(dbPath);
			const holder = await openRunnerShipGate(store);
			bindAuthority(store, holder);
			approve(store, holder);
			const candidate = store.listRunnerShipHoldersForMergeProbe()[0]!;
			if (candidate.authority.status !== "resolved") {
				throw new Error("authority");
			}
			store.recordRunnerShipMergedObserved({
				questionId: holder.question_id,
				expectedHolderState: "approved",
				expectedHolderHead: HEAD_A,
				expectedAuthority: candidate.authority,
				mergedHead: HEAD_A,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-08-03T11:00:00.000Z",
			});
			store.close();

			store = await StateStore.create(dbPath);
			const checkPrMerge = vi.fn();
			await dispatcher(
				store,
				arm({
					checkPrMerge,
					enrichPrHead: vi.fn(async () => ({
						ok: true as const,
						headSha: HEAD_B,
						mergedAt: NOW,
					})),
				}),
			).reconcile();

			expect(checkPrMerge).not.toHaveBeenCalled();
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(store.listRunnerShipHoldersForMergeProbe()).toHaveLength(0);
			expect(
				store
					.listWorkflowAlertOutbox()
					.map((row) => row.payload.metadata.workflowEngine.disposition),
			).toContain("observation_corrupt");
			store.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pins but never completes a legacy approved merge", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1624",
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: 1624,
		});
		// Reproduce an already-persisted pre-FLY-1638 approved holder. The current
		// founder-decision API correctly refuses to create this unbound state, but
		// an upgraded database can still contain it and must remain fail-closed.
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			`UPDATE workflow_gate_holder
			    SET state = 'approved', materialization_stage = 'completed',
			        card_message_id = 'legacy-card'
			  WHERE question_id = ?`,
			[holder.question_id],
		);
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			headRefOid: HEAD_A,
			rawHeadRefOid: HEAD_A,
		}));
		const sharedArm = arm({ checkPrMerge, enrichPrHead: vi.fn() });
		const runner = dispatcher(store, sharedArm);
		await runner.reconcile();
		await runner.reconcile();

		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(
			store
				.listWorkflowAlertOutbox()
				.map((row) => row.payload.metadata.workflowEngine.disposition),
		).toContain("runner_ship_legacy_merge_anomaly");
		store.close();
	});

	it("alerts once after five hydration revalidation failures and completes after recovery", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		approve(store, holder);
		const candidate = store.listRunnerShipHoldersForMergeProbe()[0]!;
		if (candidate.authority.status !== "resolved") throw new Error("authority");
		store.recordRunnerShipMergedObserved({
			questionId: holder.question_id,
			expectedHolderState: "approved",
			expectedHolderHead: HEAD_A,
			expectedAuthority: candidate.authority,
			mergedHead: HEAD_A,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-08-03T11:00:00.000Z",
		});
		let classifierNow = 0;
		let recovered = false;
		const enrichPrHead = vi.fn(async () =>
			recovered
				? { ok: true as const, headSha: HEAD_A, mergedAt: NOW }
				: { ok: false as const, reason: "nonzero" as const },
		);
		const runner = dispatcher(
			store,
			arm({
				checkPrMerge: vi.fn(),
				enrichPrHead,
				now: () => classifierNow,
			}),
		);
		for (const at of [0, 30_000, 90_000, 210_000, 450_000]) {
			classifierNow = at;
			await runner.reconcile();
		}
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(
			store
				.listWorkflowAlertOutbox()
				.map((row) => row.payload.metadata.workflowEngine.disposition),
		).toContain("runner_ship_hydration_reval_failed");

		recovered = true;
		classifierNow = 750_000;
		await runner.reconcile();
		expect(enrichPrHead).toHaveBeenCalledTimes(6);
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
		store.close();
	});

	it("retries the enrichment alert after the fifth-attempt persistence CAS races", async () => {
		const store = await engineRun();
		const holder = await openRunnerShipGate(store);
		bindAuthority(store, holder);
		approve(store, holder);
		let classifierNow = 0;
		const original = store.recordRunnerShipMergedObserved.bind(store);
		let persistenceCalls = 0;
		vi.spyOn(store, "recordRunnerShipMergedObserved").mockImplementation(
			(input) => {
				persistenceCalls += 1;
				return persistenceCalls === 5
					? { status: "candidate_changed" as const }
					: original(input);
			},
		);
		const enrichPrHead = vi.fn(async () => ({
			ok: false as const,
			reason: "nonzero" as const,
		}));
		const runner = dispatcher(
			store,
			arm({
				checkPrMerge: vi.fn(async () => ({
					state: "merged" as const,
					rawHeadRefOid: "not-a-sha",
				})),
				enrichPrHead,
				now: () => classifierNow,
			}),
		);

		for (const at of [0, 30_000, 90_000, 210_000, 450_000, 750_000]) {
			classifierNow = at;
			await runner.reconcile();
		}

		expect(enrichPrHead).toHaveBeenCalledTimes(6);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(
			store
				.listWorkflowAlertOutbox()
				.map((row) => row.payload.metadata.workflowEngine.disposition),
		).toContain("runner_ship_head_enrichment_failed");
		store.close();
	});
});
