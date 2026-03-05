import { describe, it, expect } from "vitest";
import type { ExecutionContext } from "flywheel-core";
import { HardRuleEngine } from "../decision/HardRuleEngine.js";
import { defaultRules } from "../decision/rules.js";

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
		diffSummary: "diff",
		headSha: "def456",
		durationMs: 120_000,
		consecutiveFailures: 0,
		partial: false,
		...overrides,
	};
}

describe("HardRuleEngine", () => {
	it("HR-001: security label triggers escalate", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ labels: ["security"] }));
		expect(result?.triggered).toBe(true);
		expect(result?.action).toBe("escalate");
		expect(result?.ruleId).toBe("HR-001");
	});

	it("HR-001: unrelated label passes", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ labels: ["feature"] }));
		expect(result).toBeNull();
	});

	it("HR-002: 3 consecutive failures escalates", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ consecutiveFailures: 3 }));
		expect(result?.triggered).toBe(true);
		expect(result?.ruleId).toBe("HR-002");
	});

	it("HR-002: 2 failures passes", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ consecutiveFailures: 2 }));
		expect(result).toBeNull();
	});

	it("HR-003: .env file triggers escalate", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(
			makeCtx({ changedFilePaths: [".env"] }),
		);
		expect(result?.ruleId).toBe("HR-003");
	});

	it("HR-003: .env in nested path triggers", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(
			makeCtx({ changedFilePaths: ["config/.env.production"] }),
		);
		expect(result?.ruleId).toBe("HR-003");
	});

	it("HR-004: 501 lines escalates", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ linesAdded: 501 }));
		expect(result?.ruleId).toBe("HR-004");
	});

	it("HR-004: 500 lines passes", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ linesAdded: 500 }));
		expect(result).toBeNull();
	});

	it("HR-005: breaking-change label triggers", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(
			makeCtx({ labels: ["breaking-change"] }),
		);
		expect(result?.ruleId).toBe("HR-005");
	});

	it("HR-007: timeout blocks", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ exitReason: "timeout" }));
		expect(result?.triggered).toBe(true);
		expect(result?.action).toBe("block");
		expect(result?.ruleId).toBe("HR-007");
	});

	it("HR-008: partial=true escalates", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ partial: true }));
		expect(result?.ruleId).toBe("HR-008");
		expect(result?.action).toBe("escalate");
	});

	it("HR-008: partial=false passes", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ partial: false }));
		expect(result).toBeNull();
	});

	it("block rules evaluated before escalate rules", () => {
		const engine = new HardRuleEngine(defaultRules());
		// Both timeout (block) and partial (escalate) trigger — block wins
		const result = engine.evaluate(
			makeCtx({ exitReason: "timeout", partial: true }),
		);
		expect(result?.action).toBe("block");
		expect(result?.ruleId).toBe("HR-007");
	});

	it("HR-007 timeout + HR-008 partial: block wins over escalate", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(
			makeCtx({ exitReason: "timeout", partial: true, labels: ["security"] }),
		);
		expect(result?.action).toBe("block");
		expect(result?.ruleId).toBe("HR-007");
	});

	it("HR-009: zero commits blocks", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ commitCount: 0 }));
		expect(result?.triggered).toBe(true);
		expect(result?.action).toBe("block");
		expect(result?.ruleId).toBe("HR-009");
	});

	it("HR-009: 1+ commits passes", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx({ commitCount: 1 }));
		expect(result).toBeNull();
	});

	it("HR-007 timeout beats HR-009 zero commits (both block)", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(
			makeCtx({ exitReason: "timeout", commitCount: 0 }),
		);
		expect(result?.ruleId).toBe("HR-007"); // higher priority
	});

	it("no rules triggered returns null", () => {
		const engine = new HardRuleEngine(defaultRules());
		const result = engine.evaluate(makeCtx());
		expect(result).toBeNull();
	});
});
