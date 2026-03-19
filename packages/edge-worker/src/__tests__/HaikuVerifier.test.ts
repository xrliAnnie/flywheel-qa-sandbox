import type { ExecutionContext, LLMClient } from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import { HaikuVerifier } from "../decision/HaikuVerifier.js";

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
	return {
		executionId: "test-exec-id",
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
		diffSummary: "diff",
		headSha: "def456",
		durationMs: 120_000,
		consecutiveFailures: 0,
		partial: false,
		...overrides,
	};
}

describe("HaikuVerifier", () => {
	it("approved response with clean checklist", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					approved: true,
					confidence: 0.95,
					concerns: [],
					checklist: {
						matchesIssue: true,
						noObviousBugs: true,
						errorHandling: true,
						noSecrets: true,
						appropriateScope: true,
					},
				}),
			}),
		};
		const verifier = new HaikuVerifier(client, "haiku");

		const result = await verifier.verify(makeCtx(), "full diff here");

		expect(result.approved).toBe(true);
		expect(result.confidence).toBe(0.95);
		expect(result.checklist.matchesIssue).toBe(true);
	});

	it("rejected response with concerns", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					approved: false,
					confidence: 0.3,
					concerns: ["missing error handling"],
					checklist: {
						matchesIssue: true,
						noObviousBugs: true,
						errorHandling: false,
						noSecrets: true,
						appropriateScope: true,
					},
				}),
			}),
		};
		const verifier = new HaikuVerifier(client, "haiku");

		const result = await verifier.verify(makeCtx(), "diff");

		expect(result.approved).toBe(false);
		expect(result.concerns).toContain("missing error handling");
		expect(result.checklist.errorHandling).toBe(false);
	});

	it("invalid JSON → not approved (conservative)", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockResolvedValue({ content: "not json" }),
		};
		const verifier = new HaikuVerifier(client, "haiku");

		const result = await verifier.verify(makeCtx(), "diff");

		expect(result.approved).toBe(false);
		expect(result.confidence).toBe(0);
	});

	it("LLM throws → propagates", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockRejectedValue(new Error("API down")),
		};
		const verifier = new HaikuVerifier(client, "haiku");

		await expect(verifier.verify(makeCtx(), "diff")).rejects.toThrow(
			"API down",
		);
	});

	it("full diff passed to prompt (not truncated)", async () => {
		const client: LLMClient = {
			chat: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					approved: true,
					confidence: 0.9,
					concerns: [],
					checklist: {
						matchesIssue: true,
						noObviousBugs: true,
						errorHandling: true,
						noSecrets: true,
						appropriateScope: true,
					},
				}),
			}),
		};
		const verifier = new HaikuVerifier(client, "haiku");
		const largeDiff = "d".repeat(10_000);

		await verifier.verify(makeCtx(), largeDiff);

		const prompt = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
			.messages[0].content;
		expect(prompt).toContain(largeDiff);
	});
});
