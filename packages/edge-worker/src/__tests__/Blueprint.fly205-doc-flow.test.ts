/**
 * FLY-205 — DOC-FLOW prompt injection contract.
 *
 * Covers:
 *  - tier shapes: full / plan_only / none (default = full)
 *  - `design_review --plan <path>` is spelled out for full + plan_only
 *    (Bridge Codex auto-trigger listens on stage_changed=design_review and
 *    fail-closes without --plan — Codex design R1 #4)
 *  - department resolution: concrete owningDept wins; "multiple"/undefined
 *    fall back to default_department (Codex design R1 #1)
 *  - issueKey uses the human identifier, never an opaque/UUID body id;
 *    missing URL degrades the header line (Codex design R1 #2)
 *  - OFF sentinel: absent OR disabled doc_flow → byte-identical prompt with
 *    zero DOC-FLOW content (FLY-175 reverse-compat discipline)
 *  - agent.md coexistence: DOC-FLOW and `## Baseline Rules` both survive when
 *    a project executor prepends Agent Role content
 *  - shipped-generic constructor regression: docFlowConfig is the LAST param —
 *    flywheelRepoRoot stays in its slot (Codex design R2 #5)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";
import type { BlueprintContext, DocTier, ShellRunner } from "../Blueprint.js";
import {
	Blueprint,
	parseDocTier,
	resolveDocFlowDepartment,
} from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import {
	resolvedTestAgent,
	testAgentFallbacks,
} from "./agent-dispatch-fixtures.js";

function makeNode(id = "LEARN-21"): DagNode {
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
			commitMessages: ["feat: implement feature"],
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

interface BuildOpts {
	docFlowConfig?: { enabled: boolean; default_department?: string };
	docFlowEnabled?: () => boolean;
	ctxExtra?: Partial<BlueprintContext>;
	agentDispatcher?: AgentDispatcher;
	projectRoot?: string;
	nodeId?: string;
}

async function buildPrompt(opts: BuildOpts = {}): Promise<string> {
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
		opts.agentDispatcher,
		undefined, // checkpointConfig
		undefined, // flywheelRepoRoot
		opts.docFlowConfig
			? { default_department: opts.docFlowConfig.default_department }
			: undefined,
		undefined, // ponytailConfig
		undefined, // ponytailReadiness
		undefined, // skillFrameworkParticipation
		undefined, // skillFrameworkReadiness
		undefined, // codexSkillAssemblyProbe
		undefined, // skillFrameworkModeControl
		opts.docFlowEnabled ?? (() => opts.docFlowConfig?.enabled === true),
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		projectName: "testproj",
		...opts.ctxExtra,
	};
	await blueprint.run(
		makeNode(opts.nodeId),
		opts.projectRoot ?? "/tmp/fly205-blueprint-test",
		ctx,
	);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

const ENABLED = { enabled: true, default_department: "content" };

describe("parseDocTier (single source of truth)", () => {
	it("accepts exactly the three tiers", () => {
		expect(parseDocTier("full")).toBe("full");
		expect(parseDocTier("plan_only")).toBe("plan_only");
		expect(parseDocTier("none")).toBe("none");
	});
	it("rejects everything else", () => {
		expect(parseDocTier("FULL")).toBeUndefined();
		expect(parseDocTier("")).toBeUndefined();
		expect(parseDocTier(undefined)).toBeUndefined();
		expect(parseDocTier(null)).toBeUndefined();
		expect(parseDocTier(42)).toBeUndefined();
		expect(parseDocTier("plan")).toBeUndefined();
	});
});

describe("resolveDocFlowDepartment", () => {
	it("uses a concrete owningDept string", () => {
		expect(resolveDocFlowDepartment("product", "content")).toBe("product");
	});
	it('falls back on the literal "multiple" (never a directory name)', () => {
		expect(resolveDocFlowDepartment("multiple", "content")).toBe("content");
	});
	it("falls back on undefined", () => {
		expect(resolveDocFlowDepartment(undefined, "content")).toBe("content");
	});
});

describe("DOC-FLOW injection (FLY-205)", () => {
	it("full tier: three docs + stage commands + design_review --plan", async () => {
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			ctxExtra: { docTier: "full" as DocTier },
		});
		expect(prompt).toContain("DOC-FLOW");
		expect(prompt).toContain("Doc tier for this task: full");
		expect(prompt).toContain("exploration.md");
		expect(prompt).toContain("research.md");
		expect(prompt).toContain("plan.md");
		expect(prompt).toContain(
			"stage set design_review --plan content/doc/LEARN-21-<slug>/plan.md",
		);
		// gates-never-skipped semantics is spelled out
		expect(prompt).toContain("DOCUMENT OUTPUT ONLY");
	});

	it("default tier (docTier omitted) = full", async () => {
		const prompt = await buildPrompt({ docFlowConfig: ENABLED });
		expect(prompt).toContain("Doc tier for this task: full");
	});

	it("plan_only tier: only plan.md, still design_review --plan", async () => {
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			ctxExtra: { docTier: "plan_only" as DocTier },
		});
		expect(prompt).toContain("Doc tier for this task: plan_only");
		expect(prompt).toContain("plan_only: produce only plan.md");
		expect(prompt).toContain(
			"stage set design_review --plan content/doc/LEARN-21-<slug>/plan.md",
		);
		expect(prompt).not.toContain("exploration.md,");
	});

	it("none tier: no docs required, no header template, veto note present", async () => {
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			ctxExtra: { docTier: "none" as DocTier },
		});
		expect(prompt).toContain("Doc tier for this task: none");
		expect(prompt).toContain("no process docs required");
		expect(prompt).not.toContain("Every doc starts with title");
	});

	it("department: concrete owningDept wins over default", async () => {
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			ctxExtra: { owningDept: "product" },
		});
		expect(prompt).toContain("Folder: product/doc/LEARN-21-<slug>/");
	});

	it('department: "multiple" falls back to default_department', async () => {
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			ctxExtra: { owningDept: "multiple" },
		});
		expect(prompt).toContain("Folder: content/doc/LEARN-21-<slug>/");
		expect(prompt).not.toContain("multiple/doc/");
	});

	it("issueKey: human identifier wins over opaque node id; URL baked into header", async () => {
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			nodeId: "a1b2c3d4-uuid-like-opaque-id",
			ctxExtra: {
				issueIdentifier: "LEARN-21",
				issueUrl: "https://linear.app/x/issue/LEARN-21",
			},
		});
		expect(prompt).toContain("Folder: content/doc/LEARN-21-<slug>/");
		expect(prompt).not.toContain("a1b2c3d4-uuid-like-opaque-id-<slug>");
		expect(prompt).toContain(
			"Issue: LEARN-21 (https://linear.app/x/issue/LEARN-21)",
		);
	});

	it("missing URL degrades the header line (key-only)", async () => {
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			ctxExtra: { issueIdentifier: "LEARN-21" },
		});
		expect(prompt).toContain("Issue: LEARN-21 (URL 不可得");
	});

	it("OFF sentinel: absent and disabled configs produce byte-identical prompts with zero DOC-FLOW content", async () => {
		// FLY-795: pin executionId so the comparison isolates the doc_flow config
		// difference from the (config-independent) PROGRESS LEDGER block, which bakes
		// the runner's exec-id like the other comm-command prompt lines.
		const pin = { ctxExtra: { executionId: "fly205-fixed-exec" } };
		const absent = await buildPrompt({ ...pin });
		const disabled = await buildPrompt({
			...pin,
			docFlowConfig: { enabled: false, default_department: "content" },
		});
		expect(disabled).toBe(absent); // byte-identical
		expect(absent).not.toContain("DOC-FLOW");
	});

	it("enabled but default_department missing: fail-safe skip (no broken path), warns", async () => {
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const prompt = await buildPrompt({
			docFlowConfig: { enabled: true },
		});
		expect(prompt).not.toContain("DOC-FLOW");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("default_department is missing"),
		);
		warnSpy.mockRestore();
	});

	it("store read failure disables DOC-FLOW locally and warns", async () => {
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			docFlowEnabled: () => {
				throw new Error("flag store unavailable");
			},
		});
		expect(prompt).not.toContain("DOC-FLOW (project doc conventions");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("flag store unavailable"),
		);
		warnSpy.mockRestore();
	});
});

describe("DOC-FLOW with project agent.md (coexistence + constructor slot regression)", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fly205-agent-"));
	afterAll(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("Agent Role, DOC-FLOW and Baseline Rules all present together", async () => {
		const agentsDir = path.join(tmpRoot, ".flywheel", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "exec.md"),
			"# Test Executor\nProject executor content marker XYZZY.",
		);
		const dispatcher = new AgentDispatcher(
			{
				exec: resolvedTestAgent({
					nodeName: "exec",
					labels: ["whatever"],
					projectRoot: tmpRoot,
					relativeFile: "exec.md",
				}),
			},
			"exec",
			testAgentFallbacks(tmpRoot),
		);
		const prompt = await buildPrompt({
			docFlowConfig: ENABLED,
			agentDispatcher: dispatcher,
			projectRoot: tmpRoot,
			ctxExtra: { docTier: "plan_only" as DocTier },
		});
		// All three layers coexist: executor prepended, baseline kept, DOC-FLOW in
		expect(prompt).toContain("XYZZY");
		expect(prompt).toContain("## Baseline Rules");
		expect(prompt).toContain("DOC-FLOW");
		// Order: Agent Role first, then baseline (which contains DOC-FLOW)
		expect(prompt.indexOf("XYZZY")).toBeLessThan(
			prompt.indexOf("## Baseline Rules"),
		);
	});

	it("registry general fallback coexists with enabled doc_flow", async () => {
		// flywheelRepoRoot = real repo root (4 levels up from this test file dir
		// at runtime is fragile — use the package path resolution instead).
		const repoRoot = path.resolve(__dirname, "../../../..");
		const genericPath = path.join(
			repoRoot,
			".flywheel",
			"agents",
			"nodes",
			"general.md",
		);
		// Precondition: shipped file exists in this checkout
		expect(fs.existsSync(genericPath)).toBe(true);

		const adapter = makeMockAdapter();
		const dispatcher = new AgentDispatcher(
			{},
			undefined,
			testAgentFallbacks(repoRoot),
		);
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
			dispatcher,
			undefined, // checkpointConfig
			repoRoot, // flywheelRepoRoot — must stay in ITS slot
			ENABLED, // doc-flow department authoring config
			undefined, // ponytailConfig
			undefined, // ponytailReadiness
			undefined, // skillFrameworkParticipation
			undefined, // skillFrameworkReadiness
			undefined, // codexSkillAssemblyProbe
			undefined, // skillFrameworkModeControl
			() => true, // project-scoped doc_flow flag-store reader
		);
		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "claude",
			projectName: "testproj",
		};
		await blueprint.run(makeNode(), "/tmp/fly205-generic-test", ctx);
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const prompt = call.appendSystemPrompt ?? "";
		// Shipped-generic content loaded (constructor slots not misaligned)
		expect(prompt).toContain("Flywheel General Executor");
		// AND the DOC-FLOW block is present
		expect(prompt).toContain("DOC-FLOW");
	});

	it("OFF sentinel for shipped-generic fallback: absent config → injected DOC-FLOW block absent (Codex code R1 HIGH-1; FLY-217 allows static override-B prose)", async () => {
		// Zero-config projects use the STATIC shipped generic-executor.md as
		// their prompt surface. The byte-compat guarantee that must hold with
		// doc_flow absent is that the runtime-injected DOC-FLOW *block* (the one
		// Blueprint conditionally unshifts, carrying real dept/issue/tier values)
		// is NOT present.
		//
		// FLY-217 update: generic-executor.md now carries conditional doc-flow
		// HANDLING instructions (override B: "If a DOC-FLOW block is present
		// elsewhere in this prompt …"). That static prose legitimately mentions
		// "DOC-FLOW"/"doc-flow path" and is INERT when no block is injected — so
		// we assert on the injected block's distinctive markers, not the bare
		// word the override references.
		const repoRoot = path.resolve(__dirname, "../../../..");
		const adapter = makeMockAdapter();
		const dispatcher = new AgentDispatcher(
			{},
			undefined,
			testAgentFallbacks(repoRoot),
		);
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
			dispatcher,
			undefined, // checkpointConfig
			repoRoot, // flywheelRepoRoot
			undefined, // docFlowConfig ABSENT
		);
		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "claude",
			projectName: "testproj",
		};
		await blueprint.run(makeNode(), "/tmp/fly205-generic-off-test", ctx);
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const prompt = call.appendSystemPrompt ?? "";
		expect(prompt).toContain("Flywheel General Executor");
		// FLY-217: assert the runtime-injected DOC-FLOW block is absent (its
		// distinctive header + lines), NOT the bare word — generic-executor.md's
		// override-B prose legitimately contains "DOC-FLOW"/"doc-flow path".
		expect(prompt).not.toContain("DOC-FLOW (project doc conventions");
		expect(prompt).not.toContain("doc_flow enabled");
		expect(prompt).not.toContain("Doc tier for this task:");
	});
});
