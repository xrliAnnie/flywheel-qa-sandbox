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
		memoryAllowedUsers: ["annie"],
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

	it("returns memories when found (200)", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "auth bug",
				project_name: "geoforge3d",
				agent_id: "product-lead",
				user_id: "annie",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.memories).toEqual(["memory1", "memory2"]);
		expect(mockMemoryService.searchMemories).toHaveBeenCalledWith({
			query: "auth bug",
			projectName: "geoforge3d",
			agentId: "product-lead",
			userId: "annie",
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
				user_id: "annie",
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

	it("400 when agent_id missing", async () => {
		const res = await fetch(url(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "test",
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
				user_id: "annie",
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
				user_id: "annie",
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
				user_id: "annie",
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
				user_id: "annie",
				limit: 25,
			}),
		});
		expect(res.status).toBe(200);
		expect(mockMemoryService.searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 25 }),
		);
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
				user_id: "annie",
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
