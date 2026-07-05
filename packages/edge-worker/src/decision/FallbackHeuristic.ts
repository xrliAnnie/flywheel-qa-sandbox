import type { DecisionResult, ExecutionContext } from "flywheel-core";

/**
 * Conservative fallback when LLM is unavailable.
 * NEVER auto-approves — safety constraint.
 */
export class FallbackHeuristic {
	evaluate(ctx: ExecutionContext, llmError: string): DecisionResult {
		// Rule 1: no commits → blocked
		if (ctx.commitCount === 0) {
			return {
				route: "blocked",
				confidence: 0.9,
				reasoning: `No commits produced. LLM error: ${llmError}`,
				concerns: ["Zero commits", llmError],
				decisionSource: "fallback_heuristic",
			};
		}

		// Rule 2: consecutive failures ≥ 2 → blocked
		if (ctx.consecutiveFailures >= 2) {
			return {
				route: "blocked",
				confidence: 0.85,
				reasoning: `${ctx.consecutiveFailures} consecutive failures. LLM error: ${llmError}`,
				concerns: ["Multiple consecutive failures", llmError],
				decisionSource: "fallback_heuristic",
			};
		}

		// Rule 3: large change → needs_review
		if (ctx.linesAdded > 200 || ctx.filesChangedCount > 10) {
			return {
				route: "needs_review",
				confidence: 0.6,
				reasoning: `Large change (${ctx.linesAdded} lines, ${ctx.filesChangedCount} files). LLM error: ${llmError}`,
				concerns: ["Large change size", llmError],
				decisionSource: "fallback_heuristic",
			};
		}

		// Rule 4: default → needs_review (never auto_approve)
		return {
			route: "needs_review",
			confidence: 0.5,
			reasoning: `Default fallback — LLM unavailable. Error: ${llmError}`,
			concerns: [llmError],
			decisionSource: "fallback_heuristic",
		};
	}
}
