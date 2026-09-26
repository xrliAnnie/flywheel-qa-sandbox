/**
 * FLY-793 — Blueprint three-stage phase-prompt contract.
 *
 * A three-stage run is ONE issue with Design → Implement → QA phase-sessions on
 * one shared branch (shareParentBranch). The Design phase prompt must do the
 * design and complete via `phase_design_complete` WITHOUT implementing / PR /
 * land; the Implement phase reads the committed design and does the PR. The
 * default single-session prompt (no shareParentBranch) is byte-compatible.
 */

import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function makeNode(id = "FLY-793"): DagNode {
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

async function buildPrompt(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<string> {
	const adapter = makeMockAdapter();
	const blueprint = new Blueprint(
		makeHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
		undefined,
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
		leadId: "product-lead",
		...ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly793-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("Blueprint three-stage phase prompt (FLY-793)", () => {
	it("Design phase: designs + completes via phase_design_complete, no implement/land steps", async () => {
		const p = await buildPrompt({
			sessionRole: "design",
			shareParentBranch: true,
		});
		expect(p).toContain("DESIGN phase");
		expect(p).toContain("phase_design_complete");
		// design does NOT get the default implement step (step 6 controls this)
		expect(p).not.toContain("Create a feature branch");
		// NOTE: the shared LEAD-REPORT-BACK / approve-gate contract still appears
		// here (it lives inside the leadId block). Gating that per-phase is coupled
		// to the orchestration flow (approve fires after QA, not at Design) →
		// completed in Step 7 (PhaseOrchestrator). Design's explicit "do NOT PR/ship"
		// step overrides in the meantime, and three_stage is off by default.
	});

	it("Implement phase: reads committed design, does the PR", async () => {
		const p = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(p).toContain("IMPLEMENT phase");
		expect(p).toContain("committed design");
		expect(p).toContain("create a GitHub PR");
	});

	it("QA phase: writer on the shared branch, emits qa-result, does NOT open a second PR", async () => {
		const p = await buildPrompt({
			sessionRole: "qa",
			shareParentBranch: true,
		});
		expect(p).toContain("QA phase");
		expect(p).toContain("qa-result");
		// QA inherits the Implement phase's open PR — it must NOT run the
		// PR-create / land block (no "create a GitHub PR", no landing signal).
		expect(p).not.toContain("create a GitHub PR");
		expect(p).not.toContain("Create a feature branch");
	});

	it("byte-compat: no shareParentBranch → default single-session prompt", async () => {
		const p = await buildPrompt({});
		expect(p).toContain("Create a feature branch");
		expect(p).not.toContain("DESIGN phase");
		expect(p).not.toContain("IMPLEMENT phase");
	});

	it("shareParentBranch but sessionRole main → still default (not a phase)", async () => {
		const p = await buildPrompt({ shareParentBranch: true });
		expect(p).toContain("Create a feature branch");
		expect(p).not.toContain("DESIGN phase");
	});
});
