import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
	type ThreeStageVerdictIntent,
	type TurnBeltRow,
} from "../phase-orchestrator.js";
import {
	resolveHandoffDispatchChannelId,
	resolveThreeStagePolicy,
} from "../three-stage-policy.js";

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
		hasGateResponse: vi.fn((): boolean => false),
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
	const probeGhostTmux = vi.fn(async () => "absent" as const);
	const parkPhaseRunner = vi.fn(async () => {});
	const wakePhaseRunner = vi.fn(async () => ({ ok: true }));
	const assertPhaseWorktreeReady = vi.fn(async () => ({ ok: true }));
	const listStrandedDesignPhases = vi.fn((): PhaseSession[] => []);
	const listStrandedImplementPhases = vi.fn((): PhaseSession[] => []);
	const listPhaseSessionRows = vi.fn((): PhaseSession[] => []);
	const { qaVerdicts, intents } = makeQaVerdicts();
	const resolveLeadId = vi.fn((): string | undefined => "eng-lead");
	// FLY-887: default keep-alive OFF so the existing tests validate the LEGACY
	// close-and-respawn path (the byte-compat sentinel). Keep-alive tests override.
	const keepAliveEnabled = vi.fn(() => false);
	const getAlivePhaseSession = vi.fn((): PhaseSession | undefined => undefined);
	const hasShipFinalizationClaim = vi.fn((): boolean => false);
	const refreshPhaseStatusLine = vi.fn(async (): Promise<void> => {});
	const grantTurn = vi.fn(() => {});
	// FLY-921 Fix C: turn-belt reconcile deps (defaults = empty belt).
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
		listStrandedDesignPhases,
		listStrandedImplementPhases,
		listPhaseSessionRows,
		resolveLeadId,
		keepAliveEnabled,
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
		listStrandedDesignPhases,
		listStrandedImplementPhases,
		listPhaseSessionRows,
		resolveLeadId,
		keepAliveEnabled,
		getAlivePhaseSession,
		hasShipFinalizationClaim,
		refreshPhaseStatusLine,
		grantTurn,
		turnBelt,
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

	it("Design done → captures SHA, closes design, starts Implement (Codex gpt-5.6-sol xhigh) on branch B", async () => {
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
			// FLY-1224 (Annie's 2026-07-13 table): implement dispatches the FULL
			// codex triple {model, vendor, effort}; the label layer stays bypassed
			// so no issue label can override the phase table. T3 mutation target:
			// dropping the vendor/effort passthrough at this site must turn RED.
			dispatchModel: "gpt-5.6-sol",
			dispatchVendor: "codex",
			dispatchEffort: "xhigh",
			ignoreRunnerLabelSelection: true,
			startPoint: "deadbeefcafe1234",
			shareParentBranch: true,
		});
	});

	it("Implement awaiting_review → starts QA (Opus, claude vendor) on the same branch", async () => {
		const { deps, start } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			// FLY-921: a genuine needs_review completion carries the review binding.
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
		);
		expect(start.mock.calls[0]![0]).toMatchObject({
			sessionRole: "qa",
			// FLY-887 R2 (Annie's table): QA runs on Opus — never Sonnet.
			// FLY-1224: qa stays a claude phase (vendor claude, no effort).
			dispatchModel: "claude-opus-4-8",
			dispatchVendor: "claude",
			ignoreRunnerLabelSelection: true,
			shareParentBranch: true,
		});
		expect(start.mock.calls[0]![0].dispatchEffort).toBeUndefined();
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
					// FLY-1224 (T3, legacy fix lane): implement-fix carries the full
					// codex triple from the phase table; label layer stays bypassed.
					dispatchModel: "gpt-5.6-sol",
					dispatchVendor: "codex",
					dispatchEffort: "xhigh",
					ignoreRunnerLabelSelection: true,
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
			// FLY-921: a genuine needs_review completion carries the review binding.
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-1",
			}),
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

/**
 * FLY-902: with `three_stage_channels` configured, the handoff-side policy
 * check MUST see the dispatching Lead's chatChannel. The shipped R2 wiring
 * (plugin.ts's resolveThreeStage closure) omitted dispatchChannelId, so the
 * policy read the channel as unresolved, fail-closed, and every handoff
 * silently no-oped — design stuck at design_done forever, zero logs.
 *
 * These tests compose resolveThreeStage from the REAL production pieces
 * (resolveThreeStagePolicy + resolveHandoffDispatchChannelId) exactly the way
 * plugin.ts wires them post-fix, so a regression in either piece — or a
 * plugin wiring that stops passing the channel — re-fails here.
 */
describe("PhaseOrchestrator × three_stage_channels (FLY-902 regression)", () => {
	beforeEach(() => vi.clearAllMocks());

	const CHAN = "1516209714097291335";
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leads: [
				{
					agentId: "flywheel-eng-lead",
					chatChannel: CHAN,
					match: { labels: ["flywheel"] },
				},
			],
		},
	] as ProjectEntry[];
	const pipelineConfig = {
		three_stage: true,
		three_stage_channels: [CHAN],
	};
	const issueLabels = ["flywheel"];

	/** The post-fix plugin.ts wiring shape (real policy + real resolver). */
	const fixedResolveThreeStage = (s: PhaseSession) =>
		resolveThreeStagePolicy({
			pipelineConfig,
			issueLabels,
			env: {},
			dispatchChannelId: resolveHandoffDispatchChannelId(
				projects,
				s.project_name,
				issueLabels,
			),
		});

	it("BUG FIX: a configured allowlist with the Lead's channel in it still hands Design off to Implement", async () => {
		const { deps, start } = makeDeps({
			resolveThreeStage: fixedResolveThreeStage,
		});
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]![0]).toMatchObject({ sessionRole: "implement" });
	});

	it("documents the shipped bug: the old wiring (no dispatchChannelId) never hands off — and now warns instead of silent no-op", async () => {
		const warn = vi.fn();
		const { deps, start } = makeDeps({
			// The pre-fix plugin.ts closure shape: same real policy, channel omitted.
			resolveThreeStage: () =>
				resolveThreeStagePolicy({ pipelineConfig, issueLabels, env: {} }),
			logger: { warn },
		});
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(start).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toContain("three-stage disabled");
		expect(warn.mock.calls[0]![0]).toContain("(unresolved)");
	});

	it("fail-closed semantics preserved: a channel NOT in the allowlist blocks the handoff, loudly", async () => {
		const warn = vi.fn();
		const outOfListProjects = [
			{
				...projects[0]!,
				leads: [
					{
						agentId: "flywheel-eng-lead",
						chatChannel: "999",
						match: { labels: ["flywheel"] },
					},
				],
			},
		] as ProjectEntry[];
		const { deps, start } = makeDeps({
			resolveThreeStage: (s: PhaseSession) =>
				resolveThreeStagePolicy({
					pipelineConfig,
					issueLabels,
					env: {},
					dispatchChannelId: resolveHandoffDispatchChannelId(
						outOfListProjects,
						s.project_name,
						issueLabels,
					),
				}),
			logger: { warn },
		});
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(start).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toContain("999");
	});

	it("no warn spam off the handoff boundary: a disabled policy on a non-boundary status stays quiet", async () => {
		const warn = vi.fn();
		const { deps, start } = makeDeps({
			resolveThreeStage: () => ({ enabled: false, reason: "whatever" }),
			logger: { warn },
		});
		// `qa`/`running` passes the phase-role guard but is NOT a handoff boundary
		// (auto-QA sessions share the `qa` role — they must not trigger the warn).
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "qa", status: "running" }),
		);
		expect(start).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});

/**
 * FLY-921 Fix B — implement→QA handoff evidence gate. A synthesized
 * needs_review completion (nested-session callback / kill / early death,
 * routed through DecisionLayer fallback) carries NO review binding, while a
 * runner-driven `complete --route needs_review --question-id Q` always does.
 * The gate: review_question_id present AND !== REVIEW_BINDING_UNBOUND.
 */
describe("FLY-921 Fix B — implement→QA handoff evidence gate", () => {
	beforeEach(() => vi.clearAllMocks());

	it("implement@awaiting_review WITHOUT review_question_id → fail-closed: no dispatch, no grantTurn, no wake; Lead alerted; status line refreshed", async () => {
		const {
			deps,
			start,
			grantTurn,
			wakePhaseRunner,
			alertLeadPipelineError,
			refreshPhaseStatusLine,
		} = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "implement", status: "awaiting_review" }),
		);
		expect(start).not.toHaveBeenCalled();
		expect(grantTurn).not.toHaveBeenCalled();
		expect(wakePhaseRunner).not.toHaveBeenCalled();
		expect(alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(alertLeadPipelineError.mock.calls[0]![0].reason).toContain(
			"WITHOUT runner-driven review evidence",
		);
		expect(refreshPhaseStatusLine).toHaveBeenCalled();
	});

	it("review_question_id === 'unbound' sentinel → same fail-closed", async () => {
		const { deps, start, alertLeadPipelineError } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "unbound",
			}),
		);
		expect(start).not.toHaveBeenCalled();
		expect(alertLeadPipelineError).toHaveBeenCalledOnce();
	});

	it("real review_question_id but NO pr_number → handoff proceeds (pr_number is NOT required evidence — Codex R1 #1)", async () => {
		// The session shape has no pr_number field at all — a genuine
		// needs_review completion without --pr must hand off normally.
		const { deps, start, alertLeadPipelineError } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-real-1",
			}),
		);
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]![0]).toMatchObject({ sessionRole: "qa" });
		expect(alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("evidence present + keep-alive ON → wake-or-spawn handoff unchanged", async () => {
		const qa = session({
			execution_id: "qa-exec",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running",
		});
		const { deps, start, grantTurn, wakePhaseRunner } = makeDeps({
			keepAliveEnabled: vi.fn(() => true),
			getAlivePhaseSession: vi.fn((_i: string, phase: string) =>
				phase === "qa" ? qa : undefined,
			),
		});
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({
				session_role: "implement",
				status: "awaiting_review",
				review_question_id: "q-real-1",
			}),
		);
		expect(grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "qa-exec", phase: "qa" }),
		);
		expect(wakePhaseRunner).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
	});

	it("design@design_done boundary is NOT evidence-gated (synthesized routes cannot produce design_done)", async () => {
		const { deps, start, alertLeadPipelineError } = makeDeps();
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "design", status: "design_done" }),
		);
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]![0]).toMatchObject({ sessionRole: "implement" });
		expect(alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("three-stage disabled + evidence missing → FLY-902 disabled-warn wins (no evidence-gate alert)", async () => {
		const warn = vi.fn();
		const { deps, start, alertLeadPipelineError } = makeDeps({
			resolveThreeStage: () => ({ enabled: false, reason: "config off" }),
			logger: { warn },
		});
		await new PhaseOrchestrator(deps).onPhaseComplete(
			session({ session_role: "implement", status: "awaiting_review" }),
		);
		expect(start).not.toHaveBeenCalled();
		expect(alertLeadPipelineError).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toContain("three-stage disabled");
	});

	it("reconcileOnStartup replaying an evidence-less implement@awaiting_review → same fail-closed (onPhaseComplete reuse)", async () => {
		const { deps, start, alertLeadPipelineError, listStrandedDesignPhases } =
			makeDeps();
		listStrandedDesignPhases.mockReturnValue([
			session({
				execution_id: "impl-stranded",
				session_role: "implement",
				status: "awaiting_review",
			}),
		]);
		await new PhaseOrchestrator(deps).reconcileOnStartup();
		expect(start).not.toHaveBeenCalled();
		expect(alertLeadPipelineError).toHaveBeenCalledOnce();
	});
});

/**
 * FLY-921 Fix C — turn-belt stale-holder reconcile. FLY-543 shape: the Lead
 * kills the TURN holder's process, the epoch lock never releases, and the
 * surviving (parked) design session polls `turn` forever getting `not-yours`.
 * reconcileTurnBelt detects a dead holder and re-grants the TURN to the most
 * downstream probed-ALIVE phase (qa → implement → design), or releases it.
 */
describe("FLY-921 Fix C — turn-belt stale-holder reconcile", () => {
	beforeEach(() => vi.clearAllMocks());

	const OLD = () => Date.now() - 10 * 60_000; // beyond the 5-min grant grace
	const FRESH = () => Date.now() - 10_000; // inside the grace window

	function turnRow(over: Partial<TurnBeltRow> = {}): TurnBeltRow {
		return {
			issue_id: "FLY-543",
			holder_exec_id: "qa-dead",
			phase: "qa",
			epoch: 3,
			granted_at: OLD(),
			...over,
		};
	}

	/** deps wired for one issue: a stale-candidate holder + a candidate pool. */
	function makeBeltDeps(args: {
		turn: TurnBeltRow | null;
		holderSession?: PhaseSession;
		candidates?: PhaseSession[];
		/** liveness per execution_id (default absent). */
		liveness?: Record<
			string,
			"alive" | "dead_pin" | "absent" | "indeterminate"
		>;
	}) {
		const h = makeDeps();
		(h.turnBelt.getTurn as ReturnType<typeof vi.fn>).mockImplementation(
			() => args.turn,
		);
		(h.turnBelt.listTurns as ReturnType<typeof vi.fn>).mockImplementation(() =>
			args.turn ? [{ projectName: "flywheel", turn: args.turn }] : [],
		);
		(
			h.turnBelt.getSessionForTurnHolder as ReturnType<typeof vi.fn>
		).mockImplementation((execId: string) =>
			args.holderSession?.execution_id === execId
				? args.holderSession
				: undefined,
		);
		(
			h.turnBelt.getPhaseSessionsForIssue as ReturnType<typeof vi.fn>
		).mockImplementation(() => args.candidates ?? []);
		h.probePhaseAlive.mockImplementation(async (s: PhaseSession) => {
			return args.liveness?.[s.execution_id] ?? "absent";
		});
		return h;
	}

	const parkedDesign = () =>
		session({
			execution_id: "design-alive",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done",
		});

	it("holder terminal (failed, FLY-543 kill shape) → TURN re-granted to probed-alive design; alert once", async () => {
		const h = makeBeltDeps({
			turn: turnRow(),
			holderSession: session({
				execution_id: "qa-dead",
				session_role: "qa",
				chat_thread_role: "qa",
				status: "failed",
			}),
			candidates: [parkedDesign()],
			liveness: { "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "qa-dead",
		});
		expect(h.grantTurn).toHaveBeenCalledOnce();
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				issueId: "FLY-543",
				execId: "design-alive",
				phase: "design",
				projectName: "flywheel",
			}),
		);
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		const reason = h.alertLeadPipelineError.mock.calls[0]![0].reason;
		expect(reason).toContain("qa-dead");
		expect(reason).toContain("design-alive");
		expect(h.turnBelt.deleteTurn).not.toHaveBeenCalled();
	});

	it("holder terminal (completed) → stale → recovery", async () => {
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "impl-done" }),
			holderSession: session({
				execution_id: "impl-done",
				session_role: "implement",
				chat_thread_role: "implement",
				status: "completed",
			}),
			candidates: [parkedDesign()],
			liveness: { "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "impl-done",
		});
		expect(h.grantTurn).toHaveBeenCalledOnce();
	});

	it("holder terminal (completed) + QA role → legitimate pipeline finish, NOT stale (Codex code R1 HIGH): no re-grant, no delete, no false alert", async () => {
		// A normal approved-ship completion: the QA session reaches terminal
		// `completed` while still the TURN holder (post-ship finalization deletes
		// the TURN moments later). With keep-alive ON, an upstream design/implement
		// phase is still parked-alive and WOULD be a recovery candidate — the bug
		// was that reconcile handed the TURN to it + fired a STALE-TURN Lead alert
		// on every successful three-stage ship. It must be a no-op.
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-shipped" }),
			holderSession: session({
				execution_id: "qa-shipped",
				session_role: "qa",
				chat_thread_role: "qa",
				status: "completed",
			}),
			candidates: [parkedDesign()],
			liveness: { "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "qa-shipped",
		});
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.turnBelt.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("holder terminal (failed) + QA role → STILL stale (kill shape, not a graceful ship) → recovery", async () => {
		// Guard the scope of the ship carve-out above: a `failed` QA holder is the
		// FLY-543 killed shape and must still recover, unlike `completed`.
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-killed" }),
			holderSession: session({
				execution_id: "qa-killed",
				session_role: "qa",
				chat_thread_role: "qa",
				status: "failed",
			}),
			candidates: [parkedDesign()],
			liveness: { "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "qa-killed",
		});
		expect(h.grantTurn).toHaveBeenCalledOnce();
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
	});

	it("holder non-terminal + probe alive → healthy, no action, no alert", async () => {
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-live" }),
			holderSession: session({
				execution_id: "qa-live",
				session_role: "qa",
				chat_thread_role: "qa",
				status: "running",
			}),
			liveness: { "qa-live": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.turnBelt.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("holder non-terminal + probe dead_pin → stale → recovery", async () => {
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-pinned" }),
			holderSession: session({
				execution_id: "qa-pinned",
				session_role: "qa",
				chat_thread_role: "qa",
				status: "running",
			}),
			candidates: [parkedDesign()],
			liveness: { "qa-pinned": "dead_pin", "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-alive" }),
		);
	});

	it("holder non-terminal + probe indeterminate → fail-closed skip, no alert", async () => {
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-maybe" }),
			holderSession: session({
				execution_id: "qa-maybe",
				session_role: "qa",
				chat_thread_role: "qa",
				status: "running",
			}),
			candidates: [parkedDesign()],
			liveness: { "qa-maybe": "indeterminate", "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.turnBelt.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("Codex R1 #2 pin: non-terminal absent QA holder is EXCLUDED from recovery — TURN never re-granted to the dead holder itself", async () => {
		const deadQa = session({
			execution_id: "qa-dead",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "awaiting_review", // non-terminal — a status-only selector would pick it
		});
		const h = makeBeltDeps({
			turn: turnRow(),
			holderSession: deadQa,
			candidates: [deadQa, parkedDesign()],
			liveness: { "qa-dead": "absent", "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).toHaveBeenCalledOnce();
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-alive", phase: "design" }),
		);
	});

	it("candidates probed in qa → implement → design order; dead candidates skipped", async () => {
		const deadImpl = session({
			execution_id: "impl-dead",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review",
		});
		const h = makeBeltDeps({
			turn: turnRow(),
			holderSession: session({
				execution_id: "qa-dead",
				chat_thread_role: "qa",
				status: "failed",
			}),
			candidates: [parkedDesign(), deadImpl],
			liveness: { "impl-dead": "absent", "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		// implement probed before design (priority), found dead, skipped.
		expect(h.grantTurn).toHaveBeenCalledOnce();
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-alive" }),
		);
	});

	it("candidate probe indeterminate → TURN untouched this round (never move on unknown liveness)", async () => {
		const maybeImpl = session({
			execution_id: "impl-maybe",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review",
		});
		const h = makeBeltDeps({
			turn: turnRow(),
			holderSession: session({
				execution_id: "qa-dead",
				chat_thread_role: "qa",
				status: "failed",
			}),
			candidates: [maybeImpl, parkedDesign()],
			liveness: { "impl-maybe": "indeterminate", "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.turnBelt.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("no live candidates → deleteTurn + alert (TURN released)", async () => {
		const h = makeBeltDeps({
			turn: turnRow(),
			holderSession: session({
				execution_id: "qa-dead",
				chat_thread_role: "qa",
				status: "failed",
			}),
			candidates: [],
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.turnBelt.deleteTurn).toHaveBeenCalledWith("FLY-543", "flywheel");
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).toHaveBeenCalledOnce();
		expect(h.alertLeadPipelineError.mock.calls[0]![0].reason).toContain(
			"TURN released",
		);
	});

	it("idempotent: a second reconcile after recovery (new holder alive) takes no action, no second alert", async () => {
		const design = parkedDesign();
		const h = makeBeltDeps({
			turn: turnRow({
				holder_exec_id: "design-alive",
				phase: "design",
				epoch: 4,
			}),
			holderSession: design,
			liveness: { "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("guard 1 (spawn race): event-scoped reconcile no-ops when the terminal exec is NOT the holder", async () => {
		// implement just completed and handoff already granted the TURN to the
		// freshly-spawned QA whose session row hasn't landed yet — do NOT touch it.
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-fresh-spawn", granted_at: FRESH() }),
			holderSession: undefined,
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "impl-done",
		});
		expect(h.probePhaseAlive).not.toHaveBeenCalled();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.turnBelt.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("guard 2 (grant grace): startup scan skips a missing-row holder granted < 5 min ago", async () => {
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-in-flight", granted_at: FRESH() }),
			holderSession: undefined,
			candidates: [parkedDesign()],
			liveness: { "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).not.toHaveBeenCalled();
		expect(h.turnBelt.deleteTurn).not.toHaveBeenCalled();
		expect(h.alertLeadPipelineError).not.toHaveBeenCalled();
	});

	it("guard 2 counterpart: missing-row holder beyond the grace window IS a remnant → recovery", async () => {
		const h = makeBeltDeps({
			turn: turnRow({ holder_exec_id: "qa-remnant", granted_at: OLD() }),
			holderSession: undefined,
			candidates: [parkedDesign()],
			liveness: { "design-alive": "alive" },
		});
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-alive" }),
		);
	});

	it("startup full-table scan reconciles per project (grantTurn carries each row's projectName)", async () => {
		const h = makeDeps();
		const t1 = turnRow({ issue_id: "FLY-A", holder_exec_id: "dead-a" });
		const t2 = turnRow({ issue_id: "FLY-B", holder_exec_id: "dead-b" });
		(h.turnBelt.listTurns as ReturnType<typeof vi.fn>).mockReturnValue([
			{ projectName: "proj-1", turn: t1 },
			{ projectName: "proj-2", turn: t2 },
		]);
		(
			h.turnBelt.getSessionForTurnHolder as ReturnType<typeof vi.fn>
		).mockImplementation((execId: string) =>
			session({
				execution_id: execId,
				chat_thread_role: "qa",
				status: "failed",
			}),
		);
		const designA = session({
			execution_id: "design-a",
			issue_id: "FLY-A",
			chat_thread_role: "design",
			status: "design_done",
		});
		const designB = session({
			execution_id: "design-b",
			issue_id: "FLY-B",
			chat_thread_role: "design",
			status: "design_done",
		});
		(
			h.turnBelt.getPhaseSessionsForIssue as ReturnType<typeof vi.fn>
		).mockImplementation((issueId: string) =>
			issueId === "FLY-A" ? [designA] : [designB],
		);
		h.probePhaseAlive.mockResolvedValue("alive");
		await new PhaseOrchestrator(h.deps).reconcileTurnBelt();
		expect(h.grantTurn).toHaveBeenCalledTimes(2);
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-a", projectName: "proj-1" }),
		);
		expect(h.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({ execId: "design-b", projectName: "proj-2" }),
		);
	});
});
