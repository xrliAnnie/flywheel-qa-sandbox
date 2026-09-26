import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PhaseLiveness,
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../phase-orchestrator.js";

/**
 * FLY-1224 (C8, probe-before-wake) — T6/T6b/T7/T8.
 *
 * The stall this kills: a codex implement completes needs_review and its
 * PROCESS exits (transitional contract — no park loop), but its row stays
 * status-ALIVE (awaiting_review). The QA-FAIL fix-wake then "succeeds" (a
 * mailbox write always does), patches `fixExecId`, and permanently
 * short-circuits onQaResult's resume condition — an unreplayable stall.
 * Both wake sites now PROBE the real tmux process first; only a PROVEN-dead
 * target falls to the spawn fallback.
 *
 * MUTATION β (Lead hard-constraint 2): strip the probe from the wake sites →
 * the dead_pin/absent-dead tests here MUST go red (wake called, fixExecId =
 * the corpse's exec id instead of the fresh spawn's).
 */

function makeQaVerdicts() {
	const intents = new Map<string, ThreeStageVerdictIntent>();
	let sessionRow: PhaseSession | undefined;
	const qaVerdicts: PhaseOrchestratorDeps["qaVerdicts"] = {
		getSession: vi.fn(() => sessionRow),
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
		recordFixRound: vi.fn(() => 1),
		getActiveImplementSession: vi.fn((): PhaseSession | undefined => undefined),
		listVerdictEventCandidates: vi.fn((): PhaseSession[] => []),
		getLatestQaResultEvent: vi.fn(() => undefined),
		listStrandedPassCandidates: vi.fn((): PhaseSession[] => []),
		postIssueThread: vi.fn(async () => {}),
		hasGateResponse: vi.fn((): boolean => false),
	};
	return {
		qaVerdicts,
		intents,
		setSessionRow: (s: PhaseSession) => {
			sessionRow = s;
		},
	};
}

function makeDeps(over: Partial<PhaseOrchestratorDeps> = {}) {
	const start = vi.fn(async () => ({ executionId: "fresh-exec" }));
	const capturePhaseHeadSha = vi.fn(async () => "deadbeefcafe1234");
	const closePhaseRunner = vi.fn(async () => {});
	const alertLeadPipelineError = vi.fn(async () => {});
	const probePhaseAlive = vi.fn(async (): Promise<PhaseLiveness> => "alive");
	const probeGhostTmux = vi.fn(async (): Promise<PhaseLiveness> => "absent");
	const parkPhaseRunner = vi.fn(async () => {});
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const assertPhaseWorktreeReady = vi.fn(async () => ({ ok: true }));
	const getAlivePhaseSession = vi.fn((): PhaseSession | undefined => undefined);
	const listPhaseSessionRows = vi.fn((): PhaseSession[] => []);
	const turnBelt: PhaseOrchestratorDeps["turnBelt"] = {
		listTurns: vi.fn(() => []),
		getTurn: vi.fn(() => null),
		deleteTurn: vi.fn(() => {}),
		getSessionForTurnHolder: vi.fn((): PhaseSession | undefined => undefined),
		getPhaseSessionsForIssue: vi.fn((): PhaseSession[] => []),
	};
	const grantTurn = vi.fn(() => {});
	const { qaVerdicts, intents, setSessionRow } = makeQaVerdicts();
	const deps: PhaseOrchestratorDeps = {
		startDispatcher: { start },
		effects: {
			capturePhaseHeadSha,
			closePhaseRunner,
			alertLeadPipelineError,
			probePhaseAlive,
			probeGhostTmux,
			parkPhaseRunner,
			wakePhaseRunner,
			assertPhaseWorktreeReady,
		},
		resolveThreeStage: () => ({ enabled: true }),
		listStrandedDesignPhases: () => [],
		listStrandedImplementPhases: () => [],
		listPhaseSessionRows,
		resolveLeadId: () => "eng-lead",
		keepAliveEnabled: () => true,
		getAlivePhaseSession,
		hasShipFinalizationClaim: () => false,
		refreshPhaseStatusLine: vi.fn(async () => {}),
		grantTurn,
		turnBelt,
		qaVerdicts,
		...over,
	};
	return {
		deps,
		start,
		probePhaseAlive,
		probeGhostTmux,
		wakePhaseRunner,
		assertPhaseWorktreeReady,
		grantTurn,
		getAlivePhaseSession,
		alertLeadPipelineError,
		qaVerdicts,
		intents,
		setSessionRow,
	};
}

function session(over: Partial<PhaseSession>): PhaseSession {
	return {
		execution_id: "exec-1",
		issue_id: "FLY-1224",
		project_name: "flywheel",
		status: "running",
		...over,
	};
}

function qaSession() {
	return session({
		execution_id: "qa-1",
		session_role: "qa",
		chat_thread_role: "qa",
		status: "running",
	});
}

/** The codex-implement corpse shape: status-ALIVE row, persisted tmux target. */
function deadImplRow() {
	return session({
		execution_id: "impl-corpse",
		session_role: "implement",
		chat_thread_role: "implement",
		status: "awaiting_review",
		tmux_session: "flywheel-base:@42",
	});
}

/**
 * Liveness scripting: probePhaseAlive answers per-row via execution_id so the
 * handoff path's PREV probe (park decision) and the C8 TARGET probe can differ.
 */
function scriptLiveness(
	h: ReturnType<typeof makeDeps>,
	byExec: Record<string, PhaseLiveness>,
	fallback: PhaseLiveness = "alive",
) {
	h.probePhaseAlive.mockImplementation(
		async (row: PhaseSession) => byExec[row.execution_id] ?? fallback,
	);
}

describe("FLY-1224 C8 — fix-wake site (T6/T6b/T7)", () => {
	beforeEach(() => vi.clearAllMocks());

	function failVerdict() {
		return { eventId: "V1", status: "fail", summary: "scenario X broke" };
	}

	it("T6: dead_pin implement → NO wake / NO worktree assert / NO grantTurn; spawn fallback; fixExecId = FRESH exec", async () => {
		const impl = deadImplRow();
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		scriptLiveness(h, { "impl-corpse": "dead_pin" });
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), failVerdict());
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.assertPhaseWorktreeReady).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "implement",
			dispatchVendor: "codex",
		});
		// MUTATION β red-line: with the probe stripped, the wake path patches
		// fixExecId = "impl-corpse" (the corpse) — this asserts the FRESH exec.
		expect(h.intents.get("qa-1")?.fixExecId).toBe("fresh-exec");
	});

	it("T6: absent + persisted target + DIRECT probe dead → spawn fallback (fresh exec)", async () => {
		const impl = deadImplRow();
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		scriptLiveness(h, { "impl-corpse": "absent" });
		h.probeGhostTmux.mockResolvedValue("absent");
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), failVerdict());
		// the direct probe MUST have hit THIS row's persisted target
		expect(h.probeGhostTmux).toHaveBeenCalledWith(impl);
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.intents.get("qa-1")?.fixExecId).toBe("fresh-exec");
	});

	it("T6b: absent + NO persisted tmux target → unfalsifiable → existing wake path (fail-closed)", async () => {
		const impl = session({
			execution_id: "impl-no-target",
			session_role: "implement",
			status: "awaiting_review",
			// no tmux_session — a CommDB lock/corruption window also reads absent
		});
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		scriptLiveness(h, { "impl-no-target": "absent" });
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), failVerdict());
		expect(h.probeGhostTmux).not.toHaveBeenCalled();
		expect(h.wakePhaseRunner).toHaveBeenCalledOnce();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("T6b: absent + persisted target + direct probe ALIVE → wake path, no spawn", async () => {
		const impl = deadImplRow();
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		scriptLiveness(h, { "impl-corpse": "absent" });
		h.probeGhostTmux.mockResolvedValue("alive");
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), failVerdict());
		expect(h.wakePhaseRunner).toHaveBeenCalledOnce();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("T6b: absent + persisted target + direct probe INDETERMINATE → existing path (fail-closed)", async () => {
		const impl = deadImplRow();
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		scriptLiveness(h, { "impl-corpse": "absent" });
		h.probeGhostTmux.mockResolvedValue("indeterminate");
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), failVerdict());
		expect(h.wakePhaseRunner).toHaveBeenCalledOnce();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("T7: probe ALIVE → the wake path is parameter-identical to the pre-C8 shape", async () => {
		const impl = session({
			execution_id: "impl-1",
			session_role: "implement",
			tmux_session: "flywheel-base:@7",
		});
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		// default probePhaseAlive = alive
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), failVerdict());
		expect(h.assertPhaseWorktreeReady).toHaveBeenCalledWith(
			impl,
			"deadbeefcafe1234",
		);
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "impl-1", phase: "implement" }),
		);
		expect(h.wakePhaseRunner).toHaveBeenCalledWith(
			expect.objectContaining({
				session: impl,
				kind: "fix",
				headSha: "deadbeefcafe1234",
				round: 1,
				qaSummary: "scenario X broke",
			}),
		);
		expect(h.start).not.toHaveBeenCalled();
		expect(h.intents.get("qa-1")?.fixExecId).toBe("impl-1");
	});

	it("T7: probe INDETERMINATE (target-level) → existing wake path (fail-closed, never spawn on a maybe-alive)", async () => {
		const impl = deadImplRow();
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		scriptLiveness(h, { "impl-corpse": "indeterminate" });
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), failVerdict());
		expect(h.wakePhaseRunner).toHaveBeenCalledOnce();
		expect(h.start).not.toHaveBeenCalled();
	});
});

describe("FLY-1224 C8 — handoff-wake site (T8)", () => {
	beforeEach(() => vi.clearAllMocks());

	function implDone() {
		return session({
			execution_id: "impl-done",
			session_role: "implement",
			status: "awaiting_review",
			review_question_id: "q-1",
		});
	}

	it("T8: dead_pin QA target → NO wake / NO grantTurn; spawn fallback dispatches QA", async () => {
		const qa = session({
			execution_id: "qa-corpse",
			session_role: "qa",
			chat_thread_role: "qa",
			tmux_session: "flywheel-base:@9",
		});
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "qa" ? qa : undefined,
			),
		});
		// prev (impl-done) probes alive → parks; the QA target probes dead_pin.
		scriptLiveness(h, { "qa-corpse": "dead_pin", "impl-done": "alive" });
		await new PhaseOrchestrator(h.deps).onPhaseComplete(implDone());
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.assertPhaseWorktreeReady).not.toHaveBeenCalled();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "qa",
			dispatchVendor: "claude",
		});
	});

	it("T8: absent + persisted target + direct probe dead → spawn fallback", async () => {
		const qa = session({
			execution_id: "qa-corpse",
			session_role: "qa",
			chat_thread_role: "qa",
			tmux_session: "flywheel-base:@9",
		});
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "qa" ? qa : undefined,
			),
		});
		scriptLiveness(h, { "qa-corpse": "absent", "impl-done": "alive" });
		h.probeGhostTmux.mockImplementation(async (row: PhaseSession) =>
			row.execution_id === "qa-corpse" ? "absent" : "alive",
		);
		await new PhaseOrchestrator(h.deps).onPhaseComplete(implDone());
		expect(h.probeGhostTmux).toHaveBeenCalledWith(qa);
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).toHaveBeenCalledOnce();
	});

	it("T8: alive QA target → wake path byte-unchanged (grantTurn before wake, no spawn)", async () => {
		const qa = session({
			execution_id: "qa-live",
			session_role: "qa",
			chat_thread_role: "qa",
			tmux_session: "flywheel-base:@9",
		});
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "qa" ? qa : undefined,
			),
		});
		// default alive everywhere
		await new PhaseOrchestrator(h.deps).onPhaseComplete(implDone());
		expect(h.assertPhaseWorktreeReady).toHaveBeenCalledWith(
			qa,
			"deadbeefcafe1234",
		);
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "qa-live", phase: "qa" }),
		);
		expect(h.wakePhaseRunner).toHaveBeenCalledWith(
			expect.objectContaining({ session: qa, kind: "retest" }),
		);
		expect(h.grantTurn.mock.invocationCallOrder[0]).toBeLessThan(
			h.wakePhaseRunner.mock.invocationCallOrder[0]!,
		);
		expect(h.start).not.toHaveBeenCalled();
	});

	it("T8: absent + NO persisted target → existing wake path (fail-closed)", async () => {
		const qa = session({
			execution_id: "qa-no-target",
			session_role: "qa",
			chat_thread_role: "qa",
			// no tmux_session
		});
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "qa" ? qa : undefined,
			),
		});
		scriptLiveness(h, { "qa-no-target": "absent", "impl-done": "alive" });
		await new PhaseOrchestrator(h.deps).onPhaseComplete(implDone());
		expect(h.probeGhostTmux).not.toHaveBeenCalled();
		expect(h.wakePhaseRunner).toHaveBeenCalledOnce();
		expect(h.start).not.toHaveBeenCalled();
	});
});
