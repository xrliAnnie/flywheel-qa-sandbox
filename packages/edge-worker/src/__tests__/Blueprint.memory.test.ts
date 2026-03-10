import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FlywheelRunResult } from "flywheel-core";
import { Blueprint } from "../Blueprint.js";
import type { BlueprintContext } from "../Blueprint.js";
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

function makeMockRunner(overrides: Partial<FlywheelRunResult> = {}) {
	const runResult: FlywheelRunResult = {
		sessionId: "sess-1",
		costUsd: 0.05,
		durationMs: 60_000,
		tmuxWindow: "flywheel:@42",
		...overrides,
	};
	return { run: vi.fn().mockResolvedValue(runResult) };
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

function makeContext(overrides: Partial<BlueprintContext> = {}): BlueprintContext {
	return {
		teamName: "eng",
		runnerName: "claude",
		...overrides,
	};
}

function makeMockMemoryService(overrides: Partial<MemoryService> = {}): MemoryService {
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
			() => makeMockRunner(),
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

		const runner = makeMockRunner();
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => runner,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined, undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext({ projectName: "geoforge3d" }),
		);

		// Verify runner was called with system prompt containing memory
		const runCall = runner.run.mock.calls[0][0];
		expect(runCall.appendSystemPrompt).toContain("<project_memory>");
		expect(runCall.appendSystemPrompt).toContain("Auth tokens expire after 1 hour");
	});

	it("memory retrieval failure is non-fatal", async () => {
		const memoryService = makeMockMemoryService({
			searchAndFormat: vi.fn().mockRejectedValue(new Error("Qdrant down")),
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockRunner(),
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined, undefined,
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

		const runner = makeMockRunner();
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => runner,
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined, undefined,
			memoryService,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		const runCall = runner.run.mock.calls[0][0];
		expect(runCall.appendSystemPrompt).not.toContain("<project_memory>");
	});

	it("uses canonical projectScope (teamName fallback) for memory search", async () => {
		const memoryService = makeMockMemoryService();

		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockRunner(),
			makeMockShell(),
			undefined, undefined, undefined, undefined, undefined, undefined, undefined,
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
