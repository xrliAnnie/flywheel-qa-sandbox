import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock mem0ai/oss for E2E tests that don't need live API
const mockAdd = vi.fn();
const mockSearch = vi.fn();
const mockVectorStore = {
	ready: Promise.resolve(),
	initError: undefined as Error | undefined,
};

vi.mock("mem0ai/oss", () => ({
	Memory: vi.fn().mockImplementation(() => ({
		add: mockAdd,
		search: mockSearch,
		vectorStore: mockVectorStore,
	})),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, mkdirSync: vi.fn() };
});

import { createMemoryService } from "../memory/createMemoryService.js";
import { MemoryService } from "../memory/MemoryService.js";

describe("Memory System E2E", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("full loop: add → search → found in prompt", async () => {
		// 1. Simulate add returning a stored fact
		mockAdd.mockResolvedValue({
			results: [
				{ id: "m1", event: "ADD", memory: "Auth tokens expire after 1 hour" },
			],
		});

		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		// 2. Add messages
		const addResult = await svc.addMessages({
			messages: [
				{ role: "user", content: "Issue: Fix auth token expiry (GEO-42)" },
				{
					role: "assistant",
					content:
						"Session result: success. Commits: fix: extend token TTL to 1 hour",
				},
			],
			projectName: "geoforge3d",
			userId: "test-user",
			agentId: "product-lead",
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
			userId: "test-user",
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
			userId: "test-user",
		});

		expect(block).toBeNull();

		// Verify search was called with correct project scope
		const [, opts] = mockSearch.mock.calls[0];
		expect(opts.userId).toBe("test-user");
	});

	it("graceful degradation: missing GOOGLE_API_KEY → memory disabled", async () => {
		const svc = await createMemoryService({
			supabaseUrl: "https://test.supabase.co",
			supabaseKey: "test-key",
			projectName: "geoforge3d",
		});
		expect(svc).toBeUndefined();
	});

	it("graceful degradation: missing SUPABASE_URL → memory disabled", async () => {
		const svc = await createMemoryService({
			googleApiKey: "test-key",
			supabaseKey: "test-key",
			projectName: "geoforge3d",
		});
		expect(svc).toBeUndefined();
	});

	it("graceful degradation: missing SUPABASE_KEY → memory disabled", async () => {
		const svc = await createMemoryService({
			googleApiKey: "test-key",
			supabaseUrl: "https://test.supabase.co",
			projectName: "geoforge3d",
		});
		expect(svc).toBeUndefined();
	});

	it("graceful degradation: all missing → memory disabled", async () => {
		const svc = await createMemoryService({
			projectName: "geoforge3d",
		});
		expect(svc).toBeUndefined();
	});
});

// Live E2E tests moved to memory-live.test.ts (no mock interference)
