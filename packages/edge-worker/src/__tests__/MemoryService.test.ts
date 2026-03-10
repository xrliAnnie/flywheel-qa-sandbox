import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { MemoryService } from "../memory/MemoryService.js";
import { createMemoryService } from "../memory/createMemoryService.js";
import { Memory } from "mem0ai/oss";

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

	// ── addSessionMemory ────────────────────────────

	it("calls memory.add() with correct scoping for success session", async () => {
		mockAdd.mockResolvedValue({
			results: [{ id: "1", event: "ADD", memory: "fact" }],
		});
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.addSessionMemory({
			projectName: "geoforge3d",
			executionId: "exec-123",
			issueId: "GEO-42",
			issueTitle: "Fix auth bug",
			sessionResult: "success",
			commitMessages: ["fix: auth token refresh"],
			diffSummary: "+10 -3 in auth.ts",
		});

		expect(mockAdd).toHaveBeenCalledOnce();
		const [messages, opts] = mockAdd.mock.calls[0];

		// Check scoping (mem0 SDK uses camelCase)
		expect(opts.userId).toBe("geoforge3d");
		expect(opts.runId).toBe("exec-123");
		expect(opts.metadata.app_id).toBe("flywheel");

		// Check message content
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toContain("Fix auth bug");
		expect(messages[1].role).toBe("assistant");
		expect(messages[1].content).toContain("success");

		expect(result).toEqual({ added: 1, updated: 0 });
	});

	it("includes error field for failure session", async () => {
		mockAdd.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.addSessionMemory({
			projectName: "geoforge3d",
			executionId: "exec-456",
			issueId: "GEO-43",
			issueTitle: "Broken build",
			sessionResult: "failure",
			commitMessages: [],
			diffSummary: "",
			error: "no commits produced",
		});

		const [messages] = mockAdd.mock.calls[0];
		expect(messages[1].content).toContain("Error: no commits produced");
	});

	it("includes decisionReasoning for blocked session", async () => {
		mockAdd.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.addSessionMemory({
			projectName: "geoforge3d",
			executionId: "exec-789",
			issueId: "GEO-44",
			issueTitle: "Dangerous refactor",
			sessionResult: "failure",
			commitMessages: [],
			diffSummary: "",
			decisionRoute: "blocked",
			decisionReasoning: "Too many files changed; concern: blast radius",
		});

		const [messages] = mockAdd.mock.calls[0];
		expect(messages[1].content).toContain("Decision: blocked");
		expect(messages[1].content).toContain(
			"Decision reasoning: Too many files changed",
		);
	});

	it("passes correct user_id, run_id, app_id to mem0", async () => {
		mockAdd.mockResolvedValue({ results: [] });
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		await svc.addSessionMemory({
			projectName: "alpha-project",
			executionId: "run-001",
			issueId: "ALPHA-1",
			issueTitle: "Test",
			sessionResult: "success",
			commitMessages: ["test"],
			diffSummary: "",
			agentId: "backend",
		});

		const [, opts] = mockAdd.mock.calls[0];
		expect(opts.userId).toBe("alpha-project");
		expect(opts.runId).toBe("run-001");
		expect(opts.metadata.app_id).toBe("flywheel");
		expect(opts.agentId).toBe("backend");
	});

	it("counts added and updated results correctly", async () => {
		mockAdd.mockResolvedValue({
			results: [
				{ id: "1", event: "ADD", memory: "new fact" },
				{ id: "2", event: "UPDATE", memory: "updated fact" },
				{ id: "3", event: "ADD", memory: "another fact" },
			],
		});
		const svc = new MemoryService({
			googleApiKey: "test-key",
			historyDbPath: ":memory:",
		});

		const result = await svc.addSessionMemory({
			projectName: "proj",
			executionId: "exec-1",
			issueId: "P-1",
			issueTitle: "Test",
			sessionResult: "success",
			commitMessages: [],
			diffSummary: "",
		});

		expect(result).toEqual({ added: 2, updated: 1 });
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
		});

		expect(result).toContain("<project_memory>");
		expect(result).toContain("</project_memory>");
		expect(result).toContain("## Learned from previous sessions");
		expect(result).toContain("- Auth tokens expire after 1 hour");
		expect(result).toContain("- Use pnpm, not npm");
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
			agentId: "qa",
		});

		const [, opts] = mockSearch.mock.calls[0];
		expect(opts.userId).toBe("myproject");
		expect(opts.agentId).toBe("qa");
		expect(opts.filters).toEqual({ app_id: "flywheel" });
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
