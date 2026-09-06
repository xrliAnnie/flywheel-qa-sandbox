import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	CMUX_LIVE_SESSION_STATUSES,
	OPERATIONAL_TERMINAL_STATUSES,
} from "../operational-terminal-status.js";
import { StateStore } from "../StateStore.js";

const HEAD = "a".repeat(40);
const NOW = "2026-09-06T08:00:00.000Z";
const stores: StateStore[] = [];
const roots: string[] = [];

function raw(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function founderGate(
	input: {
		dbPath?: string;
		runId?: string;
		questionId?: string;
		createdAt?: string;
		engineOwned?: boolean;
		runStatus?: string;
		currentNodeId?: string;
		nodeState?: string;
		nodeEndedAt?: string;
		holderState?: string;
		sessionStatus?: string;
	} = {},
): Promise<StateStore> {
	const runId = input.runId ?? "run-1";
	const questionId = input.questionId ?? "question-1";
	const executionId = `${runId}-qa`;
	const store = await StateStore.create(input.dbPath ?? ":memory:");
	stores.push(store);
	store.createWorkflowRun({
		runId,
		issueId: `FLY-${runId.replace(/\D/g, "") || "2112"}`,
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	raw(store)
		.prepare(
			`UPDATE workflow_run
			    SET engine_owned = ?, status = ?, current_node_id = ?, created_at = ?
			  WHERE run_id = ?`,
		)
		.run(
			input.engineOwned === false ? 0 : 1,
			input.runStatus ?? "active",
			input.currentNodeId ?? "founder_gate",
			input.createdAt ?? "2026-09-06T07:00:00.000Z",
			runId,
		);
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "founder_gate",
		attempt: 1,
		state: input.nodeState ?? "review",
		executionId,
		...(input.nodeEndedAt ? { endedAt: input.nodeEndedAt } : {}),
	});
	store.ensureWorkflowGateHolder({
		runId,
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: HEAD,
		sourceExecutionId: executionId,
		questionId,
		now: "2026-09-06T07:01:00.000Z",
	});
	for (const stage of [
		"question_written",
		"session_bound",
		"card_posted",
		"card_bound",
		"completed",
	] as const) {
		expect(
			store.advanceWorkflowGateHolderMaterialization({
				questionId,
				stage,
				...(stage === "card_posted"
					? { cardMessageId: `card-${questionId}` }
					: {}),
				now: "2026-09-06T07:02:00.000Z",
			}),
		).toMatchObject({ ok: true });
	}
	if (input.holderState && input.holderState !== "awaiting_review") {
		raw(store)
			.prepare(
				"UPDATE workflow_gate_holder SET state = ? WHERE question_id = ?",
			)
			.run(input.holderState, questionId);
	}
	if (input.sessionStatus) {
		store.upsertSession({
			execution_id: executionId,
			issue_id: `FLY-${runId.replace(/\D/g, "") || "2112"}`,
			project_name: "flywheel",
			status: input.sessionStatus,
			workflow_node_id: "founder_gate",
		});
	}
	return store;
}

function insertShipTarget(store: StateStore, questionId = "question-1"): void {
	raw(store)
		.prepare(
			`INSERT INTO workflow_ship_target_binding
			 (approve_question_id, run_id, target_repo_path, target_repo_identity,
			  probe_repo_slug, frozen_head_sha, worktree_binding_generation)
			 VALUES (?, 'run-1', '.', '__main__', 'acme/flywheel', ?, 'generation-1')`,
		)
		.run(questionId, HEAD);
}

function insertPendingDispatch(store: StateStore): void {
	raw(store)
		.prepare(
			`INSERT INTO workflow_side_effect_ledger
			 (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state)
			 VALUES ('run-1', 'founder_gate', 1, 'dispatch', 1,
			         'replacement-1', 'intent_recorded')`,
		)
		.run();
}

function insertInflightRework(store: StateStore): void {
	const db = raw(store);
	db.prepare(
		`INSERT INTO workflow_actor
		 (execution_id, project_name, issue_id, role, created_at)
		 VALUES ('replacement-1', 'flywheel', 'FLY-2112', 'implement', ?)`,
	).run(NOW);
	db.prepare(
		`INSERT INTO workflow_rework_request
		 (request_id, run_id, source_event_id, authority, source_node_id,
		  source_attempt, base_revision, authority_context_json,
		  authority_context_digest, requested_at)
		 VALUES ('rework-1', 'run-1', 'source-1', 'engine', 'founder_gate', 1,
		         'base', '{}', 'digest', ?)`,
	).run(NOW);
	db.prepare(
		`INSERT INTO workflow_rework_route_revision
		 (request_id, revision, target_node_id, target_attempt,
		  preferred_actor_execution_id, invalidation_scope_json,
		  verification_policy_json, interpreted_by, interpretation_reason, created_at)
		 VALUES ('rework-1', 1, 'founder_gate', 2, 'replacement-1', '[]', '[]',
		         'engine', 'replacement', ?)`,
	).run(NOW);
	db.prepare(
		`INSERT INTO workflow_rework_delivery
		 (request_id, route_revision, state, updated_at)
		 VALUES ('rework-1', 1, 'pending', ?)`,
	).run(NOW);
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("FLY-2112 sessionless founder-gate closeout", () => {
	it("atomically terminates the run and revokes every current gate surface", async () => {
		const store = await founderGate();
		insertShipTarget(store);

		expect(store.listSessionlessWorkflowGateCandidates()).toEqual([
			expect.objectContaining({
				runId: "run-1",
				questionId: "question-1",
				projectName: "flywheel",
			}),
		]);
		expect(
			store.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toEqual({ ok: true, idempotentReplay: false });

		expect(store.getWorkflowRun("run-1")?.status).toBe("terminated");
		expect(store.getWorkflowRunNode("run-1", "founder_gate", 1)).toMatchObject({
			state: "superseded",
			ended_at: NOW,
		});
		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				state: "superseded",
				superseded_from_state: "awaiting_review",
				superseded_reason: "run_sessionless",
				card_void_state: "pending",
			},
		);
		expect(
			store.getWorkflowShipTargetBinding("question-1")?.superseded_at,
		).toBe(NOW);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "run_terminated_sessionless_gate"),
		).toHaveLength(1);
		const diagnostic = store.getWorkflowRunDiagnostic({
			runId: "run-1",
			evidence: [],
			now: NOW,
		});
		expect(diagnostic).toMatchObject({
			ok: true,
			dto: {
				latest_termination: {
					reason: "run_sessionless",
					closeout_kind: null,
				},
			},
		});
		expect(store.listPendingSessionlessGateMailboxRetirements()).toEqual([
			expect.objectContaining({
				runId: "run-1",
				questionId: "question-1",
				projectName: "flywheel",
			}),
		]);

		expect(
			store.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: "2026-09-06T08:01:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "run_terminated_sessionless_gate"),
		).toHaveLength(1);
	});

	it.each([...OPERATIONAL_TERMINAL_STATUSES])(
		"treats terminal session status %s as sessionless",
		async (status) => {
			const store = await founderGate({ sessionStatus: status });
			expect(store.listSessionlessWorkflowGateCandidates()).toHaveLength(1);
		},
	);

	it.each([...CMUX_LIVE_SESSION_STATUSES])(
		"lets live session status %s veto closeout",
		async (status) => {
			const store = await founderGate({ sessionStatus: status });
			expect(store.listSessionlessWorkflowGateCandidates()).toEqual([]);
			expect(
				store.terminateSessionlessWorkflowGate({
					runId: "run-1",
					questionId: "question-1",
					now: NOW,
				}),
			).toEqual({ ok: false, reason: "live_session" });
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		},
	);

	it("rechecks live-session and rework races inside the commit transaction", async () => {
		const liveRace = await founderGate();
		expect(liveRace.listSessionlessWorkflowGateCandidates()).toHaveLength(1);
		liveRace.upsertSession({
			execution_id: "run-1-qa",
			issue_id: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		expect(
			liveRace.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "live_session" });

		const reworkRace = await founderGate();
		expect(reworkRace.listSessionlessWorkflowGateCandidates()).toHaveLength(1);
		insertInflightRework(reworkRace);
		expect(
			reworkRace.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "rework_delivery_inflight" });
	});

	it("replays from durable terminal shape without duplicating its event", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2112-closeout-"));
		roots.push(root);
		const dbPath = join(root, "state.db");
		const store = await founderGate({ dbPath });
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const seeded = await StateStore.create(dbPath);
		stores.push(seeded);

		expect(
			seeded.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		seeded.close();
		stores.splice(stores.indexOf(seeded), 1);

		const reopened = await StateStore.create(dbPath);
		stores.push(reopened);
		expect(
			reopened.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: "2026-09-06T08:05:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			reopened
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "run_terminated_sessionless_gate"),
		).toHaveLength(1);
	});

	it("cancels a carrier delivery with an honest automatic-closeout audit cause", async () => {
		const store = await founderGate();
		raw(store)
			.prepare(
				`INSERT INTO workflow_carrier_delivery
				 (question_id, run_id, gate_node_id, gate_attempt, approved_head,
				  source_execution_id, carrier_activation_id, state, created_at, updated_at)
				 VALUES ('question-1', 'run-1', 'founder_gate', 1, ?, 'run-1-qa',
				         'carrier-activation-1', 'pending', ?, ?)`,
			)
			.run(HEAD, NOW, NOW);

		expect(
			store.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toMatchObject({ ok: true });
		expect(
			raw(store)
				.prepare(
					"SELECT state, last_error FROM workflow_carrier_delivery WHERE question_id = 'question-1'",
				)
				.get(),
		).toEqual({ state: "completed", last_error: "run_sessionless" });
		const event = store
			.listWorkflowRunEvents("run-1")
			.find((candidate) => candidate.kind === "carrier_delivery_cancelled");
		expect(event?.payload).toMatchObject({
			closeoutCause: "sessionless_closeout",
			reason: "run_sessionless",
		});
		expect(event?.payload).not.toHaveProperty("operatorAction");
	});

	it("vetoes pending dispatches and stale running attempts", async () => {
		const pending = await founderGate();
		insertPendingDispatch(pending);
		expect(pending.listSessionlessWorkflowGateCandidates()).toEqual([]);
		expect(
			pending.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "pending_dispatch_intent" });

		const running = await founderGate();
		running.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "running",
			executionId: "old-implement",
		});
		expect(running.listSessionlessWorkflowGateCandidates()).toEqual([]);
		expect(
			running.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toEqual({ ok: false, reason: "running_node" });
	});

	it.each([
		["legacy run", { engineOwned: false }],
		["inactive run", { runStatus: "held" }],
		["non-current gate", { currentNodeId: "land" }],
		["ended gate node", { nodeEndedAt: NOW }],
		["wrong node state", { nodeState: "done" }],
		["wrong holder state", { holderState: "approved" }],
	] as const)("rejects %s", async (_label, options) => {
		const store = await founderGate(options);
		expect(store.listSessionlessWorkflowGateCandidates()).toEqual([]);
		expect(
			store.terminateSessionlessWorkflowGate({
				runId: "run-1",
				questionId: "question-1",
				now: NOW,
			}),
		).toMatchObject({ ok: false });
	});

	it("applies LIMIT after live-session vetoes so healthy gates cannot starve zombies", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		for (let index = 0; index < 21; index += 1) {
			const runId = `run-live-${String(index).padStart(2, "0")}`;
			const questionId = `question-live-${String(index).padStart(2, "0")}`;
			store.createWorkflowRun({
				runId,
				issueId: `FLY-${3000 + index}`,
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			raw(store)
				.prepare(
					`UPDATE workflow_run SET engine_owned = 1, current_node_id = 'founder_gate',
					 created_at = ? WHERE run_id = ?`,
				)
				.run(`2026-09-05T${String(index).padStart(2, "0")}:00:00.000Z`, runId);
			store.upsertWorkflowRunNode({
				runId,
				nodeId: "founder_gate",
				attempt: 1,
				state: "review",
				executionId: `${runId}-qa`,
			});
			store.ensureWorkflowGateHolder({
				runId,
				gateNodeId: "founder_gate",
				attempt: 1,
				headSha: HEAD,
				sourceExecutionId: `${runId}-qa`,
				questionId,
				now: NOW,
			});
			raw(store)
				.prepare(
					"UPDATE workflow_gate_holder SET state = 'awaiting_review' WHERE question_id = ?",
				)
				.run(questionId);
			store.upsertSession({
				execution_id: `${runId}-qa`,
				issue_id: `FLY-${3000 + index}`,
				project_name: "flywheel",
				status: "running",
			});
		}
		store.createWorkflowRun({
			runId: "run-zombie",
			issueId: "FLY-3999",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		raw(store)
			.prepare(
				"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'founder_gate' WHERE run_id = 'run-zombie'",
			)
			.run();
		store.upsertWorkflowRunNode({
			runId: "run-zombie",
			nodeId: "founder_gate",
			attempt: 1,
			state: "review",
			executionId: "run-zombie-qa",
		});
		store.ensureWorkflowGateHolder({
			runId: "run-zombie",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: HEAD,
			sourceExecutionId: "run-zombie-qa",
			questionId: "question-zombie",
			now: NOW,
		});
		raw(store)
			.prepare(
				"UPDATE workflow_gate_holder SET state = 'awaiting_review' WHERE question_id = 'question-zombie'",
			)
			.run();

		expect(store.listSessionlessWorkflowGateCandidates(1)).toEqual([
			expect.objectContaining({ runId: "run-zombie" }),
		]);
	});
});
