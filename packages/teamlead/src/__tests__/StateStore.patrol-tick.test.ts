import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1687 StateStore patrol read models", () => {
	let store: StateStore;
	let db: { run(sql: string, params?: unknown[]): void };

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		db = (
			store as unknown as { db: { run(sql: string, params?: unknown[]): void } }
		).db;
	});

	afterEach(() => store.close());

	it("returns exactly the six non-terminal statuses for one project", () => {
		const included = [
			"running",
			"ship_parked",
			"awaiting_review",
			"approved_to_ship",
			"pending",
			"design_done",
		];
		for (const [index, status] of [
			...included,
			"completed",
			"failed",
		].entries()) {
			store.upsertSession({
				execution_id: `exec-${index}`,
				issue_id: `issue-${index}`,
				project_name: "foo_bar",
				status,
			});
		}
		store.upsertSession({
			execution_id: "other-project",
			issue_id: "other-issue",
			project_name: "fooxbar",
			status: "running",
		});

		expect(
			store
				.getPatrolRosterSessions("foo_bar")
				.map((session) => session.status)
				.sort(),
		).toEqual([...included].sort());
	});

	it("scopes the chain head by exact session_key, including underscore projects", () => {
		const exact = "patrol:foo_bar:eng-lead";
		const lookalike = "patrol:fooxbar:eng-lead";
		const first = store.appendLeadEvent(
			"eng-lead",
			"tick-exact-1",
			"patrol_tick",
			JSON.stringify({
				event_type: "patrol_tick",
				execution_id: "x",
				issue_id: "",
			}),
			exact,
		);
		store.appendLeadEvent(
			"eng-lead",
			"tick-lookalike",
			"patrol_tick",
			JSON.stringify({
				event_type: "patrol_tick",
				execution_id: "y",
				issue_id: "",
			}),
			lookalike,
		);
		const latest = store.appendLeadEvent(
			"eng-lead",
			"tick-exact-2",
			"patrol_tick",
			JSON.stringify({
				event_type: "patrol_tick",
				execution_id: "z",
				issue_id: "",
			}),
			exact,
		);

		expect(first).not.toBe(latest);
		expect(store.getLatestPatrolTickEvent("eng-lead", exact)?.seq).toBe(latest);
		expect(
			store.getLatestPatrolTickEvent("eng-lead", lookalike)?.event_id,
		).toBe("tick-lookalike");
	});

	it("uses the patrol composite index without a temp ORDER BY b-tree", () => {
		const db = (
			store as unknown as {
				db: {
					exec(sql: string): Array<{
						columns: string[];
						values: unknown[][];
					}>;
				};
			}
		).db;
		const plan = db.exec(
			`EXPLAIN QUERY PLAN
			 SELECT * FROM lead_events
			 WHERE lead_id = 'eng-lead'
			   AND event_type = 'patrol_tick'
			   AND session_key = 'patrol:foo_bar:eng-lead'
			 ORDER BY seq DESC LIMIT 1`,
		)[0];
		const detailIndex = plan?.columns.indexOf("detail") ?? -1;
		const details =
			detailIndex < 0
				? ""
				: (plan?.values ?? [])
						.map((row) => String(row[detailIndex]))
						.join("\n");
		expect(details).toContain("idx_lead_events_patrol");
		expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("reads the complete project-scoped loop ledger without hiding an older open rework route", () => {
		const now = "2026-08-20T12:00:00.000Z";
		for (const [runId, projectName, status] of [
			["run-active", "foo_bar", "active"],
			["run-held", "foo_bar", "held"],
			["run-other", "other_project", "active"],
		] as const) {
			db.run(
				`INSERT INTO workflow_run
				   (run_id, issue_id, project_name, current_node_id, current_qa_attempt,
				    status, created_at)
				 VALUES (?, 'issue-1', ?, 'implement', 2, ?, ?)`,
				[runId, projectName, status, now],
			);
		}
		db.run(
			`INSERT INTO workflow_run_node
			   (run_id, node_id, attempt, state, execution_id, started_at, ended_at)
			 VALUES
			   ('run-active', 'implement', 1, 'done', 'exec-old', ?, ?),
			   ('run-active', 'implement', 2, 'running', 'exec-current', ?, NULL),
			   ('run-active', 'qa', 1, 'pending', NULL, ?, NULL),
			   ('run-held', 'qa', 1, 'running', 'exec-held', ?, NULL)`,
			[now, now, now, now, now],
		);
		db.run(
			`INSERT INTO workflow_actor
			   (execution_id, project_name, issue_id, role, created_at)
			 VALUES ('exec-current', 'foo_bar', 'issue-1', 'implement', ?)`,
			[now],
		);
		db.run(
			`INSERT INTO workflow_rework_request
			   (request_id, run_id, source_event_id, authority, source_node_id,
			    source_attempt, base_revision, authority_context_json,
			    authority_context_digest, requested_at)
			 VALUES ('request-1', 'run-active', 'source-1', 'qa', 'qa', 1,
			         'base', '{}', 'digest', ?)`,
			[now],
		);
		for (const [revision, nodeId, attempt] of [
			[1, "implement", 2],
			[2, "qa", 3],
		] as const) {
			db.run(
				`INSERT INTO workflow_rework_route_revision
				   (request_id, revision, target_node_id, target_attempt,
				    preferred_actor_execution_id, invalidation_scope_json,
				    verification_policy_json, interpreted_by, interpretation_reason,
				    created_at)
				 VALUES ('request-1', ?, ?, ?, 'exec-current', '[]', '[]',
				         'test', 'test', ?)`,
				[revision, nodeId, attempt, now],
			);
		}
		db.run(
			`INSERT INTO workflow_rework_delivery
			   (request_id, route_revision, state, updated_at)
			 VALUES ('request-1', 1, 'held', ?)`,
			[now],
		);
		for (const [operationId, projectName, supersededAt] of [
			["land-open", "foo_bar", null],
			["land-superseded", "foo_bar", now],
			["land-other", "other_project", null],
		] as const) {
			db.run(
				`INSERT INTO land_operation
				   (operation_id, run_id, issue_id, project_name, pr_number,
				    approved_head, state, current_step, superseded_at, created_at,
				    updated_at)
				 VALUES (?, 'run-active', 'issue-1', ?, ?, 'head', 'held', 'merge',
				         ?, ?, ?)`,
				[
					operationId,
					projectName,
					operationId === "land-open"
						? 1
						: operationId === "land-superseded"
							? 2
							: 3,
					supersededAt,
					now,
					now,
				],
			);
		}
		db.run(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, created_at, updated_at)
			 VALUES ('run-active', 'qa', 1, 'head', 'exec-current', 'question-1',
			         'approved', 'completed', ?, ?)`,
			[now, now],
		);
		db.run(
			`INSERT INTO workflow_carrier_delivery
			   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
			    source_execution_id, carrier_activation_id, state, created_at,
			    updated_at)
			 VALUES ('question-1', 'run-active', 'qa', 1, 'head', 'exec-current',
			         'carrier-1', 'held', ?, ?)`,
			[now, now],
		);

		expect(store.getPatrolWorkflowRuns("foo_bar", "issue-1")).toEqual([
			{
				runId: "run-active",
				status: "active",
				currentNodeId: "implement",
			},
			{
				runId: "run-held",
				status: "held",
				currentNodeId: "implement",
			},
		]);
		expect(store.listActiveNodeAttempts("run-active")).toEqual([
			{
				runId: "run-active",
				nodeId: "implement",
				attempt: 2,
				state: "running",
				executionId: "exec-current",
			},
			{
				runId: "run-active",
				nodeId: "qa",
				attempt: 1,
				state: "pending",
				executionId: null,
			},
		]);
		expect(store.getLatestNodeAttempt("run-active", "implement")).toEqual({
			runId: "run-active",
			nodeId: "implement",
			attempt: 2,
			state: "running",
			executionId: "exec-current",
		});
		expect(store.listOpenReworkDeliveries("run-active")).toEqual([
			{
				runId: "run-active",
				state: "held",
				targetNodeId: "implement",
				targetAttempt: 2,
				preferredActorExecutionId: "exec-current",
				routeRevision: 1,
			},
		]);
		db.run("PRAGMA foreign_keys = OFF");
		db.run(
			`INSERT INTO workflow_rework_request
			   (request_id, run_id, source_event_id, authority, source_node_id,
			    source_attempt, base_revision, authority_context_json,
			    authority_context_digest, requested_at)
			 VALUES ('request-orphan', 'run-active', 'source-orphan', 'qa', 'qa', 1,
			         'base', '{}', 'digest', ?)`,
			[now],
		);
		db.run(
			`INSERT INTO workflow_rework_delivery
			   (request_id, route_revision, state, updated_at)
			 VALUES ('request-orphan', 7, 'held', ?)`,
			[now],
		);
		db.run("PRAGMA foreign_keys = ON");
		expect(store.listOpenReworkDeliveries("run-active")).toEqual([
			{
				runId: "run-active",
				state: "held",
				targetNodeId: "implement",
				targetAttempt: 2,
				preferredActorExecutionId: "exec-current",
				routeRevision: 1,
			},
			{
				runId: "run-active",
				state: "held",
				targetNodeId: null,
				targetAttempt: null,
				preferredActorExecutionId: null,
				routeRevision: 7,
			},
		]);
		expect(store.listOpenLandOperations("foo_bar", "issue-1")).toEqual([
			{ state: "held", currentStep: "merge", supersededAt: null },
		]);
		expect(store.listOpenGateAuthorities("run-active")).toEqual([
			{ runId: "run-active", kind: "gate", state: "approved" },
			{ runId: "run-active", kind: "carrier", state: "held" },
		]);
	});
});
