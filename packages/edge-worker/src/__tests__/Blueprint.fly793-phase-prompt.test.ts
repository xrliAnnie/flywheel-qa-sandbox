/**
 * FLY-793 — Blueprint DAG workflow-prompt contract.
 *
 * A DAG workflow run is ONE issue with Design → Implement → QA phase-sessions on
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
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
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
	nodeId = "FLY-793",
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
	await blueprint.run(makeNode(nodeId), "/tmp/fly793-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("Blueprint DAG workflow prompt (FLY-793)", () => {
	it("Design phase: designs + completes via phase_design_complete, no implement/land steps", async () => {
		const p = await buildPrompt({
			sessionRole: "design",
			shareParentBranch: true,
		});
		expect(p).toContain("DESIGN phase");
		expect(p).toContain("phase_design_complete");
		expect(p).toContain("Founder design HTML (MANDATORY)");
		expect(p).toContain("1) one-sentence summary");
		expect(p).toContain("2) core flow diagram");
		expect(p).toContain("3) data / structure model");
		expect(p).toContain("4) key tradeoffs and rejected alternatives");
		expect(p).toContain("5) honest boundary");
		expect(p).toContain("INTERACTIVE COMMENT LAYER (MANDATORY");
		expect(p).toContain("localStorage");
		expect(p).toContain("location.pathname");
		expect(p).toContain('nonce="__CSP_NONCE__"');
		expect(p).toContain("Do NOT include your own Content-Security-Policy meta");
		expect(p).toContain("addEventListener");
		expect(p).toContain("HTML-escape");
		expect(p).toContain("textContent/value");
		expect(p).toContain("navigator.clipboard.writeText");
		expect(p).toContain("unavailable OR its promise rejects");
		expect(p).toContain("execCommand('copy')");
		expect(p).toContain("【页面意见汇总】FLY-793");
		expect(p).toContain("about 1800 characters");
		expect(p).toContain("repeat the marker on every chunk");
		expect(p).toContain("DIAGRAMS AND LANGUAGE (MANDATORY");
		expect(p).toContain("mmdc");
		expect(p).toContain("inline that SVG");
		expect(p).toContain("no runtime mermaid.js");
		expect(p).toContain("first time each technical term appears");
		expect(p).toContain("Do NOT fake diagrams with CSS boxes");
		expect(p).toContain("retry once with standard flags");
		expect(p).toContain("DIAGRAM PENDING LOCAL RENDER");
		expect(p).toContain("hosted or remote diagram rendering service");
		expect(p).toContain("mmdc --svgId");
		expect(p).toContain("unique per diagram");
		expect(p).toContain("plain-language explanation");
		expect(p).toContain("doc/FLY-793-<slug>/");
		expect(p).toContain("--publish-only");
		expect(p).toContain("--lead product-lead");
		expect(p).toContain("DESIGN-HTML ready:");
		expect(p).toContain("does NOT wait for founder review");
		// design does NOT get the default implement step (step 6 controls this)
		expect(p).not.toContain("Create a feature branch");
		// NOTE: the shared LEAD-REPORT-BACK / approve-gate contract still appears
		// here (it lives inside the leadId block). Gating that per-phase is coupled
		// to the orchestration flow (approve fires after QA, not at Design) →
		// completed in Step 7 (workflow engine). Design's explicit "do NOT PR/ship"
		// step overrides in the meantime, and shared_workflow is off by default.
	});

	it("Design phase: uses the human issue identifier when the canonical issue id is a UUID", async () => {
		const p = await buildPrompt(
			{
				sessionRole: "design",
				shareParentBranch: true,
				issueIdentifier: "FLY-1404",
			},
			"71abbe4c-117d-475c-8adc-ce4d0dba9e84",
		);

		expect(p).toContain("doc/FLY-1404-<slug>/");
		expect(p).toContain("issue: FLY-1404");
		expect(p).not.toContain("doc/71abbe4c-117d-475c-8adc-ce4d0dba9e84-");
	});

	it("Implement phase: reads committed design, does the PR", async () => {
		const p = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(p).toContain("IMPLEMENT phase");
		expect(p).toContain("committed design");
		expect(p).toContain("create a GitHub PR");
		expect(p).not.toContain("Founder design HTML (MANDATORY)");
		expect(p).not.toContain("INTERACTIVE COMMENT LAYER");
		expect(p).not.toContain("DIAGRAMS AND LANGUAGE");
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
		expect(p).not.toContain("INTERACTIVE COMMENT LAYER");
		expect(p).not.toContain("DIAGRAMS AND LANGUAGE");
	});

	it("byte-compat: no shareParentBranch → default single-session prompt", async () => {
		const p = await buildPrompt({});
		expect(p).toContain("Create a feature branch");
		expect(p).not.toContain("DESIGN phase");
		expect(p).not.toContain("IMPLEMENT phase");
		expect(p).not.toContain("INTERACTIVE COMMENT LAYER");
		expect(p).not.toContain("DIAGRAMS AND LANGUAGE");
	});

	it("shareParentBranch but sessionRole main → still default (not a phase)", async () => {
		const p = await buildPrompt({ shareParentBranch: true });
		expect(p).toContain("Create a feature branch");
		expect(p).not.toContain("DESIGN phase");
		expect(p).not.toContain("INTERACTIVE COMMENT LAYER");
		expect(p).not.toContain("DIAGRAMS AND LANGUAGE");
	});
});
