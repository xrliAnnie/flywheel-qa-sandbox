import type { DecisionResult, ExecutionContext } from "flywheel-core";
import type { AuditLogger } from "../AuditLogger.js";
import type { FallbackHeuristic } from "./FallbackHeuristic.js";
import type { HaikuTriageAgent } from "./HaikuTriageAgent.js";
import type { HaikuVerifier } from "./HaikuVerifier.js";
import type { HardRuleEngine } from "./HardRuleEngine.js";

export interface IDecisionLayer {
	decide(ctx: ExecutionContext, cwd: string): Promise<DecisionResult>;
}

export interface FullDiffProvider {
	getFullDiff(cwd: string, baseSha: string): Promise<string>;
}

/**
 * Orchestrates: Hard Rules → Haiku Triage → Haiku Verify → Fallback.
 * cwd is passed per-call (Blueprint reused across worktrees).
 */
export class DecisionLayer implements IDecisionLayer {
	constructor(
		private hardRules: HardRuleEngine,
		private triage: HaikuTriageAgent,
		private verifier: HaikuVerifier,
		private fallback: FallbackHeuristic,
		private auditLogger: AuditLogger,
		private diffProvider: FullDiffProvider,
	) {}

	async decide(
		ctx: ExecutionContext,
		cwd: string,
	): Promise<DecisionResult> {
		// Early return: PR already merged by flywheel-land — bypass all rules/triage/verify
		if (ctx.landingStatus?.status === "merged") {
			const result: DecisionResult = {
				route: "auto_approve",
				confidence: 1.0,
				reasoning: `PR already merged by flywheel-land at ${ctx.landingStatus.mergedAt ?? "unknown"}`,
				concerns: [],
				decisionSource: "hard_rule",
				hardRuleId: "HR-LANDED",
			};
			await this.audit(ctx, result);
			return result;
		}

		let result: DecisionResult;

		// Step 1: Hard rules (deterministic, no LLM)
		const hardRuleResult = this.hardRules.evaluate(ctx);
		if (hardRuleResult) {
			result = {
				route: hardRuleResult.action === "block" ? "blocked" : "needs_review",
				confidence: 1.0,
				reasoning: hardRuleResult.reason,
				concerns: [hardRuleResult.reason],
				decisionSource: "hard_rule",
				hardRuleId: hardRuleResult.ruleId,
			};
			await this.audit(ctx, result);
			return result;
		}

		// Step 2: LLM triage
		try {
			result = await this.triage.triage(ctx);
		} catch (err) {
			// LLM failure → fallback
			const errMsg = err instanceof Error ? err.message : String(err);
			result = this.fallback.evaluate(ctx, errMsg);
			await this.audit(ctx, result);
			return result;
		}

		// Step 3: If auto_approve, verify with full diff
		if (result.route === "auto_approve") {
			try {
				const fullDiff = await this.diffProvider.getFullDiff(
					cwd,
					ctx.baseSha,
				);
				const verification = await this.verifier.verify(ctx, fullDiff);
				result.verification = verification;

				if (!verification.approved) {
					result = {
						...result,
						route: "needs_review",
						confidence: verification.confidence,
						concerns: [...result.concerns, ...verification.concerns],
						decisionSource: "haiku_verify",
					};
				}
			} catch {
				// Verifier failure → downgrade to needs_review
				result = {
					...result,
					route: "needs_review",
					confidence: 0.5,
					concerns: [...result.concerns, "Verification failed"],
					decisionSource: "haiku_verify",
				};
			}
		}

		await this.audit(ctx, result);
		return result;
	}

	private async audit(
		ctx: ExecutionContext,
		result: DecisionResult,
	): Promise<void> {
		try {
			await this.auditLogger.log(ctx, result);
		} catch {
			// Best-effort — audit failure doesn't block decision
		}
	}
}
