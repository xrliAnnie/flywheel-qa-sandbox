import type { AgentDispatcher } from "flywheel-edge-worker";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
	type TurnBeltRow,
} from "../phase-orchestrator.js";
import { type ProjectRuntime, RunDispatcher } from "../run-dispatcher.js";
import { WorkflowShadowWriter } from "../workflow-shadow-writer.js";

/**
 * FLY-1232 module ② wiring — the T1/T2/T7 pre-launch seam inside
 * RunDispatcher.start() and the orchestrator hook sites (T3/T3b/T4/T5/T6).
 *
 * B1 sentinel: with NO writer injected the seam stays undefined and normal
 * fresh dispatches keep launchCommitPath undefined — byte-compatible.
 */

const PROJECT = "flywheel";
const ISSUE = "FLY-1232";

async function makeShadow(probes?: {
	marker?: boolean;
	row?: boolean;
}): Promise<{ store: StateStore; writer: WorkflowShadowWriter }> {
	const store = await StateStore.create(":memory:");
	let n = 0;
	const writer = new WorkflowShadowWriter({
		store,
		newRunId: () => `run-${++n}`,
		probes: probes
			? {
					hasCommitMarker: () => probes.marker ?? false,
					hasNonPendingCommDbRow: () => probes.row ?? false,
				}
			: undefined,
		logger: { warn: () => {} },
	});
	return { store, writer };
}

// ── RunDispatcher pre-launch seam ───────────────────────────────────────────

/** RunDispatcher with the CommDB pre-registration stubbed out (unit seam). */
class TestDispatcher extends RunDispatcher {
	protected override preRegisterCommDb(): void {}
	protected override cleanupPreRegistration(): void {}
}

function makeRuntime(
	onRun: (ctx: BlueprintContext) => Promise<{
		success: boolean;
		sessionId?: string;
		error?: string;
		worktreePath?: string;
	}>,
): Map<string, ProjectRuntime> {
	const runtime: ProjectRuntime = {
		blueprint: {
			run: (_issue: unknown, _root: string, ctx: BlueprintContext) =>
				onRun(ctx),
		} as unknown as ProjectRuntime["blueprint"],
		projectRoot: "/tmp/nowhere",
		tmuxSessionName: "flywheel",
		agentDispatcher: {} as AgentDispatcher,
	};
	return new Map([[PROJECT, runtime]]);
}

describe("RunDispatcher.start() pre-launch seam (T1/T2/T7)", () => {
	it("T1: writes the shadow dispatch BEFORE Blueprint.run and passes launchCommitPath on the fresh path (flag ON)", async () => {
		const { store, writer } = await makeShadow();
		let shadowRowsAtRun = -1;
		let ctxSeen: BlueprintContext | undefined;
		const dispatcher = new TestDispatcher(
			makeRuntime(async (ctx) => {
				ctxSeen = ctx;
				shadowRowsAtRun = store.listWorkflowRunEvents("run-1").length;
				return { success: true, sessionId: "s1" };
			}),
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // FLY-1185 lifecycleAdmission
			undefined, // FLY-1185 lifecycleLaunchGuard
			writer,
		);
		await dispatcher.start({ issueId: ISSUE, projectName: PROJECT });
		await dispatcher.drain();

		expect(shadowRowsAtRun).toBe(1); // shadow batch landed pre-launch
		const events = store.listWorkflowRunEvents("run-1");
		expect(events[0]?.event_uid).toBe("run:run-1:dispatch:main:1:1");
		expect(ctxSeen?.launchCommitPath).toBeTruthy();
		expect(String(ctxSeen?.launchCommitPath)).toContain(
			ctxSeen?.executionId as string,
		);
	});

	it("B1: with NO writer the seam is silent and launchCommitPath stays undefined (byte-compat sentinel)", async () => {
		const { store } = await makeShadow();
		let ctxSeen: BlueprintContext | undefined;
		const dispatcher = new TestDispatcher(
			makeRuntime(async (ctx) => {
				ctxSeen = ctx;
				return { success: true, sessionId: "s1" };
			}),
			[],
		);
		await dispatcher.start({ issueId: ISSUE, projectName: PROJECT });
		await dispatcher.drain();
		expect(ctxSeen?.launchCommitPath).toBeUndefined();
		expect(store.listActiveWorkflowRuns()).toHaveLength(0);
	});

	it("T2/T7: honors the caller's shadowContext (edge + node + attempt); a re-drive with a NEW execId gets a new ordinal", async () => {
		const { store, writer } = await makeShadow();
		const dispatcher = new TestDispatcher(
			makeRuntime(async () => ({ success: true, sessionId: "s1" })),
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // FLY-1185 lifecycleAdmission
			undefined, // FLY-1185 lifecycleLaunchGuard
			writer,
		);
		const req = {
			issueId: ISSUE,
			projectName: PROJECT,
			sessionRole: "qa",
			shadowContext: {
				node: "qa",
				attempt: 1,
				edge: { from: "implement", to: "qa" },
			},
		};
		await dispatcher.start(req);
		await dispatcher.drain();
		await dispatcher.start(req); // T7-shaped replacement (start mints a new execId)
		await dispatcher.drain();

		const uids = store.listWorkflowRunEvents("run-1").map((e) => e.event_uid);
		expect(uids).toEqual([
			"run:run-1:edge:implement:qa:1",
			"run:run-1:dispatch:qa:1:1",
			"run:run-1:dispatch:qa:1:2",
		]);
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(2);
	});

	it("a rejected Blueprint.run with NO durable evidence abandons the ledger row (pre-commit positive failure)", async () => {
		const { store, writer } = await makeShadow({ marker: false, row: false });
		const dispatcher = new TestDispatcher(
			makeRuntime(async () => {
				throw new Error("spawn refused");
			}),
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // FLY-1185 lifecycleAdmission
			undefined, // FLY-1185 lifecycleLaunchGuard
			writer,
		);
		await dispatcher.start({ issueId: ISSUE, projectName: PROJECT });
		await dispatcher.drain();
		const row = store.listWorkflowSideEffects("run-1")[0];
		expect(row?.state).toBe("abandoned");
		expect(row?.reason).toContain("spawn refused");
	});
});

// ── PhaseOrchestrator hook sites ────────────────────────────────────────────

function makeQaVerdicts(store: StateStore) {
	const intents = new Map<string, ThreeStageVerdictIntent>();
	const qaVerdicts: PhaseOrchestratorDeps["qaVerdicts"] = {
		getSession: vi.fn((): PhaseSession | undefined => undefined),
		readIntent: vi.fn((id: string) => intents.get(id)),
		patchIntent: vi.fn(
			(id: string, patch: Partial<ThreeStageVerdictIntent>) => {
				intents.set(id, {
					...(intents.get(id) ?? {}),
					...patch,
				} as ThreeStageVerdictIntent);
			},
		),
		countImplementPhases: vi.fn(() => 1),
		// mirrors plugin.ts: the durable fix-round record lands in the SAME store
		// the shadow writer derives currentAttempt from.
		recordFixRound: vi.fn((session: PhaseSession, verdictEventId: string) => {
			const eventId = `three-stage-fix-round-${verdictEventId}`;
			const round =
				store.countEventsByIssueAndType(
					session.issue_id,
					"three_stage_fix_round",
				) + 1;
			store.insertEvent({
				event_id: eventId,
				execution_id: session.execution_id,
				issue_id: session.issue_id,
				project_name: session.project_name ?? PROJECT,
				event_type: "three_stage_fix_round",
				source: "test",
				payload: { round, verdictEventId },
			});
			return round;
		}),
		getActiveImplementSession: vi.fn((): PhaseSession | undefined => undefined),
		listVerdictEventCandidates: vi.fn((): PhaseSession[] => []),
		getLatestQaResultEvent: vi.fn(() => undefined),
		listStrandedPassCandidates: vi.fn((): PhaseSession[] => []),
		postIssueThread: vi.fn(async () => {}),
		hasGateResponse: vi.fn((): boolean => false),
	};
	return { qaVerdicts, intents };
}

function makeOrchestrator(
	store: StateStore,
	writer: WorkflowShadowWriter,
	over: Partial<PhaseOrchestratorDeps> = {},
) {
	// the fake dispatcher honors the seam contract: a spawn request carrying
	// shadowContext produces the same shadow write the real seam performs.
	const start = vi.fn(
		async (req: {
			issueId: string;
			projectName: string;
			shadowContext?: {
				node: string;
				attempt: number;
				edge?: { from: string; to: string };
			};
		}) => {
			const executionId = `spawned-${start.mock.calls.length}`;
			if (req.shadowContext) {
				writer.onSpawnDispatch({
					projectName: req.projectName,
					issueId: req.issueId,
					executionId,
					context: req.shadowContext,
				});
			}
			return { executionId };
		},
	);
	const { qaVerdicts, intents } = makeQaVerdicts(store);
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const getAlivePhaseSession = vi.fn((): PhaseSession | undefined => undefined);
	const turnBelt: PhaseOrchestratorDeps["turnBelt"] = {
		listTurns: vi.fn((): { projectName: string; turn: TurnBeltRow }[] => []),
		getTurn: vi.fn((): TurnBeltRow | null => null),
		deleteTurn: vi.fn(() => {}),
		getSessionForTurnHolder: vi.fn((): PhaseSession | undefined => undefined),
		getPhaseSessionsForIssue: vi.fn((): PhaseSession[] => []),
	};
	const deps: PhaseOrchestratorDeps = {
		startDispatcher: { start },
		effects: {
			capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
			closePhaseRunner: vi.fn(async () => {}),
			alertLeadPipelineError: vi.fn(async () => {}),
			probePhaseAlive: vi.fn(async () => "alive" as const),
			probeGhostTmux: vi.fn(async () => "absent" as const),
			parkPhaseRunner: vi.fn(async () => {}),
			wakePhaseRunner,
			assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
		},
		resolveThreeStage: () => ({ enabled: true }),
		listStrandedDesignPhases: vi.fn((): PhaseSession[] => []),
		listStrandedImplementPhases: vi.fn((): PhaseSession[] => []),
		listPhaseSessionRows: vi.fn((): PhaseSession[] => []),
		resolveLeadId: vi.fn(() => "eng-lead"),
		keepAliveEnabled: vi.fn(() => false),
		getAlivePhaseSession,
		hasShipFinalizationClaim: vi.fn(() => false),
		refreshPhaseStatusLine: vi.fn(async () => {}),
		grantTurn: vi.fn(() => {}),
		turnBelt,
		qaVerdicts,
		workflowShadow: writer,
		...over,
	};
	return {
		orch: new PhaseOrchestrator(deps),
		start,
		wakePhaseRunner,
		getAlivePhaseSession,
		qaVerdicts,
		intents,
	};
}

function session(over: Partial<PhaseSession>): PhaseSession {
	return {
		execution_id: "exec-1",
		issue_id: ISSUE,
		project_name: PROJECT,
		status: "running",
		...over,
	};
}

describe("PhaseOrchestrator shadow hooks (T2–T6)", () => {
	it("T4+T2: design done → node_completed(design) THEN edge+dispatch(implement) via the seam contract", async () => {
		const { store, writer } = await makeShadow();
		const { orch, start } = makeOrchestrator(store, writer);
		await orch.onPhaseComplete(
			session({
				execution_id: "exec-design",
				session_role: "design",
				status: "design_done",
			}),
		);
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]?.[0]).toMatchObject({
			shadowContext: {
				node: "implement",
				attempt: 1,
				edge: { from: "design", to: "implement" },
			},
		});
		const uids = store.listWorkflowRunEvents("run-1").map((e) => e.event_uid);
		expect(uids).toEqual([
			"run:run-1:complete:design:1:exec-design",
			"run:run-1:edge:design:implement:1",
			"run:run-1:dispatch:implement:1:1",
		]);
	});

	it("T3b: keep-alive retest handoff WAKES the parked QA — edge + wake, NO ledger row", async () => {
		const { store, writer } = await makeShadow();
		const parkedQa = session({
			execution_id: "exec-qa",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		const { orch, start } = makeOrchestrator(store, writer, {
			keepAliveEnabled: vi.fn(() => true),
			getAlivePhaseSession: vi.fn((_, phase) =>
				phase === "qa" ? parkedQa : undefined,
			),
		});
		await orch.onPhaseComplete(
			session({
				execution_id: "exec-impl",
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
		);
		expect(start).not.toHaveBeenCalled(); // wake, not spawn
		const uids = store.listWorkflowRunEvents("run-1").map((e) => e.event_uid);
		expect(uids).toContain("run:run-1:complete:implement:1:exec-impl"); // T4
		expect(uids).toContain("run:run-1:edge:implement:qa:1"); // T3b edge
		expect(uids).toContain("run:run-1:wake:qa:1"); // T3b wake
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(0);
	});

	it("T6+T3: keep-alive QA FAIL → loop_iteration(round) + wake implement at attempt round+1", async () => {
		const { store, writer } = await makeShadow();
		const parkedImpl = session({
			execution_id: "exec-impl",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "running",
		});
		const qaSession = session({
			execution_id: "exec-qa",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		const { orch } = makeOrchestrator(store, writer, {
			keepAliveEnabled: vi.fn(() => true),
			getAlivePhaseSession: vi.fn((_, phase) =>
				phase === "implement" ? parkedImpl : undefined,
			),
			qaVerdicts: (() => {
				const { qaVerdicts } = makeQaVerdicts(store);
				qaVerdicts.getSession = vi.fn(() => qaSession);
				return qaVerdicts;
			})(),
		});
		await orch.onQaResult(qaSession, {
			eventId: "verdict-1",
			status: "fail",
			summary: "broken",
		});
		const uids = store.listWorkflowRunEvents("run-1").map((e) => e.event_uid);
		expect(uids).toContain("run:run-1:kickback:1"); // T6
		expect(uids).toContain("run:run-1:wake:implement:2"); // T3 at round+1
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(0); // wake ≠ spawn
	});

	it("T5: QA PASS → complete(qa) + qa→end edge at the current attempt", async () => {
		const { store, writer } = await makeShadow();
		const qaSession = session({
			execution_id: "exec-qa",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		const { orch } = makeOrchestrator(store, writer, {
			qaVerdicts: (() => {
				const { qaVerdicts } = makeQaVerdicts(store);
				qaVerdicts.getSession = vi.fn(() => qaSession);
				return qaVerdicts;
			})(),
		});
		await orch.onQaResult(qaSession, { eventId: "verdict-1", status: "pass" });
		const uids = store.listWorkflowRunEvents("run-1").map((e) => e.event_uid);
		expect(uids).toContain("run:run-1:complete:qa:1:exec-qa");
		expect(uids).toContain("run:run-1:edge:qa:end:1");
	});

	it("byte-compat: without the workflowShadow dep the pipeline runs with ZERO shadow writes", async () => {
		const { store, writer } = await makeShadow();
		const { orch, start } = makeOrchestrator(store, writer, {
			workflowShadow: undefined,
		});
		await orch.onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]?.[0]).not.toHaveProperty("shadowContext");
		expect(store.listActiveWorkflowRuns()).toHaveLength(0);
	});
});
