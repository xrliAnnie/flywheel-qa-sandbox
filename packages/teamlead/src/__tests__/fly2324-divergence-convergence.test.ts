import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { WorkflowEngineDispatcher } from "../bridge/workflow-engine-dispatcher.js";
import { StateStore } from "../StateStore.js";

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function addDoneNode(
	store: StateStore,
	runId: string,
	status: "active" | "held" | "completed" | "terminated",
): void {
	const executionId = `execution-${runId}`;
	store.createWorkflowRun({
		runId,
		issueId: `ISSUE-${runId}`,
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: `ISSUE-${runId}`,
		project_name: "flywheel",
		status: "failed",
		workflow_node_id: "implement",
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId,
	});
	rawDb(store)
		.prepare(
			"UPDATE workflow_run SET engine_owned = 1, status = ? WHERE run_id = ?",
		)
		.run(status, runId);
}

describe("FLY-2324 divergence convergence", () => {
	it("only scans active or held workflow runs", async () => {
		const store = await StateStore.create(":memory:");
		try {
			for (const status of [
				"active",
				"held",
				"completed",
				"terminated",
			] as const) {
				addDoneNode(store, `run-${status}`, status);
			}

			expect(
				store
					.listWorkflowDivergenceCandidates()
					.map(({ runId }) => runId)
					.sort(),
			).toEqual(["run-active", "run-held"]);
		} finally {
			store.close();
		}
	});

	it("records each lifecycle revision once without reusing an event UID", async () => {
		const store = await StateStore.create(":memory:");
		try {
			addDoneNode(store, "run-revision", "active");
			const first = store.listWorkflowDivergenceCandidates()[0]!;
			expect(
				store.commitWorkflowDivergenceObservation({
					...first,
					observedStatus: first.sessionStatus,
					observedLifecycleRevision: first.lifecycleRevision,
					now: "2026-09-04T08:00:00.000Z",
				}),
			).toEqual({ ok: true, divergence: true, deduped: false });

			store.upsertSession({
				execution_id: "execution-run-revision",
				issue_id: "ISSUE-run-revision",
				project_name: "flywheel",
				status: "terminated",
				workflow_node_id: "implement",
			});
			const second = store.listWorkflowDivergenceCandidates()[0]!;
			expect(second.lifecycleRevision).toBeGreaterThan(first.lifecycleRevision);
			expect(
				store.commitWorkflowDivergenceObservation({
					...second,
					observedStatus: second.sessionStatus,
					observedLifecycleRevision: second.lifecycleRevision,
					now: "2026-09-04T08:01:00.000Z",
				}),
			).toEqual({ ok: true, divergence: true, deduped: false });
			expect(store.listWorkflowDivergenceCandidates()).toEqual([]);
			expect(
				store
					.listWorkflowRunEvents("run-revision")
					.filter((event) => event.kind === "workflow_node_session_divergence"),
			).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	it("persists an irreconcilable divergence UID conflict before checkpointing it once", async () => {
		const store = await StateStore.create(":memory:");
		try {
			addDoneNode(store, "run-conflict", "active");
			const candidate = store.listWorkflowDivergenceCandidates()[0]!;
			rawDb(store)
				.prepare(
					`INSERT INTO workflow_run_event
					   (run_id, seq, event_uid, kind, node_id, execution_id, payload, at)
					 SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, 'workflow_node_session_divergence',
					        'implement', ?, '{}', ?
					   FROM workflow_run_event WHERE run_id = ?`,
				)
				.run(
					"run-conflict",
					`divergence:run-conflict:implement:1:${candidate.lifecycleRevision}`,
					"execution-run-conflict",
					"2026-09-04T08:00:00.000Z",
					"run-conflict",
				);

			expect(
				store.commitWorkflowDivergenceObservation({
					...candidate,
					observedStatus: candidate.sessionStatus,
					observedLifecycleRevision: candidate.lifecycleRevision,
					now: "2026-09-04T08:01:00.000Z",
				}),
			).toEqual({ ok: true, divergence: true, deduped: false });
			expect(
				store
					.listWorkflowRunEvents("run-conflict")
					.filter(
						(event) =>
							event.kind === "workflow_node_session_divergence_conflict",
					),
			).toEqual([
				expect.objectContaining({
					event_uid: `divergence_conflict:run-conflict:implement:1:${candidate.lifecycleRevision}`,
				}),
			]);
			expect(store.listWorkflowDivergenceCandidates()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("checkpoints once when both divergence event identities already conflict", async () => {
		const store = await StateStore.create(":memory:");
		try {
			addDoneNode(store, "run-double-conflict", "active");
			const candidate = store.listWorkflowDivergenceCandidates()[0]!;
			const insertConflictingEvent = (eventUid: string) =>
				rawDb(store)
					.prepare(
						`INSERT INTO workflow_run_event
						   (run_id, seq, event_uid, kind, node_id, execution_id, payload, at)
						 SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, 'workflow_node_session_divergence',
						        'implement', ?, '{}', ?
						   FROM workflow_run_event WHERE run_id = ?`,
					)
					.run(
						"run-double-conflict",
						eventUid,
						"execution-run-double-conflict",
						"2026-09-04T08:00:00.000Z",
						"run-double-conflict",
					);
			insertConflictingEvent(
				`divergence:run-double-conflict:implement:1:${candidate.lifecycleRevision}`,
			);
			insertConflictingEvent(
				`divergence_conflict:run-double-conflict:implement:1:${candidate.lifecycleRevision}`,
			);

			expect(
				store.commitWorkflowDivergenceObservation({
					...candidate,
					observedStatus: candidate.sessionStatus,
					observedLifecycleRevision: candidate.lifecycleRevision,
					now: "2026-09-04T08:01:00.000Z",
				}),
			).toEqual({ ok: true, divergence: true, deduped: true });
			expect(store.listWorkflowDivergenceCandidates()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("does not report a stale observation race as durably checkpointed", async () => {
		const store = await StateStore.create(":memory:");
		try {
			addDoneNode(store, "run-stale", "active");
			const candidate = store.listWorkflowDivergenceCandidates()[0]!;
			vi.spyOn(store, "listWorkflowDivergenceCandidates").mockReturnValue([
				candidate,
			]);
			vi.spyOn(store, "commitWorkflowDivergenceObservation").mockReturnValue({
				ok: false,
				reason: "stale_divergence_observation",
			});
			const logs: string[] = [];
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: {
					start: vi.fn(),
					getInflightCount: () => 0,
					validateAgentName: () => ({ ok: true }),
				} as never,
				log: (message) => logs.push(message),
			}).reconcile();

			expect(logs).toEqual([]);
		} finally {
			store.close();
		}
	});
});
