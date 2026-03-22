import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeDiscordRuntime } from "../bridge/claude-discord-runtime.js";
import type { LeadBootstrap, LeadEventEnvelope } from "../bridge/lead-runtime.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeEnvelope(overrides?: Partial<LeadEventEnvelope>): LeadEventEnvelope {
	return {
		seq: 42,
		event: {
			event_type: "session_completed",
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "GEO-100",
			issue_title: "Fix bug",
			status: "awaiting_review",
			decision_route: "needs_review",
			commit_count: 3,
			lines_added: 100,
			lines_removed: 20,
		},
		sessionKey: "flywheel:GEO-100",
		leadId: "product-lead",
		timestamp: "2026-03-21T10:00:00.000Z",
		...overrides,
	};
}

function makeBootstrap(): LeadBootstrap {
	return {
		leadId: "product-lead",
		activeSessions: [
			{
				executionId: "exec-1",
				issueId: "issue-1",
				issueIdentifier: "GEO-100",
				issueTitle: "Fix login bug",
				projectName: "geoforge3d",
				status: "running",
			},
		],
		pendingDecisions: [
			{
				executionId: "exec-2",
				issueId: "issue-2",
				issueIdentifier: "GEO-101",
				issueTitle: "Add feature",
				projectName: "geoforge3d",
				decisionRoute: "needs_review",
			},
		],
		recentFailures: [],
		recentEvents: [],
		memoryRecall: null,
	};
}

describe("ClaudeDiscordRuntime", () => {
	let runtime: ClaudeDiscordRuntime;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch.mockResolvedValue({ ok: true });
		runtime = new ClaudeDiscordRuntime("ctrl-channel-123", "bot-token-abc");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("has type claude-discord", () => {
		expect(runtime.type).toBe("claude-discord");
	});

	describe("deliver()", () => {
		it("posts formatted message to Discord control channel", async () => {
			await runtime.deliver(makeEnvelope());

			expect(mockFetch).toHaveBeenCalledOnce();
			const [url, opts] = mockFetch.mock.calls[0];
			expect(url).toBe(
				"https://discord.com/api/v10/channels/ctrl-channel-123/messages",
			);
			expect(opts.method).toBe("POST");
			expect(opts.headers.Authorization).toBe("Bot bot-token-abc");
			const body = JSON.parse(opts.body);
			expect(body.content).toContain("[Event #42]");
			expect(body.content).toContain("session_completed");
			expect(body.content).toContain("GEO-100");
		});

		it("updates health tracking after delivery", async () => {
			await runtime.deliver(makeEnvelope({ seq: 99 }));
			const h = await runtime.health();
			expect(h.status).toBe("healthy");
			expect(h.lastDeliveredSeq).toBe(99);
			expect(h.lastDeliveryAt).toBeTruthy();
		});

		it("swallows errors on non-ok response (warn only)", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			mockFetch.mockResolvedValue({
				ok: false,
				status: 429,
				text: () => Promise.resolve("rate limited"),
			});

			// Should not throw
			await runtime.deliver(makeEnvelope());
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it("swallows errors on fetch failure (timeout / network)", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			mockFetch.mockRejectedValue(new Error("abort"));

			await runtime.deliver(makeEnvelope());
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it("includes 3s timeout via AbortController", async () => {
			await runtime.deliver(makeEnvelope());
			const [, opts] = mockFetch.mock.calls[0];
			expect(opts.signal).toBeInstanceOf(AbortSignal);
		});
	});

	describe("sendBootstrap()", () => {
		it("posts formatted bootstrap snapshot", async () => {
			await runtime.sendBootstrap(makeBootstrap());

			expect(mockFetch).toHaveBeenCalled();
			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.content).toContain("Bootstrap");
			expect(body.content).toContain("product-lead");
			expect(body.content).toContain("GEO-100");
			expect(body.content).toContain("Active Sessions");
		});

		it("bootstrap is idempotent — multiple calls produce same content", async () => {
			const snapshot = makeBootstrap();
			await runtime.sendBootstrap(snapshot);
			await runtime.sendBootstrap(snapshot);
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});
	});

	describe("health()", () => {
		it("returns degraded before first delivery", async () => {
			const h = await runtime.health();
			expect(h.status).toBe("degraded");
			expect(h.lastDeliveryAt).toBeNull();
			expect(h.lastDeliveredSeq).toBe(0);
		});
	});

	describe("sendBootstrap() — memoryRecall formatting (GEO-203)", () => {
		it("includes full memoryRecall without truncation", async () => {
			// Create a memoryRecall string > 500 chars
			const longMemory = "### Role-Specific Memory\n" +
				Array.from({ length: 30 }, (_, i) => `- Decision ${i}: This is a moderately long memory entry about project decisions`).join("\n");
			expect(longMemory.length).toBeGreaterThan(500);

			const snapshot = {
				...makeBootstrap(),
				memoryRecall: longMemory,
			};
			await runtime.sendBootstrap(snapshot);

			// Collect all posted content
			const allContent = mockFetch.mock.calls
				.map((call: any[]) => JSON.parse(call[1].body).content)
				.join("");
			// Full memoryRecall should be present (not truncated at 500)
			expect(allContent).toContain("Decision 29");
			expect(allContent).toContain("### Memory Recall");
		});

		it("splits long bootstrap with memoryRecall into multiple Discord messages", async () => {
			// Create content that exceeds 1900 char Discord limit
			const longMemory = Array.from({ length: 50 }, (_, i) =>
				`- Memory entry ${i}: Important context about decisions and architecture patterns`,
			).join("\n");

			const snapshot = {
				...makeBootstrap(),
				memoryRecall: longMemory,
			};
			await runtime.sendBootstrap(snapshot);

			// Should require multiple Discord messages
			expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
		});
	});

	it("shutdown() is a no-op", async () => {
		await runtime.shutdown();
	});
});
