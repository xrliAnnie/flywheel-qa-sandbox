/**
 * FLY-859 — Blueprint QA-phase PASS/FAIL sequencing + Implement fix-round.
 *
 * The three-stage QA phase is the pipeline's ship-gate holder AND ship
 * executor on PASS: its prompt must chain qa-result → the standard APPROVE
 * GATE flow (FLY-849 §3.8 showed the old prompt let the runner stop right
 * after the verdict, stranding the pipeline). On FAIL it stops for the
 * PhaseOrchestrator's Implement-fix loop (never the auto-QA park protocol).
 * An Implement-fix dispatch renders the QA findings context; a plain
 * implement dispatch is byte-compatible.
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
		leadId: "flywheel-eng-lead",
		...ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly859-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("Blueprint QA-phase PASS/FAIL sequencing (FLY-859)", () => {
	it("PASS chains into the APPROVE GATE flow — the QA phase is the ship executor", async () => {
		const p = await buildPrompt({
			sessionRole: "qa",
			shareParentBranch: true,
		});
		expect(p).toContain("On PASS");
		expect(p).toContain("qa-result --exec-id");
		expect(p).toContain("--target-exec");
		expect(p).toContain("--status pass");
		expect(p).toContain("APPROVE GATE flow below");
		expect(p).toContain("ship executor");
		// the standard APPROVE GATE block itself is present for the QA phase
		expect(p).toContain("APPROVE GATE (MANDATORY");
	});

	it("FAIL commits findings first, then PARKS for the keep-alive RE-TEST loop (default ON) — never complete, never approve gate", async () => {
		// FLY-887: keep-alive is default ON, so the FAIL branch now parks for a
		// RE-TEST wake (the implementer stays alive to fix), NOT the old
		// close-and-respawn "Implement-fix phase" / "Do NOT park for retest" text.
		const p = await buildPrompt({
			sessionRole: "qa",
			shareParentBranch: true,
		});
		expect(p).toContain("On FAIL");
		expect(p).toContain("--status fail");
		expect(p).toContain("RE-TEST wake");
		expect(p).toContain("park --exec-id");
		expect(p).toContain("turn --exec-id");
		expect(p).toContain("Do NOT run `complete`");
		// the legacy close-and-respawn wording is gone under keep-alive
		expect(p).not.toContain("Do NOT park for retest");
		expect(p).not.toContain("the pipeline closes this session");
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
