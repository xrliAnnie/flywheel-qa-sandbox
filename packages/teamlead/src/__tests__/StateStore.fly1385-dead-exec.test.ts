import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

async function engineRunWithImplement(
	sessionStatus: "running" | "failed" = "failed",
): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1335",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "selection-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-20T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	expect(
		store.commitWorkflowTransitionTx({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-dead",
			subjectDigest: "a".repeat(40),
			now: "2026-07-20T00:05:00.000Z",
		}),
	).toMatchObject({ ok: true });
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "implement",
			executionId: "implement-dead",
			attempt: 1,
			expiresAt: "2026-07-20T01:00:00.000Z",
			absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
			now: "2026-07-20T00:06:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "implement",
				attempt: 1,
				executionId: "implement-dead",
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId: "implement-dead",
	});
	store.upsertSession({
		execution_id: "implement-dead",
		issue_id: "FLY-1335",
		project_name: "flywheel",
		status: sessionStatus,
		workflow_node_id: "implement",
	});
	return store;
}

async function engineRunWithDeadQa(): Promise<{
	store: StateStore;
	submissionCredential: string;
}> {
	const store = await engineRunWithImplement("running");
	expect(
		store.commitWorkflowTransitionTx({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-dead",
			outcome: "implement_done",
			successorExecutionId: "qa-dead",
			now: "2026-07-20T00:20:00.000Z",
		}),
	).toMatchObject({ ok: true });
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "qa",
		executionId: "qa-dead",
		attempt: 1,
		expiresAt: "2026-07-20T02:00:00.000Z",
		absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
		now: "2026-07-20T00:21:00.000Z",
		env: WORKFLOW_ON,
	});
	if (!admission.ok || !admission.submissionCredential) {
		throw new Error("QA admission failed");
	}
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "qa",
				attempt: 1,
				executionId: "qa-dead",
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: "qa-dead",
	});
	store.upsertSession({
		execution_id: "qa-dead",
		issue_id: "FLY-1335",
		project_name: "flywheel",
		status: "failed",
		workflow_node_id: "qa",
	});
	return { store, submissionCredential: admission.submissionCredential };
}

async function engineRunWithOutputFromDeadExecution(
	options: { writeOutput?: boolean } = {},
): Promise<{
	store: StateStore;
	canonicalRoot: string;
	outputCredential: string;
}> {
	const store = await StateStore.create(":memory:");
	const canonicalRoot = mkdtempSync(join(tmpdir(), "fly1385-output-"));
	mkdirSync(join(canonicalRoot, "agents"));
	writeFileSync(
		join(canonicalRoot, "agents", "generic-executor.md"),
		"Produce the requested artifact.\n",
	);
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_product_v1",
	)!;
	store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
	store.materializeWorkflowRun({
		runId: "output-run",
		issueId: "FLY-1335",
		projectName: "flywheel",
		taskCategory: "research",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "output-start",
			selectionDigest: "output-selection",
			nodeId: "research",
			attempt: 1,
			executionId: "research-1",
			createdAt: "2026-07-20T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "output-run",
		nodeId: "research",
		attempt: 1,
		state: "running",
		executionId: "research-1",
	});
	expect(
		store.commitWorkflowTransitionTx({
			runId: "output-run",
			nodeId: "research",
			attempt: 1,
			executionId: "research-1",
			outcome: "node_done",
			successorExecutionId: "produce-dead",
			now: "2026-07-20T00:00:30.000Z",
		}),
	).toMatchObject({ ok: true });
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: "output-run",
		nodeId: "produce",
		executionId: "produce-dead",
		attempt: 1,
		expiresAt: "2026-07-20T02:00:00.000Z",
		absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
		now: "2026-07-20T00:01:00.000Z",
		env: WORKFLOW_ON,
	});
	if (!admission.ok || !admission.outputCredential) {
		throw new Error("output admission failed");
	}
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "output-run",
		ops: [
			{
				op: "side_effect",
				node: "produce",
				attempt: 1,
				executionId: "produce-dead",
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "output-run",
		nodeId: "produce",
		attempt: 1,
		state: "running",
		executionId: "produce-dead",
	});
	if (options.writeOutput !== false) {
		expect(
			store.submitWorkflowNodeOutput({
				token: admission.outputCredential,
				clientRequestId: "output-1",
				payload: '{"artifact":"durable"}',
				now: "2026-07-20T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true });
	}
	store.upsertSession({
		execution_id: "produce-dead",
		issue_id: "FLY-1335",
		project_name: "flywheel",
		status: "failed",
		workflow_node_id: "produce",
	});
	return {
		store,
		canonicalRoot,
		outputCredential: admission.outputCredential,
	};
}

function startAndFailReservedImplement(
	store: StateStore,
	executionId: string,
	now: string,
): void {
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "implement",
			executionId,
			attempt: 1,
			expiresAt: "2026-07-20T05:00:00.000Z",
			absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
			now,
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "implement",
				attempt: 1,
				executionId,
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-1335",
		project_name: "flywheel",
		status: "failed",
		workflow_node_id: "implement",
	});
}

function startAndFailReservedOutput(
	store: StateStore,
	executionId: string,
	now: string,
): void {
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "output-run",
			nodeId: "produce",
			executionId,
			attempt: 1,
			expiresAt: "2026-07-20T05:00:00.000Z",
			absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
			now,
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "output-run",
		ops: [
			{
				op: "side_effect",
				node: "produce",
				attempt: 1,
				executionId,
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "output-run",
		nodeId: "produce",
		attempt: 1,
		state: "running",
		executionId,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-1335",
		project_name: "flywheel",
		status: "failed",
		workflow_node_id: "produce",
	});
}

describe("FLY-1385 dead workflow execution recovery", () => {
	it("fails closed when a durable event UID is reused with different content", async () => {
		const store = await engineRunWithImplement();
		const event = {
			runId: "run-1",
			eventUid: "checked-event-1",
			kind: "checked_test",
			nodeId: "implement",
			executionId: "implement-dead",
			payload: { reason: "same" },
		};
		expect(store.appendWorkflowRunEventChecked(event)).toEqual({
			seq: expect.any(Number),
			deduped: false,
		});
		expect(store.appendWorkflowRunEventChecked(event)).toEqual({
			seq: expect.any(Number),
			deduped: true,
		});
		expect(() =>
			store.appendWorkflowRunEventChecked({
				...event,
				payload: { reason: "different" },
			}),
		).toThrow("workflow_event_uid_conflict:checked-event-1");
		store.close();
	});

	it("atomically gives a running node to a fresh execution and appends a launch intent", async () => {
		const store = await engineRunWithImplement();

		const recovered = store.rollbackDeadWorkflowNodeExecution({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			deadExecutionId: "implement-dead",
			newExecutionId: "implement-retry-1",
			reason: "terminal_session_and_dead_probe",
			livenessEvidence: {
				liveness: "dead",
				observedAt: "2026-07-20T00:10:00.000Z",
			},
			now: "2026-07-20T00:10:00.000Z",
		});

		expect(recovered).toEqual({
			ok: true,
			idempotentReplay: false,
			launchOrdinal: 2,
		});
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "pending",
			execution_id: "implement-retry-1",
		});
		const attachments = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
		});
		// This fixture never delivered or reconciled the issue input, so recovery
		// must not manufacture a ready checkpoint for the replacement writer.
		expect(attachments).toHaveLength(1);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find((event) => event.kind === "resume_target_unrecoverable"),
		).toMatchObject({
			payload: expect.objectContaining({
				reason: "attachment_missing",
				detail: { cause: "writer_source_evidence_unavailable" },
			}),
		});
		expect(store.listWorkflowSideEffects("run-1")).toEqual([
			expect.objectContaining({
				launch_ordinal: 1,
				execution_id: "implement-dead",
				state: "started",
			}),
			expect.objectContaining({
				launch_ordinal: 2,
				execution_id: "implement-retry-1",
				state: "intent_recorded",
			}),
		]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "execution_dead_rolled_back"),
		).toEqual([
			expect.objectContaining({
				execution_id: "implement-dead",
				payload: expect.objectContaining({
					newExecutionId: "implement-retry-1",
					launchOrdinal: 2,
				}),
			}),
		]);
		store.close();
	});

	it("keeps dead-execution recovery committed when its resume-only writer receipt conflicts", async () => {
		const store = await engineRunWithImplement();
		const newExecutionId = "implement-retry-conflict";
		const writerTransitionUid = `writer_replacement:${canonicalSubmissionDigest(
			{
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				newExecutionId,
			},
		)}`;
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: writerTransitionUid,
			kind: "writer_replacement",
			nodeId: "implement",
			executionId: newExecutionId,
			payload: { targetNodeId: "wrong", targetAttempt: 99 },
		});

		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				deadExecutionId: "implement-dead",
				newExecutionId,
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:10:00.000Z",
				},
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true, launchOrdinal: 2 });
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "pending",
			execution_id: newExecutionId,
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "execution_dead_rolled_back"),
		).toHaveLength(1);
		store.close();
	});

	it("refuses to page from tmux-only activity at the durable trip seam", async () => {
		const store = await engineRunWithImplement();
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				deadExecutionId: "implement-dead",
				newExecutionId: "implement-retry-1",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:10:00.000Z",
				},
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true });

		expect(
			store.tripWorkflowDeadExecutionWatch({
				deadExecutionId: "implement-dead",
				evidence: {
					kind: "tmux_output",
					detail: "tmux output changed on a reused physical window",
				},
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-20T00:11:00.000Z",
			}),
		).toEqual({ ok: false, reason: "weak_dead_execution_activity" });
		expect(store.getWorkflowDeadExecutionWatch("implement-dead")).toMatchObject(
			{
				state: "active",
				evidence: null,
			},
		);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		store.close();
	});

	it("prunes an active-run dead-execution watch at the 24-hour TTL boundary", async () => {
		const store = await engineRunWithImplement();
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				deadExecutionId: "implement-dead",
				newExecutionId: "implement-retry-1",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:10:00.000Z",
				},
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true });

		expect(
			store.pruneWorkflowDeadExecutionWatches({
				now: "2026-07-21T00:09:59.999Z",
				ttlMs: 24 * 60 * 60 * 1000,
			}),
		).toBe(0);
		expect(store.getWorkflowDeadExecutionWatch("implement-dead")).toBeDefined();

		expect(
			store.pruneWorkflowDeadExecutionWatches({
				now: "2026-07-21T00:10:00.000Z",
				ttlMs: 24 * 60 * 60 * 1000,
			}),
		).toBe(1);
		expect(
			store.getWorkflowDeadExecutionWatch("implement-dead"),
		).toBeUndefined();
		store.close();
	});

	it("prunes a fresh dead-execution watch as soon as its run terminates", async () => {
		const store = await engineRunWithImplement();
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				deadExecutionId: "implement-dead",
				newExecutionId: "implement-retry-1",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:10:00.000Z",
				},
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-1",
				reason: "test lifecycle closeout",
				clientRequestId: "terminate-for-watch-prune",
				principal: "master",
				evidence: [
					{
						executionId: "design-1",
						sessionStatus: null,
						lifecycleRevision: null,
						liveness: "dead",
						observedAt: "2026-07-20T00:10:30.000Z",
					},
					{
						executionId: "implement-dead",
						sessionStatus: "failed",
						lifecycleRevision: store.getLifecycleRevision("implement-dead"),
						liveness: "dead",
						observedAt: "2026-07-20T00:10:30.000Z",
					},
					{
						executionId: "implement-retry-1",
						sessionStatus: null,
						lifecycleRevision: null,
						liveness: "dead",
						observedAt: "2026-07-20T00:10:30.000Z",
					},
				],
				now: "2026-07-20T00:10:31.000Z",
			}),
		).toMatchObject({ ok: true, status: "terminated" });

		expect(
			store.pruneWorkflowDeadExecutionWatches({
				now: "2026-07-20T00:11:00.000Z",
				ttlMs: 24 * 60 * 60 * 1000,
			}),
		).toBe(1);
		expect(
			store.getWorkflowDeadExecutionWatch("implement-dead"),
		).toBeUndefined();
		store.close();
	});

	it("replays the same rollback without allocating another execution", async () => {
		const store = await engineRunWithImplement();
		const request = {
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			deadExecutionId: "implement-dead",
			newExecutionId: "implement-retry-1",
			reason: "terminal_session_and_dead_probe",
			livenessEvidence: {
				liveness: "dead" as const,
				observedAt: "2026-07-20T00:10:00.000Z",
			},
			now: "2026-07-20T00:10:00.000Z",
		};

		expect(store.rollbackDeadWorkflowNodeExecution(request)).toMatchObject({
			ok: true,
			idempotentReplay: false,
			launchOrdinal: 2,
		});
		expect(store.rollbackDeadWorkflowNodeExecution(request)).toEqual({
			ok: true,
			idempotentReplay: true,
			launchOrdinal: 2,
		});
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(2);
		store.close();
	});

	it("recovers a missing session row when a durable teardown fact and dead probe agree", async () => {
		const store = await engineRunWithImplement("running");
		expect(
			store.recordEnrolledTerminalSignal({
				executionId: "implement-dead",
				sourceEventId: "terminal-before-row-loss",
				signal: "failed",
				source: "direct-event-sink",
				now: "2026-07-20T00:08:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const internals = store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internals.db.run("DELETE FROM sessions WHERE execution_id = ?", [
			"implement-dead",
		]);

		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				deadExecutionId: "implement-dead",
				newExecutionId: "implement-retry-1",
				reason: "durable_teardown_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:10:00.000Z",
				},
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true, launchOrdinal: 2 });
		store.close();
	});

	it("revokes the dead execution's unconsumed capability before retrying", async () => {
		const { store, submissionCredential } = await engineRunWithDeadQa();

		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "qa",
				attempt: 1,
				deadExecutionId: "qa-dead",
				newExecutionId: "qa-retry-1",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:30:00.000Z",
				},
				now: "2026-07-20T00:30:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.getWorkflowSubmissionCredentialByToken(submissionCredential),
		).toMatchObject({
			revoked: 1,
			revoked_reason: "dead_execution_rolled_back",
		});
		store.close();
	});

	it("blindly replaces a proven-dead execution even after it wrote output", async () => {
		const { store, canonicalRoot } =
			await engineRunWithOutputFromDeadExecution();

		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "output-run",
				nodeId: "produce",
				attempt: 1,
				deadExecutionId: "produce-dead",
				newExecutionId: "produce-retry-1",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:10:00.000Z",
				},
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true, launchOrdinal: 2 });
		expect(store.getWorkflowRun("output-run")?.status).toBe("active");
		expect(store.listWorkflowSideEffects("output-run")).toHaveLength(2);
		expect(
			store
				.listWorkflowRunEvents("output-run")
				.filter((event) => event.kind === "dead_execution_after_output"),
		).toHaveLength(0);
		const retryAdmission = store.admitGeneralizedWorkflowExecution({
			runId: "output-run",
			nodeId: "produce",
			executionId: "produce-retry-1",
			attempt: 1,
			expiresAt: "2026-07-20T02:10:00.000Z",
			absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
			now: "2026-07-20T00:11:00.000Z",
			env: WORKFLOW_ON,
		});
		if (!retryAdmission.ok || !retryAdmission.outputCredential) {
			throw new Error("replacement output admission failed");
		}
		store.upsertSession({
			execution_id: "produce-retry-1",
			issue_id: "FLY-1335",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "produce",
		});
		store.applyWorkflowLedgerBatch({
			projectName: "flywheel",
			issueId: "FLY-1335",
			runId: "output-run",
			ops: [
				{
					op: "side_effect",
					node: "produce",
					attempt: 1,
					executionId: "produce-retry-1",
					to: "started",
				},
			],
		});
		store.upsertWorkflowRunNode({
			runId: "output-run",
			nodeId: "produce",
			attempt: 1,
			state: "running",
			executionId: "produce-retry-1",
		});
		expect(
			store.submitWorkflowNodeOutput({
				token: retryAdmission.outputCredential,
				clientRequestId: "replacement-output",
				payload: '{"artifact":"replacement"}',
				now: "2026-07-20T00:12:00.000Z",
			}),
		).toEqual({ ok: false, reason: "output_already_exists" });
		expect(
			store.commitEnrolledCompletion({
				executionId: "produce-retry-1",
				route: "needs_review",
				sourceEventId: "replacement-complete",
				completionSubmission: { decision: { route: "needs_review" } },
				now: "2026-07-20T00:13:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "missing_output" });
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});

	it("holds the run after three replacement launches die", async () => {
		const store = await engineRunWithImplement();
		let deadExecutionId = "implement-dead";
		for (let retry = 1; retry <= 3; retry += 1) {
			const newExecutionId = `implement-retry-${retry}`;
			const at = `2026-07-20T00:${10 + retry}:00.000Z`;
			expect(
				store.rollbackDeadWorkflowNodeExecution({
					runId: "run-1",
					nodeId: "implement",
					attempt: 1,
					deadExecutionId,
					newExecutionId,
					reason: "terminal_session_and_dead_probe",
					livenessEvidence: { liveness: "dead", observedAt: at },
					now: at,
				}),
			).toMatchObject({
				ok: true,
				idempotentReplay: false,
				launchOrdinal: retry + 1,
			});
			startAndFailReservedImplement(store, newExecutionId, at);
			deadExecutionId = newExecutionId;
		}
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "repeated_dead_execution_pattern"),
		).toHaveLength(2);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);

		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				deadExecutionId,
				newExecutionId: "implement-retry-4",
				reason: "terminal_session_and_dead_probe",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:20:00.000Z",
				},
				now: "2026-07-20T00:20:00.000Z",
			}),
		).toEqual({ ok: false, reason: "retry_limit_exceeded" });
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(4);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "retry_limit_escalated"),
		).toHaveLength(1);
		const uid = "retry_limit:run-1:implement:1:4";
		const alert = store.getWorkflowAlertOutbox(uid);
		expect(alert).toMatchObject({
			state: "pending",
			attempt: 0,
			payload: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				title: "【需人工】FLY-1335 节点 implement 盲换 3 次仍起不来",
				metadata: {
					workflowEngine: {
						runId: "run-1",
						issueId: "FLY-1335",
						nodeId: "implement",
						executionId: "implement-retry-3",
						disposition: "held",
						launchCount: 4,
						maxBlindReplacements: 3,
						outputExistsForAttempt: false,
						management: {
							terminate: "POST /api/runs/run-1/terminate",
						},
						leadResolution: "resolved",
					},
				},
			},
		});
		expect(alert?.payload.body).toContain("换了 3 次仍起不来");
		expect(alert?.payload.body).not.toContain("POST /api");

		const first = store.claimNextWorkflowAlert({
			ownerId: "bridge-a",
			now: "2026-07-20T00:21:00.000Z",
			leaseExpiresAt: "2026-07-20T00:22:00.000Z",
		});
		expect(first).toMatchObject({ attempt: 1, generation: 1 });
		expect(
			store.finishWorkflowAlertDelivery({
				escalationUid: uid,
				ownerId: "bridge-a",
				generation: first!.generation,
				outcome: "failed",
				error: "discord timeout",
				now: "2026-07-20T00:21:10.000Z",
			}),
		).toEqual({ ok: true, state: "pending" });
		const second = store.claimNextWorkflowAlert({
			ownerId: "bridge-b",
			now: "2026-07-20T00:21:20.000Z",
			leaseExpiresAt: "2026-07-20T00:22:20.000Z",
		});
		expect(second).toMatchObject({ attempt: 2, generation: 2 });
		store.close();
	});

	it("reports the mechanical output-exists fact when blind replacements exhaust", async () => {
		const { store, canonicalRoot } =
			await engineRunWithOutputFromDeadExecution();
		let deadExecutionId = "produce-dead";
		for (let retry = 1; retry <= 3; retry += 1) {
			const newExecutionId = `produce-retry-${retry}`;
			const at = `2026-07-20T00:${20 + retry}:00.000Z`;
			expect(
				store.rollbackDeadWorkflowNodeExecution({
					runId: "output-run",
					nodeId: "produce",
					attempt: 1,
					deadExecutionId,
					newExecutionId,
					reason: "terminal_session_and_dead_probe",
					livenessEvidence: { liveness: "dead", observedAt: at },
					now: at,
				}),
			).toMatchObject({ ok: true, launchOrdinal: retry + 1 });
			startAndFailReservedOutput(store, newExecutionId, at);
			deadExecutionId = newExecutionId;
		}

		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "output-run",
				nodeId: "produce",
				attempt: 1,
				deadExecutionId,
				newExecutionId: "must-not-launch",
				reason: "terminal_session_and_dead_probe",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:30:00.000Z",
				},
				now: "2026-07-20T00:30:00.000Z",
			}),
		).toEqual({ ok: false, reason: "retry_limit_exceeded" });
		expect(
			store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine,
		).toMatchObject({
			launchCount: 4,
			maxBlindReplacements: 3,
			outputExistsForAttempt: true,
		});
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});

	it("rejects an output writer whose credential became stale after its first read", async () => {
		const { store, canonicalRoot, outputCredential } =
			await engineRunWithOutputFromDeadExecution({ writeOutput: false });
		const internals = store as unknown as {
			workflowSelectAll(
				sql: string,
				params?: unknown[],
			): Record<string, unknown>[];
		};
		const originalSelectAll = internals.workflowSelectAll.bind(store);
		let rollbackInjected = false;
		internals.workflowSelectAll = (sql, params) => {
			const rows = originalSelectAll(sql, params);
			if (
				!rollbackInjected &&
				sql.includes(
					"SELECT * FROM workflow_output_credential WHERE credential_hash",
				)
			) {
				rollbackInjected = true;
				expect(
					store.rollbackDeadWorkflowNodeExecution({
						runId: "output-run",
						nodeId: "produce",
						attempt: 1,
						deadExecutionId: "produce-dead",
						newExecutionId: "produce-retry-1",
						reason: "terminal_session_and_dead_probe",
						livenessEvidence: {
							liveness: "dead",
							observedAt: "2026-07-20T00:10:00.000Z",
						},
						now: "2026-07-20T00:10:00.000Z",
					}),
				).toMatchObject({ ok: true });
			}
			return rows;
		};

		expect(
			store.submitWorkflowNodeOutput({
				token: outputCredential,
				clientRequestId: "late-output",
				payload: '{"artifact":"stale"}',
				now: "2026-07-20T00:11:00.000Z",
			}),
		).toEqual({ ok: false, reason: "credential_revoked" });
		expect(store.getWorkflowNodeOutput(1)).toBeUndefined();
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});

	it("settles a late completion from the superseded execution before checking output", async () => {
		const { store, canonicalRoot } = await engineRunWithOutputFromDeadExecution(
			{ writeOutput: false },
		);
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "output-run",
				nodeId: "produce",
				attempt: 1,
				deadExecutionId: "produce-dead",
				newExecutionId: "produce-retry",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-07-20T00:10:00.000Z",
				},
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true });

		expect(
			store.commitEnrolledCompletion({
				executionId: "produce-dead",
				route: "needs_review",
				sourceEventId: "late-completion",
				completionSubmission: { decision: { route: "needs_review" } },
				now: "2026-07-20T00:11:00.000Z",
			}),
		).toEqual({ ok: false, reason: "stale_execution_superseded" });
		expect(
			store.getWorkflowNodeCompletion("output-run", "produce", 1),
		).toBeUndefined();
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});

	it("atomically records an enrolled terminal signal, session projection, and teardown fact", async () => {
		const store = await engineRunWithImplement("running");
		expect(store.getLifecycleRevision("implement-dead")).toBe(0);

		expect(
			store.recordEnrolledTerminalSignal({
				executionId: "implement-dead",
				sourceEventId: "terminal-signal-1",
				signal: "failed",
				failureKind: "runner_zombie",
				lastError: "tmux and process probes are dead",
				source: "direct-event-sink",
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toEqual({
			ok: true,
			idempotentReplay: false,
			status: "failed",
			attemptedStatus: "failed",
			effectiveStatus: "failed",
			statusPreserved: false,
			runId: "run-1",
			nodeId: "implement",
		});
		expect(
			store
				.getEventsByExecution("implement-dead")
				.filter((event) => event.event_id === "terminal-signal-1"),
		).toEqual([
			expect.objectContaining({
				event_type: "session_failed",
				source: "direct-event-sink",
			}),
		]);
		expect(store.getSession("implement-dead")).toMatchObject({
			status: "failed",
			last_error: "tmux and process probes are dead",
			workflow_node_id: "implement",
			terminal_at: expect.any(String),
		});
		expect(store.getLifecycleRevision("implement-dead")).toBe(1);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "generalized_teardown_recorded"),
		).toEqual([
			expect.objectContaining({
				execution_id: "implement-dead",
				payload: expect.objectContaining({
					sourceEventId: "terminal-signal-1",
					signal: "failed",
					status: "failed",
				}),
			}),
		]);
		store.close();
	});

	it("replays the same enrolled terminal event as a no-op at a later timestamp", async () => {
		const store = await engineRunWithImplement("running");
		const signal = {
			executionId: "implement-dead",
			sourceEventId: "terminal-signal-replay",
			signal: "failed" as const,
			failureKind: "runner_zombie",
			lastError: "tmux and process probes are dead",
			source: "direct-event-sink",
		};

		expect(
			store.recordEnrolledTerminalSignal({
				...signal,
				now: "2026-07-20T00:10:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(
			store.recordEnrolledTerminalSignal({
				...signal,
				now: "2026-07-20T00:12:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(store.getLifecycleRevision("implement-dead")).toBe(1);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "generalized_teardown_recorded"),
		).toHaveLength(1);
		store.close();
	});

	it("holds and terminates a quiescent run with idempotent operator receipts", async () => {
		const store = await engineRunWithImplement();
		const evidence = [
			{
				executionId: "design-1",
				sessionStatus: null,
				lifecycleRevision: null,
				liveness: "dead" as const,
				observedAt: "2026-07-20T00:30:00.000Z",
			},
			{
				executionId: "implement-dead",
				sessionStatus: "failed",
				lifecycleRevision: store.getLifecycleRevision("implement-dead"),
				liveness: "dead" as const,
				observedAt: "2026-07-20T00:30:00.000Z",
			},
		];
		const request = {
			runId: "run-1",
			reason: "operator recovery",
			clientRequestId: "hold-1",
			principal: "master",
			evidence,
			now: "2026-07-20T00:30:01.000Z",
		};
		expect(store.holdWorkflowRunByOperator(request)).toEqual({
			ok: true,
			status: "held",
			idempotentReplay: false,
		});
		expect(store.holdWorkflowRunByOperator(request)).toEqual({
			ok: true,
			status: "held",
			idempotentReplay: true,
		});
		expect(
			store.terminateWorkflowRunByOperator({
				...request,
				clientRequestId: "terminate-1",
			}),
		).toEqual({
			ok: true,
			status: "terminated",
			idempotentReplay: false,
		});
		expect(store.getWorkflowRun("run-1")?.status).toBe("terminated");
		store.close();
	});

	// SKIPPED with #705: the FLY-1434 quiescence validator is neutralized by
	// founder directive (2026-07-24 incident) — the refusal this asserts is
	// intentionally disabled. Restore with the redesigned rework path.
	it.skip("refuses operator run management while an attributed session is nonterminal", async () => {
		const store = await engineRunWithImplement("running");
		const result = store.holdWorkflowRunByOperator({
			runId: "run-1",
			reason: "should fail",
			clientRequestId: "hold-live",
			principal: "master",
			evidence: [
				{
					executionId: "design-1",
					sessionStatus: null,
					lifecycleRevision: null,
					liveness: "dead",
					observedAt: "2026-07-20T00:30:00.000Z",
				},
				{
					executionId: "implement-dead",
					sessionStatus: "running",
					lifecycleRevision: store.getLifecycleRevision("implement-dead"),
					liveness: "dead",
					observedAt: "2026-07-20T00:30:00.000Z",
				},
			],
			now: "2026-07-20T00:30:01.000Z",
		});
		expect(result).toEqual({
			ok: false,
			reason: "run_has_live_executions",
			executionIds: ["implement-dead"],
		});
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		store.close();
	});

	it("blindly replaces quota/auth deaths instead of classifying their cause", async () => {
		const store = await engineRunWithImplement();
		const result = store.rollbackDeadWorkflowNodeExecution({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			deadExecutionId: "implement-dead",
			newExecutionId: "implement-retry-1",
			reason: "quota_or_auth_failure",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			livenessEvidence: {
				liveness: "dead",
				observedAt: "2026-07-20T00:30:00.000Z",
			},
			now: "2026-07-20T00:30:00.000Z",
		});
		expect(result).toMatchObject({ ok: true, launchOrdinal: 2 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(2);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		store.close();
	});

	it("checkpoints terminal done-node divergence in the same commit as its event", async () => {
		const store = await engineRunWithImplement();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "implement-dead",
		});
		const candidates = store.listWorkflowDivergenceCandidates();
		expect(candidates).toEqual([
			expect.objectContaining({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-dead",
				sessionStatus: "failed",
			}),
		]);
		const observed = candidates[0]!;
		expect(
			store.commitWorkflowDivergenceObservation({
				...observed,
				observedStatus: observed.sessionStatus,
				observedLifecycleRevision: observed.lifecycleRevision,
				now: "2026-07-20T00:40:00.000Z",
			}),
		).toEqual({ ok: true, divergence: true, deduped: false });
		expect(store.listWorkflowDivergenceCandidates()).toEqual([]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "workflow_node_session_divergence"),
		).toHaveLength(1);
		store.close();
	});
});
