import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const root of cleanups.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

const workflowEnv = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

function createGeneralizedRun(
	store: StateStore,
	options: { runId?: string; executionId?: string } = {},
) {
	const runId = options.runId ?? "run-fly1427";
	const executionId = options.executionId ?? "exec-fly1427";
	const root = mkdtempSync(join(tmpdir(), "fly1427-terminal-run-"));
	cleanups.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: `tpl-${runId}`, revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId,
		issueId: "FLY-1427",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId,
			nodeId: "execute",
			executionId,
			attempt: 1,
			now: "2026-07-22T00:00:00.000Z",
			expiresAt: "2026-07-22T01:00:00.000Z",
			absoluteDeadlineAt: "2026-07-23T00:00:00.000Z",
			env: workflowEnv,
		}),
	).toMatchObject({ ok: true });
	return { runId, executionId };
}

function seedSession(store: StateStore, executionId: string, status: string) {
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-1427",
		project_name: "flywheel",
		status,
		workflow_node_id: "execute",
		session_stage: "started",
	});
}

describe("FLY-1427 enrolled terminal signal immunity", () => {
	it("FLY-2018: terminal failure metadata participates in replay equality", async () => {
		const store = await StateStore.create(":memory:");
		const { executionId } = createGeneralizedRun(store);
		seedSession(store, executionId, "running");
		const base = {
			executionId,
			sourceEventId: "teardown-fly2018",
			signal: "failed" as const,
			failureKind: "goal_blocked",
			lastError: "refresh token revoked",
			failureClass: "environment" as const,
			failureCode: "codex:unauthorized",
			source: "direct-event-sink",
		};

		expect(store.recordEnrolledTerminalSignal(base)).toMatchObject({
			ok: true,
			idempotentReplay: false,
		});
		expect(
			store.recordEnrolledTerminalSignal({
				...base,
				failureClass: undefined,
				failureCode: undefined,
			}),
		).toEqual({ ok: false, reason: "terminal_signal_conflict" });
		expect(store.getEventPayloadById(base.sourceEventId)).toEqual({
			failureKind: "goal_blocked",
			lastError: "refresh token revoked",
			failureClass: "environment",
			failureCode: "codex:unauthorized",
		});
		store.close();
	});

	it.each([
		["classified-first", true],
		["absent-first", false],
	] as const)(
		"FLY-2018: %s canonical classification never drifts on a later source event",
		async (_label, classifiedFirst) => {
			const store = await StateStore.create(":memory:");
			const { executionId } = createGeneralizedRun(store);
			seedSession(store, executionId, "running");
			const loud = vi.spyOn(console, "error").mockImplementation(() => {});
			const classified = {
				failureClass: "environment" as const,
				failureCode: "codex:unauthorized",
			};
			for (const [index, hasClassification] of [
				classifiedFirst,
				!classifiedFirst,
			].entries()) {
				expect(
					store.recordEnrolledTerminalSignal({
						executionId,
						sourceEventId: `canonical-${index}`,
						signal: "failed",
						failureKind: "goal_blocked",
						lastError: "blocked",
						...(hasClassification ? classified : {}),
						source: "direct-event-sink",
					}),
				).toMatchObject({ ok: true });
			}

			expect(
				store.getWorkflowExecutionTerminalFailureCanonical(executionId),
			).toEqual({
				failureClass: classifiedFirst ? "environment" : null,
				failureCode: classifiedFirst ? "codex:unauthorized" : null,
				lastError: "blocked",
			});
			expect(loud).toHaveBeenCalledWith(
				expect.stringContaining("canonical preserved"),
			);
			store.close();
		},
	);

	it.each(["terminated", "shelved", "approved"])(
		"preserves %s while recording the teardown fact and replay metadata",
		async (terminalStatus) => {
			const store = await StateStore.create(":memory:");
			const { runId, executionId } = createGeneralizedRun(store);
			seedSession(store, executionId, terminalStatus);
			const before = store.getSession(executionId)!;
			const beforeRevision = store.getLifecycleRevision(executionId);

			const first = store.recordEnrolledTerminalSignal({
				executionId,
				sourceEventId: "teardown-fly1427",
				signal: "completed",
				source: "direct-event-sink",
				now: "2026-07-22T00:01:00.000Z",
			});
			expect(first).toMatchObject({
				ok: true,
				idempotentReplay: false,
				status: "completed",
				attemptedStatus: "completed",
				effectiveStatus: terminalStatus,
				statusPreserved: true,
			});
			expect(store.getSession(executionId)).toMatchObject({
				status: terminalStatus,
				terminal_at: before.terminal_at,
			});
			expect(store.getLifecycleRevision(executionId)).toBe(beforeRevision);
			expect(store.getEventPayloadById("teardown-fly1427")).toEqual({
				failureKind: null,
				lastError: null,
			});
			const fact = store
				.listWorkflowRunEvents(runId)
				.find((event) => event.kind === "generalized_teardown_recorded");
			expect(fact?.payload).toMatchObject({
				attemptedStatus: "completed",
				effectiveStatus: terminalStatus,
				statusPreserved: true,
			});

			const replay = store.recordEnrolledTerminalSignal({
				executionId,
				sourceEventId: "teardown-fly1427",
				signal: "completed",
				source: "direct-event-sink",
				now: "2026-07-22T00:01:00.000Z",
			});
			expect(replay).toMatchObject({
				ok: true,
				idempotentReplay: true,
				attemptedStatus: "completed",
				effectiveStatus: terminalStatus,
				statusPreserved: true,
			});
			expect(
				store
					.listWorkflowRunEvents(runId)
					.filter((event) => event.kind === "generalized_teardown_recorded"),
			).toHaveLength(1);
			expect(store.getLifecycleRevision(executionId)).toBe(beforeRevision);
			store.close();
		},
	);

	it.each([
		["failed", "completed"],
		["running", "completed"],
	] as const)(
		"keeps the existing projection behavior for %s → %s",
		async (fromStatus, attemptedStatus) => {
			const store = await StateStore.create(":memory:");
			const { executionId } = createGeneralizedRun(store);
			seedSession(store, executionId, fromStatus);
			const result = store.recordEnrolledTerminalSignal({
				executionId,
				sourceEventId: `teardown-${fromStatus}`,
				signal: "completed",
				source: "direct-event-sink",
			});
			expect(result).toMatchObject({
				ok: true,
				attemptedStatus,
				effectiveStatus: attemptedStatus,
				statusPreserved: false,
			});
			expect(store.getSession(executionId)?.status).toBe(attemptedStatus);
			store.close();
		},
	);
});

describe("FLY-1427 enrolled completion transaction immunity", () => {
	it("rejects fresh completion before writing a receipt or advancing the node", async () => {
		const store = await StateStore.create(":memory:");
		const { runId, executionId } = createGeneralizedRun(store);
		seedSession(store, executionId, "terminated");
		const beforeRevision = store.getLifecycleRevision(executionId);

		expect(
			store.commitEnrolledCompletion({
				executionId,
				route: "needs_review",
				sourceEventId: "completion-fly1427",
				completionSubmission: { decision: { route: "needs_review" } },
				now: "2026-07-22T00:02:00.000Z",
			}),
		).toEqual({
			ok: false,
			reason: "transition_refused",
			detail: {
				transitionReason: "engine_invariant:writer_session_terminal",
				alertPending: true,
			},
		});
		expect(
			store.getWorkflowNodeCompletion(runId, "execute", 1),
		).toBeUndefined();
		expect(store.getWorkflowRunNode(runId, "execute", 1)?.state).not.toBe(
			"done",
		);
		expect(store.getSession(executionId)?.status).toBe("terminated");
		expect(store.getLifecycleRevision(executionId)).toBe(beforeRevision);
		store.close();
	});

	it("protects a terminated session when replaying a legacy receipt", async () => {
		const store = await StateStore.create(":memory:");
		const { runId, executionId } = createGeneralizedRun(store);
		seedSession(store, executionId, "terminated");
		const submission = { decision: { route: "needs_review" } };
		const raw = store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		raw.db.run(
			`INSERT INTO workflow_node_completion
			   (run_id, node_id, attempt, execution_id, route, event_uid,
			    source_event_id, completion_submission_digest, completed_at)
			 VALUES (?, 'execute', 1, ?, 'needs_review', ?, ?, ?, ?)`,
			[
				runId,
				executionId,
				`wfc:${runId}:execute:1`,
				"legacy-source-event",
				canonicalSubmissionDigest(submission),
				"2026-07-22T00:02:00.000Z",
			],
		);
		const beforeRevision = store.getLifecycleRevision(executionId);

		expect(
			store.commitEnrolledCompletion({
				executionId,
				route: "needs_review",
				sourceEventId: "replay-source-event",
				completionSubmission: submission,
				now: "2026-07-22T00:03:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(store.getSession(executionId)?.status).toBe("terminated");
		expect(store.getLifecycleRevision(executionId)).toBe(beforeRevision);
		expect(store.getWorkflowRunNode(runId, "execute", 1)?.state).toBe("done");
		store.close();
	});
});

describe("FLY-1427 bounded production correction", () => {
	const overwrittenExecutionIds = [
		"88d06933-5795-4d21-aea0-db51930d7171",
		"57e09567-68ba-49de-9448-9bcbc143c1d5",
		"a955657f-010b-4527-99c4-5c0ef6714e8d",
		"7b76d2a0-5a0a-45f1-9d29-09f14b57846c",
		"c80fad41-998b-4843-b756-8886547049a8",
	] as const;

	it("corrects exactly the five known rows once and leaves unrelated staleness untouched", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1427-backfill-"));
		cleanups.push(root);
		const dbPath = join(root, "state.db");
		let store = await StateStore.create(dbPath);
		for (const executionId of overwrittenExecutionIds) {
			store.upsertSession({
				execution_id: executionId,
				issue_id: "FLY-1412",
				project_name: "flywheel",
				status: "completed",
				session_stage: "started",
			});
		}
		store.upsertSession({
			execution_id: "unrelated-stale-completed",
			issue_id: "FLY-OLD",
			project_name: "flywheel",
			status: "completed",
			session_stage: "started",
		});
		const before = new Map(
			overwrittenExecutionIds.map((executionId) => [
				executionId,
				{
					revision: store.getLifecycleRevision(executionId),
					terminalAt: store.getSession(executionId)?.terminal_at,
				},
			]),
		);
		store.close();

		store = await StateStore.create(dbPath);
		for (const executionId of overwrittenExecutionIds) {
			expect(store.getSession(executionId)).toMatchObject({
				status: "terminated",
				session_stage: "started",
			});
			expect(store.getLifecycleRevision(executionId)).toBe(
				(before.get(executionId)?.revision ?? 0) + 1,
			);
			expect(store.getSession(executionId)?.terminal_at).toBe(
				before.get(executionId)?.terminalAt,
			);
			expect(store.getEventPayloadById(`fly1427:${executionId}`)).toEqual({
				from: "completed",
				to: "terminated",
				reason: "FLY-1427",
			});
		}
		expect(store.getSession("unrelated-stale-completed")).toMatchObject({
			status: "completed",
			session_stage: "started",
		});
		store.close();

		store = await StateStore.create(dbPath);
		for (const executionId of overwrittenExecutionIds) {
			expect(store.getLifecycleRevision(executionId)).toBe(
				(before.get(executionId)?.revision ?? 0) + 1,
			);
			expect(
				store
					.getEventsByExecution(executionId)
					.filter((event) => event.event_type === "state_correction"),
			).toHaveLength(1);
		}
		store.close();
	});
});
