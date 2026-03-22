import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock mem0ai/oss before importing MemoryService
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

// Mock node:fs for createMemoryService tests
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, mkdirSync: vi.fn() };
});

import { Memory } from "mem0ai/oss";
import { createMemoryService } from "../memory/createMemoryService.js";
import { MemoryService } from "../memory/MemoryService.js";

describe("MemoryService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── Constructor ─────────────────────────────────

	it("creates instance without error", () => {
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});
		expect(svc).toBeInstanceOf(MemoryService);
		expect(Memory).toHaveBeenCalledOnce();
	});

	it("creates instance with Supabase config (production)", () => {
		const svc = new MemoryService({
			googleApiKey: "test-key",
			supabaseUrl: "https://test.supabase.co",
			supabaseKey: "test-service-role-key",
			historyDbPath: "/tmp/test.db",
		});
		expect(svc).toBeInstanceOf(MemoryService);
		const constructorCall = vi.mocked(Memory).mock.calls[0][0] as any;
		expect(constructorCall.vectorStore.provider).toBe("supabase");
		expect(constructorCall.vectorStore.config.supabaseUrl).toBe(
			"https://test.supabase.co",
		);
		expect(constructorCall.vectorStore.config.supabaseKey).toBe(
			"test-service-role-key",
		);
		expect(constructorCall.vectorStore.config.tableName).toBe("memories");
	});

	it("uses in-memory vector store for test config", () => {
		new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});
		const constructorCall = vi.mocked(Memory).mock.calls[0][0] as any;
		expect(constructorCall.vectorStore.provider).toBe("memory");
	});

	// ── searchAndFormat ─────────────────────────────

	it("returns null when no memories found", async () => {
		mockSearch.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.searchAndFormat({
			query: "some query",
			projectName: "geoforge3d",
			userId: "test-user",
		});

		expect(result).toBeNull();
	});

	it("returns formatted <project_memory> block with memories", async () => {
		mockSearch.mockResolvedValue({
			results: [
				{ memory: "Auth tokens expire after 1 hour" },
				{ memory: "Use pnpm, not npm" },
			],
		});
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.searchAndFormat({
			query: "auth bug",
			projectName: "geoforge3d",
			userId: "test-user",
		});

		expect(result).toContain("<project_memory>");
		expect(result).toContain("</project_memory>");
		expect(result).toContain("## Learned from previous sessions");
		expect(result).toContain("- Auth tokens expire after 1 hour");
		expect(result).toContain("- Use pnpm, not npm");
	});

	// ── searchMemories (NEW — API-oriented, strict throw) ──

	it("searchMemories returns raw string array", async () => {
		mockSearch.mockResolvedValue({
			results: [
				{ memory: "Auth tokens expire after 1 hour" },
				{ memory: "Use pnpm, not npm" },
			],
		});
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.searchMemories({
			query: "auth",
			projectName: "geoforge3d",
			userId: "test-user",
		});

		expect(result).toEqual([
			"Auth tokens expire after 1 hour",
			"Use pnpm, not npm",
		]);
	});

	it("searchMemories returns empty array when no results", async () => {
		mockSearch.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.searchMemories({
			query: "nothing",
			projectName: "geoforge3d",
			userId: "test-user",
		});

		expect(result).toEqual([]);
	});

	it("searchMemories respects limit parameter", async () => {
		mockSearch.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.searchMemories({
			query: "test",
			projectName: "proj",
			userId: "test-user",
			limit: 5,
		});

		const [, opts] = mockSearch.mock.calls[0];
		expect(opts.limit).toBe(5);
	});

	it("searchMemories passes agentId to mem0 search", async () => {
		mockSearch.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.searchMemories({
			query: "test",
			projectName: "proj",
			userId: "test-user",
			agentId: "product-lead",
		});

		const [, opts] = mockSearch.mock.calls[0];
		expect(opts.agentId).toBe("product-lead");
	});

	it("searchMemories filters by app_id: projectName", async () => {
		mockSearch.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.searchMemories({
			query: "test",
			projectName: "proj",
			userId: "test-user",
		});

		const [, opts] = mockSearch.mock.calls[0];
		expect(opts.filters).toEqual({ app_id: "proj" });
	});

	it("searchMemories throws on malformed mem0 response", async () => {
		mockSearch.mockResolvedValue({ unexpected: true });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await expect(
			svc.searchMemories({ query: "test", projectName: "proj", userId: "test-user" }),
		).rejects.toThrow("Unexpected search response shape");
	});

	it("searchMemories throws on null response", async () => {
		mockSearch.mockResolvedValue(null);
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await expect(
			svc.searchMemories({ query: "test", projectName: "proj", userId: "test-user" }),
		).rejects.toThrow("Unexpected search response shape");
	});

	it("searchMemories throws when all items lack memory field", async () => {
		mockSearch.mockResolvedValue({ results: [{ id: "1" }, { id: "2" }] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await expect(
			svc.searchMemories({ query: "test", projectName: "proj", userId: "test-user" }),
		).rejects.toThrow("lack a valid 'memory' field");
	});

	// ── addMessages (NEW — API-oriented, strict throw) ──

	it("addMessages adds messages and returns counts", async () => {
		mockAdd.mockResolvedValue({
			results: [
				{ id: "1", event: "ADD", memory: "fact" },
				{ id: "2", event: "UPDATE", memory: "updated" },
			],
		});
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.addMessages({
			messages: [{ role: "user", content: "hello" }],
			projectName: "geoforge3d",
			userId: "test-user",
			agentId: "product-lead",
		});

		expect(result).toEqual({ added: 1, updated: 1 });
	});

	it("addMessages sets app_id to projectName in metadata", async () => {
		mockAdd.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.addMessages({
			messages: [{ role: "user", content: "hi" }],
			projectName: "proj",
			userId: "test-user",
			agentId: "lead",
		});

		const [, opts] = mockAdd.mock.calls[0];
		expect(opts.metadata.app_id).toBe("proj");
	});

	it("addMessages merges caller metadata with enforced app_id", async () => {
		mockAdd.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.addMessages({
			messages: [{ role: "user", content: "hi" }],
			projectName: "proj",
			userId: "test-user",
			agentId: "lead",
			metadata: { custom_key: "value", app_id: "should-be-overridden" },
		});

		const [, opts] = mockAdd.mock.calls[0];
		expect(opts.metadata.app_id).toBe("proj");
		expect(opts.metadata.custom_key).toBe("value");
	});

	it("addMessages passes agentId to mem0 add", async () => {
		mockAdd.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.addMessages({
			messages: [{ role: "assistant", content: "response" }],
			projectName: "proj",
			userId: "test-user",
			agentId: "ops-lead",
		});

		const [, opts] = mockAdd.mock.calls[0];
		expect(opts.agentId).toBe("ops-lead");
		expect(opts.userId).toBe("test-user");
	});

	it("addMessages throws on malformed mem0 add() response", async () => {
		mockAdd.mockResolvedValue({ unexpected: true });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await expect(
			svc.addMessages({
				messages: [{ role: "user", content: "test" }],
				projectName: "proj",
				userId: "test-user",
				agentId: "lead",
			}),
		).rejects.toThrow("Unexpected add response shape");
	});

	it("addMessages throws when all items lack recognized event field", async () => {
		mockAdd.mockResolvedValue({
			results: [{ id: "1" }, { id: "2" }],
		});
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await expect(
			svc.addMessages({
				messages: [{ role: "user", content: "test" }],
				projectName: "proj",
				userId: "test-user",
				agentId: "lead",
			}),
		).rejects.toThrow("lack recognized 'event' field");
	});

	// ── searchAndFormat (refactored — verify graceful degradation) ──

	it("searchAndFormat returns null on malformed response (graceful degradation)", async () => {
		mockSearch.mockResolvedValue({ unexpected: true });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.searchAndFormat({
			query: "test",
			projectName: "proj",
			userId: "test-user",
		});

		expect(result).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("searchAndFormat degraded"),
		);
		warnSpy.mockRestore();
	});

	it("passes app_id filter to search (matches write-side scoping)", async () => {
		mockSearch.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.searchAndFormat({
			query: "test",
			projectName: "myproject",
			userId: "test-user",
			agentId: "qa",
		});

		const [, opts] = mockSearch.mock.calls[0];
		expect(opts.userId).toBe("test-user");
		expect(opts.agentId).toBe("qa");
		expect(opts.filters).toEqual({ app_id: "myproject" });
	});
});

describe("createMemoryService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockVectorStore.ready = Promise.resolve();
		mockVectorStore.initError = undefined;
	});

	it("returns MemoryService when all keys provided", async () => {
		const svc = await createMemoryService({
			googleApiKey: "test-key",
			supabaseUrl: "https://test.supabase.co",
			supabaseKey: "test-service-role-key",
			projectName: "myproject",
		});
		expect(svc).toBeInstanceOf(MemoryService);
	});

	it("returns undefined without googleApiKey", async () => {
		const svc = await createMemoryService({
			supabaseUrl: "https://test.supabase.co",
			supabaseKey: "test-service-role-key",
			projectName: "myproject",
		});
		expect(svc).toBeUndefined();
	});

	it("returns undefined without supabaseUrl", async () => {
		const svc = await createMemoryService({
			googleApiKey: "test-key",
			supabaseKey: "test-service-role-key",
			projectName: "myproject",
		});
		expect(svc).toBeUndefined();
	});

	it("returns undefined without supabaseKey", async () => {
		const svc = await createMemoryService({
			googleApiKey: "test-key",
			supabaseUrl: "https://test.supabase.co",
			projectName: "myproject",
		});
		expect(svc).toBeUndefined();
	});

	it("returns undefined when vectorStore.initError is set", async () => {
		mockVectorStore.initError = new Error("connection refused");
		const svc = await createMemoryService({
			googleApiKey: "test-key",
			supabaseUrl: "https://test.supabase.co",
			supabaseKey: "test-service-role-key",
			projectName: "myproject",
		});
		expect(svc).toBeUndefined();
	});

	it("uses history path under ~/.flywheel/memories/<projectName>/", async () => {
		const svc = await createMemoryService({
			googleApiKey: "test-key",
			supabaseUrl: "https://test.supabase.co",
			supabaseKey: "test-service-role-key",
			projectName: "geoforge3d",
		});
		expect(svc).toBeDefined();
		const constructorCall = vi.mocked(Memory).mock.calls.at(-1)?.[0] as any;
		expect(constructorCall.historyDbPath).toMatch(
			/\.flywheel\/memories\/geoforge3d\/history\.db$/,
		);
	});
});
