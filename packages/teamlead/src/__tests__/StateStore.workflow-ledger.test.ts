import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-1232 module ② — the workflow ledger composite transaction
 * (`applyWorkflowLedgerBatch`, the ONLY sanctioned transaction surface,
 * design R3#5) and the `workflow_side_effect_ledger` dispatch-outbox state
 * machine (§2.4b / research §F.3).
 *
 * Production reaches these APIs through the workflow engine when claims
 * writes are enabled.
 */

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const PROJECT = "flywheel";
const ISSUE = "FLY-1232";

function allDeliveryAttempts(
	store: StateStore,
): ReturnType<StateStore["listLiveWorkflowDeliveryAttempts"]> {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw
		.prepare("SELECT * FROM workflow_delivery_attempt")
		.all() as ReturnType<StateStore["listLiveWorkflowDeliveryAttempts"]>;
}

function dispatchBatch(
	store: StateStore,
	executionId: string,
	opts: {
		node?: string;
		attempt?: number;
		edge?: { from: string; to: string };
		newRunId?: string;
	} = {},
) {
	const ops: Parameters<StateStore["applyWorkflowLedgerBatch"]>[0]["ops"] = [];
	if (opts.edge) {
		ops.push({
			op: "edge",
			from: opts.edge.from,
			to: opts.edge.to,
			attempt: opts.attempt ?? 1,
			executionId,
		});
	}
	ops.push({
		op: "dispatch",
		node: opts.node ?? "design",
		attempt: opts.attempt ?? 1,
		executionId,
	});
	return store.applyWorkflowLedgerBatch({
		projectName: PROJECT,
		issueId: ISSUE,
		newRunId: opts.newRunId ?? "run-shadow-1",
		ops,
	});
}

describe("applyWorkflowLedgerBatch — run getOrCreate + active-run uniqueness", () => {
	it("creates the active workflow run on first batch and reuses it afterwards", async () => {
		const store = await freshStore();
		const first = dispatchBatch(store, "exec-1");
		expect(first.created).toBe(true);
		expect(first.runId).toBe("run-shadow-1");

		const second = store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			newRunId: "run-shadow-IGNORED",
			ops: [{ op: "kickback", round: 1 }],
		});
		expect(second.created).toBe(false);
		expect(second.runId).toBe("run-shadow-1");
	});

	it("enforces ONE active run per (project, issue) at the DB layer (partial unique index)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1232-shadow-"));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		dispatchBatch(store, "exec-1");
		store.close();

		const raw = new Database(dbPath);
		try {
			expect(() =>
				raw
					.prepare(
						"INSERT INTO workflow_run (run_id, issue_id, project_name) VALUES ('run-2', ?, ?)",
					)
					.run(ISSUE, PROJECT),
			).toThrow(/UNIQUE/i);
		} finally {
			raw.close();
		}
	});

	it("a finalized run releases the (project, issue) slot — the next batch creates a NEW run (B10)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1");
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [{ op: "finalize" }],
		});
		expect(store.getWorkflowRun("run-shadow-1")?.status).toBe("completed");

		const next = dispatchBatch(store, "exec-2", { newRunId: "run-shadow-2" });
		expect(next.created).toBe(true);
		expect(next.runId).toBe("run-shadow-2");
	});

	it("explicit-runId batches accept ONLY side_effect ops — a finalized run's history cannot be mutated (R2#5)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", { node: "qa", attempt: 1 });
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [{ op: "finalize" }],
		});
		// evidence advancement on the completed run — allowed
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			runId: "run-shadow-1",
			ops: [
				{
					op: "side_effect",
					node: "qa",
					attempt: 1,
					executionId: "exec-1",
					to: "launch_committed",
				},
			],
		});
		expect(store.listWorkflowSideEffects("run-shadow-1")[0]?.state).toBe(
			"launch_committed",
		);
		// lifecycle mutation on the completed run — refused
		for (const op of [
			{ op: "dispatch", node: "qa", attempt: 2, executionId: "e2" },
			{ op: "complete", node: "qa", attempt: 1, executionId: "exec-1" },
			{ op: "kickback", round: 9 },
			{ op: "finalize" },
		] as const) {
			expect(() =>
				store.applyWorkflowLedgerBatch({
					projectName: PROJECT,
					issueId: ISSUE,
					runId: "run-shadow-1",
					ops: [op],
				}),
			).toThrow(/side_effect/);
		}
	});

	it("keeps an explicitly targeted engine run side-effect-only", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", { node: "qa", attempt: 1 });
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			"UPDATE workflow_run SET engine_owned = 1 WHERE run_id = 'run-shadow-1'",
		);
		const before = store.listWorkflowResumeAttachments({
			runId: "run-shadow-1",
		});

		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			runId: "run-shadow-1",
			expectedEngineOwned: 1,
			ops: [
				{
					op: "side_effect",
					node: "qa",
					attempt: 1,
					executionId: "exec-1",
					to: "launch_committed",
				},
			],
		});
		expect(
			store.listWorkflowResumeAttachments({ runId: "run-shadow-1" }),
		).toEqual(before);
		for (const op of [
			{ op: "dispatch", node: "qa", attempt: 2, executionId: "exec-2" },
			{ op: "wake", node: "qa", attempt: 1, executionId: "exec-1" },
			{ op: "complete", node: "qa", attempt: 1, executionId: "exec-1" },
			{ op: "edge", from: "qa", to: "land", attempt: 1 },
			{ op: "kickback", round: 2 },
			{ op: "finalize" },
		] as const) {
			expect(() =>
				store.applyWorkflowLedgerBatch({
					projectName: PROJECT,
					issueId: ISSUE,
					runId: "run-shadow-1",
					expectedEngineOwned: 1,
					ops: [op],
				}),
			).toThrow(/side_effect/);
		}
	});

	it("explicit-runId batches validate project/issue identity against the targeted run (R3#1)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", { node: "qa", attempt: 1 });
		const sideEffect = {
			op: "side_effect",
			node: "qa",
			attempt: 1,
			executionId: "exec-1",
			to: "launch_committed",
		} as const;
		expect(() =>
			store.applyWorkflowLedgerBatch({
				projectName: "some-other-project",
				issueId: ISSUE,
				runId: "run-shadow-1",
				ops: [sideEffect],
			}),
		).toThrow(/identity/i);
		expect(() =>
			store.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: "FLY-9999",
				runId: "run-shadow-1",
				ops: [sideEffect],
			}),
		).toThrow(/identity/i);
		expect(store.listWorkflowSideEffects("run-shadow-1")[0]?.state).toBe(
			"intent_recorded",
		);
	});

	it("refuses to create a run without a caller-supplied newRunId (fail-closed)", async () => {
		const store = await freshStore();
		expect(() =>
			store.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: ISSUE,
				ops: [{ op: "kickback", round: 1 }],
			}),
		).toThrow(/newRunId/);
	});
});

describe("applyWorkflowLedgerBatch — dispatch op (T1/T2/T7) + writer-allocated ordinal", () => {
	it("writes node_dispatched + running node projection + intent_recorded ledger row, ordinal allocated by the writer", async () => {
		const store = await freshStore();
		const res = dispatchBatch(store, "exec-1", { node: "design", attempt: 1 });
		expect(res.dispatchOrdinals).toEqual([1]);

		const events = store.listWorkflowRunEvents("run-shadow-1");
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("node_dispatched");
		expect(events[0]?.event_uid).toBe("run:run-shadow-1:dispatch:design:1:1");
		expect(events[0]?.execution_id).toBe("exec-1");

		const node = store.getWorkflowRunNode("run-shadow-1", "design", 1);
		expect(node?.state).toBe("running");
		expect(node?.execution_id).toBe("exec-1");

		const ledger = store.listWorkflowSideEffects("run-shadow-1");
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			node_id: "design",
			attempt: 1,
			kind: "dispatch",
			launch_ordinal: 1,
			execution_id: "exec-1",
			state: "intent_recorded",
		});

		expect(store.getWorkflowRun("run-shadow-1")?.current_node_id).toBe(
			"design",
		);
	});

	it("pre-commit re-drive with the SAME execution id converges: same ordinal, no new ledger row, event deduped", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1");
		const replay = dispatchBatch(store, "exec-1");
		expect(replay.dispatchOrdinals).toEqual([1]);
		expect(store.listWorkflowSideEffects("run-shadow-1")).toHaveLength(1);
		expect(store.listWorkflowRunEvents("run-shadow-1")).toHaveLength(1);
	});

	it("crash-swapped execution id: a NEW execution on the same (node, attempt) gets a NEW ledger row + next ordinal; the logical edge event is still deduped (R3#2)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", {
			node: "qa",
			attempt: 2,
			edge: { from: "implement", to: "qa" },
		});
		// crash after batch commit, reconcile re-enters handoff with a NEW execId
		const second = dispatchBatch(store, "exec-2", {
			node: "qa",
			attempt: 2,
			edge: { from: "implement", to: "qa" },
		});
		expect(second.dispatchOrdinals).toEqual([2]);

		const ledger = store.listWorkflowSideEffects("run-shadow-1");
		expect(ledger).toHaveLength(2);
		expect(ledger.map((r) => r.execution_id).sort()).toEqual([
			"exec-1",
			"exec-2",
		]);

		const events = store.listWorkflowRunEvents("run-shadow-1");
		const edges = events.filter((e) => e.kind === "edge_traversed");
		expect(edges).toHaveLength(1); // logical edge deduped
		const dispatches = events.filter((e) => e.kind === "node_dispatched");
		expect(dispatches.map((e) => e.event_uid)).toEqual([
			"run:run-shadow-1:dispatch:qa:2:1",
			"run:run-shadow-1:dispatch:qa:2:2",
		]);
	});
});

describe("applyWorkflowLedgerBatch — wake / edge / complete / kickback / finalize ops", () => {
	it("wake (T3) writes node_dispatched with the wake uid and NO side-effect row (wake is not a spawn)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", { node: "implement", attempt: 1 });
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [
				{ op: "wake", node: "implement", attempt: 2, executionId: "exec-1" },
			],
		});
		const events = store.listWorkflowRunEvents("run-shadow-1");
		expect(events.map((e) => e.event_uid)).toContain(
			"run:run-shadow-1:wake:implement:2",
		);
		expect(store.listWorkflowSideEffects("run-shadow-1")).toHaveLength(1); // only the spawn's row
		expect(
			store.getWorkflowRunNode("run-shadow-1", "implement", 2)?.state,
		).toBe("running");
	});

	it("wake handoff (T3b) writes edge_traversed + wake node_dispatched in ONE batch", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-qa", { node: "qa", attempt: 1 });
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [
				{
					op: "edge",
					from: "implement",
					to: "qa",
					attempt: 2,
					executionId: "exec-qa",
				},
				{ op: "wake", node: "qa", attempt: 2, executionId: "exec-qa" },
			],
		});
		const uids = store
			.listWorkflowRunEvents("run-shadow-1")
			.map((e) => e.event_uid);
		expect(uids).toContain("run:run-shadow-1:edge:implement:qa:2");
		expect(uids).toContain("run:run-shadow-1:wake:qa:2");
	});

	it("complete (T4) writes node_completed keyed by execution id and ends the node projection", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", { node: "design", attempt: 1 });
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [
				{ op: "complete", node: "design", attempt: 1, executionId: "exec-1" },
			],
		});
		const events = store.listWorkflowRunEvents("run-shadow-1");
		expect(events.map((e) => e.event_uid)).toContain(
			"run:run-shadow-1:complete:design:1:exec-1",
		);
		const node = store.getWorkflowRunNode("run-shadow-1", "design", 1);
		expect(node?.state).toBe("done");
		expect(node?.ended_at).toBeTruthy();
	});

	it("uid namespace: the SAME execution completing across two keep-alive rounds is NOT deduped (R2#2)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", { node: "implement", attempt: 1 });
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [
				{
					op: "complete",
					node: "implement",
					attempt: 1,
					executionId: "exec-1",
				},
				{
					op: "complete",
					node: "implement",
					attempt: 2,
					executionId: "exec-1",
				},
			],
		});
		const completes = store
			.listWorkflowRunEvents("run-shadow-1")
			.filter((e) => e.kind === "node_completed");
		expect(completes).toHaveLength(2);
	});

	it("kickback (T6) writes ONLY loop_iteration, keyed by round; replay is idempotent", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1");
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [{ op: "kickback", round: 1 }],
		});
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [{ op: "kickback", round: 1 }],
		});
		const loops = store
			.listWorkflowRunEvents("run-shadow-1")
			.filter((e) => e.kind === "loop_iteration");
		expect(loops).toHaveLength(1);
		expect(loops[0]?.event_uid).toBe("run:run-shadow-1:kickback:1");
	});

	it("kickbacks are namespaced by RUN id — a second workflow on the same issue does not collide (R2#2)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1");
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [{ op: "kickback", round: 1 }, { op: "finalize" }],
		});
		const second = dispatchBatch(store, "exec-2", { newRunId: "run-shadow-2" });
		expect(second.runId).toBe("run-shadow-2");
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [{ op: "kickback", round: 1 }],
		});
		const loops = store
			.listWorkflowRunEvents("run-shadow-2")
			.filter((e) => e.kind === "loop_iteration");
		expect(loops).toHaveLength(1); // run-2's round 1 is its own event
	});

	it("finalize (T9) flips active→completed, appends NO event (§3.1b has no finalize kind — B9), and replays idempotently", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1");
		const before = store.listWorkflowRunEvents("run-shadow-1").length;
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [{ op: "finalize" }],
		});
		expect(store.getWorkflowRun("run-shadow-1")?.status).toBe("completed");
		expect(store.listWorkflowRunEvents("run-shadow-1")).toHaveLength(before);
		// replay: run no longer active → batch must NOT create a new run implicitly
		expect(() =>
			store.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: ISSUE,
				ops: [{ op: "finalize" }],
			}),
		).toThrow(/newRunId/);
	});

	it("every kind the batch writes is inside the umbrella §3.1b vocabulary (B9)", async () => {
		const store = await freshStore();
		dispatchBatch(store, "exec-1", {
			node: "implement",
			attempt: 1,
			edge: { from: "design", to: "implement" },
		});
		store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [
				{ op: "wake", node: "implement", attempt: 2, executionId: "exec-1" },
				{
					op: "complete",
					node: "implement",
					attempt: 2,
					executionId: "exec-1",
				},
				{ op: "kickback", round: 1 },
				{ op: "finalize" },
			],
		});
		const VOCAB = new Set([
			"node_dispatched",
			"node_completed",
			"edge_traversed",
			"loop_iteration",
		]);
		for (const e of store.listWorkflowRunEvents("run-shadow-1")) {
			expect(VOCAB.has(e.kind), `kind ${e.kind} outside §3.1b`).toBe(true);
		}
	});
});

describe("applyWorkflowLedgerBatch — fail-closed input validation", () => {
	it("rejects non-finite / non-positive attempt and round (never writes a NaN into a uid)", async () => {
		const store = await freshStore();
		expect(() =>
			store.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: ISSUE,
				newRunId: "r",
				ops: [
					{
						op: "dispatch",
						node: "design",
						attempt: Number.NaN,
						executionId: "e",
					},
				],
			}),
		).toThrow(/attempt/);
		expect(() =>
			store.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: ISSUE,
				newRunId: "r",
				ops: [{ op: "kickback", round: 0 }],
			}),
		).toThrow(/round/);
		// nothing persisted by the rejected batches
		expect(store.getWorkflowRun("r")).toBeUndefined();
	});

	it("rejects node / edge labels containing the uid separator", async () => {
		const store = await freshStore();
		expect(() =>
			store.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: ISSUE,
				newRunId: "r",
				ops: [
					{ op: "dispatch", node: "de:sign", attempt: 1, executionId: "e" },
				],
			}),
		).toThrow(/node/);
	});
});

describe("workflow_side_effect_ledger — dispatch outbox state machine (②b)", () => {
	function seedDispatch(store: StateStore, executionId = "exec-1") {
		dispatchBatch(store, executionId, { node: "qa", attempt: 1 });
	}

	function transition(
		store: StateStore,
		to: "launch_committed" | "started" | "abandoned",
		opts: { executionId?: string; reason?: string } = {},
	) {
		return store.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [
				{
					op: "side_effect",
					node: "qa",
					attempt: 1,
					executionId: opts.executionId ?? "exec-1",
					to,
					...(opts.reason !== undefined && { reason: opts.reason }),
				},
			],
		});
	}

	it("advances intent_recorded → launch_committed → started with per-state timestamps", async () => {
		const store = await freshStore();
		seedDispatch(store);
		const launchAttempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find(
				(row) =>
					row.family === "launch" &&
					JSON.parse(row.contract_ref_json).pk === "exec-1",
			);
		expect(launchAttempt).toMatchObject({
			granted_at: expect.any(String),
			sent_at: null,
			received_at: null,
		});
		transition(store, "launch_committed");
		let row = store.listWorkflowSideEffects("run-shadow-1")[0];
		expect(row?.state).toBe("launch_committed");
		expect(row?.committed_at).toBeTruthy();
		expect(row?.started_at).toBeNull();
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.find(({ attempt_id }) => attempt_id === launchAttempt!.attempt_id),
		).toMatchObject({ received_at: row!.committed_at, sent_at: null });

		transition(store, "started");
		row = store.listWorkflowSideEffects("run-shadow-1")[0];
		expect(row?.state).toBe("started");
		expect(row?.started_at).toBeTruthy();
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.find(({ attempt_id }) => attempt_id === launchAttempt!.attempt_id),
		).toMatchObject({
			sent_at: row!.started_at,
			received_at: row!.committed_at,
		});
	});

	it("keeps a pre-contract launch progressing when its delivery attempt is absent", async () => {
		const store = await freshStore();
		seedDispatch(store);
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run("DELETE FROM workflow_delivery_attempt WHERE family = 'launch'");

		expect(() => transition(store, "launch_committed")).not.toThrow();
		expect(store.listWorkflowSideEffects("run-shadow-1")[0]).toMatchObject({
			state: "launch_committed",
			committed_at: expect.any(String),
		});
	});

	it("a forward skip (intent_recorded → started, both evidences proven at once) stamps committed_at too", async () => {
		const store = await freshStore();
		seedDispatch(store);
		transition(store, "started");
		const row = store.listWorkflowSideEffects("run-shadow-1")[0];
		expect(row?.state).toBe("started");
		expect(row?.committed_at).toBeTruthy();
		expect(row?.started_at).toBeTruthy();
	});

	it("same-state replay is an idempotent no-op", async () => {
		const store = await freshStore();
		seedDispatch(store);
		transition(store, "launch_committed");
		const before = store.listWorkflowSideEffects("run-shadow-1")[0];
		transition(store, "launch_committed");
		const after = store.listWorkflowSideEffects("run-shadow-1")[0];
		expect(after).toEqual(before);
	});

	it("rejects backward transitions (started is terminal — a runner exiting later never rewrites history)", async () => {
		const store = await freshStore();
		seedDispatch(store);
		transition(store, "started");
		expect(() => transition(store, "launch_committed")).toThrow(
			/illegal|transition/i,
		);
		expect(() =>
			transition(store, "abandoned", { reason: "too late" }),
		).toThrow(/illegal|transition/i);
	});

	it("abandon requires a reason, stamps abandoned_at, and is allowed ONLY from intent_recorded (pre-commit positive failure)", async () => {
		const store = await freshStore();
		seedDispatch(store);
		expect(() => transition(store, "abandoned")).toThrow(/reason/);
		transition(store, "abandoned", {
			reason: "pre_commit_failure: run() rejected",
		});
		const row = store.listWorkflowSideEffects("run-shadow-1")[0];
		expect(row?.state).toBe("abandoned");
		expect(row?.reason).toContain("pre_commit_failure");
		expect(row?.abandoned_at).toBeTruthy();
		expect(
			allDeliveryAttempts(store).find(
				(attempt) =>
					attempt.family === "launch" &&
					JSON.parse(attempt.contract_ref_json).pk === "exec-1",
			),
		).toMatchObject({ settlement_reason: "source_terminal" });

		// marker already durable ⇒ the row sits at launch_committed and can never abandon
		const store2 = await freshStore();
		seedDispatch(store2, "exec-2");
		store2.applyWorkflowLedgerBatch({
			projectName: PROJECT,
			issueId: ISSUE,
			ops: [
				{
					op: "side_effect",
					node: "qa",
					attempt: 1,
					executionId: "exec-2",
					to: "launch_committed",
				},
			],
		});
		expect(() =>
			store2.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: ISSUE,
				ops: [
					{
						op: "side_effect",
						node: "qa",
						attempt: 1,
						executionId: "exec-2",
						to: "abandoned",
						reason: "nope",
					},
				],
			}),
		).toThrow(/illegal|transition/i);
	});

	it("transitions on an unknown ledger row are refused (fail-closed)", async () => {
		const store = await freshStore();
		seedDispatch(store);
		expect(() =>
			transition(store, "launch_committed", { executionId: "ghost" }),
		).toThrow(/not found/i);
	});

	it("execution_id and row identity are immutable at the DB layer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1232-ledger-"));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		dispatchBatch(store, "exec-1", { node: "qa", attempt: 1 });
		store.close();

		const raw = new Database(dbPath);
		try {
			expect(() =>
				raw
					.prepare(
						"UPDATE workflow_side_effect_ledger SET execution_id = 'forged'",
					)
					.run(),
			).toThrow(/immutable/);
			expect(() =>
				raw
					.prepare("UPDATE workflow_side_effect_ledger SET launch_ordinal = 9")
					.run(),
			).toThrow(/immutable/);
		} finally {
			raw.close();
		}
	});
});

describe("applyWorkflowLedgerBatch — per-statement fault injection (B6: no torn writes)", () => {
	it("a failure at ANY statement rolls back the WHOLE batch (no orphan run/event/node/ledger rows), and the replay then succeeds", async () => {
		// Count the statements a full T2-shaped batch executes, then re-run the
		// batch on a fresh store failing at each statement index in turn.
		const countingStore = await freshStore();
		const countingDb = (
			countingStore as unknown as {
				db: { run: (sql: string, params?: unknown[]) => void };
			}
		).db;
		const originalRun = countingDb.run.bind(countingDb);
		let statements = 0;
		countingDb.run = (sql: string, params?: unknown[]) => {
			statements++;
			return originalRun(sql, params);
		};
		const fullBatch = (store: StateStore) =>
			store.applyWorkflowLedgerBatch({
				projectName: PROJECT,
				issueId: ISSUE,
				newRunId: "run-shadow-1",
				ops: [
					{
						op: "edge",
						from: "design",
						to: "implement",
						attempt: 1,
						executionId: "exec-1",
					},
					{
						op: "dispatch",
						node: "implement",
						attempt: 1,
						executionId: "exec-1",
					},
				],
			});
		fullBatch(countingStore);
		expect(statements).toBeGreaterThan(2);

		for (let failAt = 1; failAt <= statements; failAt++) {
			const store = await freshStore();
			const db = (
				store as unknown as {
					db: { run: (sql: string, params?: unknown[]) => void };
				}
			).db;
			const realRun = db.run.bind(db);
			let n = 0;
			db.run = (sql: string, params?: unknown[]) => {
				n++;
				if (n === failAt) throw new Error(`injected failure at stmt ${failAt}`);
				return realRun(sql, params);
			};
			expect(() => fullBatch(store), `failAt=${failAt} must throw`).toThrow(
				/injected failure/,
			);
			db.run = realRun;

			// ZERO residue — no torn writes between events / projections / intent.
			expect(store.getWorkflowRun("run-shadow-1")).toBeUndefined();
			expect(store.listWorkflowRunEvents("run-shadow-1")).toHaveLength(0);
			expect(store.listWorkflowSideEffects("run-shadow-1")).toHaveLength(0);
			expect(
				store.getWorkflowRunNode("run-shadow-1", "implement", 1),
			).toBeUndefined();

			// replay after the fault succeeds cleanly
			const replay = fullBatch(store);
			expect(replay.created).toBe(true);
			expect(replay.dispatchOrdinals).toEqual([1]);
		}
	});
});
