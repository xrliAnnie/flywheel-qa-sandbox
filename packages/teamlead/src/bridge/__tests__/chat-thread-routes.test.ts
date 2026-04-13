/**
 * FLY-91: Integration tests for chat-thread endpoints in tools.ts.
 * Uses Express Router mounted on a real HTTP server to test full request/response cycle.
 *
 * Round 3: Updated for options object API + new POST /create endpoint tests.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type {
	ChatThreadContext,
	ChatThreadCreator,
	ChatThreadResult,
} from "../ChatThreadCreator.js";
import { createQueryRouter, type QueryRouterOptions } from "../tools.js";

// Mock @linear/sdk at module level — dynamic import() in tools.ts will use this.
// Individual tests configure the mock behavior via mockIssue/mockSearchNodes.
let mockIssue: ((id: string) => unknown) | undefined;
let mockSearchNodes: unknown[] | undefined;

vi.mock("@linear/sdk", () => ({
	LinearClient: class {
		async issue(id: string) {
			if (mockIssue) return mockIssue(id);
			return { id, identifier: "FLY-91", title: "Chat thread feature" };
		}
		async searchIssues(_term: string) {
			return {
				nodes: mockSearchNodes ?? [
					{
						id: "uuid-fly-91",
						identifier: "FLY-91",
						title: "Chat thread feature",
					},
				],
			};
		}
	},
}));

const TEST_PROJECT: ProjectEntry = {
	projectName: "TestProject",
	projectRoot: "/tmp/test",
	leads: [
		{
			agentId: "lead-alpha",
			chatChannel: "ch-100",
			match: { labels: ["alpha"] },
			botToken: "lead-token-alpha",
		},
		{
			agentId: "lead-beta",
			chatChannel: "ch-200",
			match: { labels: ["beta"] },
			// no botToken — should fall back to global
		},
	],
};

/** Minimal HTTP client for test requests to our Express server. */
async function request(
	server: Server,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: unknown }> {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("Server not bound");
	const url = `http://127.0.0.1:${addr.port}${path}`;
	const res = await fetch(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json();
	return { status: res.status, body: json };
}

/** Creates a fake ChatThreadCreator for test injection. */
function createFakeCreator(
	impl: (ctx: ChatThreadContext) => Promise<ChatThreadResult>,
): ChatThreadCreator {
	return { ensureChatThread: impl } as ChatThreadCreator;
}

describe("chat-thread routes (tools.ts)", () => {
	let store: StateStore;
	let server: Server;

	function createTestServer(opts: QueryRouterOptions) {
		const app = express();
		app.use(express.json());
		app.use("/api", createQueryRouter(store, [TEST_PROJECT], opts));
		server = createServer(app);
		server.listen(0);
		return server;
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		if (server) server.close();
		mockIssue = undefined;
		mockSearchNodes = undefined;
	});

	// ─── Feature flag OFF ───────────────────────────────────────────

	describe("feature flag OFF", () => {
		beforeEach(() => {
			createTestServer({ chatThreadsEnabled: false });
		});

		it("POST /api/chat-threads/register returns 404 when disabled", async () => {
			const res = await request(server, "POST", "/api/chat-threads/register", {
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-1",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(404);
		});

		it("POST /api/chat-threads/create returns 404 when disabled", async () => {
			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "issue-1",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(404);
		});

		it("GET /api/chat-threads returns 404 when disabled", async () => {
			const res = await request(
				server,
				"GET",
				"/api/chat-threads?issueId=issue-1&channelId=ch-100",
			);
			expect(res.status).toBe(404);
		});
	});

	// ─── Existing register + GET endpoints (flag ON) ───────────────

	describe("register + GET (flag ON)", () => {
		beforeEach(() => {
			createTestServer({ chatThreadsEnabled: true });
		});

		it("POST /api/chat-threads/register returns 400 for missing fields", async () => {
			const res = await request(server, "POST", "/api/chat-threads/register", {
				threadId: "t-1",
			});
			expect(res.status).toBe(400);
		});

		it("POST /api/chat-threads/register returns 503 when LINEAR_API_KEY not set", async () => {
			const orig = process.env.LINEAR_API_KEY;
			delete process.env.LINEAR_API_KEY;
			try {
				const res = await request(
					server,
					"POST",
					"/api/chat-threads/register",
					{
						threadId: "t-1",
						channelId: "ch-100",
						issueId: "issue-1",
						leadId: "lead-alpha",
						projectName: "TestProject",
					},
				);
				expect(res.status).toBe(503);
			} finally {
				if (orig) process.env.LINEAR_API_KEY = orig;
			}
		});

		it("GET /api/chat-threads returns 400 for missing query params", async () => {
			const res = await request(
				server,
				"GET",
				"/api/chat-threads?issueId=&channelId=",
			);
			expect(res.status).toBe(400);
		});

		it("GET /api/chat-threads returns null threadId when none registered", async () => {
			const res = await request(
				server,
				"GET",
				"/api/chat-threads?issueId=issue-1&channelId=ch-100",
			);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ threadId: null });
		});

		it("GET /api/chat-threads returns registered threadId", async () => {
			store.upsertChatThread("t-1", "ch-100", "issue-1", "lead-alpha");
			const res = await request(
				server,
				"GET",
				"/api/chat-threads?issueId=issue-1&channelId=ch-100",
			);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ threadId: "t-1" });
		});
	});

	// ─── POST /api/chat-threads/create (Round 3) ───────────────────

	describe("POST /api/chat-threads/create", () => {
		it("returns 400 when neither issueId nor issueIdentifier provided", async () => {
			const creator = createFakeCreator(async () => ({
				created: true,
				threadId: "t-new",
			}));
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/create", {
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(400);
		});

		it("returns 404 for unknown project (via validateChatThreadParams)", async () => {
			const creator = createFakeCreator(async () => ({
				created: true,
				threadId: "t-new",
			}));
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-1",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "NonExistent",
			});
			expect(res.status).toBe(404);
		});

		it("returns 503 when no bot token available", async () => {
			const creator = createFakeCreator(async () => ({
				created: true,
				threadId: "t-new",
			}));
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-91",
				channelId: "ch-200",
				leadId: "lead-beta",
				projectName: "TestProject",
			});
			expect(res.status).toBe(503);
			expect((res.body as { error: string }).error).toContain("bot token");
		});

		it("returns 503 when LINEAR_API_KEY not configured", async () => {
			const creator = createFakeCreator(async () => ({
				created: true,
				threadId: "t-new",
			}));
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});

			const orig = process.env.LINEAR_API_KEY;
			delete process.env.LINEAR_API_KEY;
			try {
				const res = await request(server, "POST", "/api/chat-threads/create", {
					issueId: "uuid-1",
					channelId: "ch-100",
					leadId: "lead-alpha",
					projectName: "TestProject",
				});
				expect(res.status).toBe(503);
				expect((res.body as { error: string }).error).toContain(
					"LINEAR_API_KEY",
				);
			} finally {
				if (orig) process.env.LINEAR_API_KEY = orig;
			}
		});

		it("returns 503 when chatThreadCreator not initialized", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				globalBotToken: "global-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(503);
			expect((res.body as { error: string }).error).toContain(
				"ChatThreadCreator",
			);
		});

		it("happy path (issueId) — new thread created", async () => {
			const capturedCtx: ChatThreadContext[] = [];
			const creator = createFakeCreator(async (ctx) => {
				capturedCtx.push(ctx);
				return { created: true, threadId: "t-new-1" };
			});
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ threadId: "t-new-1", created: true });

			expect(capturedCtx).toHaveLength(1);
			expect(capturedCtx[0].issueId).toBe("uuid-fly-91");
			expect(capturedCtx[0].chatChannelId).toBe("ch-100");
			expect(capturedCtx[0].botToken).toBe("lead-token-alpha");
		});

		it("happy path (issueId) — existing thread returned", async () => {
			const creator = createFakeCreator(async () => ({
				created: false,
				threadId: "t-existing",
			}));
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ threadId: "t-existing", created: false });
		});

		it("happy path (issueIdentifier) — resolve + create", async () => {
			const capturedCtx: ChatThreadContext[] = [];
			const creator = createFakeCreator(async (ctx) => {
				capturedCtx.push(ctx);
				return { created: true, threadId: "t-resolved" };
			});
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueIdentifier: "FLY-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ threadId: "t-resolved", created: true });

			expect(capturedCtx[0].issueId).toBe("uuid-fly-91");
			expect(capturedCtx[0].issueIdentifier).toBe("FLY-91");
		});

		it("issueIdentifier fuzzy match but no exact match returns 404", async () => {
			const creator = createFakeCreator(async () => ({
				created: true,
				threadId: "t-new",
			}));
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});
			// searchIssues("FLY-9") returns FLY-91 (fuzzy) but not FLY-9 (exact)
			mockSearchNodes = [
				{ id: "uuid-fly-91", identifier: "FLY-91", title: "Thread feature" },
			];
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueIdentifier: "FLY-9",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(404);
			expect((res.body as { error: string }).error).toContain("FLY-9");
		});

		it("returns 502 when ChatThreadCreator returns error", async () => {
			const creator = createFakeCreator(async () => ({
				created: false,
				error: "Discord 500: Internal Server Error",
			}));
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(502);
			expect((res.body as { error: string }).error).toContain("Discord 500");
		});

		it("returns 502 when ChatThreadCreator throws", async () => {
			const creator = createFakeCreator(async () => {
				throw new Error("Unexpected network failure");
			});
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(502);
			expect((res.body as { error: string }).error).toContain(
				"Unexpected network failure",
			);
		});

		it("per-lead token fallback to global", async () => {
			const capturedCtx: ChatThreadContext[] = [];
			const creator = createFakeCreator(async (ctx) => {
				capturedCtx.push(ctx);
				return { created: true, threadId: "t-global" };
			});
			createTestServer({
				chatThreadsEnabled: true,
				chatThreadCreator: creator,
				globalBotToken: "global-fallback-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-91",
				channelId: "ch-200",
				leadId: "lead-beta",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect(capturedCtx[0].botToken).toBe("global-fallback-token");
		});
	});
});
