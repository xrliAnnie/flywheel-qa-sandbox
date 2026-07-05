import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PhaseLiveness,
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../phase-orchestrator.js";

/**
 * FLY-887: keep-alive handoff (park + wake-or-spawn + TURN) and QA-FAIL fix loop.
 * Keep-alive ON (default in production); the legacy path is covered separately
 * with keep-alive OFF (phase-orchestrator.test.ts).
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
	const start = vi.fn(async () => ({ executionId: "next-exec" }));
	const capturePhaseHeadSha = vi.fn(async () => "deadbeefcafe1234");
	const closePhaseRunner = vi.fn(async () => {});
	const alertLeadPipelineError = vi.fn(async () => {});
	const probePhaseAlive = vi.fn(async (): Promise<PhaseLiveness> => "alive");
	const parkPhaseRunner = vi.fn(async () => {});
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const assertPhaseWorktreeReady = vi.fn(async () => ({ ok: true }));
	const getAlivePhaseSession = vi.fn((): PhaseSession | undefined => undefined);
	const grantTurn = vi.fn(() => {});
	const { qaVerdicts, intents, setSessionRow } = makeQaVerdicts();
	const deps: PhaseOrchestratorDeps = {
		startDispatcher: { start },
		effects: {
			capturePhaseHeadSha,
			closePhaseRunner,
			alertLeadPipelineError,
			probePhaseAlive,
			parkPhaseRunner,
			wakePhaseRunner,
			assertPhaseWorktreeReady,
		},
		resolveThreeStage: () => ({ enabled: true }),
		listStrandedDesignPhases: () => [],
		resolveLeadId: () => "eng-lead",
		keepAliveEnabled: () => true,
		getAlivePhaseSession,
		grantTurn,
		qaVerdicts,
		...over,
	};
	return {
		deps,
		start,
		capturePhaseHeadSha,
		closePhaseRunner,
		alertLeadPipelineError,
		probePhaseAlive,
		parkPhaseRunner,
		wakePhaseRunner,
		assertPhaseWorktreeReady,
		getAlivePhaseSession,
		grantTurn,
		qaVerdicts,
		intents,
		setSessionRow,
	};
}

function session(over: Partial<PhaseSession>): PhaseSession {
	return {
		execution_id: "exec-1",
		issue_id: "FLY-1",
		project_name: "flywheel",
		status: "running",
		...over,
	};
}

describe("FLY-887 keep-alive handoff (park + wake-or-spawn + TURN)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("design done + alive → PARK (not close); no live implement → spawn", async () => {
		const h = makeDeps();
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(h.parkPhaseRunner).toHaveBeenCalledOnce();
		expect(h.closePhaseRunner).not.toHaveBeenCalled();
		// no live implement → spawn (caller does NOT grant TURN; dispatcher seam does)
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "implement",
		});
		expect(h.grantTurn).not.toHaveBeenCalled();
	});

	it("liveness indeterminate → fail-closed (no park, no close, no dispatch)", async () => {
		const h = makeDeps({
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(
					async (): Promise<PhaseLiveness> => "indeterminate",
				),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.deps.effects.parkPhaseRunner).not.toHaveBeenCalled();
		expect(h.deps.effects.closePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("dead_pin → close-clean (not park), then spawn next", async () => {
		const h = makeDeps({
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(h.deps.effects.closePhaseRunner).toHaveBeenCalledOnce();
		expect(h.deps.effects.parkPhaseRunner).not.toHaveBeenCalled();
		expect(h.start).toHaveBeenCalledOnce();
	});

	it("implement done + live parked QA → grantTurn BEFORE wake, no spawn", async () => {
		const qa = session({
			execution_id: "qa-exec",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_issue, phase) =>
				phase === "qa" ? qa : undefined,
			),
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({ session_role: "implement", status: "awaiting_review" }),
		);
		expect(h.parkPhaseRunner).toHaveBeenCalledOnce();
		expect(h.assertPhaseWorktreeReady).toHaveBeenCalledWith(
			qa,
			"deadbeefcafe1234",
		);
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "qa-exec", phase: "qa" }),
		);
		expect(h.wakePhaseRunner).toHaveBeenCalledWith(
			expect.objectContaining({ session: qa, kind: "retest" }),
		);
		expect(h.start).not.toHaveBeenCalled();
	});

	it("wake target worktree not ready → fail-closed, no grantTurn, no wake", async () => {
		const qa = session({ execution_id: "qa-exec", session_role: "qa" });
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "qa" ? qa : undefined,
			),
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({
					ok: false,
					reason: "dirty",
				})),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({ session_role: "implement", status: "awaiting_review" }),
		);
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deps.effects.wakePhaseRunner).not.toHaveBeenCalled();
	});

	it("wake failure → warns but leaves TURN set (held for reconcile), never throws", async () => {
		const qa = session({ execution_id: "qa-exec", session_role: "qa" });
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "qa" ? qa : undefined,
			),
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({
					ok: false,
					error: "no mailbox",
				})),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({ session_role: "implement", status: "awaiting_review" }),
		);
		expect(h.grantTurn).toHaveBeenCalledOnce(); // TURN set before wake
		expect(h.deps.effects.alertLeadPipelineError).not.toHaveBeenCalled(); // not fail-closed
	});
});

describe("FLY-887 keep-alive QA-FAIL fix loop (wake implement, don't close QA)", () => {
	beforeEach(() => vi.clearAllMocks());

	function qaSession() {
		return session({
			execution_id: "qa-1",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
	}

	it("FAIL + live implement → recordFixRound + grantTurn + wake(fix), QA NOT closed", async () => {
		const impl = session({ execution_id: "impl-1", session_role: "implement" });
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
		});
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), {
			eventId: "V1",
			status: "fail",
			summary: "login regression",
		});
		expect(h.qaVerdicts.recordFixRound).toHaveBeenCalledOnce();
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "impl-1", phase: "implement" }),
		);
		expect(h.wakePhaseRunner).toHaveBeenCalledWith(
			expect.objectContaining({ session: impl, kind: "fix", round: 1 }),
		);
		expect(h.closePhaseRunner).not.toHaveBeenCalled(); // QA parks, not closed
		expect(h.intents.get("qa-1")?.fixExecId).toBe("impl-1");
	});

	it("FAIL round over cap → refuse (alert Lead), no wake", async () => {
		const impl = session({ execution_id: "impl-1", session_role: "implement" });
		const h = makeDeps({
			getAlivePhaseSession: vi.fn(() => impl),
			qaVerdicts: {
				...makeQaVerdicts().qaVerdicts,
				getSession: vi.fn(() => qaSession()),
				recordFixRound: vi.fn(() => 4), // > default cap 3
			},
		});
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), {
			eventId: "V1",
			status: "fail",
		});
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
	});

	it("FAIL + no live implement (died) → spawn Implement-fix, QA still NOT closed", async () => {
		const h = makeDeps({ getAlivePhaseSession: vi.fn(() => undefined) });
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), {
			eventId: "V1",
			status: "fail",
		});
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "implement",
			phaseFixContext: { round: 1 },
		});
		expect(h.closePhaseRunner).not.toHaveBeenCalled();
	});

	it("multi-round: a NEW verdict eventId after a complete round is processed as a new round", async () => {
		const impl = session({ execution_id: "impl-1", session_role: "implement" });
		let round = 0;
		const h = makeDeps({ getAlivePhaseSession: vi.fn(() => impl) });
		h.setSessionRow(qaSession());
		// increment the round per verdict (the durable ledger's insert-or-read).
		(
			h.qaVerdicts.recordFixRound as ReturnType<typeof vi.fn>
		).mockImplementation(() => ++round);
		const orch = new PhaseOrchestrator(h.deps);
		await orch.onQaResult(qaSession(), { eventId: "V1", status: "fail" });
		await orch.onQaResult(qaSession(), { eventId: "V2", status: "fail" });
		expect(h.qaVerdicts.recordFixRound).toHaveBeenCalledTimes(2);
		expect(h.wakePhaseRunner).toHaveBeenCalledTimes(2);
		expect(
			(h.wakePhaseRunner.mock.calls[1]![0] as { round: number }).round,
		).toBe(2);
	});

	it("PASS → no fix loop, no close (QA proceeds to the ship gate itself)", async () => {
		const h = makeDeps();
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), {
			eventId: "V1",
			status: "pass",
		});
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).not.toHaveBeenCalled();
		expect(h.closePhaseRunner).not.toHaveBeenCalled();
		expect(h.intents.get("qa-1")?.status).toBe("pass");
	});
});

describe("FLY-887 QA FINDING: reconcileOnStartup re-fires design→implement on EVERY restart under keep-alive", () => {
	beforeEach(() => vi.clearAllMocks());

	/**
	 * BUG: under keep-alive, a design phase parks FOREVER at status='design_done'
	 * (that is the whole point of "park, don't exit"). But
	 * `listStrandedDesignPhases` (StateStore.getStrandedDesignPhaseSessions) is a
	 * blind `session_role='design' AND status='design_done'` query with no
	 * liveness/progress check — it was written pre-FLY-887, when design_done was
	 * ALWAYS a genuine "implement never started" crash artifact. Under keep-alive
	 * it now ALSO matches every currently-healthy parked design session, on every
	 * single Bridge restart, for as long as the issue is unshipped.
	 *
	 * reconcileOnStartup replays each of these through onPhaseComplete → handoff,
	 * which re-derives `next = nextPhase('design') = 'implement'` and re-executes
	 * the FULL wake-or-spawn path — even when the pipeline has ALREADY moved past
	 * Implement into a live QA fix-loop. This test proves the concrete harm: the
	 * shared-worktree TURN gets torn away from whoever legitimately holds it
	 * (here: QA, mid fix-loop) and reassigned to `implement`, which then receives
	 * a "retest"-worded wake it was never taught to handle (that wording is QA's
	 * contract, not implement's — implement's prompt only knows a "QA FIX"
	 * wake). This fires on EVERY restart, not once, since the design session's
	 * status never changes.
	 *
	 * EXPECTED (fix target): reconcileOnStartup must not re-drive a design→
	 * implement handoff when the issue has already progressed past Implement
	 * (an alive QA/beyond phase already exists, or the TURN already points
	 * elsewhere) — the RED assertions below currently FAIL against phase-
	 * orchestrator.ts, demonstrating the bug.
	 */
	it("does NOT steal the TURN from a live QA fix-loop, and does NOT wake implement, when reconcile replays a permanently-parked design_done session", async () => {
		const strandedDesign = session({
			execution_id: "design-exec",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done", // permanent under keep-alive — not a crash artifact
		});
		const aliveImplement = session({
			execution_id: "impl-exec",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review",
		});
		const grantTurn = vi.fn();
		const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
		const start = vi.fn(async () => ({ executionId: "should-not-spawn" }));
		const h = makeDeps({
			listStrandedDesignPhases: () => [strandedDesign],
			getAlivePhaseSession: (_issueId, phase) =>
				phase === "implement" ? aliveImplement : undefined,
			grantTurn,
			startDispatcher: { start },
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "currentSharedWorktreeHead"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async () => "alive" as const),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner,
				// Same shared worktree → trivially "ready" regardless of how far
				// downstream the pipeline has actually progressed.
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});

		await new PhaseOrchestrator(h.deps).reconcileOnStartup();

		// A design session that is merely PARKED (not genuinely stranded) must not
		// re-trigger a handoff at all — the pipeline has already moved on.
		expect(grantTurn).not.toHaveBeenCalled();
		expect(wakePhaseRunner).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});
});
