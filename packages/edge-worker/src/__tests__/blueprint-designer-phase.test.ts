/**
 * FLY-1059 — Blueprint three-stage Design phase mockup-first upgrade.
 *
 * A UI/design-flavored three-stage Design phase runs the mockup-first Designer
 * workflow (concept images A/B/C → founder design gate → high-fidelity) instead
 * of the generic brainstorm→plan text design. Every other case — non-UI Design,
 * Implement, QA, single-session — stays byte-identical to before (the byte-compat
 * seam this test locks). Mirrors Blueprint.fly793-phase-prompt.test.ts.
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

function makeNode(id = "FLY-1059"): DagNode {
	return { id, blockedBy: [] };
}

/** Hydrator whose fetched labels are configurable (R2#5 fallback path). */
function makeHydrator(labels: string[] = []) {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
		labels,
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
	hydratorLabels: string[] = [],
): Promise<{ prompt: string; system: string }> {
	const adapter = makeMockAdapter();
	const blueprint = new Blueprint(
		makeHydrator(hydratorLabels),
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
	await blueprint.run(makeNode(), "/tmp/fly1059-blueprint-test", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return { prompt: call.prompt ?? "", system: call.appendSystemPrompt ?? "" };
}

describe("Blueprint Design phase — mockup-first (FLY-1059)", () => {
	it("UI-flavored Design phase → mockup-first Designer workflow", async () => {
		const { prompt, system } = await buildPrompt({
			sessionRole: "design",
			shareParentBranch: true,
			issueLabels: ["ui"],
		});
		// main prompt
		expect(prompt).toContain("mockup-first");
		expect(prompt).toContain("concept directions");
		// system prompt: the mockup-first anchors
		expect(system).toContain("mockup-first Designer workflow");
		expect(system).toContain("confirm the mockup TYPE");
		expect(system).toContain("DESIGN GATE");
		expect(system).toContain("codex-image");
		expect(system).toContain("gemini-image");
		expect(system).toContain("phase_design_complete");
		// it is NOT the generic text-design phase, and never the implement/land steps
		expect(system).not.toContain(
			"brainstorm → research → plan → design review",
		);
		expect(system).not.toContain("Create a feature branch");
	});

	it("byte-compat: non-UI (backend) Design phase → the existing generic design prompt", async () => {
		const { prompt, system } = await buildPrompt({
			sessionRole: "design",
			shareParentBranch: true,
			issueLabels: ["backend"],
		});
		// unchanged generic text-design contract
		expect(prompt).toContain(
			"Produce the design (brainstorm → research → plan → design review)",
		);
		expect(system).toContain("DESIGN phase");
		expect(system).toContain("brainstorm → research → plan → design review");
		expect(system).toContain("phase_design_complete");
		// none of the mockup-first anchors leak in
		expect(prompt).not.toContain("mockup-first");
		expect(system).not.toContain("mockup-first Designer workflow");
		expect(system).not.toContain("confirm the mockup TYPE");
	});

	it("hydrated-labels fallback: no ctx.issueLabels, hydrator returns [ui] → still mockup-first (R2#5)", async () => {
		const { system } = await buildPrompt(
			{ sessionRole: "design", shareParentBranch: true },
			["ui"], // hydrator-provided labels
		);
		expect(system).toContain("mockup-first Designer workflow");
		expect(system).not.toContain(
			"brainstorm → research → plan → design review",
		);
	});

	it("guard requires the Design phase: UI label but NOT a phase → default single-session", async () => {
		const { prompt, system } = await buildPrompt({
			issueLabels: ["ui"],
		});
		expect(prompt).toContain("Implement FLY-1059");
		expect(system).toContain("Create a feature branch");
		expect(system).not.toContain("mockup-first Designer workflow");
		expect(system).not.toContain("DESIGN phase");
	});

	it("Implement/QA phases are unaffected by a UI label", async () => {
		const impl = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
			issueLabels: ["ui"],
		});
		expect(impl.system).toContain("IMPLEMENT phase");
		expect(impl.system).not.toContain("mockup-first Designer workflow");

		const qa = await buildPrompt({
			sessionRole: "qa",
			shareParentBranch: true,
			issueLabels: ["ui"],
		});
		expect(qa.system).toContain("QA phase");
		expect(qa.system).not.toContain("mockup-first Designer workflow");
	});
});
