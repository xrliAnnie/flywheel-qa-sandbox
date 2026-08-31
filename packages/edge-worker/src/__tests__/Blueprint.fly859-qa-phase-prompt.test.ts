/**
 * FLY-859 — Blueprint QA-phase PASS/FAIL sequencing + Implement fix-round.
 *
 * The DAG workflow QA phase is the pipeline's ship-gate holder AND ship
 * executor on PASS: its prompt must chain qa-result → the standard APPROVE
 * GATE flow (FLY-849 §3.8 showed the old prompt let the runner stop right
 * after the verdict, stranding the pipeline). On FAIL it stops for the
 * workflow engine's Implement-fix loop (never the auto-QA park protocol).
 * An Implement-fix dispatch renders the QA findings context; a plain
 * implement dispatch is byte-compatible.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

function makeNode(id = "FLY-859"): DagNode {
	return { id, blockedBy: [] };
}

function makeHydrator() {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
		labels: [],
	}));
}

function makeMockGitChecker() {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 3,
			commitMessages: ["feat: x"],
		})),
	} as unknown as GitResultChecker;
}

function makeMockShell(): ShellRunner {
	return { execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })) };
}

function makeMockAdapter(): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-uuid",
				tmuxWindow: "flywheel:@42",
				durationMs: 5000,
			}),
		),
	};
}

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

function makeRealWorktree(): string {
	const p = join(
		tmpdir(),
		`fly859-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(p, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: p });
	cleanups.push(p);
	return p;
}

function makeWtManager(worktreePath: string) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-859",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "proj",
			issueId: "FLY-859",
			worktreePath,
			branch: "flywheel-FLY-859",
			mainRepoPath: "/tmp/fly859-main",
		})),
	} as unknown as WorktreeManager;
}

async function buildPrompt(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<string> {
	const adapter = makeMockAdapter();
	const worktreePath = makeRealWorktree();
	const blueprint = new Blueprint(
		makeHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
		makeWtManager(worktreePath),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ brainstorm: { enabled: true }, approve_to_ship: { enabled: true } },
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		leadId: "flywheel-eng-lead",
		...ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly859-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

function expectVerdictLeadReport(input: {
	prompt: string;
	executionId: string;
	status: "pass" | "fail" | "pass|fail";
	label: "workflow verdict" | "QA verdict";
	summary: string;
	leadId?: string;
}): void {
	const verdict = `qa-result --exec-id ${input.executionId} --target-exec ${input.executionId} --status ${input.status} --summary "${input.summary}"`;
	const verdictIndex = input.prompt.indexOf(verdict);
	expect(verdictIndex).toBeGreaterThanOrEqual(0);
	const commandEnd = input.prompt.indexOf("`", verdictIndex);
	const leadId = input.leadId ?? "flywheel-eng-lead";
	const report = `ask --lead ${leadId} --exec-id ${input.executionId} --report "DONE: ${input.label} recorded; status=${input.status}; evidence=${input.summary}; blocking priority=<none|priority>"`;
	const reportIndex = input.prompt.indexOf(report, verdictIndex);
	expect(reportIndex).toBeGreaterThan(verdictIndex);
	expect(reportIndex).toBeLessThan(commandEnd);
	expect(input.prompt.slice(verdictIndex, reportIndex)).toContain(" && node ");
	expect(input.prompt).toContain("retry only the `ask --report` half");
	expect(input.prompt).toContain("exactly the same report message");
}

describe("Blueprint QA-phase PASS/FAIL sequencing (FLY-859)", () => {
	it("PASS chains into the APPROVE GATE flow — the QA phase is the ship executor", async () => {
		const p = await buildPrompt({
			executionId: "exec-qa-pass",
			sessionRole: "qa",
			shareParentBranch: true,
		});
		expect(p).toContain("On PASS");
		expect(p).toContain("qa-result --exec-id");
		expect(p).toContain("--target-exec");
		expect(p).toContain("--status pass");
		expect(p).toContain("APPROVE GATE flow below");
		expect(p).toContain("ship executor");
		expectVerdictLeadReport({
			prompt: p,
			executionId: "exec-qa-pass",
			status: "pass",
			label: "QA verdict",
			summary: "<what you tested + verdict>",
		});
		expect(p.indexOf("DONE: QA verdict recorded; status=pass")).toBeLessThan(
			p.indexOf("APPROVE GATE flow below"),
		);
		// the standard APPROVE GATE block itself is present for the QA phase
		expect(p).toContain("APPROVE GATE (MANDATORY");
	});

	it("FAIL commits findings first, then PARKS for the keep-alive RE-TEST loop (default ON) — never complete, never approve gate", async () => {
		// FLY-887: keep-alive is default ON, so the FAIL branch now parks for a
		// RE-TEST wake (the implementer stays alive to fix), NOT the old
		// close-and-respawn "Implement-fix phase" / "Do NOT park for retest" text.
		const p = await buildPrompt({
			executionId: "exec-qa-fail",
			sessionRole: "qa",
			shareParentBranch: true,
		});
		expect(p).toContain("On FAIL");
		expect(p).toContain("--status fail");
		expect(p).toContain("RE-TEST wake");
		expect(p).toContain("park --exec-id");
		expect(p).toContain("turn --exec-id");
		expect(p).toContain("Do NOT run `complete`");
		expectVerdictLeadReport({
			prompt: p,
			executionId: "exec-qa-fail",
			status: "fail",
			label: "QA verdict",
			summary: "<exact scenario / expected-vs-actual / severity>",
		});
		expect(p.indexOf("DONE: QA verdict recorded; status=fail")).toBeLessThan(
			p.indexOf("park --exec-id exec-qa-fail"),
		);
		// the legacy close-and-respawn wording is gone under keep-alive
		expect(p).not.toContain("Do NOT park for retest");
		expect(p).not.toContain("the pipeline closes this session");
	});

	it("Codex QA PASS parks after the needs-review completion boundary", async () => {
		const p = await buildPrompt({
			runnerBackend: "codex-tmux",
			sessionRole: "qa",
			shareParentBranch: true,
		});
		const completion = p.indexOf("complete --route needs_review");
		const park = p.indexOf("park --exec-id", completion);
		expect(completion).toBeGreaterThanOrEqual(0);
		expect(park).toBeGreaterThan(completion);
		expect(p).toContain("phase controller stays alive");
	});

	it("Codex QA FAIL parks after qa-result and replays stable wake ids safely", async () => {
		const p = await buildPrompt({
			executionId: "exec-codex-qa-fail",
			runnerBackend: "codex-tmux",
			sessionRole: "qa",
			shareParentBranch: true,
		});
		const verdict = p.indexOf("--status fail");
		const park = p.indexOf("park --exec-id", verdict);
		expect(verdict).toBeGreaterThanOrEqual(0);
		expect(park).toBeGreaterThan(verdict);
		expect(p).toContain("[phase-wake <id>]");
		expect(p).toContain("do not repeat external or worktree side effects");
		expectVerdictLeadReport({
			prompt: p,
			executionId: "exec-codex-qa-fail",
			status: "fail",
			label: "QA verdict",
			summary: "<exact scenario / expected-vs-actual / severity>",
		});
	});

	it("founder feedback kickback reports the accepted QA verdict before parking", async () => {
		const p = await buildPrompt({
			executionId: "exec-feedback",
			runnerBackend: "codex-tmux",
			sessionRole: "qa",
			shareParentBranch: true,
		});
		expectVerdictLeadReport({
			prompt: p,
			executionId: "exec-feedback",
			status: "fail",
			label: "QA verdict",
			summary: "founder feedback kickback: <summary of the requested changes>",
		});
		const report = p.indexOf(
			"DONE: QA verdict recorded; status=fail; evidence=founder feedback kickback",
		);
		const park = p.indexOf(
			'park --exec-id exec-feedback --reason "DAG workflow QA awaiting implement fix (founder feedback)"',
		);
		expect(report).toBeGreaterThanOrEqual(0);
		expect(park).toBeGreaterThan(report);
	});

	it("generalized credential verdict uses the workflow label and degrades safely without a Lead", async () => {
		const generalized = {
			executionId: "exec-generalized-qa",
			projectName: "flywheel",
			generalizedExecutionContext: {
				runId: "run-generalized-qa",
				nodeId: "qa",
				attempt: 1,
				snapshotDigest: "snapshot-generalized-qa",
			},
			workflowCapabilities: {
				shared_branch_writer: false,
				creates_pr: false,
				can_ship: false,
				can_land: false,
				produces_output: false,
				completion_route: "needs_review",
			},
			workflowAgentContent: "Verify the bounded workflow node.",
			workflowSubmissionCredential: "submission-ticket",
			workflowSubmissionExpected: true,
		};
		const withLead = await buildPrompt(generalized);
		expectVerdictLeadReport({
			prompt: withLead,
			executionId: "exec-generalized-qa",
			status: "pass|fail",
			label: "workflow verdict",
			summary: "<evidence and verdict>",
		});

		const withoutLead = await buildPrompt({
			...generalized,
			leadId: undefined,
		});
		expect(withoutLead).toContain(
			'qa-result --exec-id exec-generalized-qa --target-exec exec-generalized-qa --status pass|fail --summary "<evidence and verdict>"',
		);
		expect(withoutLead).not.toContain("DONE: workflow verdict recorded");
		expect(withoutLead).not.toContain("followed by its Lead report");
		expect(withoutLead).not.toContain("retry only the `ask --report` half");
		expect(withoutLead.match(/qa-result --exec-id/g)).toHaveLength(1);
	});

	it("Implement-fix dispatch renders the QA fix-round context", async () => {
		const p = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
			phaseFixContext: { round: 2, qaSummary: "login flow regression" },
		});
		expect(p).toContain("## QA Fix Round 2");
		expect(p).toContain("login flow regression");
		expect(p).toContain("do NOT run `gh pr create`");
	});

	it("byte-compat: a plain implement phase has no fix-round section", async () => {
		const p = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(p).toContain("IMPLEMENT phase");
		expect(p).not.toContain("QA Fix Round");
	});

	it("byte-compat: single-session default prompt untouched", async () => {
		const p = await buildPrompt({});
		expect(p).toContain("Create a feature branch");
		expect(p).not.toContain("On PASS");
		expect(p).not.toContain("QA Fix Round");
	});
});
