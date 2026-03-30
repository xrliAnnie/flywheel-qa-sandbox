import express from "express";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createMemoryRouter } from "../bridge/memory-route.js";

// ─── Mock MemoryService ────────────────────────

function makeMockMemoryService() {
	return {
		searchMemories: vi.fn().mockResolvedValue(["memory1", "memory2"]),
		addMessages: vi.fn().mockResolvedValue({ added: 1, updated: 0 }),
	};
}

// ─── Mock projects config ──────────────────────

const mockProjects = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "x",
				chatChannel: "y",
				match: { labels: ["Product"] },
			},
		],
		// GEO-203: dual-bucket — lead IDs (private) + project name (shared)
		memoryAllowedUsers: ["annie", "product-lead", "geoforge3d"],
	},
];

// ─── Test server setup ─────────────────────────

function createTestApp(
	memoryService: ReturnType<typeof makeMockMemoryService>,
) {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/memory",
		createMemoryRouter(memoryService as any, mockProjects),
	);
	return app;
}

let server: ReturnType<typeof import("http").createServer>;
let baseUrl: string;
let mockMemoryService: ReturnType<typeof makeMockMemoryService>;

beforeAll(async () => {
	mockMemoryService = makeMockMemoryService();
	const app = createTestApp(mockMemoryService);
	server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
});

beforeEach(() => {
	vi.clearAllMocks();
	mockMemoryService.searchMemories.mockResolvedValue(["memory1", "memory2"]);
	mockMemoryService.addMessages.mockResolvedValue({ added: 1, updated: 0 });
});

// ─── POST /search ──────────────────────────────

describe("POST /api/memory/search", () => {
	const url = () => `${baseUrl}/api/memory/search`;

	it("returns memories when found (200) — private bucket", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "auth bug",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.memories).toEqual(["memory1", "memory2"]);
		expect(mockMemoryService.searchMemories).toHaveBeenCalledWith({
			query: "auth bug",
			projectName: "geoforge3d",
			agentId: "product-lead",
			userId: "product-lead",
			limit: undefined,
		});
	});

	it("returns empty array when no memories (200)", async () => {
		mockMemoryService.searchMemories.mockResolvedValue([]);
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "nothing",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.memories).toEqual([]);
	});

	it("400 when query missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when query is not a string", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: 123,
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when query is empty string", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when project_name missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	// GEO-203: agent_id is now optional for search (dual-bucket support)
	it("200 when agent_id omitted — shared bucket search (user_id=project_name)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				user_id: "geoforge3d",
			}),
		});
		expect(res.status).toBe(200);
		expect(mockMemoryService.searchMemories).toHaveBeenCalledWith({
			query: "test",
			projectName: "geoforge3d",
			userId: "geoforge3d",
			agentId: undefined,
			limit: undefined,
		});
	});

	it("400 when agent_id omitted but user_id ≠ project_name (dual-bucket contract)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				user_id: "product-lead",
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("shared bucket");
	});

	it("400 when agent_id and user_id mismatch (cross-namespace)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("private bucket");
	});

	it("400 when agent_id is empty string", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("200 with user_id=product-lead — private bucket search", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "my decisions",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
			}),
		});
		expect(res.status).toBe(200);
	});

	it("200 with user_id=geoforge3d — shared bucket search", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "project facts",
				project_name: "geoforge3d",
				user_id: "geoforge3d",
			}),
		});
		expect(res.status).toBe(200);
	});

	it("400 when user_id missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when user_id is empty string", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when project_name is unknown (config validation)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "unknown-project",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when agent_id is unknown (config validation)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "unknown-agent",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when user_id not in memoryAllowedUsers", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "bob",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when limit is not an integer", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
				limit: 3.5,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when limit < 1", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
				limit: 0,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when limit > 50", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
				limit: 51,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("passes limit to service when valid", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
				limit: 25,
			}),
		});
		expect(res.status).toBe(200);
		expect(mockMemoryService.searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 25 }),
		);
	});

	it("200 with agent_id + user_id=project_name — shared bucket with agent filter", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "project facts",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "geoforge3d",
			}),
		});
		expect(res.status).toBe(200);
	});

	it("502 on MemoryService error", async () => {
		mockMemoryService.searchMemories.mockRejectedValue(
			new Error("Supabase connection failed"),
		);
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
			}),
		});
		expect(res.status).toBe(502);
	});
});

// ─── POST /add ─────────────────────────────────

describe("POST /api/memory/add", () => {
	const url = () => `${baseUrl}/api/memory/add`;

	it("adds messages and returns counts (200)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hello" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ added: 1, updated: 0 });
		expect(mockMemoryService.addMessages).toHaveBeenCalledWith({
			messages: [{ role: "user", content: "hello" }],
			projectName: "geoforge3d",
			agentId: "product-lead",
			userId: "annie",
			metadata: undefined,
		});
	});

	it("400 when messages missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when messages is empty array", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when messages[].role is invalid enum", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "system", content: "hello" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when messages[].content is empty string", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when messages[].content is not a string", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: 123 }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when project_name missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when agent_id missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				project_name: "geoforge3d",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when user_id missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when project_name is unknown (config validation)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				project_name: "unknown-project",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("400 when user_id not in memoryAllowedUsers", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "bob",
			}),
		});
		expect(res.status).toBe(400);
	});

	// GEO-203: add with private bucket user_id
	it("200 when writing to private bucket (user_id=product-lead)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "assistant", content: "my decision" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "product-lead",
			}),
		});
		expect(res.status).toBe(200);
		expect(mockMemoryService.addMessages).toHaveBeenCalledWith({
			messages: [{ role: "assistant", content: "my decision" }],
			projectName: "geoforge3d",
			agentId: "product-lead",
			userId: "product-lead",
			metadata: undefined,
		});
	});

	it("400 when metadata is array (not object)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
				metadata: [1, 2, 3],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("200 when metadata is omitted (valid)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(200);
	});

	it("passes metadata to service when valid", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
				metadata: { custom: "value" },
			}),
		});
		expect(res.status).toBe(200);
		expect(mockMemoryService.addMessages).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: { custom: "value" } }),
		);
	});

	it("502 on MemoryService error", async () => {
		mockMemoryService.addMessages.mockRejectedValue(
			new Error("Gemini API failure"),
		);
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "test" }],
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(502);
	});
});
