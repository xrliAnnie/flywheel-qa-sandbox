import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	TURN_GRANT_GRACE_MS,
	TurnBeltReconciler,
	type TurnBeltReconcilerDeps,
	type WorktreeTurnRow,
} from "../turn-belt-reconcile.js";
import type { WorkflowActorSession } from "../workflow-actor-session.js";

const OLD_GRANT = () => Date.now() - TURN_GRANT_GRACE_MS - 1;
const FRESH_GRANT = () => Date.now() - 10_000;

function turn(over: Partial<WorktreeTurnRow> = {}): WorktreeTurnRow {
	return {
		issue_id: "FLY-543",
		holder_exec_id: "qa-dead",
		phase: "qa",
		epoch: 3,
		granted_at: OLD_GRANT(),
		...over,
	};
}

function actor(
	over: Partial<WorkflowActorSession> & { execution_id: string },
): WorkflowActorSession {
	return {
		issue_id: "FLY-543",
		project_name: "flywheel",
		status: "running",
		...over,
	};
}

function makeHarness(args: {
	turn?: WorktreeTurnRow | null;
	holder?: WorkflowActorSession;
	candidates?: WorkflowActorSession[];
	liveness?: Record<string, "alive" | "dead_pin" | "absent" | "indeterminate">;
	engineOwned?: string[];
}) {
	const row = args.turn === undefined ? turn() : args.turn;
	const listTurns = vi.fn(() =>
		row ? [{ projectName: "flywheel", turn: row }] : [],
	);
	const getTurn = vi.fn(() => row);
	const deleteTurn = vi.fn();
	const grantTurn = vi.fn();
	const alertLead = vi.fn(async () => {});
	const wakeRecoveredTurn = vi.fn(async () => ({ ok: true }));
	const alertWorktreeTakeoverFailure = vi.fn(async () => {});
	const isEngineOwnedExecution = vi.fn((executionId: string) =>
		(args.engineOwned ?? []).includes(executionId),
	);
	const probeActorAlive = vi.fn(async (session: WorkflowActorSession) => {
		return args.liveness?.[session.execution_id] ?? "absent";
	});
	const deps: TurnBeltReconcilerDeps = {
		turnBelt: {
			listTurns,
			getTurn,
			deleteTurn,
			getSessionForTurnHolder: (execId) =>
				args.holder?.execution_id === execId ? args.holder : undefined,
			getActorSessionsForIssue: () => args.candidates ?? [],
		},
		probeActorAlive,
		isEngineOwnedExecution,
		alertWorktreeTakeoverFailure,
		wakeRecoveredTurn,
		grantTurn,
		alertLead,
		logger: { warn: vi.fn() },
	};
	return {
		reconciler: new TurnBeltReconciler(deps),
		deleteTurn,
		grantTurn,
		alertLead,
		wakeRecoveredTurn,
		probeActorAlive,
		isEngineOwnedExecution,
		listTurns,
		getTurn,
		alertWorktreeTakeoverFailure,
	};
}

describe("TurnBeltReconciler", () => {
	beforeEach(() => vi.clearAllMocks());

	it("recovers a failed legacy holder to the most downstream live actor", async () => {
		const qa = actor({
			execution_id: "qa-dead",
			chat_thread_role: "qa",
			status: "failed",
		});
		const implement = actor({
			execution_id: "implement-alive",
			chat_thread_role: "implement",
			status: "awaiting_review",
		});
		const design = actor({
			execution_id: "design-alive",
			chat_thread_role: "design",
			status: "design_done",
		});
		const h = makeHarness({
			holder: qa,
			candidates: [design, implement],
			liveness: {
				"implement-alive": "alive",
				"design-alive": "alive",
			},
		});

		await h.reconciler.reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "qa-dead",
		});

		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				execId: "implement-alive",
				phase: "implement",
			}),
		);
		expect(h.wakeRecoveredTurn).toHaveBeenCalledWith(
			expect.objectContaining({ epoch: 4, previousHolderExecId: "qa-dead" }),
		);
		expect(h.grantTurn.mock.invocationCallOrder[0]).toBeLessThan(
			h.wakeRecoveredTurn.mock.invocationCallOrder[0] as number,
		);
		expect(h.alertLead).toHaveBeenCalledOnce();
		expect(h.deleteTurn).not.toHaveBeenCalled();
	});

	it("ignores an engine-owned scoped terminal before reading the TURN", async () => {
		const h = makeHarness({ engineOwned: ["qa-dead"] });

		await h.reconciler.reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "qa-dead",
		});

		expect(h.getTurn).not.toHaveBeenCalled();
		expect(h.probeActorAlive).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deleteTurn).not.toHaveBeenCalled();
	});

	it("ignores an engine-owned scoped TURN holder", async () => {
		const h = makeHarness({ engineOwned: ["qa-dead"] });

		await h.reconciler.reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
		});

		expect(h.getTurn).toHaveBeenCalledOnce();
		expect(h.probeActorAlive).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deleteTurn).not.toHaveBeenCalled();
	});

	it("skips engine-owned TURN holders during startup reconciliation", async () => {
		const h = makeHarness({ engineOwned: ["qa-dead"] });

		await h.reconciler.reconcileTurnBelt();

		expect(h.listTurns).toHaveBeenCalledOnce();
		expect(h.probeActorAlive).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deleteTurn).not.toHaveBeenCalled();
	});

	it("reports a typed takeover refusal for an engine-owned workflow actor", async () => {
		const h = makeHarness({ engineOwned: ["qa-dead"] });
		const qa = actor({
			execution_id: "qa-dead",
			chat_thread_role: "qa",
		});

		await h.reconciler.alertWorktreeTakeoverFailure(
			qa,
			"worktree_takeover_failed: dirty",
		);

		expect(h.alertWorktreeTakeoverFailure).toHaveBeenCalledWith({
			session: qa,
			reason: "worktree_takeover_failed: dirty",
		});
	});

	it("does not report a takeover refusal for a non-engine execution", async () => {
		const h = makeHarness({});

		await h.reconciler.alertWorktreeTakeoverFailure(
			actor({ execution_id: "legacy-qa", chat_thread_role: "qa" }),
			"worktree_takeover_failed: dirty",
		);

		expect(h.alertWorktreeTakeoverFailure).not.toHaveBeenCalled();
	});

	it("leaves a completed QA holder for post-ship finalization", async () => {
		const h = makeHarness({
			holder: actor({
				execution_id: "qa-dead",
				chat_thread_role: "qa",
				status: "completed",
			}),
			candidates: [
				actor({
					execution_id: "design-alive",
					chat_thread_role: "design",
					status: "design_done",
				}),
			],
			liveness: { "design-alive": "alive" },
		});

		await h.reconciler.reconcileTurnBelt();

		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLead).not.toHaveBeenCalled();
	});

	it("treats a completed non-QA holder as stale", async () => {
		const h = makeHarness({
			turn: turn({ holder_exec_id: "implement-done", phase: "implement" }),
			holder: actor({
				execution_id: "implement-done",
				chat_thread_role: "implement",
				status: "completed",
			}),
			candidates: [
				actor({
					execution_id: "design-alive",
					chat_thread_role: "design",
					status: "design_done",
				}),
			],
			liveness: { "design-alive": "alive" },
		});

		await h.reconciler.reconcileTurnBelt();

		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-alive", phase: "design" }),
		);
	});

	it.each(["alive", "indeterminate"] as const)(
		"leaves a non-terminal %s holder untouched",
		async (liveness) => {
			const h = makeHarness({
				turn: turn({ holder_exec_id: "qa-current" }),
				holder: actor({
					execution_id: "qa-current",
					chat_thread_role: "qa",
				}),
				liveness: { "qa-current": liveness },
			});

			await h.reconciler.reconcileTurnBelt();

			expect(h.grantTurn).not.toHaveBeenCalled();
			expect(h.deleteTurn).not.toHaveBeenCalled();
			expect(h.alertLead).not.toHaveBeenCalled();
		},
	);

	it("never re-grants to the stale holder itself", async () => {
		const staleQa = actor({
			execution_id: "qa-dead",
			chat_thread_role: "qa",
			status: "awaiting_review",
		});
		const h = makeHarness({
			holder: staleQa,
			candidates: [
				staleQa,
				actor({
					execution_id: "design-alive",
					chat_thread_role: "design",
					status: "design_done",
				}),
			],
			liveness: { "qa-dead": "absent", "design-alive": "alive" },
		});

		await h.reconciler.reconcileTurnBelt();

		expect(h.grantTurn).toHaveBeenCalledOnce();
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-alive" }),
		);
	});

	it("fails closed when a recovery candidate has indeterminate liveness", async () => {
		const h = makeHarness({
			holder: actor({
				execution_id: "qa-dead",
				chat_thread_role: "qa",
				status: "failed",
			}),
			candidates: [
				actor({
					execution_id: "implement-maybe",
					chat_thread_role: "implement",
					status: "awaiting_review",
				}),
				actor({
					execution_id: "design-alive",
					chat_thread_role: "design",
					status: "design_done",
				}),
			],
			liveness: {
				"implement-maybe": "indeterminate",
				"design-alive": "alive",
			},
		});

		await h.reconciler.reconcileTurnBelt();

		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLead).not.toHaveBeenCalled();
	});

	it("releases an expired missing-holder turn when no live actor remains", async () => {
		const h = makeHarness({
			turn: turn({ holder_exec_id: "missing-holder" }),
			candidates: [],
		});

		await h.reconciler.reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "missing-holder",
		});

		expect(h.deleteTurn).toHaveBeenCalledWith("FLY-543", "flywheel");
		expect(h.alertLead).toHaveBeenCalledWith(
			expect.objectContaining({
				session: expect.objectContaining({ execution_id: "missing-holder" }),
				reason: expect.stringContaining("NO live actor"),
			}),
		);
	});

	it("does not steal a fresh pre-launch grant before its session row lands", async () => {
		const h = makeHarness({
			turn: turn({
				holder_exec_id: "qa-spawning",
				granted_at: FRESH_GRANT(),
			}),
			candidates: [
				actor({
					execution_id: "design-alive",
					chat_thread_role: "design",
					status: "design_done",
				}),
			],
			liveness: { "design-alive": "alive" },
		});

		await h.reconciler.reconcileTurnBelt();

		expect(h.probeActorAlive).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deleteTurn).not.toHaveBeenCalled();
	});

	it("ignores a terminal event that does not belong to the current holder", async () => {
		const h = makeHarness({
			turn: turn({ holder_exec_id: "qa-spawning" }),
		});

		await h.reconciler.reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "implement-done",
		});

		expect(h.probeActorAlive).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deleteTurn).not.toHaveBeenCalled();
	});

	it("reconciles every project-attributed turn during startup", async () => {
		const grantTurn = vi.fn();
		const alertLead = vi.fn(async () => {});
		const sessions = new Map([
			[
				"design-a",
				actor({
					execution_id: "design-a",
					issue_id: "FLY-A",
					chat_thread_role: "design",
					status: "design_done",
				}),
			],
			[
				"design-b",
				actor({
					execution_id: "design-b",
					issue_id: "FLY-B",
					chat_thread_role: "design",
					status: "design_done",
				}),
			],
		]);
		const rows = [
			{ projectName: "project-a", turn: turn({ issue_id: "FLY-A" }) },
			{ projectName: "project-b", turn: turn({ issue_id: "FLY-B" }) },
		];
		const reconciler = new TurnBeltReconciler({
			turnBelt: {
				listTurns: () => rows,
				getTurn: () => null,
				deleteTurn: vi.fn(),
				getSessionForTurnHolder: (execId) =>
					actor({
						execution_id: execId,
						chat_thread_role: "qa",
						status: "failed",
					}),
				getActorSessionsForIssue: (issueId) =>
					[...sessions.values()].filter((s) => s.issue_id === issueId),
			},
			probeActorAlive: vi.fn(async () => "alive"),
			grantTurn,
			alertLead,
		});

		await reconciler.reconcileTurnBelt();

		expect(grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-a", projectName: "project-a" }),
		);
		expect(grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-b", projectName: "project-b" }),
		);
	});
});
