import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESIDENT_GRACE_MS } from "../bridge/resident-hold.js";
import { deliverResidentWake } from "../bridge/resident-wake-fence.js";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

/**
 * FLY-2921 C5 (FLY-2821): the resident hold of a loop target must survive a
 * rework round. Before this fix the R1 completion arrived under a new
 * activation, `enterResidentHoldForCompletionTx` refused it, the hold stayed
 * `woken` forever, and every later wake (R2) came back
 * `resident_hold_already_woken` until the coordinator gave up.
 */

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

const RUN = "run-heavy";
const IMPLEMENT = "implement-exec";
const A0 = `activation:${IMPLEMENT}:${RUN}:implement:1`;
const HEAD_1 = "a".repeat(40);
const HEAD_2 = "b".repeat(40);

type PrivateStore = {
	db: { raw: Database.Database };
	generalizedExecutionContextForActivation(activationId: string): unknown;
	enterResidentHoldForCompletionTx(context: unknown, now: string): boolean;
};

function privateStore(store: StateStore): PrivateStore {
	return store as unknown as PrivateStore;
}

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
		issueId: "FLY-1423",
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

function transition(
	store: StateStore,
	input: {
		nodeId: string;
		attempt: number;
		executionId: string;
		outcome: string;
		successorExecutionId?: string;
		subjectDigest?: string;
		now: string;
	},
) {
	return store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: RUN,
		alertIdentity: ALERT,
		...input,
	});
}

/** design -> implement handoff; implement-exec is the qa-loop target. */
async function implementReady(): Promise<StateStore> {
	const store = await createHeavyEngineRun();
	const handed = transition(store, {
		nodeId: "design",
		attempt: 1,
		executionId: "design-exec",
		outcome: "design_done",
		successorExecutionId: IMPLEMENT,
		now: "2026-07-23T00:05:00.000Z",
	});
	if (!handed.ok) throw new Error(`design handoff failed: ${handed.reason}`);
	if (store.listWorkflowActivationsForActor(IMPLEMENT).length === 0) {
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: RUN,
			nodeId: "implement",
			executionId: IMPLEMENT,
			attempt: 1,
			expiresAt: "2026-07-23T01:00:00.000Z",
			absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
			now: "2026-07-23T00:06:00.000Z",
			env: enabled,
		});
		if (!admitted.ok) {
			throw new Error(`implement admission failed: ${admitted.reason}`);
		}
	}
	store.upsertSession({
		execution_id: IMPLEMENT,
		issue_id: "FLY-1423",
		project_name: "flywheel",
		status: "running",
		adapter_type: "codex-tmux",
		workflow_node_id: "implement",
	});
	return store;
}

function completeImplement(
	store: StateStore,
	input: {
		sourceEventId: string;
		subjectDigest: string;
		now: string;
		activation?: { activationId: string; attempt: number; epoch: number };
	},
) {
	return store.commitEnrolledCompletion({
		nodeReuseEnabled: false,
		executionId: IMPLEMENT,
		route: "needs_review",
		sourceEventId: input.sourceEventId,
		completionSubmission: { decision: { route: "needs_review" } },
		subjectDigest: input.subjectDigest,
		...(input.activation
			? {
					workflowActivation: {
						activationId: input.activation.activationId,
						runId: RUN,
						nodeId: "implement",
						attempt: input.activation.attempt,
						turnEpoch: input.activation.epoch,
					},
				}
			: {}),
		alertIdentity: ALERT,
		now: input.now,
	});
}

/**
 * Coordinator-equivalent wake grant: claim the rework delivery, admit the
 * wake activation on the target body, project the TURN, mark turn_granted.
 * With `ack`, also record the pushed wake (`wake_sent_at` on turn_granted;
 * FLY-2921 has no awaiting_receipt state) and project the body's receipt
 * (wake_delivered), which is what lets that node transition next.
 */
function grantReworkWake(
	store: StateStore,
	requestId: string,
	input: {
		nodeId: "implement" | "qa";
		executionId: string;
		attempt: number;
		epoch: number;
		now: string;
		ack?: boolean;
	},
): { activationId: string; epoch: number } {
	const activationId = `activation:${requestId}`;
	const claim = store.claimWorkflowReworkDelivery({
		requestId,
		ownerId: "coordinator",
		now: input.now,
		leaseExpiresAt: new Date(Date.parse(input.now) + 30_000).toISOString(),
	});
	if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: RUN,
		nodeId: input.nodeId,
		executionId: input.executionId,
		attempt: input.attempt,
		activationId,
		activationMode: "wake",
		reworkRequestId: requestId,
		expiresAt: new Date(Date.parse(input.now) + 3_600_000).toISOString(),
		absoluteDeadlineAt: new Date(
			Date.parse(input.now) + 86_400_000,
		).toISOString(),
		now: input.now,
		env: enabled,
	});
	if (!admitted.ok)
		throw new Error(`wake admission failed: ${admitted.reason}`);
	const turn = store.recordWorkflowActivationTurn({
		activationId,
		issueId: "FLY-1423",
		executionId: input.executionId,
		epoch: input.epoch,
		sourceEventId: `rework-turn:${requestId}:${activationId}`,
		grantedAt: input.now,
	});
	if (!turn.ok) throw new Error(`turn projection failed: ${turn.reason}`);
	const advanced = store.advanceWorkflowReworkDelivery({
		requestId,
		ownerId: "coordinator",
		generation: claim.generation,
		from: "pending",
		to: "turn_granted",
		now: input.now,
	});
	if (!advanced.ok) throw new Error(`turn_granted failed: ${advanced.reason}`);
	if (input.ack) {
		const sent = store.markWorkflowReworkWakeSent({
			requestId,
			ownerId: "coordinator",
			generation: claim.generation,
			now: input.now,
		});
		if (!sent.ok) throw new Error(`wake_sent failed: ${sent.reason}`);
		const receipt = store.recordWorkflowReworkWakeReceipt({
			activationId,
			executionId: input.executionId,
			epoch: input.epoch,
			ackedAt: new Date(Date.parse(input.now) + 1_000).toISOString(),
			alertIdentity: ALERT,
		});
		if (!receipt.ok) throw new Error(`receipt failed: ${receipt.reason}`);
	}
	return { activationId, epoch: input.epoch };
}

/**
 * Fail QA at its current attempt, opening a rework on implement. The first
 * round binds qa-exec directly; later rounds first deliver QA's own pending
 * verification rework (the engine re-dispatches QA as a rework after the
 * implement completion), because QA may only transition once its content
 * has been delivered.
 */
function failQa(
	store: StateStore,
	input: { subjectDigest: string; epoch: number; now: string },
): string {
	const qaVerification = store
		.listWorkflowReworkDeliveries({ states: ["pending"] })
		.find(
			(delivery) =>
				store.getLatestWorkflowReworkRoute(delivery.request_id)
					?.target_node_id === "qa",
		);
	let attempt: number;
	if (qaVerification) {
		const route = store.getLatestWorkflowReworkRoute(
			qaVerification.request_id,
		)!;
		attempt = route.target_attempt;
		grantReworkWake(store, qaVerification.request_id, {
			nodeId: "qa",
			executionId: "qa-exec",
			attempt,
			epoch: input.epoch,
			now: new Date(Date.parse(input.now) - 60_000).toISOString(),
			ack: true,
		});
	} else {
		const latest = store
			.listWorkflowRunNodes(RUN, "qa")
			.sort((left, right) => right.attempt - left.attempt)[0];
		if (!latest) throw new Error("qa node missing");
		attempt = latest.attempt;
		if (latest.execution_id !== "qa-exec") {
			store.upsertWorkflowRunNode({
				runId: RUN,
				nodeId: "qa",
				attempt,
				state: "running",
				executionId: "qa-exec",
			});
		}
	}
	store.upsertSession({
		execution_id: "qa-exec",
		issue_id: "FLY-1423",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "qa",
	});
	const failed = transition(store, {
		nodeId: "qa",
		attempt,
		executionId: "qa-exec",
		outcome: "qa_fail",
		subjectDigest: input.subjectDigest,
		now: input.now,
	});
	if (!failed.ok || !failed.reworkRequestId) {
		throw new Error(`qa_fail did not open a rework: ${JSON.stringify(failed)}`);
	}
	return failed.reworkRequestId;
}

/** Rework wake on implement-exec: grant only; transport goes via the fence. */
function admitReworkWake(
	store: StateStore,
	requestId: string,
	input: { attempt: number; epoch: number; now: string },
): { activationId: string; epoch: number } {
	return grantReworkWake(store, requestId, {
		nodeId: "implement",
		executionId: IMPLEMENT,
		...input,
	});
}

function okDeliver() {
	return vi.fn(async () => ({ ok: true as const }));
}

describe("FLY-2921 C5: resident hold re-parks across rework rounds (FLY-2821)", () => {
	let store: StateStore | undefined;
	afterEach(() => {
		store?.close();
		store = undefined;
	});

	it("same run: R1 completion re-parks the hold under the current activation so R2 is delivered normally", async () => {
		store = await implementReady();

		// First completion (A0) parks the loop target.
		expect(
			completeImplement(store, {
				sourceEventId: "complete-implement-1",
				subjectDigest: HEAD_1,
				now: "2026-07-23T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getResidentHold(IMPLEMENT)).toMatchObject({
			state: "resident",
			activation_id: A0,
			attempt: 1,
			revision: 1,
			boundary_seq: 1,
		});

		// QA FAIL -> rework R1 -> wake delivered through the fence.
		const r1 = failQa(store, {
			subjectDigest: HEAD_1,
			epoch: 3,
			now: "2026-07-23T00:11:00.000Z",
		});
		const wakeR1 = admitReworkWake(store, r1, {
			attempt: 2,
			epoch: 4,
			now: "2026-07-23T00:12:00.000Z",
		});
		const deliverR1 = okDeliver();
		expect(await deliverResidentWake(store, IMPLEMENT, deliverR1)).toEqual({
			ok: true,
		});
		expect(deliverR1).toHaveBeenCalledOnce();
		expect(store.getResidentHold(IMPLEMENT)).toMatchObject({
			state: "woken",
			activation_id: A0,
			revision: 1,
		});

		// R1 completion under activation R1 re-parks the hold.
		const r1CompletedAt = "2026-07-23T00:30:00.000Z";
		expect(
			completeImplement(store, {
				sourceEventId: "complete-implement-2",
				subjectDigest: HEAD_2,
				now: r1CompletedAt,
				activation: { activationId: wakeR1.activationId, attempt: 2, epoch: 4 },
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		const reparked = store.getResidentHold(IMPLEMENT);
		expect(reparked).toMatchObject({
			state: "resident",
			activation_id: wakeR1.activationId,
			attempt: 2,
			revision: 2,
			boundary_seq: 2,
			grace_started_at: r1CompletedAt,
			closed_reason: null,
			release_cause: null,
		});
		expect(
			Date.parse(reparked!.grace_expires_at) - Date.parse(r1CompletedAt),
		).toBe(RESIDENT_GRACE_MS);

		// QA FAILs again -> R2 -> the second wake is delivered, not refused.
		const r2 = failQa(store, {
			subjectDigest: HEAD_2,
			epoch: 5,
			now: "2026-07-23T00:40:00.000Z",
		});
		expect(r2).not.toBe(r1);
		admitReworkWake(store, r2, {
			attempt: 3,
			epoch: 6,
			now: "2026-07-23T00:41:00.000Z",
		});
		const deliverR2 = okDeliver();
		expect(await deliverResidentWake(store, IMPLEMENT, deliverR2)).toEqual({
			ok: true,
		});
		expect(deliverR2).toHaveBeenCalledOnce();
		expect(store.getResidentHold(IMPLEMENT)).toMatchObject({
			state: "woken",
			activation_id: wakeR1.activationId,
			revision: 2,
		});
	});

	it("legacy data: a hold stuck at woken is still delivered to, with no hold CAS", async () => {
		store = await implementReady();
		expect(
			completeImplement(store, {
				sourceEventId: "complete-implement-1",
				subjectDigest: HEAD_1,
				now: "2026-07-23T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true });
		// A pre-fix wake left the hold woken and nothing ever re-parked it.
		expect(store.wakeResidentHold(IMPLEMENT, 1)).toBe(true);
		const before = store.getResidentHold(IMPLEMENT);
		expect(before?.state).toBe("woken");

		const deliver = okDeliver();
		expect(await deliverResidentWake(store, IMPLEMENT, deliver)).toEqual({
			ok: true,
		});
		expect(deliver).toHaveBeenCalledOnce();
		expect(store.getResidentHold(IMPLEMENT)).toEqual(before);

		// And a transport failure surfaces verbatim, still without touching the hold.
		const failing = vi.fn(async () => ({
			ok: false as const,
			error: "mailbox unavailable",
		}));
		expect(await deliverResidentWake(store, IMPLEMENT, failing)).toEqual({
			ok: false,
			error: "mailbox unavailable",
		});
		expect(store.getResidentHold(IMPLEMENT)).toEqual(before);
	});

	it.each([
		[
			"closed",
			(s: StateStore) =>
				s.closeResidentHold({
					executionId: IMPLEMENT,
					revision: 1,
					reason: "terminal",
				}),
		],
		[
			"expired",
			(s: StateStore) =>
				privateStore(s)
					.db.raw.prepare(
						"UPDATE workflow_resident_hold SET state = 'expired' WHERE execution_id = ?",
					)
					.run(IMPLEMENT).changes === 1,
		],
	])(
		"%s hold is the only retired classification: resident_hold_expired and no transport",
		async (state, retire) => {
			store = await implementReady();
			expect(
				completeImplement(store, {
					sourceEventId: "complete-implement-1",
					subjectDigest: HEAD_1,
					now: "2026-07-23T00:10:00.000Z",
				}),
			).toMatchObject({ ok: true });
			expect(retire(store)).toBe(true);
			expect(store.getResidentHold(IMPLEMENT)?.state).toBe(state);

			const deliver = okDeliver();
			expect(await deliverResidentWake(store, IMPLEMENT, deliver)).toEqual({
				ok: false,
				error: "resident_hold_expired",
			});
			expect(deliver).not.toHaveBeenCalled();
			expect(store.getResidentHold(IMPLEMENT)?.state).toBe(state);
		},
	);

	it("late completion from a stale (non-current) activation does not re-park the hold", async () => {
		store = await implementReady();
		expect(
			completeImplement(store, {
				sourceEventId: "complete-implement-1",
				subjectDigest: HEAD_1,
				now: "2026-07-23T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const r1 = failQa(store, {
			subjectDigest: HEAD_1,
			epoch: 3,
			now: "2026-07-23T00:11:00.000Z",
		});
		const wakeR1 = admitReworkWake(store, r1, {
			attempt: 2,
			epoch: 4,
			now: "2026-07-23T00:12:00.000Z",
		});
		expect(await deliverResidentWake(store, IMPLEMENT, okDeliver())).toEqual({
			ok: true,
		});
		const woken = store.getResidentHold(IMPLEMENT);
		expect(woken).toMatchObject({
			state: "woken",
			activation_id: A0,
			revision: 1,
		});

		// The public completion path refuses the superseded activation outright.
		expect(
			completeImplement(store, {
				sourceEventId: "complete-implement-1-late",
				subjectDigest: HEAD_2,
				now: "2026-07-23T00:13:00.000Z",
				activation: { activationId: A0, attempt: 1, epoch: 1 },
			}).ok,
		).toBe(false);
		expect(store.getResidentHold(IMPLEMENT)).toEqual(woken);

		// The transaction itself refuses too: A0 is no longer implement-exec's
		// current activation (attempt 2 exists), so no re-park.
		const priv = privateStore(store);
		const staleContext = priv.generalizedExecutionContextForActivation(A0);
		expect(staleContext).toBeDefined();
		expect(
			priv.enterResidentHoldForCompletionTx(
				staleContext,
				"2026-07-23T00:14:00.000Z",
			),
		).toBe(false);
		expect(store.getResidentHold(IMPLEMENT)).toEqual(woken);

		// The current activation is the one that re-parks.
		const currentContext = priv.generalizedExecutionContextForActivation(
			wakeR1.activationId,
		);
		expect(
			priv.enterResidentHoldForCompletionTx(
				currentContext,
				"2026-07-23T00:15:00.000Z",
			),
		).toBe(true);
		expect(store.getResidentHold(IMPLEMENT)).toMatchObject({
			state: "resident",
			activation_id: wakeR1.activationId,
			attempt: 2,
			revision: 2,
		});
	});
});
