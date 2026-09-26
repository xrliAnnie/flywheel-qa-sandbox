/**
 * FLY-2921 C7 (FLY-2202 / FLY-2472): a rework target that hands its work to
 * review must hand over a NEW commit with a product change.
 *
 * StateStore-level: drives `commitEnrolledCompletion` on the rework target
 * with Bridge-shaped `reworkEvidence` and asserts the decision table, that a
 * refusal changes nothing (delivery, path, node, run, completion marker), and
 * that exactly one idempotent `rework_completion_refused` audit survives the
 * transition rollback.
 */
import { describe, expect, it } from "vitest";
import {
	StateStore,
	type WorkflowReworkCompletionEvidence,
} from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const enabled = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

const ALERT = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

const BASE = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const RUN = "run-heavy";

async function createHeavyEngineRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	);
	if (!seed) throw new Error("tpl_eng_heavy seed missing");
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: RUN,
		issueId: "FLY-2921",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: enabled,
		startReservation: {
			idempotencyKey: "start-heavy",
			selectionDigest: "selection-heavy",
			nodeId: "design",
			attempt: 1,
			executionId: "design-exec",
			createdAt: "2026-07-23T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: RUN,
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-exec",
	});
	return store;
}

function advance(
	store: StateStore,
	input: {
		nodeId: string;
		attempt: number;
		executionId: string;
		outcome: string;
		successorExecutionId?: string;
		subjectDigest?: string;
	},
) {
	return store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: RUN,
		...input,
		now: "2026-07-23T00:10:00.000Z",
	});
}

/**
 * QA judged `judgedHead` (the implement#1 delivery) as FAIL: the rework
 * request's base_revision is that judged head, the target is implement#2 on
 * the same body, and the wake has been delivered (path active).
 */
async function createDeliveredRework(
	options: { judgedHead?: string | null; receipt?: boolean } = {},
): Promise<{ store: StateStore; requestId: string; activationId: string }> {
	// `null` = QA judged without a head (historical `unavailable` base).
	const judgedHead =
		options.judgedHead === undefined ? BASE : options.judgedHead;
	// `receipt: false` = wake sent but not yet acked: the completion itself
	// must project the receipt inline (FLY-2828 implied receipt).
	const receipt = options.receipt ?? true;
	const store = await createHeavyEngineRun();
	advance(store, {
		nodeId: "design",
		attempt: 1,
		executionId: "design-exec",
		outcome: "design_done",
		successorExecutionId: "implement-exec",
	});
	advance(store, {
		nodeId: "implement",
		attempt: 1,
		executionId: "implement-exec",
		outcome: "implement_done",
		successorExecutionId: "qa-exec",
	});
	const failed = advance(store, {
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-exec",
		outcome: "qa_fail",
		...(judgedHead ? { subjectDigest: judgedHead } : {}),
	});
	if (!failed.ok || !failed.reworkRequestId) {
		store.close();
		throw new Error("rework request not returned");
	}
	const requestId = failed.reworkRequestId;
	const activationId = `activation:${requestId}`;
	const claim = store.claimWorkflowReworkDelivery({
		requestId,
		ownerId: "coordinator",
		now: "2026-07-23T00:11:00.000Z",
		leaseExpiresAt: "2026-07-23T00:11:30.000Z",
	});
	if (!claim.ok) throw new Error(claim.reason);
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: RUN,
		nodeId: "implement",
		executionId: "implement-exec",
		attempt: 2,
		activationId,
		activationMode: "wake",
		reworkRequestId: requestId,
		expiresAt: "2026-07-23T02:00:00.000Z",
		absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
		now: "2026-07-23T00:11:01.000Z",
		env: enabled,
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	store.upsertSession({
		execution_id: "implement-exec",
		issue_id: "FLY-2921",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "implement",
	});
	const turn = store.recordWorkflowActivationTurn({
		activationId,
		issueId: "FLY-2921",
		executionId: "implement-exec",
		epoch: 4,
		sourceEventId: `rework-turn:${requestId}`,
		grantedAt: "2026-07-23T00:11:30.000Z",
	});
	if (!turn.ok) throw new Error(turn.reason);
	for (const [from, to] of [
		["pending", "turn_granted"],
		["turn_granted", "awaiting_receipt"],
	] as const) {
		const advanced = store.advanceWorkflowReworkDelivery({
			requestId,
			ownerId: "coordinator",
			generation: claim.generation,
			from,
			to,
			now: "2026-07-23T00:12:00.000Z",
			...(to === "awaiting_receipt" ? { releaseOwner: true } : {}),
		});
		if (!advanced.ok) throw new Error(advanced.reason);
	}
	if (!receipt) {
		expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
			"awaiting_receipt",
		);
		expect(store.getWorkflowReworkVerificationPath(requestId)?.state).toBe(
			"pending",
		);
		return { store, requestId, activationId };
	}
	const acked = store.recordWorkflowReworkWakeReceipt({
		activationId,
		executionId: "implement-exec",
		epoch: 4,
		ackedAt: "2026-07-23T00:12:01.000Z",
		alertIdentity: ALERT,
	});
	if (!acked.ok) throw new Error(acked.reason);
	expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
		"wake_delivered",
	);
	expect(store.getWorkflowReworkVerificationPath(requestId)).toMatchObject({
		state: "active",
		current_node_id: "implement",
		current_attempt: 2,
	});
	return { store, requestId, activationId };
}

function complete(
	store: StateStore,
	input: {
		activationId: string;
		subjectDigest?: string;
		reworkEvidence?: WorkflowReworkCompletionEvidence;
		sourceEventId?: string;
	},
) {
	return store.commitEnrolledCompletion({
		nodeReuseEnabled: false,
		executionId: "implement-exec",
		route: "needs_review",
		sourceEventId: input.sourceEventId ?? "complete-implement-2",
		completionSubmission: { decision: { route: "needs_review" } },
		...(input.subjectDigest ? { subjectDigest: input.subjectDigest } : {}),
		...(input.reworkEvidence ? { reworkEvidence: input.reworkEvidence } : {}),
		workflowActivation: {
			activationId: input.activationId,
			runId: RUN,
			nodeId: "implement",
			attempt: 2,
			turnEpoch: 4,
		},
		alertIdentity: ALERT,
		now: "2026-07-23T00:13:00.000Z",
	});
}

function evidence(
	requestId: string,
	overrides: Partial<WorkflowReworkCompletionEvidence> = {},
): WorkflowReworkCompletionEvidence {
	return {
		requestId,
		baseRevision: BASE,
		head: NEW_HEAD,
		headSource: "server",
		delta: "product_change",
		...overrides,
	};
}

/** Every ledger a refusal must leave untouched, as one comparable string. */
function reworkLedgers(store: StateStore, requestId: string): string {
	return JSON.stringify({
		delivery: store.getWorkflowReworkDelivery(requestId),
		path: store.getWorkflowReworkVerificationPath(requestId),
		node: store.getWorkflowRunNode(RUN, "implement", 2),
		run: {
			status: store.getWorkflowRun(RUN)?.status,
			current: store.getWorkflowRun(RUN)?.current_node_id,
		},
		completion: store.getWorkflowNodeCompletion(RUN, "implement", 2) ?? null,
		alerts: store.listWorkflowAlertOutbox().length,
		holds: store.listWorkflowHolds(RUN).length,
	});
}

function eventsOfKind(store: StateStore, kind: string) {
	return store
		.listWorkflowRunEvents(RUN)
		.filter((event) => event.kind === kind);
}

function expectRefusal(
	result: ReturnType<StateStore["commitEnrolledCompletion"]>,
	transitionReason: string,
	requestId: string,
) {
	expect(result).toMatchObject({
		ok: false,
		reason: "transition_refused",
		retryable: true,
		detail: {
			transitionReason,
			requestId,
			deliveryState: "wake_delivered",
			routeRevision: 1,
		},
	});
}

describe("FLY-2921 C7 rework completion needs a new commit (StateStore)", () => {
	it("refuses a zero-commit completion as rework_head_unchanged, changes nothing, audits once", async () => {
		const { store, requestId, activationId } = await createDeliveredRework();
		try {
			const before = reworkLedgers(store, requestId);
			const first = complete(store, {
				activationId,
				subjectDigest: BASE,
				reworkEvidence: evidence(requestId, {
					head: BASE,
					delta: "ledger_only",
				}),
			});
			expectRefusal(first, "rework_head_unchanged", requestId);
			expect(reworkLedgers(store, requestId)).toBe(before);

			const audits = eventsOfKind(store, "rework_completion_refused");
			expect(audits).toHaveLength(1);
			expect(audits[0]!.payload).toMatchObject({
				attempt: 2,
				transitionReason: "rework_head_unchanged",
				requestId,
				head: BASE,
				baseRevision: BASE,
			});
			// The generic refusal receipt / invariant alert family is NOT used:
			// nothing for the slow completion-marker reconciler to replay.
			expect(eventsOfKind(store, "completion_transition_refused")).toEqual([]);
			expect(store.listWorkflowAlertOutbox()).toEqual([]);
			expect(
				store.getWorkflowNodeCompletion(RUN, "implement", 2),
			).toBeUndefined();
			expect(store.getWorkflowRun(RUN)?.status).toBe("active");

			// Replaying the same bytes is the same refusal and the same one audit.
			const replay = complete(store, {
				activationId,
				subjectDigest: BASE,
				sourceEventId: "complete-implement-2-replay",
				reworkEvidence: evidence(requestId, {
					head: BASE,
					delta: "unverified",
				}),
			});
			expectRefusal(replay, "rework_head_unchanged", requestId);
			expect(eventsOfKind(store, "rework_completion_refused")).toHaveLength(1);
			expect(reworkLedgers(store, requestId)).toBe(before);
		} finally {
			store.close();
		}
	});

	it("refuses a progress.md-only commit as rework_no_product_change", async () => {
		const { store, requestId, activationId } = await createDeliveredRework();
		try {
			const before = reworkLedgers(store, requestId);
			const result = complete(store, {
				activationId,
				subjectDigest: NEW_HEAD,
				reworkEvidence: evidence(requestId, { delta: "ledger_only" }),
			});
			expectRefusal(result, "rework_no_product_change", requestId);
			expect(reworkLedgers(store, requestId)).toBe(before);
			const audits = eventsOfKind(store, "rework_completion_refused");
			expect(audits).toHaveLength(1);
			expect(audits[0]!.payload).toMatchObject({
				transitionReason: "rework_no_product_change",
				head: NEW_HEAD,
				baseRevision: BASE,
			});
			expect(store.listWorkflowAlertOutbox()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("accepts a real product change and settles the rework", async () => {
		const { store, requestId, activationId } = await createDeliveredRework();
		try {
			const result = complete(store, {
				activationId,
				subjectDigest: NEW_HEAD,
				reworkEvidence: evidence(requestId),
			});
			expect(result).toMatchObject({ ok: true, idempotentReplay: false });
			expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
				"completed",
			);
			expect(store.getWorkflowRunNode(RUN, "implement", 2)?.state).toBe("done");
			expect(store.getWorkflowRun(RUN)?.current_node_id).toBe("qa");
			expect(eventsOfKind(store, "rework_completion_refused")).toEqual([]);
			expect(eventsOfKind(store, "rework_delta_unverified")).toEqual([]);
			expect(eventsOfKind(store, "rework_head_check_skipped")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("allows an unverified delta on a new head and audits rework_delta_unverified once", async () => {
		const { store, requestId, activationId } = await createDeliveredRework();
		try {
			const result = complete(store, {
				activationId,
				subjectDigest: NEW_HEAD,
				reworkEvidence: evidence(requestId, { delta: "unverified" }),
			});
			expect(result).toMatchObject({ ok: true, idempotentReplay: false });
			const audits = eventsOfKind(store, "rework_delta_unverified");
			expect(audits).toHaveLength(1);
			expect(audits[0]!.payload).toMatchObject({
				attempt: 2,
				requestId,
				routeRevision: 1,
				baseRevision: BASE,
				head: NEW_HEAD,
			});
			expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
				"completed",
			);
		} finally {
			store.close();
		}
	});

	it("allows a historical 'unavailable' base and audits rework_head_check_skipped", async () => {
		const { store, requestId, activationId } = await createDeliveredRework({
			judgedHead: null,
		});
		try {
			expect(store.getWorkflowReworkRequest(requestId)?.base_revision).toBe(
				"unavailable",
			);
			const result = complete(store, {
				activationId,
				subjectDigest: BASE,
				reworkEvidence: evidence(requestId, {
					baseRevision: "unavailable",
					head: BASE,
					delta: "unverified",
				}),
			});
			expect(result).toMatchObject({ ok: true, idempotentReplay: false });
			const audits = eventsOfKind(store, "rework_head_check_skipped");
			expect(audits).toHaveLength(1);
			expect(audits[0]!.payload).toMatchObject({
				requestId,
				baseRevision: "unavailable",
				head: BASE,
			});
			expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
				"completed",
			);
		} finally {
			store.close();
		}
	});

	it("refuses an unresolved server head as rework_head_unavailable", async () => {
		const { store, requestId, activationId } = await createDeliveredRework();
		try {
			const before = reworkLedgers(store, requestId);
			const result = complete(store, {
				activationId,
				reworkEvidence: evidence(requestId, {
					head: undefined,
					headSource: "unresolved",
					delta: "unverified",
				}),
			});
			expectRefusal(result, "rework_head_unavailable", requestId);
			expect(reworkLedgers(store, requestId)).toBe(before);
			const audits = eventsOfKind(store, "rework_completion_refused");
			expect(audits).toHaveLength(1);
			expect(audits[0]!.payload).toMatchObject({
				transitionReason: "rework_head_unavailable",
				head: "unresolved",
			});
		} finally {
			store.close();
		}
	});

	it.each([
		["another request", { requestId: "rework:someone-else" }],
		["another base", { baseRevision: "c".repeat(40) }],
		["a head that is not this completion's head", { head: "d".repeat(40) }],
	] as const)(
		"refuses evidence for %s as rework_evidence_stale",
		async (_label, override) => {
			const { store, requestId, activationId } = await createDeliveredRework();
			try {
				const before = reworkLedgers(store, requestId);
				const result = complete(store, {
					activationId,
					subjectDigest: NEW_HEAD,
					reworkEvidence: evidence(requestId, override),
				});
				expectRefusal(result, "rework_evidence_stale", requestId);
				expect(reworkLedgers(store, requestId)).toBe(before);
				expect(eventsOfKind(store, "rework_completion_refused")).toHaveLength(
					1,
				);
			} finally {
				store.close();
			}
		},
	);

	it("without Bridge evidence falls back to a head-only compare", async () => {
		const unchanged = await createDeliveredRework();
		try {
			const before = reworkLedgers(unchanged.store, unchanged.requestId);
			expectRefusal(
				complete(unchanged.store, {
					activationId: unchanged.activationId,
					subjectDigest: BASE,
				}),
				"rework_head_unchanged",
				unchanged.requestId,
			);
			expect(reworkLedgers(unchanged.store, unchanged.requestId)).toBe(before);
			expect(
				complete(unchanged.store, {
					activationId: unchanged.activationId,
					subjectDigest: NEW_HEAD,
					sourceEventId: "complete-implement-2-new-head",
				}),
			).toMatchObject({ ok: true });
		} finally {
			unchanged.store.close();
		}

		const headless = await createDeliveredRework();
		try {
			// No session head to fall back on either: the head is simply unknown.
			expect(
				headless.store.getSession("implement-exec")?.pr_head_sha,
			).toBeFalsy();
			const before = reworkLedgers(headless.store, headless.requestId);
			expectRefusal(
				complete(headless.store, { activationId: headless.activationId }),
				"rework_head_unavailable",
				headless.requestId,
			);
			expect(reworkLedgers(headless.store, headless.requestId)).toBe(before);
		} finally {
			headless.store.close();
		}
	});

	it("does not judge verification nodes downstream of the target", async () => {
		const { store, requestId, activationId } = await createDeliveredRework();
		try {
			expect(
				complete(store, {
					activationId,
					subjectDigest: NEW_HEAD,
					reworkEvidence: evidence(requestId),
				}),
			).toMatchObject({ ok: true });
			// The path moved to qa#2, which re-tests the SAME head; the chained
			// QA request's base is that head and QA passes it back unchanged.
			const chained = store.listWorkflowReworkDeliveries({
				states: ["pending"],
			})[0];
			expect(chained).toBeDefined();
			expect(store.getWorkflowReworkRequest(chained!.request_id)).toMatchObject(
				{
					base_revision: NEW_HEAD,
					source_node_id: "implement",
					source_attempt: 2,
				},
			);
			expect(
				store.getLatestWorkflowReworkRoute(chained!.request_id),
			).toMatchObject({ target_node_id: "qa", target_attempt: 2 });
		} finally {
			store.close();
		}
	});

	it("qa FAIL base semantics: base_revision is the judged implement head", async () => {
		const { store, requestId } = await createDeliveredRework({
			judgedHead: BASE,
		});
		try {
			expect(store.getWorkflowReworkRequest(requestId)).toMatchObject({
				authority: "qa",
				source_node_id: "qa",
				source_attempt: 1,
				base_revision: BASE,
			});
			expect(store.getLatestWorkflowReworkRoute(requestId)).toMatchObject({
				target_node_id: "implement",
				target_attempt: 2,
				invalidation_scope: ["implement", "qa"],
			});
		} finally {
			store.close();
		}
	});

	it("keeps the refusal audit even though the implied receipt rolled back", async () => {
		// Wake sent, receipt not yet acked: the completion projects the receipt
		// inline (impliedApplied). The refusal must roll that projection back
		// (delivery stays awaiting_receipt, path stays pending) while the audit
		// written outside the savepoint survives.
		const { store, requestId, activationId } = await createDeliveredRework({
			receipt: false,
		});
		try {
			const before = reworkLedgers(store, requestId);
			const result = complete(store, {
				activationId,
				subjectDigest: BASE,
				reworkEvidence: evidence(requestId, {
					head: BASE,
					delta: "ledger_only",
				}),
			});
			expect(result).toMatchObject({
				ok: false,
				reason: "transition_refused",
				retryable: true,
				detail: {
					transitionReason: "rework_head_unchanged",
					requestId,
					deliveryState: "awaiting_receipt",
				},
			});
			expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
				"awaiting_receipt",
			);
			expect(store.getWorkflowReworkVerificationPath(requestId)?.state).toBe(
				"pending",
			);
			expect(reworkLedgers(store, requestId)).toBe(before);
			expect(eventsOfKind(store, "rework_completion_refused")).toHaveLength(1);
			expect(eventsOfKind(store, "rework_delivery_wake_delivered")).toEqual([]);

			// Positive control: the same pre-state with a new head projects the
			// receipt and completes.
			expect(
				complete(store, {
					activationId,
					subjectDigest: NEW_HEAD,
					sourceEventId: "complete-implement-2-new-head",
					reworkEvidence: evidence(requestId),
				}),
			).toMatchObject({ ok: true, idempotentReplay: false });
			expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe(
				"completed",
			);
			expect(eventsOfKind(store, "rework_completion_refused")).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
