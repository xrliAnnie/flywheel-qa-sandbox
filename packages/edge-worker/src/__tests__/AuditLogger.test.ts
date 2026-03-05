import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { AuditLogger } from "../AuditLogger.js";
import type { DecisionResult, ExecutionContext } from "flywheel-core";

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
	return {
		issueId: "issue-1",
		issueIdentifier: "GEO-95",
		issueTitle: "Fix the bug",
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
		diffSummary: "some diff",
		headSha: "def456",
		durationMs: 120_000,
		consecutiveFailures: 0,
		partial: false,
		...overrides,
	};
}

function makeDecision(overrides: Partial<DecisionResult> = {}): DecisionResult {
	return {
		route: "auto_approve",
		confidence: 0.95,
		reasoning: "Clean change",
		concerns: [],
		decisionSource: "haiku_triage",
		...overrides,
	};
}

describe("AuditLogger", () => {
	let tmpDir: string;
	let logger: AuditLogger;

	afterEach(async () => {
		await logger?.close();
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	function createLogger() {
		tmpDir = mkdtempSync(join(tmpdir(), "audit-"));
		logger = new AuditLogger(join(tmpDir, "audit.db"));
		return logger;
	}

	it("init() creates table", async () => {
		const l = createLogger();
		await l.init();
		const entries = await l.getRecent(10);
		expect(entries).toEqual([]);
	});

	it("log() inserts entry", async () => {
		const l = createLogger();
		await l.init();
		await l.log(makeContext(), makeDecision());
		const entries = await l.getRecent(10);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.issueId).toBe("issue-1");
		expect(entries[0]!.route).toBe("auto_approve");
		expect(entries[0]!.confidence).toBe(0.95);
	});

	it("getByIssue() returns matching entries", async () => {
		const l = createLogger();
		await l.init();
		await l.log(makeContext({ issueId: "a" }), makeDecision());
		await l.log(makeContext({ issueId: "b" }), makeDecision());
		await l.log(makeContext({ issueId: "a" }), makeDecision());
		const entries = await l.getByIssue("a");
		expect(entries).toHaveLength(2);
		expect(entries.every((e) => e.issueId === "a")).toBe(true);
	});

	it("getByIssue() returns empty for unknown", async () => {
		const l = createLogger();
		await l.init();
		await l.log(makeContext(), makeDecision());
		const entries = await l.getByIssue("unknown");
		expect(entries).toEqual([]);
	});

	it("getRecent() returns N entries newest first", async () => {
		const l = createLogger();
		await l.init();
		await l.log(makeContext({ issueId: "first" }), makeDecision());
		await l.log(makeContext({ issueId: "second" }), makeDecision());
		await l.log(makeContext({ issueId: "third" }), makeDecision());
		const entries = await l.getRecent(2);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.issueId).toBe("third");
		expect(entries[1]!.issueId).toBe("second");
	});

	it("log() maps eventType correctly for all sources", async () => {
		const l = createLogger();
		await l.init();
		await l.log(
			makeContext(),
			makeDecision({ decisionSource: "hard_rule" }),
		);
		await l.log(
			makeContext(),
			makeDecision({ decisionSource: "fallback_heuristic" }),
		);
		await l.log(
			makeContext(),
			makeDecision({ decisionSource: "haiku_triage" }),
		);
		const entries = await l.getRecent(10);
		const types = entries.map((e) => e.eventType);
		expect(types).toContain("hard_rule_triggered");
		expect(types).toContain("llm_fallback");
		expect(types).toContain("decision_made");
	});

	it("close() is idempotent", async () => {
		const l = createLogger();
		await l.init();
		await l.close();
		await l.close(); // second close should not throw
	});
});
