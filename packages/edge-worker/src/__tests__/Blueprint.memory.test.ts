import type { AdapterExecutionResult, DecisionResult } from "flywheel-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { IDecisionLayer } from "../decision/DecisionLayer.js";
import type { MemoryService } from "../memory/MemoryService.js";

// ─── Mocks ─────────────────────────────────

function makeMockHydrator() {
	return {
		hydrate: vi.fn().mockResolvedValue({
			issueId: "GEO-101",
			issueTitle: "Fix auth bug",
			issueDescription: "Auth tokens expire too fast",
			labels: ["feature"],
			projectId: "proj-1",
			issueIdentifier: "GEO-101",
		}),
	};
}

function makeMockGitChecker(overrides: Record<string, unknown> = {}) {
	return {
		assertCleanTree: vi.fn().mockResolvedValue(undefined),
		captureBaseline: vi.fn().mockResolvedValue("abc123"),
		check: vi.fn().mockResolvedValue({
			hasNewCommits: true,
			commitCount: 2,
			filesChanged: 1,
			commitMessages: ["fix: thing"],
			...overrides,
		}),
	};
}

function makeMockAdapter(overrides: Partial<AdapterExecutionResult> = {}) {
	const execResult: AdapterExecutionResult = {
		success: true,
		sessionId: "sess-1",
		costUsd: 0.05,
		durationMs: 60_000,
		tmuxWindow: "flywheel:@42",
		...overrides,
	};
	return {
		type: "mock" as const,
		supportsStreaming: false as const,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn().mockResolvedValue(execResult),
	};
}

function makeMockShell() {
	return { execFile: vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }) };
}

function makeMockEvidenceCollector() {
	return {
		collect: vi.fn().mockResolvedValue({
			commitCount: 2,
			filesChangedCount: 1,
			commitMessages: ["fix: thing"],
			changedFilePaths: ["src/a.ts"],
			linesAdded: 10,
			linesRemoved: 5,
			diffSummary: "diff",
			headSha: "def456",
			partial: false,
			durationMs: 60_000,
		}),
		getFullDiff: vi.fn().mockResolvedValue("full diff"),
	};
}

function makeContext(
	overrides: Partial<BlueprintContext> = {},
): BlueprintContext {
	return {
		teamName: "eng",
		runnerName: "claude",
		...overrides,
	};
}

function makeMockMemoryService(
	overrides: Partial<MemoryService> = {},
): MemoryService {
	return {
		searchAndFormat: vi.fn().mockResolvedValue(null),
		addSessionMemory: vi.fn().mockResolvedValue({ added: 1, updated: 0 }),
		...overrides,
	} as unknown as MemoryService;
}

describe("Blueprint Memory Retrieval Integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("works without memoryService (backward compat)", async () => {
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(true);
	});

	it("injects <project_memory> into system prompt when memories found", async () => {
		const memoryBlock = [
			"<project_memory>",
			"## Learned from previous sessions",
			"- Auth tokens expire after 1 hour",
			"</project_memory>",
		].join("\n");

		const memoryService = makeMockMemoryService({
			searchAndFormat: vi.fn().mockResolvedValue(memoryBlock),
		});

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext({ projectName: "geoforge3d" }),
		);

		// Verify adapter was called with system prompt containing memory
		const runCall = adapter.execute.mock.calls[0][0];
		expect(runCall.appendSystemPrompt).toContain("<project_memory>");
		expect(runCall.appendSystemPrompt).toContain(
			"Auth tokens expire after 1 hour",
		);
	});

	it("memory retrieval failure is non-fatal", async () => {
		const memoryService = makeMockMemoryService({
			searchAndFormat: vi.fn().mockRejectedValue(new Error("Qdrant down")),
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(true);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Memory retrieval failed"),
		);
		warnSpy.mockRestore();
	});

	it("no memory block when searchAndFormat returns null", async () => {
		const memoryService = makeMockMemoryService({
			searchAndFormat: vi.fn().mockResolvedValue(null),
		});

		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		const runCall = adapter.execute.mock.calls[0][0];
		expect(runCall.appendSystemPrompt).not.toContain("<project_memory>");
	});

	it("uses canonical projectScope (teamName fallback) for memory search", async () => {
		const memoryService = makeMockMemoryService();

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		// No projectName — should fall back to teamName
		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext({ teamName: "studio" }),
		);

		expect(memoryService.searchAndFormat).toHaveBeenCalledWith(
			expect.objectContaining({ projectName: "studio" }),
		);
	});
});

// ─── Helpers for Decision Layer tests ───────

function makeMockDecisionLayer(
	result: Partial<DecisionResult> = {},
): IDecisionLayer {
	return {
		decide: vi.fn().mockResolvedValue({
			route: "auto_approve",
			confidence: 0.95,
			reasoning: "Clean change",
			concerns: [],
			decisionSource: "haiku_triage",
			...result,
		}),
	};
}

describe("Blueprint Memory Extraction Integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls addSessionMemory in runWithDecision (decision path)", async () => {
		const memoryService = makeMockMemoryService();
		const decisionLayer = makeMockDecisionLayer({ route: "auto_approve" });

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext({ projectName: "geoforge3d" }),
		);

		expect(memoryService.addSessionMemory).toHaveBeenCalledOnce();
		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "geoforge3d",
				sessionResult: "success",
			}),
		);
	});

	it("calls addSessionMemory in fallback (no DecisionLayer)", async () => {
		const memoryService = makeMockMemoryService();

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext({ projectName: "geoforge3d" }),
		);

		expect(memoryService.addSessionMemory).toHaveBeenCalledOnce();
		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "geoforge3d",
				sessionResult: "success",
			}),
		);
	});

	it("addSessionMemory failure is non-fatal", async () => {
		const memoryService = makeMockMemoryService({
			addSessionMemory: vi.fn().mockRejectedValue(new Error("Gemini down")),
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(true);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Memory extraction failed"),
		);
		warnSpy.mockRestore();
	});

	it("auto_approve decision → sessionResult: success", async () => {
		const memoryService = makeMockMemoryService();
		const decisionLayer = makeMockDecisionLayer({ route: "auto_approve" });

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({ sessionResult: "success" }),
		);
	});

	it("blocked decision → sessionResult: failure", async () => {
		const memoryService = makeMockMemoryService();
		const decisionLayer = makeMockDecisionLayer({
			route: "blocked",
			reasoning: "Too many files changed",
			concerns: ["blast radius"],
		});

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionResult: "failure",
				decisionRoute: "blocked",
				decisionReasoning: expect.stringContaining("Too many files changed"),
			}),
		);
	});

	it("timed out session → sessionResult: timeout", async () => {
		const memoryService = makeMockMemoryService();
		const decisionLayer = makeMockDecisionLayer({ route: "needs_review" });

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter({ timedOut: true }),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionResult: "timeout",
				error: "timeout",
			}),
		);
	});

	it("fallback: 0 commits, not timed out → failure", async () => {
		const memoryService = makeMockMemoryService();
		const zeroCommitEvidence = {
			collect: vi.fn().mockResolvedValue({
				commitCount: 0,
				filesChangedCount: 0,
				commitMessages: [],
				changedFilePaths: [],
				linesAdded: 0,
				linesRemoved: 0,
				diffSummary: "",
				headSha: "abc123",
				partial: false,
				durationMs: 60_000,
			}),
			getFullDiff: vi.fn().mockResolvedValue(""),
		};

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker({ commitCount: 0, hasNewCommits: false }),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			zeroCommitEvidence,
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionResult: "failure",
				error: "no commits produced",
			}),
		);
	});

	it("fallback: >0 commits, not timed out → success", async () => {
		const memoryService = makeMockMemoryService();

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker({ commitCount: 3 }),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({ sessionResult: "success" }),
		);
	});

	it("blocked sessions include decisionReasoning with concerns", async () => {
		const memoryService = makeMockMemoryService();
		const decisionLayer = makeMockDecisionLayer({
			route: "blocked",
			reasoning: "File count too high",
			concerns: ["blast radius", "no tests"],
		});

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		const call = (memoryService.addSessionMemory as any).mock.calls[0][0];
		expect(call.decisionReasoning).toContain("File count too high");
		expect(call.decisionReasoning).toContain("concern: blast radius");
		expect(call.decisionReasoning).toContain("concern: no tests");
	});

	it("when ctx.projectName undefined, memory uses teamName fallback", async () => {
		const memoryService = makeMockMemoryService();

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			undefined,
			undefined,
			undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext({ teamName: "studio" }),
		);

		// Both search and extraction use the same canonical projectScope
		expect(memoryService.searchAndFormat).toHaveBeenCalledWith(
			expect.objectContaining({ projectName: "studio" }),
		);
		expect(memoryService.addSessionMemory).toHaveBeenCalledWith(
			expect.objectContaining({ projectName: "studio" }),
		);
	});
});
