import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	collectWorkflowRunReceipt,
	reconcileWorkflowRunCollections,
} from "../bridge/workflow-run-collector.js";
import { StateStore } from "../StateStore.js";

function rawDb(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
}

async function runWithLiveSessions(
	runId = "run-1",
	dbPath = ":memory:",
): Promise<StateStore> {
	const store = await StateStore.create(dbPath);
	store.createWorkflowRun({
		runId,
		issueId: "FLY-1707",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	rawDb(store).run(
		"UPDATE workflow_run SET engine_owned = 1 WHERE run_id = ?",
		[runId],
	);
	for (const [attempt, executionId] of [
		[1, "exec-b"],
		[2, "exec-a"],
	] as const) {
		store.upsertWorkflowRunNode({
			runId,
			nodeId: "implement",
			attempt,
			state: "running",
			executionId,
		});
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-1707",
			project_name: "flywheel",
			status: "running",
		});
	}
	return store;
}

function terminate(store: StateStore, clientRequestId = "force-1") {
	return store.terminateWorkflowRunByOperator({
		runId: "run-1",
		reason: "force cancel",
		clientRequestId,
		principal: "master",
		evidence: [],
		collectExecutions: true,
		now: "2026-08-15T08:00:00.000Z",
	});
}

describe("FLY-1707 workflow run collection", () => {
	it("atomically terminates, freezes only live attributed sessions, aliases the episode, and rejects false-to-true replay", async () => {
		const store = await runWithLiveSessions();
		store.upsertSession({
			execution_id: "exec-b",
			issue_id: "FLY-1707",
			project_name: "flywheel",
			status: "completed",
		});

		const result = terminate(store);
		expect(result).toMatchObject({
			ok: true,
			status: "terminated",
			idempotentReplay: false,
			collection: {
				receiptKey: "episode:run-1:0",
				state: "frozen",
				targetExecutionIds: ["exec-a"],
			},
		});
		expect(store.getWorkflowRun("run-1")?.status).toBe("terminated");
		expect(terminate(store)).toMatchObject({
			ok: true,
			idempotentReplay: true,
			collection: { receiptKey: "episode:run-1:0" },
		});
		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-1",
				reason: "force cancel",
				clientRequestId: "force-1",
				principal: "master",
				evidence: [],
				now: "2026-08-15T08:00:00.000Z",
			}),
		).toEqual({ ok: false, reason: "operator_request_conflict" });
		store.close();

		const falseFirst = await runWithLiveSessions();
		expect(
			falseFirst.terminateWorkflowRunByOperator({
				runId: "run-1",
				reason: "force cancel",
				clientRequestId: "same-key",
				principal: "master",
				evidence: [],
				now: "2026-08-15T08:00:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(terminate(falseFirst, "same-key")).toEqual({
			ok: false,
			reason: "operator_request_conflict",
		});
		falseFirst.close();
	});

	it("claims with a lease, fences stale outcomes, and produces one replayable response", async () => {
		const store = await runWithLiveSessions();
		const admitted = terminate(store);
		if (!admitted.ok || !admitted.collection) {
			throw new Error("collection was not admitted");
		}
		const receiptKey = admitted.collection.receiptKey;
		const closeExecution = vi.fn(
			async (
				_executionId: string,
				authorityCheck: () => Promise<{ ok: boolean; reason?: string }>,
			) => {
				expect(await authorityCheck()).toEqual({ ok: true });
				return { closed: true, commDbFinalized: true, retiredGateCount: 0 };
			},
		);

		const first = await collectWorkflowRunReceipt({
			store,
			receiptKey,
			ownerId: "collector-a",
			now: () => new Date("2026-08-15T08:01:00.000Z"),
			closeExecution,
		});
		expect(first.state).toBe("responded");
		expect(closeExecution.mock.calls.map(([id]) => id)).toEqual([
			"exec-a",
			"exec-b",
		]);
		expect(first.response).toMatchObject({
			success: true,
			runId: "run-1",
			receiptKey,
			inProgress: false,
		});

		const replay = await collectWorkflowRunReceipt({
			store,
			receiptKey,
			ownerId: "collector-b",
			now: () => new Date("2026-08-15T08:02:00.000Z"),
			closeExecution,
		});
		expect(replay.response).toEqual(first.response);
		expect(closeExecution).toHaveBeenCalledTimes(2);
		store.close();
	});

	it("resumes a frozen collection after reopening the durable store", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1707-collection-"));
		const dbPath = join(root, "teamlead.db");
		try {
			const beforeRestart = await runWithLiveSessions("run-1", dbPath);
			const admitted = terminate(beforeRestart);
			if (!admitted.ok || !admitted.collection) {
				throw new Error("collection was not admitted");
			}
			beforeRestart.close();

			const afterRestart = await StateStore.create(dbPath);
			expect(afterRestart.listOpenWorkflowRunCollections()).toHaveLength(1);
			const recovered = await collectWorkflowRunReceipt({
				store: afterRestart,
				receiptKey: admitted.collection.receiptKey,
				ownerId: "collector-after-restart",
				now: () => new Date("2026-08-15T08:01:00.000Z"),
				closeExecution: async () => ({
					closed: true,
					commDbFinalized: true,
					retiredGateCount: 0,
				}),
			});
			expect(recovered.state).toBe("responded");
			afterRestart.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows takeover only after lease expiry and rejects the stale collector outcome", async () => {
		const store = await runWithLiveSessions();
		const admitted = terminate(store);
		if (!admitted.ok || !admitted.collection) {
			throw new Error("collection was not admitted");
		}
		const receiptKey = admitted.collection.receiptKey;
		const first = store.claimWorkflowRunCollection({
			receiptKey,
			ownerId: "collector-a",
			now: "2026-08-15T08:01:00.000Z",
			leaseExpiresAt: "2026-08-15T08:01:30.000Z",
		});
		expect(first).toMatchObject({
			status: "claimed",
			receipt: { owner_generation: 1 },
		});
		expect(
			store.claimWorkflowRunCollection({
				receiptKey,
				ownerId: "collector-b",
				now: "2026-08-15T08:01:20.000Z",
				leaseExpiresAt: "2026-08-15T08:01:50.000Z",
			}),
		).toMatchObject({ status: "busy" });
		expect(
			store.renewWorkflowRunCollectionLease({
				receiptKey,
				ownerId: "collector-a",
				generation: 1,
				now: "2026-08-15T08:01:30.000Z",
				leaseExpiresAt: "2026-08-15T08:02:00.000Z",
			}),
		).toEqual({ ok: false, reason: "collector_authority_lost" });
		const takeover = store.claimWorkflowRunCollection({
			receiptKey,
			ownerId: "collector-b",
			now: "2026-08-15T08:01:30.000Z",
			leaseExpiresAt: "2026-08-15T08:02:00.000Z",
		});
		expect(takeover).toMatchObject({
			status: "claimed",
			receipt: { owner_generation: 2 },
		});
		expect(
			store.recordWorkflowRunCollectionOutcome({
				receiptKey,
				ownerId: "collector-a",
				generation: 1,
				outcome: {
					executionId: "exec-a",
					closed: true,
					commDbFinalized: true,
					retiredGateCount: 0,
				},
				now: "2026-08-15T08:01:32.000Z",
			}),
		).toEqual({ ok: false, reason: "collector_authority_lost" });
		store.close();
	});

	it("keeps failed closes open and converges them after lease takeover", async () => {
		const store = await runWithLiveSessions();
		const admitted = terminate(store);
		if (!admitted.ok || !admitted.collection) {
			throw new Error("collection was not admitted");
		}
		const closeExecution = vi
			.fn()
			.mockResolvedValueOnce({
				closed: false,
				commDbFinalized: false,
				retiredGateCount: 0,
				error: "tmux unavailable",
			})
			.mockResolvedValue({
				closed: true,
				commDbFinalized: true,
				retiredGateCount: 0,
			});
		const first = await collectWorkflowRunReceipt({
			store,
			receiptKey: admitted.collection.receiptKey,
			ownerId: "collector-a",
			now: () => new Date("2026-08-15T08:01:00.000Z"),
			closeExecution,
		});
		expect(first.state).toBe("collecting");
		expect(first.outcomes).toContainEqual(
			expect.objectContaining({
				executionId: "exec-a",
				closed: false,
			}),
		);

		const recovered = await collectWorkflowRunReceipt({
			store,
			receiptKey: admitted.collection.receiptKey,
			ownerId: "collector-b",
			now: () => new Date("2026-08-15T08:01:31.000Z"),
			closeExecution,
		});
		expect(recovered.state).toBe("responded");
		expect(closeExecution).toHaveBeenCalledTimes(3);
		store.close();
	});

	it("lets terminal collect-only requests adopt an open sweep receipt and exposes residue without acting", async () => {
		const store = await runWithLiveSessions();
		rawDb(store).run(
			"UPDATE workflow_run SET status = 'terminated' WHERE run_id = 'run-1'",
		);
		const swept = store.ensureTerminalWorkflowRunCollection({
			runId: "run-1",
			now: "2026-08-15T08:00:00.000Z",
		});
		expect(swept).toMatchObject({
			receipt_key: "episode:run-1:0",
			state: "frozen",
		});
		expect(store.listTerminalWorkflowRunsWithResidue(2)).toEqual([
			{
				runId: "run-1",
				projectName: "flywheel",
				issueId: "FLY-1707",
				executionIds: ["exec-a", "exec-b"],
				receiptKey: "episode:run-1:0",
			},
		]);

		const adopted = terminate(store, "collect-terminal");
		expect(adopted).toMatchObject({
			ok: true,
			status: "terminated",
			collection: { receiptKey: "episode:run-1:0" },
		});
		store.close();

		const noHistory = await runWithLiveSessions();
		rawDb(noHistory).run(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = 'run-1'",
		);
		expect(terminate(noHistory, "first-terminal-collect")).toMatchObject({
			ok: true,
			status: "completed",
			collection: { receiptKey: "episode:run-1:0", state: "frozen" },
		});
		noHistory.close();
	});

	it("isolates collector failures and changes the residue uid when a receipt appears", async () => {
		const store = await runWithLiveSessions();
		rawDb(store).run(
			"UPDATE workflow_run SET status = 'terminated' WHERE run_id = 'run-1'",
		);
		const logs: string[] = [];
		await reconcileWorkflowRunCollections({
			store,
			log: (line) => logs.push(line),
		});
		store.ensureTerminalWorkflowRunCollection({
			runId: "run-1",
			now: "2026-08-15T08:00:00.000Z",
		});
		await expect(
			reconcileWorkflowRunCollections({
				store,
				collect: async () => {
					throw new Error("collector unavailable");
				},
				log: (line) => logs.push(line),
			}),
		).resolves.toBeUndefined();

		const notes = store
			.listWorkflowRunEvents("run-1")
			.filter((event) => event.kind === "residue_sweep_note");
		expect(notes).toHaveLength(2);
		expect(new Set(notes.map((event) => event.event_uid))).toHaveLength(2);
		expect(logs).toContainEqual(
			expect.stringContaining("collector unavailable"),
		);
		store.close();
	});
});
