import { describe, it, expect, vi } from "vitest";
import type { ExecutionContext, DecisionResult } from "flywheel-core";
import { DecisionLayer } from "../decision/DecisionLayer.js";
import type { FullDiffProvider } from "../decision/DecisionLayer.js";
import { HardRuleEngine } from "../decision/HardRuleEngine.js";
import { HaikuTriageAgent } from "../decision/HaikuTriageAgent.js";
import { HaikuVerifier } from "../decision/HaikuVerifier.js";
import { FallbackHeuristic } from "../decision/FallbackHeuristic.js";
import { AuditLogger } from "../AuditLogger.js";

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

function makeMocks() {
	const hardRules = new HardRuleEngine([]);
	vi.spyOn(hardRules, "evaluate");

	const mockLLM = { chat: vi.fn() };
	const triage = new HaikuTriageAgent(mockLLM, "haiku", 2000);
	const verifier = new HaikuVerifier(mockLLM, "haiku");
	const fallback = new FallbackHeuristic();

	const auditLogger = {
		log: vi.fn().mockResolvedValue(undefined),
		init: vi.fn(),
		close: vi.fn(),
		getByIssue: vi.fn(),
		getRecent: vi.fn(),
	} as unknown as AuditLogger;

	const diffProvider: FullDiffProvider = {
		getFullDiff: vi.fn().mockResolvedValue("full diff content"),
	};

	return { hardRules, triage, verifier, fallback, auditLogger, diffProvider, mockLLM };
}

describe("DecisionLayer", () => {
	it("hard rule escalate → skips LLM, returns needs_review", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(hardRules, "evaluate").mockReturnValue({
			triggered: true,
			action: "escalate",
			reason: "Security label",
			ruleId: "HR-001",
		});

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("needs_review");
		expect(result.decisionSource).toBe("hard_rule");
		expect(result.hardRuleId).toBe("HR-001");
	});

	it("hard rule block → skips LLM, returns blocked", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(hardRules, "evaluate").mockReturnValue({
			triggered: true,
			action: "block",
			reason: "Timeout",
			ruleId: "HR-007",
		});

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("blocked");
		expect(result.decisionSource).toBe("hard_rule");
	});

	it("triage auto_approve → verifier approved → returns auto_approve", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "auto_approve",
			confidence: 0.95,
			reasoning: "Clean",
			concerns: [],
			decisionSource: "haiku_triage",
		});
		vi.spyOn(verifier, "verify").mockResolvedValue({
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
		});

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("auto_approve");
		expect(result.verification?.approved).toBe(true);
	});

	it("triage auto_approve → verifier concerns → returns needs_review", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "auto_approve",
			confidence: 0.95,
			reasoning: "Clean",
			concerns: [],
			decisionSource: "haiku_triage",
		});
		vi.spyOn(verifier, "verify").mockResolvedValue({
			approved: false,
			confidence: 0.3,
			concerns: ["Missing tests"],
			checklist: {
				matchesIssue: true,
				noObviousBugs: true,
				errorHandling: false,
				noSecrets: true,
				appropriateScope: true,
			},
		});

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("needs_review");
		expect(result.decisionSource).toBe("haiku_verify");
	});

	it("triage needs_review → returns needs_review (no verify)", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "needs_review",
			confidence: 0.7,
			reasoning: "Large change",
			concerns: [],
			decisionSource: "haiku_triage",
		});
		const verifySpy = vi.spyOn(verifier, "verify");

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("needs_review");
		expect(verifySpy).not.toHaveBeenCalled();
	});

	it("triage blocked → returns blocked", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "blocked",
			confidence: 0.9,
			reasoning: "No commits",
			concerns: [],
			decisionSource: "haiku_triage",
		});

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("blocked");
	});

	it("triage throws → fallback returns needs_review", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockRejectedValue(new Error("API error"));

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.decisionSource).toBe("fallback_heuristic");
		expect(result.route).not.toBe("auto_approve");
	});

	it("verifier throws → degrades auto_approve to needs_review", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "auto_approve",
			confidence: 0.95,
			reasoning: "Clean",
			concerns: [],
			decisionSource: "haiku_triage",
		});
		vi.spyOn(verifier, "verify").mockRejectedValue(new Error("Verify failed"));

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("needs_review");
		expect(result.concerns).toContain("Verification failed");
	});

	it("auditLogger.log called for every decision", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "needs_review",
			confidence: 0.7,
			reasoning: "test",
			concerns: [],
			decisionSource: "haiku_triage",
		});

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		await layer.decide(makeCtx(), "/project");

		expect(auditLogger.log).toHaveBeenCalledTimes(1);
	});

	it("auditLogger failure doesn't block decision", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "needs_review",
			confidence: 0.7,
			reasoning: "test",
			concerns: [],
			decisionSource: "haiku_triage",
		});
		(auditLogger.log as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("DB full"),
		);

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("needs_review"); // not thrown
	});

	it("diffProvider.getFullDiff called only for auto_approve", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockResolvedValue({
			route: "needs_review",
			confidence: 0.7,
			reasoning: "test",
			concerns: [],
			decisionSource: "haiku_triage",
		});

		const layer = new DecisionLayer(
			hardRules, triage, verifier, fallback, auditLogger, diffProvider,
		);
		await layer.decide(makeCtx(), "/project");

		expect(diffProvider.getFullDiff).not.toHaveBeenCalled();
	});
});
