import { describe, it, expect, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionContext, DecisionResult } from "flywheel-core";
import { DecisionLayer } from "../decision/DecisionLayer.js";
import type { FullDiffProvider } from "../decision/DecisionLayer.js";
import { HardRuleEngine } from "../decision/HardRuleEngine.js";
import { HaikuTriageAgent } from "../decision/HaikuTriageAgent.js";
import { HaikuVerifier } from "../decision/HaikuVerifier.js";
import { FallbackHeuristic } from "../decision/FallbackHeuristic.js";
import { defaultRules } from "../decision/rules.js";
import { AuditLogger } from "../AuditLogger.js";
import type { LLMClient } from "flywheel-core";

// ── Helpers ─────────────────────────────────────────

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
	return {
		issueId: "issue-int-1",
		issueIdentifier: "GEO-100",
		issueTitle: "Integration test issue",
		labels: [],
		projectId: "proj-1",
		exitReason: "completed",
		baseSha: "abc123",
		commitCount: 2,
		commitMessages: ["fix: integration thing"],
		changedFilePaths: ["src/a.ts"],
		filesChangedCount: 1,
		linesAdded: 10,
		linesRemoved: 5,
		diffSummary: "1 file changed, 10 insertions(+), 5 deletions(-)",
		headSha: "def456",
		durationMs: 120_000,
		consecutiveFailures: 0,
		partial: false,
		...overrides,
	};
}

function makeDiffProvider(): FullDiffProvider {
	return {
		getFullDiff: vi.fn().mockResolvedValue("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,5 @@\n+// new line"),
	};
}

function makeLLM(triageResponse: string, verifyResponse?: string): LLMClient {
	let callCount = 0;
	return {
		chat: vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve({ content: triageResponse });
			}
			return Promise.resolve({ content: verifyResponse ?? "" });
		}),
	};
}

let testDir: string;
let auditLogger: AuditLogger;

async function setupAuditLogger(): Promise<AuditLogger> {
	testDir = join(tmpdir(), `flywheel-int-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
	auditLogger = new AuditLogger(join(testDir, "audit.db"));
	await auditLogger.init();
	return auditLogger;
}

async function cleanup(): Promise<void> {
	try { await auditLogger?.close(); } catch { /* ok */ }
	try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("DecisionLayer Integration", () => {
	it("hard rule escalate → skips LLM, audit logged", async () => {
		const logger = await setupAuditLogger();
		try {
			const hardRules = new HardRuleEngine(defaultRules());
			const noLlm: LLMClient = { chat: () => { throw new Error("should not be called"); } };
			const triage = new HaikuTriageAgent(noLlm, "haiku", 2000);
			const verifier = new HaikuVerifier(noLlm, "haiku");
			const fallback = new FallbackHeuristic();

			const layer = new DecisionLayer(
				hardRules, triage, verifier, fallback, logger, makeDiffProvider(),
			);

			// HR-001: security label → escalate
			const ctx = makeCtx({ labels: ["security"] });
			const result = await layer.decide(ctx, "/project");

			expect(result.route).toBe("needs_review");
			expect(result.decisionSource).toBe("hard_rule");
			expect(result.hardRuleId).toBe("HR-001");

			// Audit logged
			const entries = await logger.getByIssue("issue-int-1");
			expect(entries.length).toBe(1);
			expect(entries[0]!.route).toBe("needs_review");
		} finally {
			await cleanup();
		}
	});

	it("triage auto_approve → verifier approved → auto_approve + audit", async () => {
		const logger = await setupAuditLogger();
		try {
			const hardRules = new HardRuleEngine(defaultRules());
			const triageJson = JSON.stringify({
				route: "auto_approve",
				confidence: 0.95,
				reasoning: "Clean small change",
				concerns: [],
			});
			const verifyJson = JSON.stringify({
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
			const llm = makeLLM(triageJson, verifyJson);
			const triage = new HaikuTriageAgent(llm, "haiku", 2000);
			const verifier = new HaikuVerifier(llm, "haiku");
			const fallback = new FallbackHeuristic();
			const diffProvider = makeDiffProvider();

			const layer = new DecisionLayer(
				hardRules, triage, verifier, fallback, logger, diffProvider,
			);

			const result = await layer.decide(makeCtx(), "/project");

			expect(result.route).toBe("auto_approve");
			expect(result.verification?.approved).toBe(true);
			expect(diffProvider.getFullDiff).toHaveBeenCalled();

			const entries = await logger.getByIssue("issue-int-1");
			expect(entries.length).toBe(1);
		} finally {
			await cleanup();
		}
	});

	it("triage auto_approve → verifier concerns → needs_review", async () => {
		const logger = await setupAuditLogger();
		try {
			const hardRules = new HardRuleEngine(defaultRules());
			const triageJson = JSON.stringify({
				route: "auto_approve",
				confidence: 0.95,
				reasoning: "Looks clean",
				concerns: [],
			});
			const verifyJson = JSON.stringify({
				approved: false,
				confidence: 0.3,
				concerns: ["Missing error handling"],
				checklist: {
					matchesIssue: true,
					noObviousBugs: true,
					errorHandling: false,
					noSecrets: true,
					appropriateScope: true,
				},
			});
			const llm = makeLLM(triageJson, verifyJson);
			const triage = new HaikuTriageAgent(llm, "haiku", 2000);
			const verifier = new HaikuVerifier(llm, "haiku");
			const fallback = new FallbackHeuristic();

			const layer = new DecisionLayer(
				hardRules, triage, verifier, fallback, logger, makeDiffProvider(),
			);

			const result = await layer.decide(makeCtx(), "/project");

			expect(result.route).toBe("needs_review");
			expect(result.decisionSource).toBe("haiku_verify");
			expect(result.concerns).toContain("Missing error handling");
		} finally {
			await cleanup();
		}
	});

	it("triage needs_review → returns needs_review + audit", async () => {
		const logger = await setupAuditLogger();
		try {
			const hardRules = new HardRuleEngine(defaultRules());
			const triageJson = JSON.stringify({
				route: "needs_review",
				confidence: 0.7,
				reasoning: "Large change needs human review",
				concerns: ["Many files changed"],
			});
			const llm = makeLLM(triageJson);
			const triage = new HaikuTriageAgent(llm, "haiku", 2000);
			const verifier = new HaikuVerifier(llm, "haiku");
			const fallback = new FallbackHeuristic();
			const diffProvider = makeDiffProvider();

			const layer = new DecisionLayer(
				hardRules, triage, verifier, fallback, logger, diffProvider,
			);

			const result = await layer.decide(makeCtx(), "/project");

			expect(result.route).toBe("needs_review");
			expect(result.decisionSource).toBe("haiku_triage");
			// Verifier should NOT be called for non-auto_approve
			expect(diffProvider.getFullDiff).not.toHaveBeenCalled();

			const entries = await logger.getByIssue("issue-int-1");
			expect(entries.length).toBe(1);
		} finally {
			await cleanup();
		}
	});

	it("triage throws → fallback → never auto_approve + audit", async () => {
		const logger = await setupAuditLogger();
		try {
			const hardRules = new HardRuleEngine(defaultRules());
			const failLlm: LLMClient = { chat: () => Promise.reject(new Error("API rate limit")) };
			const triage = new HaikuTriageAgent(failLlm, "haiku", 2000);
			const verifier = new HaikuVerifier(failLlm, "haiku");
			const fallback = new FallbackHeuristic();

			const layer = new DecisionLayer(
				hardRules, triage, verifier, fallback, logger, makeDiffProvider(),
			);

			const result = await layer.decide(makeCtx(), "/project");

			expect(result.decisionSource).toBe("fallback_heuristic");
			expect(result.route).not.toBe("auto_approve");

			const entries = await logger.getByIssue("issue-int-1");
			expect(entries.length).toBe(1);
		} finally {
			await cleanup();
		}
	});

	it("AuditLogger persists entries retrievable by issue", async () => {
		const logger = await setupAuditLogger();
		try {
			const hardRules = new HardRuleEngine(defaultRules());
			const noLlm: LLMClient = { chat: () => { throw new Error("no key"); } };
			const triage = new HaikuTriageAgent(noLlm, "haiku", 2000);
			const verifier = new HaikuVerifier(noLlm, "haiku");
			const fallback = new FallbackHeuristic();

			const layer = new DecisionLayer(
				hardRules, triage, verifier, fallback, logger, makeDiffProvider(),
			);

			// Run two decisions for different issues
			await layer.decide(makeCtx({ issueId: "issue-A" }), "/project");
			await layer.decide(makeCtx({ issueId: "issue-B" }), "/project");
			await layer.decide(makeCtx({ issueId: "issue-A" }), "/project");

			const entriesA = await logger.getByIssue("issue-A");
			const entriesB = await logger.getByIssue("issue-B");
			expect(entriesA.length).toBe(2);
			expect(entriesB.length).toBe(1);

			const recent = await logger.getRecent(10);
			expect(recent.length).toBe(3);
		} finally {
			await cleanup();
		}
	});

	it("HR-008: partial evidence → forced escalate", async () => {
		const logger = await setupAuditLogger();
		try {
			const hardRules = new HardRuleEngine(defaultRules());
			const noLlm: LLMClient = { chat: () => { throw new Error("no key"); } };
			const triage = new HaikuTriageAgent(noLlm, "haiku", 2000);
			const verifier = new HaikuVerifier(noLlm, "haiku");
			const fallback = new FallbackHeuristic();

			const layer = new DecisionLayer(
				hardRules, triage, verifier, fallback, logger, makeDiffProvider(),
			);

			const ctx = makeCtx({ partial: true });
			const result = await layer.decide(ctx, "/project");

			expect(result.route).toBe("needs_review");
			expect(result.decisionSource).toBe("hard_rule");
			expect(result.hardRuleId).toBe("HR-008");
		} finally {
			await cleanup();
		}
	});
});
