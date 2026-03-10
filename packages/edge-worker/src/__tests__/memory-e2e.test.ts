import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mem0ai/oss for E2E tests that don't need live API
const mockAdd = vi.fn();
const mockSearch = vi.fn();

vi.mock("mem0ai/oss", () => ({
	Memory: vi.fn().mockImplementation(() => ({
		add: mockAdd,
		search: mockSearch,
	})),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, mkdirSync: vi.fn() };
});

import { MemoryService } from "../memory/MemoryService.js";
import { createMemoryService } from "../memory/createMemoryService.js";

describe("Memory System E2E", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("full loop: add → search → found in prompt", async () => {
		// 1. Simulate add returning a stored fact
		mockAdd.mockResolvedValue({
			results: [{ id: "m1", event: "ADD", memory: "Auth tokens expire after 1 hour" }],
		});

		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		// 2. Add a session memory
		const addResult = await svc.addSessionMemory({
			projectName: "geoforge3d",
			executionId: "exec-001",
			issueId: "GEO-42",
			issueTitle: "Fix auth token expiry",
			sessionResult: "success",
			commitMessages: ["fix: extend token TTL to 1 hour"],
			diffSummary: "+5 -2 in auth.ts",
		});

		expect(addResult.added).toBe(1);

		// 3. Simulate search returning the stored fact
		mockSearch.mockResolvedValue({
			results: [{ memory: "Auth tokens expire after 1 hour", score: 0.95 }],
		});

		// 4. Search and verify prompt block
		const block = await svc.searchAndFormat({
			query: "auth token issues",
			projectName: "geoforge3d",
		});

		expect(block).toContain("<project_memory>");
		expect(block).toContain("Auth tokens expire after 1 hour");
		expect(block).toContain("</project_memory>");
	});

	it("project isolation: different projects don't leak", async () => {
		// Alpha project has memories
		mockSearch.mockResolvedValue({ results: [] });

		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		// Search for beta project — should get no results
		const block = await svc.searchAndFormat({
			query: "auth token",
			projectName: "beta",
		});

		expect(block).toBeNull();

		// Verify search was called with correct project scope
		const [, opts] = mockSearch.mock.calls[0];
		expect(opts.userId).toBe("beta");
	});

	it("graceful degradation: missing GOOGLE_API_KEY → memory disabled", () => {
		const svc = createMemoryService({
			qdrantUrl: "http://localhost:6333",
			projectName: "geoforge3d",
		});
		expect(svc).toBeUndefined();
	});

	it("graceful degradation: missing QDRANT_URL → memory disabled", () => {
		const svc = createMemoryService({
			googleApiKey: "test-key",
			projectName: "geoforge3d",
		});
		expect(svc).toBeUndefined();
	});

	it("graceful degradation: both missing → memory disabled", () => {
		const svc = createMemoryService({
			projectName: "geoforge3d",
		});
		expect(svc).toBeUndefined();
	});

	it("failure session includes error context", async () => {
		mockAdd.mockResolvedValue({
			results: [{ id: "m2", event: "ADD", memory: "Build fails with missing dep" }],
		});

		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.addSessionMemory({
			projectName: "geoforge3d",
			executionId: "exec-002",
			issueId: "GEO-50",
			issueTitle: "Add new feature",
			sessionResult: "failure",
			commitMessages: [],
			diffSummary: "",
			error: "no commits produced",
			decisionReasoning: "Too many files changed; concern: no tests",
		});

		// Verify messages sent to mem0 include error context
		const [messages] = mockAdd.mock.calls[0];
		expect(messages[1].content).toContain("Error: no commits produced");
		expect(messages[1].content).toContain("Decision reasoning:");
		expect(result.added).toBe(1);
	});
});

// Live E2E tests moved to memory-live.test.ts (no mock interference)
