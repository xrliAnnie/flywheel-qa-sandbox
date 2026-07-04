import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PhaseOrchestrator,
	type PhaseOrchestratorDeps,
	type PhaseSession,
} from "../phase-orchestrator.js";

function makeDeps(over: Partial<PhaseOrchestratorDeps> = {}) {
	const start = vi.fn(async () => ({ executionId: "next-exec" }));
	const capturePhaseHeadSha = vi.fn(async () => "deadbeefcafe1234");
	const closePhaseRunner = vi.fn(async () => {});
	const alertLeadPipelineError = vi.fn(async () => {});
	const listStrandedDesignPhases = vi.fn((): PhaseSession[] => []);
	const deps: PhaseOrchestratorDeps = {
		startDispatcher: { start },
		effects: { capturePhaseHeadSha, closePhaseRunner, alertLeadPipelineError },
		resolveThreeStage: () => ({ enabled: true }),
		listStrandedDesignPhases,
		...over,
	};
	return {
		deps,
		start,
		capturePhaseHeadSha,
		closePhaseRunner,
		alertLeadPipelineError,
		listStrandedDesignPhases,
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
		};
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
		const alertLeadPipelineError = vi.fn(async () => {});
		const deps: PhaseOrchestratorDeps = {
			startDispatcher: { start },
			effects: {
				capturePhaseHeadSha: vi.fn(async () => "abc123"),
				closePhaseRunner: vi.fn(async () => {}),
				alertLeadPipelineError,
			},
			resolveThreeStage: () => ({ enabled: true }),
		};
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
