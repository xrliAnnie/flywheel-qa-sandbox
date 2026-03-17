import type { ExecutionContext, LLMClient } from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import { HaikuTriageAgent } from "../decision/HaikuTriageAgent.js";

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
	return {
		issueId: "issue-1",
		issueIdentifier: "GEO-95",
		issueTitle: "Fix bug",
		labels: [],
		projectId: "proj-1",
		exitReason: "completed",
		baseSha: "abc123",
		commitCount: 2,
		commitMessages: ["fix: thing"],
		changedFilePaths: ["src/a.ts"],
		filesChangedCount: 1,
		linesAdded: 10,
		linesRemoved: 5,
		diffSummary: "diff content here",
		headSha: "def456",
		durationMs: 120_000,
		consecutiveFailures: 0,
		partial: false,
		...overrides,
	};
}

function makeMockClient(response: string): LLMClient {
	return {
		chat: vi.fn().mockResolvedValue({ content: response }),
	};
}

describe("HaikuTriageAgent", () => {
	it("valid auto_approve response parses correctly", async () => {
		const client = makeMockClient(
			JSON.stringify({
				route: "auto_approve",
				confidence: 0.95,
				reasoning: "Clean change",
				concerns: [],
			}),
		);
		const agent = new HaikuTriageAgent(client, "haiku", 2000);

		const result = await agent.triage(makeCtx());

		expect(result.route).toBe("auto_approve");
		expect(result.confidence).toBe(0.95);
		expect(result.decisionSource).toBe("haiku_triage");
	});

	it("valid needs_review response parses correctly", async () => {
		const client = makeMockClient(
			JSON.stringify({
				route: "needs_review",
				confidence: 0.7,
				reasoning: "Large change",
				concerns: ["scope unclear"],
			}),
		);
		const agent = new HaikuTriageAgent(client, "haiku", 2000);

		const result = await agent.triage(makeCtx());

		expect(result.route).toBe("needs_review");
		expect(result.concerns).toEqual(["scope unclear"]);
	});

	it("valid blocked response parses correctly", async () => {
		const client = makeMockClient(
			JSON.stringify({
				route: "blocked",
				confidence: 0.9,
				reasoning: "No commits",
				concerns: ["nothing done"],
			}),
		);
		const agent = new HaikuTriageAgent(client, "haiku", 2000);

		const result = await agent.triage(makeCtx());

		expect(result.route).toBe("blocked");
	});

	it("invalid JSON → throws (DecisionLayer catches and falls back)", async () => {
		const client = makeMockClient("This is not JSON at all");
		const agent = new HaikuTriageAgent(client, "haiku", 2000);

		await expect(agent.triage(makeCtx())).rejects.toThrow(
			"Failed to parse LLM triage response",
		);
	});

	it("unknown route → needs_review fallback", async () => {
		const client = makeMockClient(
			JSON.stringify({
				route: "invalid_route",
				confidence: 0.5,
				reasoning: "test",
				concerns: [],
			}),
		);
		const agent = new HaikuTriageAgent(client, "haiku", 2000);

		const result = await agent.triage(makeCtx());

		expect(result.route).toBe("needs_review");
	});

	it("LLM throws → propagates (not caught here)", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockRejectedValue(new Error("API error")),
		};
		const agent = new HaikuTriageAgent(client, "haiku", 2000);

		await expect(agent.triage(makeCtx())).rejects.toThrow("API error");
	});

	it("diff truncated to maxDiffChars", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					route: "auto_approve",
					confidence: 0.9,
					reasoning: "ok",
					concerns: [],
				}),
			}),
		};
		const agent = new HaikuTriageAgent(client, "haiku", 50);
		const longDiff = "x".repeat(200);

		await agent.triage(makeCtx({ diffSummary: longDiff }));

		const prompt = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
			.messages[0].content;
		expect(prompt).not.toContain("x".repeat(200));
		expect(prompt).toContain("x".repeat(50));
	});

	it("prompt includes issue context fields", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					route: "auto_approve",
					confidence: 0.9,
					reasoning: "ok",
					concerns: [],
				}),
			}),
		};
		const agent = new HaikuTriageAgent(client, "haiku", 2000);

		await agent.triage(
			makeCtx({ issueIdentifier: "GEO-99", issueTitle: "My Issue" }),
		);

		const prompt = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
			.messages[0].content;
		expect(prompt).toContain("GEO-99");
		expect(prompt).toContain("My Issue");
	});
});
