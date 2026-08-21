import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatThreadCreator } from "../bridge/ChatThreadCreator.js";
import {
	postThreadRootMessage,
	startThreadFromMessage,
} from "../bridge/chat-thread-utils.js";
import { StateStore } from "../StateStore.js";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function context(botToken = "token-a") {
	return {
		chatChannelId: "channel-1",
		issueId: "FLY-1927",
		issueIdentifier: "FLY-1927",
		issueTitle: "one issue, one thread",
		botToken,
		leadId: "lead-a",
	};
}

describe("FLY-1927 split Discord create steps", () => {
	it("gives the root post and thread start independent timeout budgets", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			signals.push(init?.signal as AbortSignal);
			return jsonResponse(200, {
				id: signals.length === 1 ? "root-1" : "root-1",
			});
		}) as unknown as typeof fetch;

		await expect(
			postThreadRootMessage(
				{
					channelId: "channel-1",
					messageContent: "hello",
					botToken: "token",
				},
				{ fetchImpl, timeoutMs: 25 },
			),
		).resolves.toEqual({ posted: true, rootMessageId: "root-1" });
		await expect(
			startThreadFromMessage(
				{
					channelId: "channel-1",
					rootMessageId: "root-1",
					threadName: "thread",
					botToken: "token",
				},
				{ fetchImpl, timeoutMs: 25 },
			),
		).resolves.toEqual({
			created: true,
			threadId: "root-1",
			rootMessageId: "root-1",
		});

		expect(signals).toHaveLength(2);
		expect(signals[0]).not.toBe(signals[1]);
	});

	it("preserves rootMessageId when start-from-message times out", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new DOMException("aborted", "AbortError");
		}) as unknown as typeof fetch;

		await expect(
			startThreadFromMessage(
				{
					channelId: "channel-1",
					rootMessageId: "root-1",
					threadName: "thread",
					botToken: "token",
				},
				{ fetchImpl },
			),
		).resolves.toMatchObject({
			created: false,
			error: "timeout",
			rootMessageId: "root-1",
		});
	});
});

describe("FLY-1927 canonical claim", () => {
	it("is an atomic first-writer-wins CAS across two StateStore connections", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1927-store-"));
		const dbPath = join(dir, "state.db");
		const first = await StateStore.create(dbPath);
		const second = await StateStore.create(dbPath);
		try {
			expect(
				first.registerChatThreadConditional(
					"root-a",
					"channel-1",
					"FLY-1927",
					"lead-a",
				),
			).toEqual({ status: "registered", threadId: "root-a" });
			expect(
				second.registerChatThreadConditional(
					"root-b",
					"channel-1",
					"FLY-1927",
					"lead-b",
				),
			).toEqual({ status: "canonical_exists", threadId: "root-a" });
			expect(
				second.getChatThreadByIssue("FLY-1927", "channel-1")?.thread_id,
			).toBe("root-a");
		} finally {
			second.close();
			first.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows replacement only after an explicit fenced missing mark", async () => {
		const store = await StateStore.create(":memory:");
		try {
			expect(
				store.registerChatThreadConditional(
					"root-old",
					"channel-1",
					"FLY-1927",
				),
			).toMatchObject({ status: "registered" });
			expect(
				store.registerChatThreadConditional(
					"root-new",
					"channel-1",
					"FLY-1927",
				),
			).toEqual({ status: "canonical_exists", threadId: "root-old" });

			store.markChatThreadMissing("root-old");
			expect(
				store.registerChatThreadConditional(
					"root-new",
					"channel-1",
					"FLY-1927",
				),
			).toEqual({ status: "registered", threadId: "root-new" });
		} finally {
			store.close();
		}
	});
});

describe("FLY-1927 ChatThreadCreator recovery without a side-table ticket", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	it("adopts the exact root thread after an uncertain start and never posts a second root", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(200, { id: "root-1" }))
			.mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
			.mockResolvedValueOnce(
				jsonResponse(200, { id: "root-1", type: 11, parent_id: "channel-1" }),
			);
		vi.stubGlobal("fetch", fetchImpl);

		const result = await new ChatThreadCreator(store).ensureChatThread(
			context(),
		);

		expect(result).toEqual({ created: true, threadId: "root-1" });
		expect(store.getChatThreadByIssue("FLY-1927", "channel-1")?.thread_id).toBe(
			"root-1",
		);
		expect(
			fetchImpl.mock.calls.filter(
				([url, init]) =>
					url === "https://discord.com/api/v10/channels/channel-1/messages" &&
					(init as RequestInit).method === "POST",
			),
		).toHaveLength(1);
	});

	it("retries start on the same root after a definite failure", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(200, { id: "root-1" }))
			.mockResolvedValueOnce(jsonResponse(500, { message: "busy" }))
			.mockResolvedValueOnce(jsonResponse(404, { message: "missing" }))
			.mockResolvedValueOnce(jsonResponse(200, { id: "root-1" }))
			.mockResolvedValueOnce(jsonResponse(200, { id: "root-1" }));
		vi.stubGlobal("fetch", fetchImpl);

		const result = await new ChatThreadCreator(store).ensureChatThread(
			context(),
		);

		expect(result).toEqual({ created: true, threadId: "root-1" });
		const urls = fetchImpl.mock.calls.map(([url]) => url as string);
		expect(
			urls.filter((url) => url.endsWith("/messages/root-1/threads")),
		).toHaveLength(2);
		expect(urls.filter((url) => url.endsWith("/messages"))).toHaveLength(1);
	});

	it("loudly fails a missing canonical root and never posts a replacement", async () => {
		store.upsertChatThread("root-gone", "channel-1", "FLY-1927", "lead-a");
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(404, { message: "missing thread" }))
			.mockResolvedValueOnce(jsonResponse(404, { message: "missing root" }));
		vi.stubGlobal("fetch", fetchImpl);

		const result = await new ChatThreadCreator(store).ensureChatThread(
			context(),
		);

		expect(result).toMatchObject({
			created: false,
			threadId: "root-gone",
			rootMessageId: "root-gone",
			errorCode: "canonical_root_gone",
		});
		expect(store.getChatThreadByIssue("FLY-1927", "channel-1")?.thread_id).toBe(
			"root-gone",
		);
		expect(
			fetchImpl.mock.calls.some(
				([url, init]) =>
					url === "https://discord.com/api/v10/channels/channel-1/messages" &&
					(init as RequestInit).method === "POST",
			),
		).toBe(false);
	});

	it("resumes a claimed canonical root after restart without posting a new root", async () => {
		store.upsertChatThread("root-resume", "channel-1", "FLY-1927", "lead-a");
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(404, { message: "thread absent" }))
			.mockResolvedValueOnce(jsonResponse(200, { id: "root-resume" }))
			.mockResolvedValueOnce(jsonResponse(200, { id: "root-resume" }));
		vi.stubGlobal("fetch", fetchImpl);

		const result = await new ChatThreadCreator(store).ensureChatThread(
			context(),
		);

		expect(result).toEqual({ created: false, threadId: "root-resume" });
		expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
			"https://discord.com/api/v10/channels/root-resume",
			"https://discord.com/api/v10/channels/channel-1/messages/root-resume",
			"https://discord.com/api/v10/channels/channel-1/messages/root-resume/threads",
		]);
	});

	it("cleans up the fresh root and fails loudly when the canonical claim throws", async () => {
		vi.spyOn(store, "registerChatThreadConditional").mockImplementation(() => {
			throw new Error("SQLITE_BUSY_SNAPSHOT");
		});
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(200, { id: "root-unclaimed" }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchImpl);

		const result = await new ChatThreadCreator(store).ensureChatThread(
			context(),
		);

		expect(result).toMatchObject({
			created: false,
			rootMessageId: "root-unclaimed",
			errorCode: "canonical_claim_failed",
			error: expect.stringContaining("SQLITE_BUSY_SNAPSHOT"),
		});
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"https://discord.com/api/v10/channels/channel-1/messages/root-unclaimed",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("lets only the canonical CAS winner start a thread", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1927-race-"));
		const dbPath = join(dir, "state.db");
		store.close();
		const firstStore = await StateStore.create(dbPath);
		const secondStore = await StateStore.create(dbPath);
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const token = (init?.headers as Record<string, string>)?.Authorization;
			if (method === "POST" && url.endsWith("/messages")) {
				return jsonResponse(200, {
					id: token === "Bot token-a" ? "root-a" : "root-b",
				});
			}
			if (method === "POST" && url.endsWith("/threads")) {
				const root = url.split("/").at(-2);
				return jsonResponse(200, { id: root });
			}
			if (method === "DELETE") return new Response(null, { status: 204 });
			throw new Error(`unexpected Discord call: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", fetchImpl);

		try {
			const [a, b] = await Promise.all([
				new ChatThreadCreator(firstStore).ensureChatThread(context("token-a")),
				new ChatThreadCreator(secondStore).ensureChatThread(context("token-b")),
			]);
			const canonical = firstStore.getChatThreadByIssue(
				"FLY-1927",
				"channel-1",
			)?.thread_id;
			expect(["root-a", "root-b"]).toContain(canonical);
			expect([a.threadId, b.threadId]).toEqual([canonical, canonical]);
			expect(
				fetchImpl.mock.calls.filter(
					([url, init]) =>
						(init as RequestInit).method === "POST" &&
						(url as string).endsWith("/threads"),
				),
			).toHaveLength(1);
			expect(
				fetchImpl.mock.calls.filter(
					([_url, init]) => (init as RequestInit).method === "DELETE",
				),
			).toHaveLength(1);
		} finally {
			secondStore.close();
			firstStore.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
