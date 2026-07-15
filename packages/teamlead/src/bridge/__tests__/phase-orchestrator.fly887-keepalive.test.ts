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
		// FLY-939 (G-B): default no gate response (not a kickback).
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
	const start = vi.fn(async () => ({ executionId: "next-exec" }));
	const capturePhaseHeadSha = vi.fn(async () => "deadbeefcafe1234");
	const closePhaseRunner = vi.fn(async () => {});
	const alertLeadPipelineError = vi.fn(async () => {});
	const probePhaseAlive = vi.fn(async (): Promise<PhaseLiveness> => "alive");
	// FLY-939 (G-C): default ghost probe = absent (no live ghost → spawn allowed).
	const probeGhostTmux = vi.fn(async (): Promise<PhaseLiveness> => "absent");
	const parkPhaseRunner = vi.fn(async () => {});
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const assertPhaseWorktreeReady = vi.fn(async () => ({ ok: true }));
	const getAlivePhaseSession = vi.fn((): PhaseSession | undefined => undefined);
	const hasShipFinalizationClaim = vi.fn((): boolean => false);
	// FLY-939 (G-A2 / G-C): default empty stranded list + empty phase rows.
	const listStrandedImplementPhases = vi.fn((): PhaseSession[] => []);
	const listPhaseSessionRows = vi.fn((): PhaseSession[] => []);
	const refreshPhaseStatusLine = vi.fn(async (): Promise<void> => {});
	const grantTurn = vi.fn(() => {});
	// FLY-921 Fix C: turn-belt reconcile deps (defaults = empty belt).
	const turnBelt: PhaseOrchestratorDeps["turnBelt"] = {
		listTurns: vi.fn(() => []),
		getTurn: vi.fn(() => null),
		deleteTurn: vi.fn(() => {}),
		getSessionForTurnHolder: vi.fn((): PhaseSession | undefined => undefined),
		getPhaseSessionsForIssue: vi.fn((): PhaseSession[] => []),
	};
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
		listStrandedImplementPhases,
		listPhaseSessionRows,
		resolveLeadId: () => "eng-lead",
		keepAliveEnabled: () => true,
		getAlivePhaseSession,
		hasShipFinalizationClaim,
		refreshPhaseStatusLine,
		grantTurn,
		turnBelt,
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
		probeGhostTmux,
		parkPhaseRunner,
		wakePhaseRunner,
		assertPhaseWorktreeReady,
		getAlivePhaseSession,
		hasShipFinalizationClaim,
		listStrandedImplementPhases,
		listPhaseSessionRows,
		refreshPhaseStatusLine,
		grantTurn,
		turnBelt,
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

	it("FLY-1269: live design_done probes, parks, then hands off without closing", async () => {
		const order: string[] = [];
		const h = makeDeps({
			startDispatcher: {
				start: vi.fn(async () => {
					order.push("dispatch-implement");
					return { executionId: "impl-new" };
				}),
			},
			effects: {
				capturePhaseHeadSha: vi.fn(async () => {
					order.push("capture-head");
					return "deadbeefcafe1234";
				}),
				closePhaseRunner: vi.fn(async () => order.push("close")),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async () => {
					order.push("probe-alive");
					return "alive" as const;
				}),
				probeGhostTmux: vi.fn(async () => "absent" as const),
				parkPhaseRunner: vi.fn(async () => order.push("park-design")),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});

		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({
				execution_id: "codex-design-exec",
				session_role: "design",
				chat_thread_role: "design",
				status: "design_done",
			}),
		);

		expect(order).toEqual([
			"capture-head",
			"probe-alive",
			"park-design",
			"dispatch-implement",
		]);
		expect(h.deps.effects.closePhaseRunner).not.toHaveBeenCalled();
	});

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
			session({
				session_role: "implement",
				status: "awaiting_review",
				// FLY-921: genuine completion carries the review binding.
				review_question_id: "q-1",
			}),
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
		expect(h.grantTurn.mock.invocationCallOrder[0]).toBeLessThan(
			h.wakePhaseRunner.mock.invocationCallOrder[0]!,
		);
		expect(h.start).not.toHaveBeenCalled();
	});

	it("FLY-1269: kill switch OFF preserves legacy close then spawn behavior", async () => {
		const order: string[] = [];
		const h = makeDeps({
			keepAliveEnabled: () => false,
			startDispatcher: {
				start: vi.fn(async () => {
					order.push("dispatch");
					return { executionId: "legacy-next" };
				}),
			},
			effects: {
				capturePhaseHeadSha: vi.fn(async () => {
					order.push("capture");
					return "deadbeefcafe1234";
				}),
				closePhaseRunner: vi.fn(async () => order.push("close")),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async () => {
					order.push("probe");
					return "alive" as const;
				}),
				probeGhostTmux: vi.fn(async () => "absent" as const),
				parkPhaseRunner: vi.fn(async () => order.push("park")),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});

		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);

		expect(order).toEqual(["capture", "close", "dispatch"]);
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
			session({
				session_role: "implement",
				status: "awaiting_review",
				// FLY-921: genuine completion carries the review binding.
				review_question_id: "q-1",
			}),
		);
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.deps.effects.wakePhaseRunner).not.toHaveBeenCalled();
	});

	// FLY-939 (G-A / Step 2): a failed handoff wake now FAILS LOUD — the TURN is
	// still set (points at the parked target, so the reconcile re-drive re-wakes
	// idempotently) but the Lead is alerted instead of a silent warn. A silent
	// warn hid the stall until a human noticed a dead pipeline (today's dup-runner
	// class of symptom). Never throws; never spawns a duplicate.
	it("wake failure → fail-loud (alerts Lead) but leaves TURN set, never throws, never spawns", async () => {
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
				probeGhostTmux: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({
					ok: false,
					error: "no mailbox",
				})),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				// FLY-921: genuine completion carries the review binding.
				review_question_id: "q-1",
			}),
		);
		expect(h.grantTurn).toHaveBeenCalledOnce(); // TURN set before wake
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce(); // fail-loud
		expect(h.start).not.toHaveBeenCalled(); // never spawns a duplicate
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
		expect(h.grantTurn.mock.invocationCallOrder[0]).toBeLessThan(
			h.wakePhaseRunner.mock.invocationCallOrder[0]!,
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
	 * FIX (phase-orchestrator.ts hasProgressedPastDesign): reconcileOnStartup
	 * skips re-driving a design→implement handoff when the issue has already
	 * progressed past Design — a live implement OR qa phase already exists, so the
	 * handoff fired and the pipeline owns itself. Only a design_done whose
	 * downstream never came up (the genuine "implement never started" remnant) is
	 * re-driven. The two follow-on tests pin both edges of that guard.
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

	// Guard against OVER-correction: reconcile MUST still re-drive the handoff for
	// the genuine crash remnant it exists for — a design_done with NO downstream
	// phase alive (the boot marker-drain landed it at design_done but Implement
	// never started). Skipping this one would silently strand a real handoff.
	it("STILL re-drives the handoff for a genuine remnant (no live implement AND no live qa)", async () => {
		const strandedDesign = session({
			execution_id: "design-exec",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done",
		});
		const h = makeDeps({
			listStrandedDesignPhases: () => [strandedDesign],
			// Nothing downstream is alive → implement never started → genuine remnant.
			getAlivePhaseSession: () => undefined,
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		// The handoff fires: no live implement → spawn (dispatcher seam grants TURN).
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "implement",
		});
	});

	// The QA branch of the progressed-past-design check is load-bearing: an
	// Implement that has since DIED (its row gone) with a live QA fix-loop must
	// STILL read as "progressed" — else reconcile resurrects a stale design→
	// implement handoff underneath the QA that legitimately holds the TURN.
	it("skips when only QA is alive (implement already dead) — QA branch of the guard", async () => {
		const strandedDesign = session({
			execution_id: "design-exec",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done",
		});
		const aliveQa = session({
			execution_id: "qa-exec",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		const h = makeDeps({
			listStrandedDesignPhases: () => [strandedDesign],
			getAlivePhaseSession: (_issueId, phase) =>
				phase === "qa" ? aliveQa : undefined,
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).not.toHaveBeenCalled();
	});

	// FLY-887 QA round 2 finding: getAlivePhaseSession only sees LIVE rows, so it
	// cannot tell "implement never started" apart from "implement/qa already
	// finished via SHIPPING" — a Bridge crash between finalizeThreeStagePhases
	// closing Implement (→ completed, no longer ALIVE) and closing Design (still
	// design_done) would otherwise read as a genuine remnant and spawn a BRAND-NEW
	// Implement onto an issue that is already merged. hasShipFinalizationClaim is
	// the durable per-issue signal (runPostShipFinalization's atomic claim event)
	// that closes this gap.
	it("does NOT spawn a new implement when the issue already shipped (finalization claim exists) even though nothing reads as alive", async () => {
		const strandedDesign = session({
			execution_id: "design-exec",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done",
		});
		const h = makeDeps({
			listStrandedDesignPhases: () => [strandedDesign],
			// Implement/QA already finalized to `completed` — no longer ALIVE.
			getAlivePhaseSession: () => undefined,
			// But the issue already shipped (crash landed between the two closeRunner
			// calls inside finalizeThreeStagePhases).
			hasShipFinalizationClaim: () => true,
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).not.toHaveBeenCalled();
	});

	// Sentinel: hasShipFinalizationClaim must NOT over-suppress the genuine
	// remnant case — a design_done whose downstream truly never started (no
	// finalization claim was ever recorded for this issue) still re-drives.
	it("STILL re-drives the genuine remnant when the issue never shipped (no finalization claim)", async () => {
		const strandedDesign = session({
			execution_id: "design-exec",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done",
		});
		const h = makeDeps({
			listStrandedDesignPhases: () => [strandedDesign],
			getAlivePhaseSession: () => undefined,
			hasShipFinalizationClaim: () => false,
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "implement",
		});
	});
});

// FLY-907: the FLY-887 face-C derivation (computePhaseLineStates /
// renderPhaseStatusLine) moved to the unified issue-display module —
// derivePhaseDisplayState + renderPhaseStatusLine are pinned per-row in
// issue-display.test.ts, and the "first (most-recent) row per role" reading
// semantics are pinned in issue-display-refresher.test.ts.
