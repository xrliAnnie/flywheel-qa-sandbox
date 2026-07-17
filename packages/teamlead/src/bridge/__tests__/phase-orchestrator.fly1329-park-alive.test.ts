import { describe, expect, it, vi } from "vitest";
import {
	type PhaseLiveness,
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../phase-orchestrator.js";

/**
 * FLY-1329 (R-1319 replay): the restart/closeout path must never kill a
 * park-alive session.
 *
 * THE INCIDENT (2026-07-16 04:57): FLY-1319's implement session 532c634b was
 * parked alive at `awaiting_review`. Its CommDB `tmux_window` mapping had gone
 * stale, so `probePhaseAlive` returned `absent` — a window-name miss. `handoff()`
 * read that as death and ran `closePhaseRunner`: StateStore forced to `completed`,
 * CommDB row deleted, shared branch B torn down (`branchDeleted:true`) — all while
 * the process was still alive and still sending `ask`s. The system stopped
 * recognizing a runner that was still working, so its `turn` probe answered
 * `no-turn` forever.
 *
 * The fixture below is that exact shape. `absent` must park, audit the downgrade,
 * and hand off to the next phase anyway.
 */

function makeQaVerdicts() {
	const intents = new Map<string, ThreeStageVerdictIntent>();
	const qaVerdicts: PhaseOrchestratorDeps["qaVerdicts"] = {
		getSession: vi.fn(() => undefined),
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
	return { qaVerdicts, intents };
}

function makeDeps(over: Partial<PhaseOrchestratorDeps> = {}) {
	const { qaVerdicts } = makeQaVerdicts();
	const deps: PhaseOrchestratorDeps = {
		startDispatcher: {
			start: vi.fn(async () => ({ executionId: "next-exec" })),
		},
		effects: {
			capturePhaseHeadSha: vi.fn(async () => "deadbeefcafe1234"),
			closePhaseRunner: vi.fn(async () => {}),
			alertLeadPipelineError: vi.fn(async () => {}),
			probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "alive"),
			probeGhostTmux: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
			parkPhaseRunner: vi.fn(async () => {}),
			wakePhaseRunner: vi.fn(async () => ({ ok: true })),
			assertPhaseWorktreeReady: vi.fn(async () => ({ ok: true })),
			recordParkLivenessDowngrade: vi.fn(async () => {}),
		},
		resolveThreeStage: () => ({ enabled: true }),
		listStrandedDesignPhases: () => [],
		listStrandedImplementPhases: () => [],
		listPhaseSessionRows: () => [],
		resolveLeadId: () => "eng-lead",
		keepAliveEnabled: () => true,
		getAlivePhaseSession: vi.fn((): PhaseSession | undefined => undefined),
		hasShipFinalizationClaim: vi.fn((): boolean => false),
		refreshPhaseStatusLine: vi.fn(async (): Promise<void> => {}),
		grantTurn: vi.fn(() => {}),
		turnBelt: {
			listTurns: vi.fn(() => []),
			getTurn: vi.fn(() => null),
			deleteTurn: vi.fn(() => {}),
			getSessionForTurnHolder: vi.fn((): PhaseSession | undefined => undefined),
			getPhaseSessionsForIssue: vi.fn((): PhaseSession[] => []),
		},
		qaVerdicts,
		...over,
	};
	return deps;
}

/**
 * The 532c634b shape: implement parked alive at its handoff status.
 *
 * Two fields make this fixture production-shaped, and both matter:
 *
 *  - `review_question_id` is REQUIRED. FLY-921 Fix B fail-closes any implement
 *    that reaches `awaiting_review` without runner-driven review evidence, well
 *    before the liveness branch. The real 532c634b had opened its approve gate,
 *    so it carried a bound question id. Omit it and every assertion below passes
 *    or fails for the wrong reason.
 *
 *  - `tmux_session` is ABSENT, because production never writes it. Verified
 *    against the live StateStore on 2026-07-17: 1423 session rows, 0 with a
 *    non-null `tmux_session`. Giving the fixture a value here would be a
 *    fiction that quietly exercises code production never reaches.
 */
function parkAliveImplement(): PhaseSession {
	return {
		execution_id: "532c634b",
		issue_id: "FLY-1319",
		session_role: "implement",
		status: "awaiting_review",
		project_name: "flywheel",
		review_question_id: "q-532c634b-review",
	} as PhaseSession;
}

describe("FLY-1329 R-1319: handoff must not kill a park-alive session on `absent`", () => {
	it("parks (never closes) an implement whose window lookup misses — the exact 532c634b shape", async () => {
		const deps = makeDeps({
			effects: {
				...makeDeps().effects,
				// The stale CommDB tmux_window mapping → window-name miss.
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
			},
		});
		const orch = new PhaseOrchestrator(deps);

		await orch.onPhaseComplete(parkAliveImplement());

		// THE regression: `absent` must NOT authorize destruction.
		expect(deps.effects.closePhaseRunner).not.toHaveBeenCalled();
		expect(deps.effects.parkPhaseRunner).toHaveBeenCalledOnce();
	});

	it("audits the downgrade so an absent park is never silent", async () => {
		const recordParkLivenessDowngrade = vi.fn(async () => {});
		const deps = makeDeps({
			effects: {
				...makeDeps().effects,
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
				recordParkLivenessDowngrade,
			},
		});
		const orch = new PhaseOrchestrator(deps);

		await orch.onPhaseComplete(parkAliveImplement());

		expect(recordParkLivenessDowngrade).toHaveBeenCalledOnce();
		const arg = recordParkLivenessDowngrade.mock.calls[0][0] as {
			session: PhaseSession;
			liveness: string;
		};
		expect(arg.session.execution_id).toBe("532c634b");
		expect(arg.liveness).toBe("absent");
	});

	/**
	 * The pipeline must keep moving. Parking the previous phase is not a reason to
	 * strand the issue: `absent` parks AND dispatches the next phase, exactly as
	 * `alive` does.
	 */
	it("still dispatches the next phase after an absent park (no strand)", async () => {
		const start = vi.fn(async () => ({ executionId: "qa-exec" }));
		const deps = makeDeps({
			startDispatcher: { start },
			effects: {
				...makeDeps().effects,
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
			},
		});
		const orch = new PhaseOrchestrator(deps);

		await orch.onPhaseComplete(parkAliveImplement());

		expect(start).toHaveBeenCalledOnce();
	});

	/** dead_pin is real death evidence — that path must stay byte-identical. */
	it("still closes on dead_pin (positive death evidence is unchanged)", async () => {
		const deps = makeDeps({
			effects: {
				...makeDeps().effects,
				probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "dead_pin"),
			},
		});
		const orch = new PhaseOrchestrator(deps);

		await orch.onPhaseComplete(parkAliveImplement());

		expect(deps.effects.closePhaseRunner).toHaveBeenCalledOnce();
		expect(deps.effects.parkPhaseRunner).not.toHaveBeenCalled();
	});

	/** indeterminate keeps its existing fail-closed behavior (byte-compat). */
	it("still fail-closes on indeterminate (no park, no close, no dispatch)", async () => {
		const start = vi.fn(async () => ({ executionId: "x" }));
		const deps = makeDeps({
			startDispatcher: { start },
			effects: {
				...makeDeps().effects,
				probePhaseAlive: vi.fn(
					async (): Promise<PhaseLiveness> => "indeterminate",
				),
			},
		});
		const orch = new PhaseOrchestrator(deps);

		await orch.onPhaseComplete(parkAliveImplement());

		expect(deps.effects.parkPhaseRunner).not.toHaveBeenCalled();
		expect(deps.effects.closePhaseRunner).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(deps.effects.alertLeadPipelineError).toHaveBeenCalledOnce();
	});

	/**
	 * FLY-1329 (A1, wake side): `absent` must not authorize abandoning a wake and
	 * spawning a replacement — that would put a second writer on shared branch B.
	 *
	 * Production shape, verified against the live StateStore (2026-07-17): every
	 * one of 1423 session rows has `tmux_session` NULL. So `isWakeTargetProvenDead`
	 * short-circuits at its "no persisted target → unfalsifiable" guard and takes
	 * the wake path. This test PINS that outcome so a future change that starts
	 * populating `tmux_session` (making FLY-1224's direct-probe branch reachable)
	 * cannot silently turn `absent` into a spawn authorization.
	 */
	it("absent wake target with no persisted tmux (the production shape) → wakes, never spawns a duplicate", async () => {
		const start = vi.fn(async () => ({ executionId: "should-not-spawn" }));
		const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
		const parkedQa = {
			execution_id: "qa-parked",
			issue_id: "FLY-1319",
			session_role: "qa",
			status: "running",
			project_name: "flywheel",
		} as PhaseSession;
		const deps = makeDeps({
			startDispatcher: { start },
			getAlivePhaseSession: vi.fn(() => parkedQa),
			effects: {
				...makeDeps().effects,
				// prev = alive (parks); the WAKE TARGET probes absent.
				probePhaseAlive: vi.fn(
					async (row: PhaseSession): Promise<PhaseLiveness> =>
						row.execution_id === "qa-parked" ? "absent" : "alive",
				),
				wakePhaseRunner,
			},
		});
		const orch = new PhaseOrchestrator(deps);

		await orch.onPhaseComplete(parkAliveImplement());

		expect(wakePhaseRunner).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
	});

	/**
	 * The kill-switch: FLYWHEEL_PARK_BIASED_HANDOFF=0 restores the legacy
	 * absent→close behavior byte-for-byte.
	 */
	it("kill-switch FLYWHEEL_PARK_BIASED_HANDOFF=0 restores the legacy absent→close path", async () => {
		const prev = process.env.FLYWHEEL_PARK_BIASED_HANDOFF;
		process.env.FLYWHEEL_PARK_BIASED_HANDOFF = "0";
		try {
			const deps = makeDeps({
				effects: {
					...makeDeps().effects,
					probePhaseAlive: vi.fn(async (): Promise<PhaseLiveness> => "absent"),
				},
			});
			const orch = new PhaseOrchestrator(deps);

			await orch.onPhaseComplete(parkAliveImplement());

			expect(deps.effects.closePhaseRunner).toHaveBeenCalledOnce();
			expect(deps.effects.parkPhaseRunner).not.toHaveBeenCalled();
		} finally {
			if (prev === undefined) delete process.env.FLYWHEEL_PARK_BIASED_HANDOFF;
			else process.env.FLYWHEEL_PARK_BIASED_HANDOFF = prev;
		}
	});
});
