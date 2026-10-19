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
		{
			// FLY-369: a second lead used to verify the archive endpoint resolves
			// the bot token from the THREAD's recorded lead_id, not the caller's.
			agentId: "lead-gamma",
			chatChannel: "ch-100",
			match: { labels: ["gamma"] },
			botToken: "lead-token-gamma",
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
	backfillImpl: (
		ctx: ChatThreadContext,
		threadId: string,
	) => Promise<void> = async () => {},
): ChatThreadCreator {
	return {
		ensureChatThread: impl,
		backfillThreadName: backfillImpl,
	} as ChatThreadCreator;
}

describe("chat-thread routes (tools.ts)", () => {
	let store: StateStore;
	let server: Server;

	function createTestServer(opts: QueryRouterOptions) {
		const app = express();
		app.use(express.json());
		app.use(
			"/api",
			createQueryRouter(store, [TEST_PROJECT], {
				apiTokenConfigured: true,
				...opts,
			}),
		);
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

	// ─── Automatic creation OFF; manual capability remains available ─

	describe("automatic creation disabled", () => {
		it("POST /api/chat-threads/register fails closed without an API token", async () => {
			createTestServer({
				chatThreadsEnabled: false,
				apiTokenConfigured: false,
			});
			const res = await request(server, "POST", "/api/chat-threads/register", {
				threadId: "t-1",
				channelId: "ch-100",
				issueId: "issue-1",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(503);
			expect((res.body as { error: string }).error).toMatch(
				/TEAMLEAD_API_TOKEN/,
			);
		});

		it("POST /api/chat-threads/create works when automatic creation is disabled", async () => {
			const ensure = vi.fn(async () => ({
				created: true,
				threadId: "t-manual",
			}));
			createTestServer({
				chatThreadsEnabled: false,
				chatThreadCreator: createFakeCreator(ensure),
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
			expect(res.body).toEqual({ threadId: "t-manual", created: true });
			expect(ensure).toHaveBeenCalledOnce();
		});

		it("POST /api/chat-threads/create fails closed without an API token", async () => {
			const ensure = vi.fn(async () => ({
				created: true,
				threadId: "never",
			}));
			createTestServer({
				chatThreadsEnabled: false,
				apiTokenConfigured: false,
				chatThreadCreator: createFakeCreator(ensure),
			});

			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueIdentifier: "FLY-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});

			expect(res.status).toBe(503);
			expect((res.body as { error: string }).error).toMatch(
				/TEAMLEAD_API_TOKEN/,
			);
			expect(ensure).not.toHaveBeenCalled();
		});

		it("GET /api/chat-threads resolves a row when automatic creation is disabled", async () => {
			store.upsertChatThread("t-manual", "ch-100", "FLY-91", "lead-alpha");
			createTestServer({ chatThreadsEnabled: false });
			const res = await request(
				server,
				"GET",
				"/api/chat-threads?issueId=FLY-91&channelId=ch-100",
			);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ threadId: "t-manual" });
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
			// FLY-270: thread key is canonicalized to the identifier (matches the
			// run-start thread; no session in this test → falls back to identifier).
			expect(capturedCtx[0].issueId).toBe("FLY-91");
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

			// FLY-270: thread key is canonicalized to the identifier (matches the
			// run-start thread; no session in this test → falls back to identifier).
			expect(capturedCtx[0].issueId).toBe("FLY-91");
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

	// ─── POST /api/chat-threads/send (FLY-162 P2) ─────────────────
	//
	// Plan §4.1 + AC1–AC4 + AC13. Validates:
	//   • feature flag (`replyByIssueEnabled`) gate
	//   • param validation (incl. issueId/issueIdentifier mismatch)
	//   • lookup-first (existing row reused, ensureChatThread NOT called)
	//   • ensure-on-miss (ensureChatThread called exactly once on first send)
	//   • split + sequential post (mock fetch for Discord)
	//   • allowed_mentions: { parse: [] } on every chunk
	//   • fail-fast 502 envelope with failedChunkIndex + remainingText

	describe("POST /api/chat-threads/send (FLY-162)", () => {
		// `mockFetch` is an injectable fetch mock passed via
		// QueryRouterOptions.discordFetch — keeps it isolated from the global
		// fetch the test `request()` helper uses to hit the test server.
		let mockFetch: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			mockFetch = vi.fn();
		});

		it("returns 404 when replyByIssueEnabled is false", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: false,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).toBe(404);
			expect((res.body as { error: string }).error).toMatch(
				/reply.by_issue not enabled/i,
			);
		});

		it("sends to an existing thread when automatic creation is disabled", async () => {
			store.upsertChatThread("t-manual", "ch-100", "FLY-147", "lead-alpha");
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "msg-manual" }),
			});
			createTestServer({
				chatThreadsEnabled: false,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "FLY-147",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "manual path",
			});
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				threadId: "t-manual",
				messageIds: ["msg-manual"],
				created: false,
			});
		});

		it("returns 400 when neither issueId nor issueIdentifier provided", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).toBe(400);
		});

		it("returns 400 when text is missing", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(400);
		});

		it("returns 404 for unknown project (validateChatThreadParams 404)", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "NoSuchProject",
				text: "hello",
			});
			expect(res.status).toBe(404);
		});

		it("returns 403 when lead not configured for project", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-100",
				leadId: "lead-unknown",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).toBe(403);
		});

		it("returns 400 when channel does not match lead.chatChannel", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-999",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).toBe(400);
		});

		it("returns 400 when issueId and issueIdentifier mismatch (Codex R2 #3)", async () => {
			mockIssue = (id: string) => ({
				id,
				identifier: "FLY-999", // different from what caller will pass
				title: "Mismatch test",
			});

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});
			process.env.LINEAR_API_KEY = "test-key";

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				issueIdentifier: "FLY-162",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).toBe(400);
			expect((res.body as { error: string }).error).toMatch(/mismatch/i);
		});

		it("happy path REUSE: row exists → ensureChatThread NOT called, posts to thread, returns created=false (AC1)", async () => {
			// Pre-seed the row so lookup hits
			store.upsertChatThread("t-reuse", "ch-100", "uuid-fly-162", "lead-alpha");

			const ensureCalls: ChatThreadContext[] = [];
			const creator = createFakeCreator(async (ctx) => {
				ensureCalls.push(ctx);
				return { created: false, threadId: "should-not-be-called" };
			});

			// Mock Discord POST chunk
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "msg-r1" }),
			});

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "reuse text",
			});
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				threadId: "t-reuse",
				messageIds: ["msg-r1"],
				created: false,
			});

			// AC1: ensureChatThread MUST NOT be called on the reuse path
			expect(ensureCalls).toHaveLength(0);

			// allowed_mentions on the chunk POST
			const [postUrl, postOpts] = mockFetch.mock.calls[0]!;
			expect(postUrl).toBe(
				"https://discord.com/api/v10/channels/t-reuse/messages",
			);
			const body = JSON.parse((postOpts as RequestInit).body as string);
			expect(body.content).toBe("reuse text");
			expect(body.allowed_mentions).toEqual({ parse: [] });
		});

		it("FLY-509: /send backfills an existing thread row with the resolved issue title", async () => {
			store.upsertChatThread(
				"t-existing-title",
				"ch-100",
				"FLY-91",
				"lead-alpha",
			);

			const ensureCalls: ChatThreadContext[] = [];
			const backfillCalls: Array<{
				ctx: ChatThreadContext;
				threadId: string;
			}> = [];
			const creator = createFakeCreator(
				async (ctx) => {
					ensureCalls.push(ctx);
					return { created: false, threadId: "should-not-be-called" };
				},
				async (ctx, threadId) => {
					backfillCalls.push({ ctx, threadId });
				},
			);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "msg-r-title" }),
			});
			process.env.LINEAR_API_KEY = "test-key";

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueIdentifier: "FLY-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "reuse with title",
			});

			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				threadId: "t-existing-title",
				messageIds: ["msg-r-title"],
				created: false,
			});
			expect(ensureCalls).toHaveLength(0);
			expect(backfillCalls).toHaveLength(1);
			expect(backfillCalls[0].threadId).toBe("t-existing-title");
			expect(backfillCalls[0].ctx.issueId).toBe("FLY-91");
			expect(backfillCalls[0].ctx.issueIdentifier).toBe("FLY-91");
			expect(backfillCalls[0].ctx.issueTitle).toBe("Chat thread feature");
		});

		it("FLY-270: bare Linear-UUID issueId is NOT reused as an orphan — goes Linear + canonicalizes to identifier (Codex code-review #1)", async () => {
			const realUuid = "adc32120-f260-42e0-90b8-968e55666e28";
			// Pre-seed a UUID-keyed orphan row (a pre-fix duplicate). The gate must
			// NOT serve this; it must canonicalize to the identifier-keyed thread.
			store.upsertChatThread("t-orphan-uuid", "ch-100", realUuid, "lead-alpha");

			const ensureCalls: ChatThreadContext[] = [];
			const creator = createFakeCreator(async (ctx) => {
				ensureCalls.push(ctx);
				return { created: true, threadId: "t-canonical" };
			});
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "msg-u1" }),
			});
			process.env.LINEAR_API_KEY = "test-key";

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: realUuid,
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "uuid send",
			});
			expect(res.status).toBe(200);
			// Did NOT serve the orphan; created the canonical identifier-keyed thread.
			expect(res.body).toEqual({
				threadId: "t-canonical",
				messageIds: ["msg-u1"],
				created: true,
			});
			expect(ensureCalls).toHaveLength(1);
			expect(ensureCalls[0].issueId).toBe("FLY-91");
		});

		it("happy path FIRST-SEND: row missing → ensureChatThread called once, then chunk posted (AC2)", async () => {
			const ensureCalls: ChatThreadContext[] = [];
			const creator = createFakeCreator(async (ctx) => {
				ensureCalls.push(ctx);
				// Simulate ensure: insert row so subsequent code sees it
				store.upsertChatThread(
					"t-fresh",
					ctx.chatChannelId,
					ctx.issueId,
					ctx.leadId,
				);
				return { created: true, threadId: "t-fresh" };
			});
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "msg-f1" }),
			});
			process.env.LINEAR_API_KEY = "test-key";

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				chatThreadCreator: creator,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueIdentifier: "FLY-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "first send",
			});
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				threadId: "t-fresh",
				messageIds: ["msg-f1"],
				created: true,
			});
			expect(ensureCalls).toHaveLength(1);
			// FLY-270: /send canonicalizes the thread key to the identifier (so it
			// reuses the run-start thread, not a UUID-keyed duplicate).
			expect(ensureCalls[0].issueId).toBe("FLY-91");
			expect(ensureCalls[0].issueTitle).toBe("Chat thread feature");
		});

		it("returns 503 when no bot token available", async () => {
			store.upsertChatThread("t-1", "ch-200", "uuid-fly-162", "lead-beta");

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				// no globalBotToken; lead-beta has no per-lead token either
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-200",
				leadId: "lead-beta",
				projectName: "TestProject",
				text: "needs token",
			});
			expect(res.status).toBe(503);
			expect((res.body as { error: string }).error).toMatch(/bot token/i);
		});

		it("split long text: posts ≥2 chunks, allowed_mentions on each (AC4)", async () => {
			// Build text > MAX_DISCORD_MESSAGE_LENGTH so it splits
			const long = `${"a".repeat(1900)}\n${"b".repeat(500)}`;
			store.upsertChatThread("t-long", "ch-100", "uuid-fly-162", "lead-alpha");

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ id: "msg-c0" }),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ id: "msg-c1" }),
				});

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: long,
			});
			expect(res.status).toBe(200);
			const body = res.body as { messageIds: string[] };
			expect(body.messageIds).toEqual(["msg-c0", "msg-c1"]);

			// allowed_mentions on every POST
			for (const call of mockFetch.mock.calls) {
				const parsed = JSON.parse((call[1] as RequestInit).body as string);
				expect(parsed.allowed_mentions).toEqual({ parse: [] });
			}
		});

		it("partial fail mid-stream: returns 502 with failedChunkIndex + remainingText (AC4)", async () => {
			// 3-chunk text
			const long = `${"a".repeat(1900)}\n${"b".repeat(1900)}\n${"c".repeat(
				500,
			)}`;
			store.upsertChatThread(
				"t-partial",
				"ch-100",
				"uuid-fly-162",
				"lead-alpha",
			);

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ id: "msg-p0" }),
				})
				.mockResolvedValueOnce({
					ok: false,
					status: 429,
					text: () => Promise.resolve("rate limited"),
				});
			// 3rd POST must NOT happen — fail-fast.

			createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				discordFetch: mockFetch,
				globalBotToken: "global-token",
			});

			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-162",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: long,
			});
			expect(res.status).toBe(502);
			const body = res.body as Record<string, unknown>;
			expect(body.threadId).toBe("t-partial");
			expect(body.messageIds).toEqual(["msg-p0"]);
			expect(body.chunksSent).toBe(1);
			expect(body.chunksTotal).toBe(3);
			expect(body.failedChunkIndex).toBe(1);
			expect(typeof body.remainingText).toBe("string");
			expect((body.remainingText as string).length).toBeGreaterThan(0);
			// Fail-fast — only 2 fetches issued
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});
	});

	// ─── GET /api/chat-threads/by-thread/:threadId (FLY-162 P3) ───
	//
	// Plan §4.1 + AC5–AC8. Validates:
	//   • feature flag (gated on `chatThreadsEnabled`, NOT
	//     `replyByIssueEnabled` — inbound enrich useful even when
	//     outbound disabled, per AC7)
	//   • happy path with session enrichment
	//   • happy path without session row (identifier/title/project null)
	//   • 404 when thread not registered
	//   • does NOT call Linear (pure local lookup)

	describe("GET /api/chat-threads/by-thread/:threadId (FLY-162)", () => {
		it("resolves a row when automatic creation is disabled", async () => {
			store.upsertChatThread("t-x", "ch-100", "FLY-147", "lead-alpha");
			createTestServer({
				chatThreadsEnabled: false,
			});
			const res = await request(
				server,
				"GET",
				"/api/chat-threads/by-thread/t-x",
			);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				threadId: "t-x",
				channelId: "ch-100",
				issueId: "FLY-147",
				issueIdentifier: null,
				issueTitle: null,
				projectName: null,
			});
		});

		it("returns 404 when thread not registered (AC6)", async () => {
			createTestServer({
				chatThreadsEnabled: true,
			});
			const res = await request(
				server,
				"GET",
				"/api/chat-threads/by-thread/t-unknown",
			);
			expect(res.status).toBe(404);
			expect((res.body as { error: string }).error).toMatch(/not registered/i);
		});

		it("happy path WITHOUT session row: returns null enrichment fields (AC5)", async () => {
			store.upsertChatThread(
				"t-bare",
				"ch-100",
				"uuid-no-session",
				"lead-alpha",
			);
			createTestServer({
				chatThreadsEnabled: true,
			});

			const res = await request(
				server,
				"GET",
				"/api/chat-threads/by-thread/t-bare",
			);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				threadId: "t-bare",
				channelId: "ch-100",
				issueId: "uuid-no-session",
				issueIdentifier: null,
				issueTitle: null,
				projectName: null,
			});
		});

		it("happy path WITH session row: returns identifier/title/projectName (AC5)", async () => {
			store.upsertChatThread(
				"t-rich",
				"ch-100",
				"uuid-fly-162-enriched",
				"lead-alpha",
			);
			// Seed a session row so getSessionByIssue enriches
			store.upsertSession({
				execution_id: "exec-rich",
				issue_id: "uuid-fly-162-enriched",
				project_name: "TestProject",
				status: "running",
				issue_identifier: "FLY-162",
				issue_title: "Enriched session",
				last_activity_at: new Date().toISOString(),
			});

			createTestServer({
				chatThreadsEnabled: true,
			});

			const res = await request(
				server,
				"GET",
				"/api/chat-threads/by-thread/t-rich",
			);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				threadId: "t-rich",
				channelId: "ch-100",
				issueId: "uuid-fly-162-enriched",
				issueIdentifier: "FLY-162",
				issueTitle: "Enriched session",
				projectName: "TestProject",
			});
		});

		it("does NOT call Linear (AC8 — pure local lookup)", async () => {
			// Use the existing test class's `searchIssues`/`issue` mocks by setting them.
			// If the route called Linear, mockIssue would be invoked; assert it isn't.
			let issueCalled = false;
			mockIssue = (id: string) => {
				issueCalled = true;
				return { id, identifier: "FLY-162", title: "Should not be called" };
			};
			store.upsertChatThread("t-local", "ch-100", "uuid-local", "lead-alpha");
			createTestServer({
				chatThreadsEnabled: true,
			});

			const res = await request(
				server,
				"GET",
				"/api/chat-threads/by-thread/t-local",
			);
			expect(res.status).toBe(200);
			expect(issueCalled).toBe(false);
		});
	});

	// ── FLY-369: POST /api/chat-threads/archive (on-demand archive) ──
	describe("POST /api/chat-threads/archive (FLY-369)", () => {
		let mockFetch: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			// Discord PATCH archive → 200 { archived: true }
			mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => ({ archived: true }),
				text: async () => "",
			});
		});

		it("archives a registered thread when automatic creation is disabled", async () => {
			store.upsertChatThread("t-manual", "ch-100", "FLY-91", "lead-alpha");
			createTestServer({
				chatThreadsEnabled: false,
				apiTokenConfigured: true,
				discordFetch: mockFetch,
			});
			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueId: "FLY-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				threadId: "t-manual",
				archived: true,
			});
			expect(mockFetch).toHaveBeenCalledOnce();
		});

		it("fails closed with 503 when no API token is configured", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				apiTokenConfigured: false,
				discordFetch: mockFetch,
			});
			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueIdentifier: "FLY-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(503);
			expect((res.body as { error: string }).error).toMatch(
				/TEAMLEAD_API_TOKEN/,
			);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("returns 400 when no issue handle is provided", async () => {
			createTestServer({ chatThreadsEnabled: true, apiTokenConfigured: true });
			const res = await request(server, "POST", "/api/chat-threads/archive", {
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(400);
		});

		it("returns 403 when the lead is not configured for the project", async () => {
			createTestServer({ chatThreadsEnabled: true, apiTokenConfigured: true });
			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueIdentifier: "FLY-91",
				channelId: "ch-100",
				leadId: "nope",
				projectName: "TestProject",
			});
			expect(res.status).toBe(403);
		});

		it("identifier-only canonicalizes through the session to a non-identifier-keyed thread", async () => {
			// Thread stored under issue_id (UUID), session maps FLY-91 → that UUID.
			store.upsertSession({
				execution_id: "exec-1",
				issue_id: "uuid-abc",
				issue_identifier: "FLY-91",
				project_name: "TestProject",
				status: "completed",
			});
			store.upsertChatThread("t-id", "ch-100", "uuid-abc", "lead-alpha");
			createTestServer({
				chatThreadsEnabled: true,
				apiTokenConfigured: true,
				discordFetch: mockFetch,
			});

			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueIdentifier: "FLY-91",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect((res.body as { archived: boolean }).archived).toBe(true);
			expect((res.body as { threadId: string }).threadId).toBe("t-id");
			// marked archived (archive-once record)
			expect(
				store.getChatThreadByIssue("uuid-abc", "ch-100")?.archived_at,
			).toBeTruthy();
			// archived via the bot token (per-lead), as a PATCH
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/channels/t-id"),
				expect.objectContaining({ method: "PATCH" }),
			);
		});

		it("uuid-only archives a uuid-keyed thread directly (no Linear)", async () => {
			store.upsertChatThread(
				"t-uuid",
				"ch-100",
				"11111111-2222-3333-4444-555555555555",
				"lead-alpha",
			);
			createTestServer({
				chatThreadsEnabled: true,
				apiTokenConfigured: true,
				discordFetch: mockFetch,
			});
			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueId: "11111111-2222-3333-4444-555555555555",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect((res.body as { archived: boolean }).archived).toBe(true);
		});

		it("archives with the THREAD's recorded lead token, not the caller's (Codex R1 #1)", async () => {
			// Thread recorded under lead-gamma; caller is lead-alpha (both on ch-100).
			store.upsertSession({
				execution_id: "exec-z",
				issue_id: "uuid-z",
				issue_identifier: "FLY-77",
				project_name: "TestProject",
				status: "completed",
			});
			store.upsertChatThread("t-gamma", "ch-100", "uuid-z", "lead-gamma");
			createTestServer({
				chatThreadsEnabled: true,
				apiTokenConfigured: true,
				discordFetch: mockFetch,
			});

			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueIdentifier: "FLY-77",
				channelId: "ch-100",
				leadId: "lead-alpha", // caller
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect((res.body as { archived: boolean }).archived).toBe(true);
			// The Discord PATCH used the THREAD owner's token (lead-gamma), not the caller's.
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/channels/t-gamma"),
				expect.objectContaining({
					method: "PATCH",
					headers: expect.objectContaining({
						Authorization: "Bot lead-token-gamma",
					}),
				}),
			);
		});

		it("returns 400 on issueId/issueIdentifier mismatch (Linear cross-check)", async () => {
			const orig = process.env.LINEAR_API_KEY;
			process.env.LINEAR_API_KEY = "test-key";
			mockIssue = (id: string) => ({ id, identifier: "FLY-91" });
			try {
				createTestServer({
					chatThreadsEnabled: true,
					apiTokenConfigured: true,
					discordFetch: mockFetch,
				});
				const res = await request(server, "POST", "/api/chat-threads/archive", {
					issueId: "uuid-fly-91",
					issueIdentifier: "FLY-OTHER",
					channelId: "ch-100",
					leadId: "lead-alpha",
					projectName: "TestProject",
				});
				expect(res.status).toBe(400);
				expect((res.body as { error: string }).error).toMatch(/mismatch/i);
			} finally {
				if (orig) process.env.LINEAR_API_KEY = orig;
				else delete process.env.LINEAR_API_KEY;
			}
		});

		it("returns 404 when no chat thread exists for the issue", async () => {
			createTestServer({
				chatThreadsEnabled: true,
				apiTokenConfigured: true,
				discordFetch: mockFetch,
			});
			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueIdentifier: "FLY-404",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(404);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("archive-once: already-archived thread is a no-op (respects a Discord re-open)", async () => {
			store.upsertChatThread("t-arch", "ch-100", "FLY-77b", "lead-alpha");
			store.markChatThreadArchived("t-arch");
			createTestServer({
				chatThreadsEnabled: true,
				apiTokenConfigured: true,
				discordFetch: mockFetch,
			});
			const res = await request(server, "POST", "/api/chat-threads/archive", {
				issueId: "FLY-77b",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				threadId: "t-arch",
				archived: true,
				reason: "already_archived",
			});
			// no Discord PATCH — we do not re-archive (archive-once)
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	// ─── FLY-927 Task 1.6: alert-channel sender gating ──────────────────────
	describe("FLY-927 alert-channel gating (ticket queue)", () => {
		const saved: Record<string, string | undefined> = {};
		beforeEach(() => {
			for (const k of [
				"FLYWHEEL_ALERT_ROUTING",
				"FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID",
			]) {
				saved[k] = process.env[k];
			}
		});
		afterEach(() => {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		});

		function serverOn() {
			return createTestServer({
				chatThreadsEnabled: true,
				replyByIssueEnabled: true,
				globalBotToken: "global-token",
				chatThreadCreator: createFakeCreator(async () => ({
					created: true,
					threadId: "t-alert-test",
				})),
			});
		}

		it("REFUSES /send targeting the unified alert channel when gating is on", async () => {
			process.env.FLYWHEEL_ALERT_ROUTING = "1";
			process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "ch-100";
			serverOn();
			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-927",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).toBe(403);
			expect((res.body as { error: string }).error).toBe("alert_channel_gated");
		});

		it("REFUSES /create targeting the unified alert channel when gating is on", async () => {
			process.env.FLYWHEEL_ALERT_ROUTING = "1";
			process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "ch-100";
			serverOn();
			const res = await request(server, "POST", "/api/chat-threads/create", {
				issueId: "uuid-fly-927",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
			});
			expect(res.status).toBe(403);
			expect((res.body as { error: string }).error).toBe("alert_channel_gated");
		});

		it("ALLOWS a different channel while gating is on (proceeds past the gate)", async () => {
			process.env.FLYWHEEL_ALERT_ROUTING = "1";
			process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "ch-alert-999";
			serverOn();
			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-927",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).not.toBe(403); // gate not tripped (downstream may fail otherwise)
		});

		it("SENTINEL: env unset → alert-channel sends are NOT gated (byte-compat)", async () => {
			delete process.env.FLYWHEEL_ALERT_ROUTING;
			process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "ch-100";
			serverOn();
			const res = await request(server, "POST", "/api/chat-threads/send", {
				issueId: "uuid-fly-927",
				channelId: "ch-100",
				leadId: "lead-alpha",
				projectName: "TestProject",
				text: "hello",
			});
			expect(res.status).not.toBe(403);
		});
	});
});
