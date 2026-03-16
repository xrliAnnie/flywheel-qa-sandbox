import { describe, it, expect } from "vitest";
import type { ExecutionContext } from "flywheel-core";
import { FallbackHeuristic } from "../decision/FallbackHeuristic.js";

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

describe("FallbackHeuristic", () => {
	const fallback = new FallbackHeuristic();

	it("0 commits → blocked", () => {
		const result = fallback.evaluate(makeCtx({ commitCount: 0 }), "API error");
		expect(result.route).toBe("blocked");
		expect(result.confidence).toBe(0.9);
	});

	it("3 consecutive failures → blocked", () => {
		const result = fallback.evaluate(
			makeCtx({ consecutiveFailures: 3 }),
			"API error",
		);
		expect(result.route).toBe("blocked");
		expect(result.confidence).toBe(0.85);
	});

	it("250 lines added → needs_review", () => {
		const result = fallback.evaluate(
			makeCtx({ linesAdded: 250 }),
			"API error",
		);
		expect(result.route).toBe("needs_review");
		expect(result.confidence).toBe(0.6);
	});

	it("12 files changed → needs_review", () => {
		const result = fallback.evaluate(
			makeCtx({ filesChangedCount: 12 }),
			"API error",
		);
		expect(result.route).toBe("needs_review");
		expect(result.confidence).toBe(0.6);
	});

	it("small clean change → needs_review (default)", () => {
		const result = fallback.evaluate(makeCtx(), "API error");
		expect(result.route).toBe("needs_review");
		expect(result.confidence).toBe(0.5);
	});

	it("never returns auto_approve", () => {
		const scenarios: Partial<ExecutionContext>[] = [
			{},
			{ commitCount: 1, linesAdded: 5, filesChangedCount: 1 },
			{ commitCount: 10, linesAdded: 50, filesChangedCount: 3 },
		];
		for (const ctx of scenarios) {
			const result = fallback.evaluate(makeCtx(ctx), "error");
			expect(result.route).not.toBe("auto_approve");
		}
	});

	it("decisionSource is fallback_heuristic", () => {
		const result = fallback.evaluate(makeCtx(), "API error");
		expect(result.decisionSource).toBe("fallback_heuristic");
	});

	it("llmError included in reasoning", () => {
		const result = fallback.evaluate(makeCtx(), "Rate limit exceeded");
		expect(result.reasoning).toContain("Rate limit exceeded");
	});
});
