import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
} from "../phase-orchestrator.js";

/**
 * Stateful qaVerdicts fake (FLY-859): patchIntent merges into an in-memory
 * map so the orchestrator's re-reads observe its own durable progression —
 * the same contract plugin.ts implements over session_params.
 */
function makeQaVerdicts() {
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
		recordFixRound: vi.fn(() => 1),
		getActiveImplementSession: vi.fn((): PhaseSession | undefined => undefined),
		listVerdictEventCandidates: vi.fn((): PhaseSession[] => []),
		getLatestQaResultEvent: vi.fn(() => undefined),
		listStrandedPassCandidates: vi.fn((): PhaseSession[] => []),
		postIssueThread: vi.fn(async () => {}),
	};
	return { qaVerdicts, intents };
}

function makeDeps(over: Partial<PhaseOrchestratorDeps> = {}) {
	const start = vi.fn(async () => ({ executionId: "next-exec" }));
	const capturePhaseHeadSha = vi.fn(async () => "deadbeefcafe1234");
	const closePhaseRunner = vi.fn(async () => {});
	const alertLeadPipelineError = vi.fn(async () => {});
	// FLY-887 keep-alive effects (defaults — legacy tests never call them).
	const probePhaseAlive = vi.fn(async () => "alive" as const);
	const parkPhaseRunner = vi.fn(async () => {});
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const assertPhaseWorktreeReady = vi.fn(async () => ({ ok: true }));
	const listStrandedDesignPhases = vi.fn((): PhaseSession[] => []);
	const { qaVerdicts, intents } = makeQaVerdicts();
	const resolveLeadId = vi.fn((): string | undefined => "eng-lead");
	// FLY-887: default keep-alive OFF so the existing tests validate the LEGACY
	// close-and-respawn path (the byte-compat sentinel). Keep-alive tests override.
	const keepAliveEnabled = vi.fn(() => false);
	const getAlivePhaseSession = vi.fn((): PhaseSession | undefined => undefined);
	const hasShipFinalizationClaim = vi.fn((): boolean => false);
	const refreshPhaseStatusLine = vi.fn(async (): Promise<void> => {});
	const grantTurn = vi.fn(() => {});
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
		listStrandedDesignPhases,
		resolveLeadId,
		keepAliveEnabled,
		getAlivePhaseSession,
		hasShipFinalizationClaim,
		refreshPhaseStatusLine,
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
		listStrandedDesignPhases,
		resolveLeadId,
		keepAliveEnabled,
		getAlivePhaseSession,
		hasShipFinalizationClaim,
		refreshPhaseStatusLine,
		grantTurn,
		qaVerdicts,
		intents,
	};
}

function session(over: Partial<PhaseSession>): PhaseSession {
	return {
		execution_id: "exec-1",
		issue_id: "FLY-793",
		project_name: "flywheel",
		status: "running",
		...over,
	};
}

describe("PhaseOrchestrator (FLY-793 Steps 4+7)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("Design done → captures SHA, closes design, starts Implement (Opus) on branch B", async () => {
		const { deps, start, capturePhaseHeadSha, closePhaseRunner } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(capturePhaseHeadSha).toHaveBeenCalledOnce();
		expect(closePhaseRunner).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]![0]).toMatchObject({
			issueId: "FLY-793",
			sessionRole: "implement",
			dispatchModel: "claude-opus-4-8",
			startPoint: "deadbeefcafe1234",
			shareParentBranch: true,
		});
	});

	it("Implement awaiting_review → starts QA (Sonnet) on the same branch", async () => {
		const { deps, start } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "implement", status: "awaiting_review" }),
		);
		expect(start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "qa",
			dispatchModel: "claude-sonnet-5",
			shareParentBranch: true,
		});
	});

	it("QA is the last phase → no handoff (its PASS/FAIL is internal-QA, Step 8)", async () => {
		const { deps, start } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "qa", status: "awaiting_review" }),
		);
		expect(start).not.toHaveBeenCalled();
	});

	it("byte-compat: non-phase (main) role → no-op", async () => {
		const { deps, start, capturePhaseHeadSha } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "main", status: "awaiting_review" }),
		);
		expect(capturePhaseHeadSha).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it("byte-compat: three_stage OFF → no-op even for a phase role", async () => {
		const { deps, start } = makeDeps({
			resolveThreeStage: () => ({ enabled: false }),
		});
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(start).not.toHaveBeenCalled();
	});

	it("wrong status for the phase → no handoff (design still running)", async () => {
		const { deps, start } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "running" }),
		);
		expect(start).not.toHaveBeenCalled();
	});

	it("fail-closed: missing head SHA → alert Lead, do NOT close or start", async () => {
		const start = vi.fn(async () => ({ executionId: "x" }));
		const closePhaseRunner = vi.fn(async () => {});
		const alertLeadPipelineError = vi.fn(async () => {});
		const deps: PhaseOrchestratorDeps = {
			startDispatcher: { start },
			effects: {
				capturePhaseHeadSha: vi.fn(async () => null),
				closePhaseRunner,
				alertLeadPipelineError,
			},
			resolveThreeStage: () => ({ enabled: true }),
			listStrandedDesignPhases: () => [],
			resolveLeadId: () => "eng-lead",
			refreshPhaseStatusLine: vi.fn(async () => {}),
			qaVerdicts: makeQaVerdicts().qaVerdicts,
		} as PhaseOrchestratorDeps;
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(closePhaseRunner).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it("fail-closed: start throws → alert Lead (handoff aborted)", async () => {
		const start = vi.fn(async () => {
			throw new Error("dispatch boom");
		});
		const { deps, alertLeadPipelineError } = makeDeps({
			startDispatcher: { start },
		});
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(alertLeadPipelineError).toHaveBeenCalledOnce();
	});

	describe("reconcileOnStartup (Codex full-PR R2 #1)", () => {
		it("re-drives every stranded design_done session through onPhaseComplete", async () => {
			const { deps, start, listStrandedDesignPhases } = makeDeps();
			listStrandedDesignPhases.mockReturnValue([
				session({
					execution_id: "e1",
					issue_id: "FLY-1",
					session_role: "design",
					status: "design_done",
				}),
				session({
					execution_id: "e2",
					issue_id: "FLY-2",
					session_role: "design",
					status: "design_done",
				}),
			]);
			await new PhaseOrchestrator(deps).reconcileOnStartup();
			// Both stranded design phases hand off to Implement.
			expect(start).toHaveBeenCalledTimes(2);
			expect(start.mock.calls[0]![0]).toMatchObject({
				issueId: "FLY-1",
				sessionRole: "implement",
			});
			expect(start.mock.calls[1]![0]).toMatchObject({
				issueId: "FLY-2",
				sessionRole: "implement",
			});
		});

		it("no stranded sessions → no-op", async () => {
			const { deps, start } = makeDeps();
			await new PhaseOrchestrator(deps).reconcileOnStartup();
			expect(start).not.toHaveBeenCalled();
		});

		it("query throws → swallowed (never blocks boot)", async () => {
			const { deps, start, listStrandedDesignPhases } = makeDeps();
			listStrandedDesignPhases.mockImplementation(() => {
				throw new Error("db locked");
			});
			await expect(
				new PhaseOrchestrator(deps).reconcileOnStartup(),
			).resolves.toBeUndefined();
			expect(start).not.toHaveBeenCalled();
		});

		describe("onQaResult (FLY-859 Step 8 — deferred ThreeStageQaCoordinator)", () => {
			const qaSession = (over: Partial<PhaseSession> = {}): PhaseSession =>
				session({
					execution_id: "qa-exec",
					session_role: "qa",
					chat_thread_role: "qa",
					status: "running",
					...over,
				});
			const verdict = (
				over: Partial<Parameters<PhaseOrchestrator["onQaResult"]>[1]> = {},
			) => ({
				eventId: "ev-1",
				status: "fail",
				summary: "scenario X broke",
				...over,
			});

			it("PASS: persists the intent and does nothing else (QA runner drives the ship gate)", async () => {
				const h = makeDeps();
				await new PhaseOrchestrator(h.deps).onQaResult(
					qaSession(),
					verdict({ status: "pass" }),
				);
				expect(h.intents.get("qa-exec")).toMatchObject({
					status: "pass",
					event_id: "ev-1",
				});
				expect(h.capturePhaseHeadSha).not.toHaveBeenCalled();
				expect(h.closePhaseRunner).not.toHaveBeenCalled();
				expect(h.start).not.toHaveBeenCalled();
				expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
			});

			it("PASS replay (same eventId) is a no-op — intent not rewritten", async () => {
				const h = makeDeps();
				const orch = new PhaseOrchestrator(h.deps);
				await orch.onQaResult(qaSession(), verdict({ status: "pass" }));
				const patchCalls = (
					h.qaVerdicts.patchIntent as ReturnType<typeof vi.fn>
				).mock.calls.length;
				await orch.onQaResult(qaSession(), verdict({ status: "pass" }));
				expect(
					(h.qaVerdicts.patchIntent as ReturnType<typeof vi.fn>).mock.calls
						.length,
				).toBe(patchCalls);
			});

			it("a second verdict with a DIFFERENT eventId is ignored (one verdict per QA session)", async () => {
				const h = makeDeps();
				const orch = new PhaseOrchestrator(h.deps);
				await orch.onQaResult(qaSession(), verdict({ status: "pass" }));
				await orch.onQaResult(
					qaSession(),
					verdict({ status: "fail", eventId: "ev-2" }),
				);
				expect(h.start).not.toHaveBeenCalled();
				expect(h.intents.get("qa-exec")?.status).toBe("pass");
			});

			it("invalid status → ignored, no intent written", async () => {
				const h = makeDeps();
				await new PhaseOrchestrator(h.deps).onQaResult(
					qaSession(),
					verdict({ status: "maybe" }),
				);
				expect(h.intents.has("qa-exec")).toBe(false);
			});

			it("non-three-stage session (chat_thread_role=main, auto-QA shape) → no-op", async () => {
				const h = makeDeps();
				await new PhaseOrchestrator(h.deps).onQaResult(
					qaSession({ chat_thread_role: "main" }),
					verdict({ status: "fail" }),
				);
				expect(h.intents.size).toBe(0);
				expect(h.start).not.toHaveBeenCalled();
			});

			it("FAIL happy path: capture → close → dispatch Implement-fix, durably in order", async () => {
				const h = makeDeps();
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.capturePhaseHeadSha).toHaveBeenCalledOnce();
				expect(h.closePhaseRunner).toHaveBeenCalledOnce();
				expect(h.start).toHaveBeenCalledOnce();
				expect(h.start.mock.calls[0]![0]).toMatchObject({
					issueId: "FLY-793",
					sessionRole: "implement",
					dispatchModel: "claude-opus-4-8",
					startPoint: "deadbeefcafe1234",
					shareParentBranch: true,
					// FLY-856: resolved live via resolveLeadId, never a phantom
					// session.lead_id read (combined-QA finding)
					leadId: "eng-lead",
					phaseFixContext: { round: 1, qaSummary: "scenario X broke" },
				});
				expect(h.intents.get("qa-exec")).toMatchObject({
					status: "fail",
					headSha: "deadbeefcafe1234",
					closed: true,
					fixExecId: "next-exec",
				});
				expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
			});

			it("FAIL: three_stage disabled mid-flight → alert once, never dispatch", async () => {
				const h = makeDeps({ resolveThreeStage: () => ({ enabled: false }) });
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
				expect(h.closePhaseRunner).not.toHaveBeenCalled();
				expect(h.start).not.toHaveBeenCalled();
				expect(h.intents.get("qa-exec")?.alertedAt).toBeTruthy();
			});

			it("FAIL cap boundary: 3rd fix round allowed (count=3 < 4), 4th blocked (count=4)", async () => {
				const allowed = makeDeps();
				(
					allowed.qaVerdicts.countImplementPhases as ReturnType<typeof vi.fn>
				).mockReturnValue(3);
				await new PhaseOrchestrator(allowed.deps).onQaResult(
					qaSession(),
					verdict(),
				);
				expect(allowed.start).toHaveBeenCalledOnce();
				expect(allowed.start.mock.calls[0]![0]).toMatchObject({
					phaseFixContext: { round: 3, qaSummary: "scenario X broke" },
				});

				const blocked = makeDeps();
				(
					blocked.qaVerdicts.countImplementPhases as ReturnType<typeof vi.fn>
				).mockReturnValue(4);
				await new PhaseOrchestrator(blocked.deps).onQaResult(
					qaSession(),
					verdict(),
				);
				expect(blocked.start).not.toHaveBeenCalled();
				expect(blocked.alertLeadPipelineError).toHaveBeenCalledOnce();
			});

			it("maxFixRounds=0 → the first FAIL is refused (no fix rounds allowed)", async () => {
				const h = makeDeps();
				h.qaVerdicts.maxFixRounds = 0;
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.start).not.toHaveBeenCalled();
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
			});

			it("FAIL: head SHA unavailable → fail-closed alert, no close, no dispatch", async () => {
				const h = makeDeps();
				h.capturePhaseHeadSha.mockResolvedValue(null as never);
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.closePhaseRunner).not.toHaveBeenCalled();
				expect(h.start).not.toHaveBeenCalled();
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
			});

			it("FAIL: close throws → fail-closed alert, no dispatch; headSha already durable", async () => {
				const h = makeDeps();
				h.closePhaseRunner.mockRejectedValue(new Error("dirty worktree"));
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.start).not.toHaveBeenCalled();
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
				expect(h.intents.get("qa-exec")).toMatchObject({
					headSha: "deadbeefcafe1234",
				});
				expect(h.intents.get("qa-exec")?.closed).toBeUndefined();
			});

			it("FAIL: dispatch throws → alert; intent shows closed but no fixExecId (resumable)", async () => {
				const h = makeDeps();
				h.start.mockRejectedValue(new Error("dispatch boom") as never);
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
				expect(h.intents.get("qa-exec")).toMatchObject({ closed: true });
				expect(h.intents.get("qa-exec")?.fixExecId).toBeUndefined();
			});

			it("FAIL resume after crash-at-dispatch: replay skips capture+close, dispatches from the persisted head", async () => {
				const h = makeDeps();
				h.intents.set("qa-exec", {
					status: "fail",
					event_id: "ev-1",
					summary: "scenario X broke",
					at: "2026-07-04T00:00:00Z",
					headSha: "persistedheadsha",
					closed: true,
				});
				// the crash left the session already terminal
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					qaSession({ status: "completed" }),
				);
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.capturePhaseHeadSha).not.toHaveBeenCalled();
				expect(h.closePhaseRunner).not.toHaveBeenCalled();
				expect(h.start).toHaveBeenCalledOnce();
				expect(h.start.mock.calls[0]![0]).toMatchObject({
					startPoint: "persistedheadsha",
				});
				expect(h.intents.get("qa-exec")?.fixExecId).toBe("next-exec");
			});

			it("FAIL adopt: a live Implement-fix already exists → adopt it, never double-spawn onto branch B", async () => {
				const h = makeDeps();
				(
					h.qaVerdicts.getActiveImplementSession as ReturnType<typeof vi.fn>
				).mockReturnValue(
					session({ execution_id: "fix-live", session_role: "implement" }),
				);
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.start).not.toHaveBeenCalled();
				expect(h.intents.get("qa-exec")?.fixExecId).toBe("fix-live");
			});

			it("fresh FAIL while the ship gate is in flight (awaiting_review) → ignored", async () => {
				const h = makeDeps();
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					qaSession({ status: "awaiting_review" }),
				);
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				expect(h.intents.has("qa-exec")).toBe(false);
				expect(h.start).not.toHaveBeenCalled();
			});

			it("fresh FAIL on an already-terminal session STILL runs the dirty-safe close before dispatching (Codex code R1 HIGH-2)", async () => {
				const h = makeDeps();
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					qaSession({ status: "completed" }),
				);
				await new PhaseOrchestrator(h.deps).onQaResult(qaSession(), verdict());
				// A terminal session can still hold the shared branch-B worktree —
				// the close effect owns the dirty check / proven removal; skipping it
				// would hand the worktree to the next dispatch's non-dirty-safe
				// removeIfExists.
				expect(h.closePhaseRunner).toHaveBeenCalledOnce();
				expect(h.start).toHaveBeenCalledOnce();
				expect(h.intents.get("qa-exec")).toMatchObject({ closed: true });
			});

			it("incomplete FAIL intent is the AUTHORITY: a later verdict with a DIFFERENT eventId resumes the recorded flow (Codex code R1 HIGH-1)", async () => {
				const h = makeDeps();
				h.intents.set("qa-exec", {
					status: "fail",
					event_id: "ev-1",
					summary: "scenario X broke",
					at: "2026-07-04T00:00:00Z",
					headSha: "persistedheadsha",
					closed: true,
				});
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					qaSession({ status: "completed" }),
				);
				await new PhaseOrchestrator(h.deps).onQaResult(
					qaSession(),
					verdict({ eventId: "ev-2", status: "fail" }),
				);
				expect(h.start).toHaveBeenCalledOnce();
				expect(h.start.mock.calls[0]![0]).toMatchObject({
					startPoint: "persistedheadsha",
				});
				// the ORIGINAL intent is resumed, not overwritten by the new event
				expect(h.intents.get("qa-exec")).toMatchObject({
					event_id: "ev-1",
					fixExecId: "next-exec",
				});
			});

			it("incomplete FAIL intent resumes even when the replayed verdict carries a garbage status", async () => {
				const h = makeDeps();
				h.intents.set("qa-exec", {
					status: "fail",
					event_id: "ev-1",
					at: "2026-07-04T00:00:00Z",
					headSha: "persistedheadsha",
					closed: true,
				});
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					qaSession({ status: "completed" }),
				);
				await new PhaseOrchestrator(h.deps).onQaResult(
					qaSession(),
					verdict({ eventId: "ev-x", status: "garbage" }),
				);
				expect(h.start).toHaveBeenCalledOnce();
				expect(h.intents.get("qa-exec")?.fixExecId).toBe("next-exec");
			});
		});

		describe("stranded-pass safety net (FLY-849 §3.8 shape)", () => {
			const strandedSession = (
				over: Partial<PhaseSession> = {},
			): PhaseSession =>
				session({
					execution_id: "qa-exec",
					session_role: "qa",
					chat_thread_role: "qa",
					status: "completed",
					...over,
				});

			function withIntentAndRow(
				h: ReturnType<typeof makeDeps>,
				row: PhaseSession,
				intent: Partial<ThreeStageVerdictIntent>,
			) {
				h.intents.set(row.execution_id, {
					status: "pass",
					event_id: "ev-1",
					at: "2026-07-04T00:00:00Z",
					...intent,
				} as ThreeStageVerdictIntent);
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					row,
				);
			}

			it("PASS intent + terminal + no binding → alert once via onPhaseComplete", async () => {
				const h = makeDeps();
				withIntentAndRow(h, strandedSession(), {});
				const orch = new PhaseOrchestrator(h.deps);
				await orch.onPhaseComplete(strandedSession());
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
				expect(h.intents.get("qa-exec")?.alertedAt).toBeTruthy();
				// second delivery (dup event / restart) does not re-alert
				await orch.onPhaseComplete(strandedSession());
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
			});

			it("'unbound' review binding counts as NO binding → alerts", async () => {
				const h = makeDeps();
				withIntentAndRow(
					h,
					strandedSession({ review_question_id: "unbound" }),
					{},
				);
				await new PhaseOrchestrator(h.deps).onPhaseComplete(strandedSession());
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
			});

			it("a REAL review binding (normal ship path) → no alert", async () => {
				const h = makeDeps();
				withIntentAndRow(
					h,
					strandedSession({ review_question_id: "q-123" }),
					{},
				);
				await new PhaseOrchestrator(h.deps).onPhaseComplete(strandedSession());
				expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
			});

			it("no PASS intent → no alert (nothing to strand)", async () => {
				const h = makeDeps();
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					strandedSession(),
				);
				await new PhaseOrchestrator(h.deps).onPhaseComplete(strandedSession());
				expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
			});
		});

		describe("reconcileOnStartup — FLY-859 verdict sweeps", () => {
			it("replays an inserted-but-unprocessed FAIL verdict from the stored event", async () => {
				const h = makeDeps();
				const s = session({
					execution_id: "qa-exec",
					session_role: "qa",
					chat_thread_role: "qa",
					status: "running",
				});
				(
					h.qaVerdicts.listVerdictEventCandidates as ReturnType<typeof vi.fn>
				).mockReturnValue([s]);
				(
					h.qaVerdicts.getLatestQaResultEvent as ReturnType<typeof vi.fn>
				).mockReturnValue({
					eventId: "ev-stored",
					payload: { status: "fail", summary: "stored summary" },
				});
				await new PhaseOrchestrator(h.deps).reconcileOnStartup();
				expect(h.start).toHaveBeenCalledOnce();
				expect(h.intents.get("qa-exec")).toMatchObject({
					status: "fail",
					event_id: "ev-stored",
					fixExecId: "next-exec",
				});
			});

			it("startup sweep resumes an incomplete FAIL intent even when the LATEST stored event has a different id (Codex code R1 HIGH-1)", async () => {
				const h = makeDeps();
				const s = session({
					execution_id: "qa-exec",
					session_role: "qa",
					chat_thread_role: "qa",
					status: "completed",
				});
				h.intents.set("qa-exec", {
					status: "fail",
					event_id: "ev-1",
					at: "2026-07-04T00:00:00Z",
					headSha: "persistedheadsha",
					closed: true,
				});
				(
					h.qaVerdicts.listVerdictEventCandidates as ReturnType<typeof vi.fn>
				).mockReturnValue([s]);
				(
					h.qaVerdicts.getLatestQaResultEvent as ReturnType<typeof vi.fn>
				).mockReturnValue({
					eventId: "ev-2-later",
					payload: { status: "fail", summary: "later duplicate" },
				});
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					s,
				);
				await new PhaseOrchestrator(h.deps).reconcileOnStartup();
				expect(h.start).toHaveBeenCalledOnce();
				expect(h.intents.get("qa-exec")).toMatchObject({
					event_id: "ev-1",
					fixExecId: "next-exec",
				});
			});

			it("an already-processed verdict (intent matches the stored event) is not replayed", async () => {
				const h = makeDeps();
				const s = session({
					execution_id: "qa-exec",
					session_role: "qa",
					chat_thread_role: "qa",
					status: "running",
				});
				h.intents.set("qa-exec", {
					status: "pass",
					event_id: "ev-stored",
					at: "2026-07-04T00:00:00Z",
				});
				(
					h.qaVerdicts.listVerdictEventCandidates as ReturnType<typeof vi.fn>
				).mockReturnValue([s]);
				(
					h.qaVerdicts.getLatestQaResultEvent as ReturnType<typeof vi.fn>
				).mockReturnValue({
					eventId: "ev-stored",
					payload: { status: "pass" },
				});
				await new PhaseOrchestrator(h.deps).reconcileOnStartup();
				expect(h.start).not.toHaveBeenCalled();
				expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
			});

			it("sweeps stranded-pass candidates and alerts once", async () => {
				const h = makeDeps();
				const s = session({
					execution_id: "qa-exec",
					session_role: "qa",
					chat_thread_role: "qa",
					status: "completed",
				});
				h.intents.set("qa-exec", {
					status: "pass",
					event_id: "ev-1",
					at: "2026-07-04T00:00:00Z",
				});
				(
					h.qaVerdicts.listStrandedPassCandidates as ReturnType<typeof vi.fn>
				).mockReturnValue([s]);
				(h.qaVerdicts.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
					s,
				);
				await new PhaseOrchestrator(h.deps).reconcileOnStartup();
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
				// idempotent second boot
				await new PhaseOrchestrator(h.deps).reconcileOnStartup();
				expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
			});

			it("sweep query failures are swallowed (never block boot)", async () => {
				const h = makeDeps();
				(
					h.qaVerdicts.listVerdictEventCandidates as ReturnType<typeof vi.fn>
				).mockImplementation(() => {
					throw new Error("db locked");
				});
				(
					h.qaVerdicts.listStrandedPassCandidates as ReturnType<typeof vi.fn>
				).mockImplementation(() => {
					throw new Error("db locked");
				});
				await expect(
					new PhaseOrchestrator(h.deps).reconcileOnStartup(),
				).resolves.toBeUndefined();
			});
		});

		it("one handoff throwing does not block the others", async () => {
			const start = vi
				.fn()
				.mockRejectedValueOnce(new Error("dispatch boom"))
				.mockResolvedValueOnce({ executionId: "ok" });
			const alertLeadPipelineError = vi.fn(async () => {});
			const { deps, listStrandedDesignPhases } = makeDeps({
				startDispatcher: { start },
				effects: {
					capturePhaseHeadSha: vi.fn(async () => "abc123"),
					closePhaseRunner: vi.fn(async () => {}),
					alertLeadPipelineError,
				},
			});
			listStrandedDesignPhases.mockReturnValue([
				session({
					execution_id: "e1",
					session_role: "design",
					status: "design_done",
				}),
				session({
					execution_id: "e2",
					session_role: "design",
					status: "design_done",
				}),
			]);
			await new PhaseOrchestrator(deps).reconcileOnStartup();
			// First fails (→ fail-closed alert), second still runs.
			expect(start).toHaveBeenCalledTimes(2);
			expect(alertLeadPipelineError).toHaveBeenCalledOnce();
		});
	});
});

describe("handoff leadId resolution (combined-QA FLY-855)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("dispatches the next phase with the LIVE-resolved leadId (sessions has no lead_id column)", async () => {
		const { deps, start, resolveLeadId } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		// The resolver was consulted for THIS session…
		expect(resolveLeadId).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "exec-1" }),
		);
		// …and its answer (NOT a phantom prev.lead_id) went into the dispatch.
		// Without a real leadId the TmuxAdapter CommDB registration is silently
		// skipped and the phase window never auto-closes after ship (FLY-855).
		expect(start.mock.calls[0]![0]).toMatchObject({
			leadId: "eng-lead",
			sessionRole: "implement",
		});
	});

	it("resolver returning undefined still dispatches (leadId undefined) — degraded, not blocked", async () => {
		const { deps, start, resolveLeadId } = makeDeps();
		resolveLeadId.mockReturnValue(undefined);
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "implement", status: "awaiting_review" }),
		);
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]![0]).toMatchObject({ sessionRole: "qa" });
		expect(start.mock.calls[0]![0].leadId).toBeUndefined();
	});

	it("reconcileOnStartup handoffs also carry the resolved leadId", async () => {
		const { deps, start, listStrandedDesignPhases } = makeDeps();
		listStrandedDesignPhases.mockReturnValue([
			session({
				execution_id: "e1",
				session_role: "design",
				status: "design_done",
			}),
		]);
		await new PhaseOrchestrator(deps).reconcileOnStartup();
		expect(start.mock.calls[0]![0]).toMatchObject({ leadId: "eng-lead" });
	});
});
