import type { ExecutionContext, HardRuleResult } from "flywheel-core";
import type { HardRule } from "./rules.js";

/**
 * Deterministic rule engine — evaluated BEFORE any LLM call.
 * Two-pass evaluation: block rules first, then escalate rules.
 * First triggered rule in each pass wins.
 */
export class HardRuleEngine {
	private rules: HardRule[];

	constructor(rules?: HardRule[]) {
		this.rules = [...(rules ?? [])].sort((a, b) => a.priority - b.priority);
	}

	registerRule(rule: HardRule): void {
		this.rules.push(rule);
		this.rules.sort((a, b) => a.priority - b.priority);
	}

	/** Two-pass: block rules first, then escalate. First triggered wins per pass. */
	evaluate(ctx: ExecutionContext): HardRuleResult | null {
		// Pass 1: block rules
		for (const rule of this.rules) {
			const result = rule.evaluate(ctx);
			if (result.triggered && result.action === "block") {
				return result;
			}
		}

		// Pass 2: escalate rules
		for (const rule of this.rules) {
			const result = rule.evaluate(ctx);
			if (result.triggered && result.action === "escalate") {
				return result;
			}
		}

		return null;
	}
}
