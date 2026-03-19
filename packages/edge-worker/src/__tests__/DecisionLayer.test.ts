import type { ExecutionContext } from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import type { AuditLogger } from "../AuditLogger.js";
import type { FullDiffProvider } from "../decision/DecisionLayer.js";
import { DecisionLayer } from "../decision/DecisionLayer.js";
import { FallbackHeuristic } from "../decision/FallbackHeuristic.js";
import { HaikuTriageAgent } from "../decision/HaikuTriageAgent.js";
import { HaikuVerifier } from "../decision/HaikuVerifier.js";
import { HardRuleEngine } from "../decision/HardRuleEngine.js";

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

	return {
		hardRules,
		triage,
		verifier,
		fallback,
		auditLogger,
		diffProvider,
		mockLLM,
	};
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("blocked");
		expect(result.decisionSource).toBe("hard_rule");
	});

	it("triage auto_approve → verifier approved → final guard downgrades to needs_review", async () => {
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("needs_review");
		expect(result.concerns).toContain("auto_approve disabled by policy");
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("blocked");
	});

	it("triage throws → fallback returns needs_review", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(triage, "triage").mockRejectedValue(new Error("API error"));

		const layer = new DecisionLayer(
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		const result = await layer.decide(makeCtx(), "/project");

		expect(result.route).toBe("needs_review"); // not thrown
	});

	it("landed PR → early return auto_approve (bypasses hard rules + triage)", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		const evaluateSpy = vi.spyOn(hardRules, "evaluate");
		const triageSpy = vi.spyOn(triage, "triage");

		const layer = new DecisionLayer(
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		const result = await layer.decide(
			makeCtx({
				landingStatus: { status: "merged", mergedAt: "2025-01-01T00:00:00Z" },
			}),
			"/project",
		);

		expect(result.route).toBe("auto_approve");
		expect(result.confidence).toBe(1.0);
		expect(result.hardRuleId).toBe("HR-LANDED");
		expect(result.decisionSource).toBe("hard_rule");
		expect(result.reasoning).toContain("flywheel-land");
		expect(evaluateSpy).not.toHaveBeenCalled();
		expect(triageSpy).not.toHaveBeenCalled();
	});

	it("landed PR → audit logged", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();

		const layer = new DecisionLayer(
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		await layer.decide(
			makeCtx({ landingStatus: { status: "merged" } }),
			"/project",
		);

		expect(auditLogger.log).toHaveBeenCalledTimes(1);
	});

	it("landing failed → falls through to hard rules (HR-010)", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		vi.spyOn(hardRules, "evaluate").mockReturnValue({
			triggered: true,
			action: "block",
			reason: "Landing failed",
			ruleId: "HR-010",
		});

		const layer = new DecisionLayer(
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		const result = await layer.decide(
			makeCtx({
				landingStatus: { status: "failed", failureReason: "ci_failed" },
			}),
			"/project",
		);

		expect(result.route).toBe("blocked");
		expect(result.hardRuleId).toBe("HR-010");
	});

	it("ready_to_merge → HR-READY needs_review (bypasses hard rules + triage)", async () => {
		const { hardRules, triage, verifier, fallback, auditLogger, diffProvider } =
			makeMocks();
		const evaluateSpy = vi.spyOn(hardRules, "evaluate");
		const triageSpy = vi.spyOn(triage, "triage");

		const layer = new DecisionLayer(
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		const result = await layer.decide(
			makeCtx({ landingStatus: { status: "ready_to_merge", prNumber: 42 } }),
			"/project",
		);

		expect(result.route).toBe("needs_review");
		expect(result.confidence).toBe(1.0);
		expect(result.hardRuleId).toBe("HR-READY");
		expect(result.decisionSource).toBe("hard_rule");
		expect(result.reasoning).toContain("CEO approval");
		expect(evaluateSpy).not.toHaveBeenCalled();
		expect(triageSpy).not.toHaveBeenCalled();
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
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			diffProvider,
		);
		await layer.decide(makeCtx(), "/project");

		expect(diffProvider.getFullDiff).not.toHaveBeenCalled();
	});
});
