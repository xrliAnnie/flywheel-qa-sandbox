import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PhaseLiveness,
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../phase-orchestrator.js";

/**
 * FLY-939: wake-not-respawn. All paths that need to re-run/re-verify a phase must
 * WAKE the resident parked session (or fail LOUD), never silently strand it or
 * blindly spawn a duplicate. Keep-alive ON throughout (the production default).
 *
 *   G-A  — a failed fix-loop / handoff wake fails LOUD and stays REPLAYABLE.
 *   G-A2 — a stranded implement→QA handoff is re-driven on boot.
 *   G-B  — a founder-feedback kickback (QA gate answered) enters the fix-loop.
 *   G-C  — a spawn fallback ghost-probes and refuses to spawn onto a live ghost.
 */

function makeQaVerdicts(
	over: Partial<PhaseOrchestratorDeps["qaVerdicts"]> = {},
) {
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
		...over,
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
	const probeGhostTmux = vi.fn(async (): Promise<PhaseLiveness> => "absent");
	const parkPhaseRunner = vi.fn(async () => {});
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const assertPhaseWorktreeReady = vi.fn(async () => ({ ok: true }));
	const getAlivePhaseSession = vi.fn((): PhaseSession | undefined => undefined);
	const hasShipFinalizationClaim = vi.fn((): boolean => false);
	const listStrandedImplementPhases = vi.fn((): PhaseSession[] => []);
	const listPhaseSessionRows = vi.fn((): PhaseSession[] => []);
	const refreshPhaseStatusLine = vi.fn(async (): Promise<void> => {});
	const grantTurn = vi.fn(() => {});
	const turnBelt: PhaseOrchestratorDeps["turnBelt"] = {
		listTurns: vi.fn(() => []),
		getTurn: vi.fn(() => null),
		deleteTurn: vi.fn(() => {}),
		getSessionForTurnHolder: vi.fn((): PhaseSession | undefined => undefined),
		getPhaseSessionsForIssue: vi.fn((): PhaseSession[] => []),
	};
	// Merge a partial qaVerdicts override into the full default set — the rest of
	// `over` must NOT clobber the merged qaVerdicts (a bare partial would drop
	// getSession/readIntent/... and break onQaResult's fresh re-read).
	const { qaVerdicts: qaOver, ...restOver } = over;
	const { qaVerdicts, intents, setSessionRow } = makeQaVerdicts(
		(qaOver as Partial<PhaseOrchestratorDeps["qaVerdicts"]>) ?? {},
	);
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
		...restOver,
	};
	return {
		deps,
		start,
		capturePhaseHeadSha,
		alertLeadPipelineError,
		probeGhostTmux,
		wakePhaseRunner,
		getAlivePhaseSession,
		listStrandedImplementPhases,
		listPhaseSessionRows,
		hasShipFinalizationClaim,
		grantTurn,
		qaVerdicts,
		intents,
		setSessionRow,
	};
}

function session(over: Partial<PhaseSession>): PhaseSession {
	return {
		execution_id: "exec-1",
		issue_id: "FLY-939",
		project_name: "flywheel",
		status: "running",
		...over,
	};
}

function qaSession(over: Partial<PhaseSession> = {}): PhaseSession {
	return session({
		execution_id: "qa-1",
		session_role: "qa",
		chat_thread_role: "qa",
		status: "running",
		...over,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// G-A — fix-loop wake failure fails LOUD and stays replayable
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-939 G-A: QA-FAIL fix-loop wake failure is fail-loud + replayable", () => {
	beforeEach(() => vi.clearAllMocks());

	it("wake fails → failClosed, fixExecId NOT patched, alertedAt NOT patched, TURN set, no spawn", async () => {
		const impl = session({ execution_id: "impl-1", session_role: "implement" });
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
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
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), {
			eventId: "V1",
			status: "fail",
			summary: "login regression",
		});
		expect(h.grantTurn).toHaveBeenCalledOnce(); // TURN set before wake
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce(); // fail-loud
		expect(h.start).not.toHaveBeenCalled(); // never spawns a duplicate
		// The intent stays replayable: no fixExecId, no alertedAt.
		expect(h.intents.get("qa-1")?.fixExecId).toBeUndefined();
		expect(h.intents.get("qa-1")?.alertedAt).toBeUndefined();
	});

	it("wake succeeds → fixExecId patched, no failClosed (sentinel — the happy path is unchanged)", async () => {
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
		});
		expect(h.intents.get("qa-1")?.fixExecId).toBe("impl-1");
		expect(h.deps.effects.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("boot replay after a failed wake re-drives the SAME round and re-wakes", async () => {
		const impl = session({ execution_id: "impl-1", session_role: "implement" });
		let wakeOk = false; // first attempt fails, the replay succeeds
		const wakePhaseRunner = vi.fn(async () => ({
			ok: wakeOk,
			...(wakeOk ? {} : { error: "no mailbox" }),
		}));
		const recordFixRound = vi.fn(() => 1); // insert-or-read always returns round 1
		const qa = qaSession();
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
				probeGhostTmux: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner,
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
			qaVerdicts: { recordFixRound },
		});
		h.setSessionRow(qa);
		const orch = new PhaseOrchestrator(h.deps);
		// Round 1: wake fails → replayable intent, no fixExecId.
		await orch.onQaResult(qa, { eventId: "V1", status: "fail" });
		expect(h.intents.get("qa-1")?.fixExecId).toBeUndefined();
		// Boot reconcile replays the SAME stored verdict; now the wake succeeds.
		wakeOk = true;
		await orch.onQaResult(qa, { eventId: "V1", status: "fail" });
		expect(recordFixRound).toHaveBeenCalledTimes(2); // same event id → same round
		expect(recordFixRound.mock.results.every((r) => r.value === 1)).toBe(true);
		expect(wakePhaseRunner).toHaveBeenCalledTimes(2);
		expect(h.intents.get("qa-1")?.fixExecId).toBe("impl-1"); // now bound
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A2 — boot re-drives a stranded implement→QA handoff
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-939 G-A2: reconcile re-drives a stranded implement→QA handoff", () => {
	beforeEach(() => vi.clearAllMocks());

	const strandedImpl = () =>
		session({
			execution_id: "impl-strand",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review",
			review_question_id: "q-1", // genuine completion evidence
		});

	it("stranded implement + ZERO qa rows + no ship claim → re-drives handoff (spawns QA)", async () => {
		const h = makeDeps({
			listStrandedImplementPhases: () => [strandedImpl()],
			listPhaseSessionRows: () => [], // no qa rows
			getAlivePhaseSession: () => undefined,
			hasShipFinalizationClaim: () => false,
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({ sessionRole: "qa" });
	});

	it("an ALIVE qa row exists → pipeline owns itself → skip", async () => {
		// FLY-1050 contract change: a DEAD qa row (terminated/failed/completed,
		// no ship claim) no longer counts as "the handoff fired" — that exact
		// criteria stranded FLY-967 (dead qa row blocked the re-drive forever).
		// The ownership signal is now an ALIVE qa (or a latest-FAIL fix-loop /
		// ship claim); dead-row respawn is covered by
		// phase-orchestrator.fly1050-qa-respawn.test.ts.
		const aliveQa = session({
			execution_id: "qa-live",
			chat_thread_role: "qa",
			status: "awaiting_review",
		});
		const h = makeDeps({
			listStrandedImplementPhases: () => [strandedImpl()],
			listPhaseSessionRows: (_issue, phase) =>
				phase === "qa" ? [aliveQa] : [],
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "qa" ? aliveQa : undefined,
			),
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("FLY-1050: a DEAD (completed, no ship claim) qa row no longer blocks the re-drive", async () => {
		const terminalQa = session({
			execution_id: "qa-old",
			chat_thread_role: "qa",
			status: "completed",
		});
		const h = makeDeps({
			listStrandedImplementPhases: () => [strandedImpl()],
			listPhaseSessionRows: (_issue, phase) =>
				phase === "qa" ? [terminalQa] : [],
			getAlivePhaseSession: () => undefined,
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({ sessionRole: "qa" });
	});

	it("issue already shipped (finalization claim) → skip", async () => {
		const h = makeDeps({
			listStrandedImplementPhases: () => [strandedImpl()],
			listPhaseSessionRows: () => [],
			hasShipFinalizationClaim: () => true,
		});
		await new PhaseOrchestrator(h.deps).reconcileOnStartup();
		expect(h.start).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// G-B — founder-feedback kickback enters the fix-loop
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-939 G-B: founder-feedback kickback routes to the fix-loop", () => {
	beforeEach(() => vi.clearAllMocks());

	// The kickback shape: QA already PASSED (intent = pass), sits at
	// awaiting_review holding its own ship gate, the gate was answered
	// (hasGateResponse=true), and QA re-emits a FAIL. It must WAKE the parked
	// implement, not be dropped.
	function kickbackSetup(
		over: Partial<PhaseSession> = {},
		gateAnswered = true,
	) {
		const qa = qaSession({
			status: "awaiting_review",
			review_question_id: "q-1",
			...over,
		});
		const impl = session({ execution_id: "impl-1", session_role: "implement" });
		const h = makeDeps({
			getAlivePhaseSession: vi.fn((_i, phase) =>
				phase === "implement" ? impl : undefined,
			),
			qaVerdicts: { hasGateResponse: vi.fn(() => gateAnswered) },
		});
		h.setSessionRow(qa);
		// Seed the prior PASS intent (QA passed before the founder asked for changes).
		h.intents.set("qa-1", {
			status: "pass",
			event_id: "V-pass",
			at: "t0",
		} as ThreeStageVerdictIntent);
		return { h, qa, impl };
	}

	it("awaiting_review + gate answered + FAIL → wakes the parked implement", async () => {
		const { h, qa } = kickbackSetup();
		await new PhaseOrchestrator(h.deps).onQaResult(qa, {
			eventId: "V-fail",
			status: "fail",
			summary: "founder wants the copy tightened",
		});
		expect(h.wakePhaseRunner).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "fix" }),
		);
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "implement" }),
		);
	});

	it("awaiting_review + gate NOT answered (pending) → refused (no fix-loop)", async () => {
		const { h, qa } = kickbackSetup({}, /* gateAnswered */ false);
		await new PhaseOrchestrator(h.deps).onQaResult(qa, {
			eventId: "V-fail",
			status: "fail",
		});
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("awaiting_review but review_question_id absent → not a kickback → refused", async () => {
		const { h, qa } = kickbackSetup({ review_question_id: undefined });
		await new PhaseOrchestrator(h.deps).onQaResult(qa, {
			eventId: "V-fail",
			status: "fail",
		});
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
	});

	it("approved_to_ship + FAIL → refused unconditionally (never un-ships)", async () => {
		const { h, qa } = kickbackSetup({ status: "approved_to_ship" });
		await new PhaseOrchestrator(h.deps).onQaResult(qa, {
			eventId: "V-fail",
			status: "fail",
		});
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("keep-alive OFF → kickback path never fires (byte-compat sentinel)", async () => {
		const { h, qa } = kickbackSetup();
		(h.deps as { keepAliveEnabled: () => boolean }).keepAliveEnabled = () =>
			false;
		await new PhaseOrchestrator(h.deps).onQaResult(qa, {
			eventId: "V-fail",
			status: "fail",
		});
		// The prior-PASS ignore path holds — no fix-loop of any kind.
		expect(h.wakePhaseRunner).not.toHaveBeenCalled();
		expect(h.start).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// G-C — spawn fallback ghost-probes; never respawn onto a live ghost
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-939 G-C: spawn fallback ghost guard (never respawn onto a live ghost)", () => {
	beforeEach(() => vi.clearAllMocks());

	const ghostRow = (over: Partial<PhaseSession> = {}) =>
		session({
			execution_id: "qa-ghost",
			chat_thread_role: "qa",
			status: "completed", // terminal per DB…
			tmux_session: "cmux-qa-ghost", // …but its tmux window is probed directly
			...over,
		});

	it("handoff spawn: terminal qa row with a LIVE tmux → fail-closed, NO spawn", async () => {
		const h = makeDeps({
			getAlivePhaseSession: () => undefined, // no live wake target
			listPhaseSessionRows: (_i, phase) => (phase === "qa" ? [ghostRow()] : []),
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
				// The GHOST probe (persisted tmux) says alive — the CommDB-based
				// probePhaseAlive would have masked it as absent. This is the seam.
				probeGhostTmux: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
		);
		expect(h.deps.effects.probeGhostTmux).toHaveBeenCalled();
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("handoff spawn: indeterminate ghost probe → fail-closed, NO spawn", async () => {
		const h = makeDeps({
			getAlivePhaseSession: () => undefined,
			listPhaseSessionRows: (_i, phase) => (phase === "qa" ? [ghostRow()] : []),
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
				probeGhostTmux: vi.fn(
					async (): Promise<PhaseLiveness> => "indeterminate",
				),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
		);
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("handoff spawn: all rows dead/absent → spawn proceeds (dispatch args unchanged)", async () => {
		const deadRow = ghostRow({ tmux_session: "cmux-dead" });
		const h = makeDeps({
			getAlivePhaseSession: () => undefined,
			listPhaseSessionRows: (_i, phase) => (phase === "qa" ? [deadRow] : []),
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
				probeGhostTmux: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
		);
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.start.mock.calls[0]![0]).toMatchObject({ sessionRole: "qa" });
	});

	it("ghost guard probes at most the 3 most-recent rows with a tmux_session", async () => {
		const rows = [
			ghostRow({ execution_id: "r1", tmux_session: "t1" }),
			ghostRow({ execution_id: "r2", tmux_session: "t2" }),
			ghostRow({ execution_id: "r3", tmux_session: "t3" }),
			ghostRow({ execution_id: "r4", tmux_session: "t4" }), // 4th = never probed
		];
		const probeGhostTmux = vi.fn(async (): Promise<PhaseLiveness> => "absent");
		const h = makeDeps({
			getAlivePhaseSession: () => undefined,
			listPhaseSessionRows: (_i, phase) => (phase === "qa" ? rows : []),
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
				probeGhostTmux,
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
		);
		expect(probeGhostTmux).toHaveBeenCalledTimes(3);
		expect(h.start).toHaveBeenCalledOnce();
	});

	it("fix-loop spawn fallback: dead implement but a LIVE ghost implement row → no spawn, intent replayable", async () => {
		const h = makeDeps({
			getAlivePhaseSession: () => undefined, // implement died (no alive row)
			listPhaseSessionRows: (_i, phase) =>
				phase === "implement"
					? [
							ghostRow({
								execution_id: "impl-ghost",
								chat_thread_role: "implement",
								tmux_session: "cmux-impl-ghost",
							}),
						]
					: [],
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
				probeGhostTmux: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		h.setSessionRow(qaSession());
		await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), {
			eventId: "V1",
			status: "fail",
		});
		expect(h.start).not.toHaveBeenCalled();
		expect(h.deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.intents.get("qa-1")?.fixExecId).toBeUndefined(); // replayable
	});

	it("keep-alive OFF → ghost guard is inert (legacy spawn proceeds; sentinel)", async () => {
		const h = makeDeps({
			keepAliveEnabled: () => false,
			// even if a live ghost existed, the legacy path never probes.
			listPhaseSessionRows: (_i, phase) =>
				phase === "qa" ? [ghostRow({ tmux_session: "cmux-live" })] : [],
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError: vi.fn(async () => {}),
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
				probeGhostTmux: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
				parkPhaseRunner: vi.fn(async () => {}),
				wakePhaseRunner: vi.fn(async () => ({ ok: true })),
				assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			},
		});
		await new PhaseOrchestrator(h.deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
		);
		expect(h.deps.effects.probeGhostTmux).not.toHaveBeenCalled();
		expect(h.start).toHaveBeenCalledOnce(); // legacy close+respawn
	});
});
