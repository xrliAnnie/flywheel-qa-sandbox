/**
 * FLY-598 — FOUNDER-UX GATE prompt injection contract.
 *
 * Covers:
 *  - mode enforce / audit_only → the FOUNDER-UX GATE block is injected (gate
 *    instruction + self-declare guidance + stage set implement --ux-file).
 *  - OFF sentinel: absent OR mode:"off" → byte-identical prompt with ZERO
 *    founder-UX content (Codex R2-#6 byte-compat; the deliberate prompt change
 *    only happens in audit_only/enforce).
 *  - founderUxGateConfig is the LAST constructor param (after docFlowConfig).
 */

import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

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
			filesChanged: 1,
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
			async (): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "s",
				tmuxWindow: "flywheel:@1",
				durationMs: 1,
			}),
		),
	};
}

async function buildPrompt(founderUxGateConfig?: {
	mode: "off" | "audit_only" | "enforce";
}): Promise<string> {
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
		undefined, // agentDispatcher
		undefined, // checkpointConfig
		undefined, // flywheelRepoRoot
		undefined, // docFlowConfig
		founderUxGateConfig, // FLY-598: LAST param
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		projectName: "testproj",
		// FLY-795: pin executionId so the OFF-sentinel byte-identical comparison
		// isolates the founder-UX config difference from the (config-independent)
		// PROGRESS LEDGER block, which bakes the runner's exec-id like the other
		// comm-command prompt lines do.
		executionId: "fly598-fixed-exec",
	};
	await blueprint.run(
		{ id: "FLY-598", blockedBy: [] } as DagNode,
		"/tmp/fly598-bp",
		ctx,
	);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("FOUNDER-UX GATE injection (FLY-598)", () => {
	// FLY-900: the gate is retired fleet-wide by default; the injection now also
	// requires the kill-switch to be explicitly re-enabled. These ON-path cases
	// run with it enabled so they still assert the original enforce behavior.
	beforeEach(() => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "1");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("enforce: injects the gate instruction + self-declare + ux-file stage", async () => {
		const prompt = await buildPrompt({ mode: "enforce" });
		expect(prompt).toContain("FOUNDER-UX GATE");
		expect(prompt).toContain("await-founder-ux-gate --ux-file");
		expect(prompt).toContain("declare-founder-ux");
		expect(prompt).toContain("stage set implement --ux-file");
	});

	it("audit_only: same deliberate injection present", async () => {
		const prompt = await buildPrompt({ mode: "audit_only" });
		expect(prompt).toContain("FOUNDER-UX GATE");
		expect(prompt).toContain("await-founder-ux-gate --ux-file");
	});

	it("OFF sentinel: absent and mode:off produce byte-identical prompts with zero founder-UX content", async () => {
		const absent = await buildPrompt(undefined);
		const off = await buildPrompt({ mode: "off" });
		expect(off).toBe(absent); // byte-identical
		expect(absent).not.toContain("FOUNDER-UX GATE");
		expect(absent).not.toContain("await-founder-ux-gate");
	});

	// FLY-900: with the kill-switch disabled (default), even an enforce/audit_only
	// project injects ZERO founder-UX content — byte-identical to the off prompt.
	it("FLY-900 kill-switch OFF: enforce injects NOTHING (byte-identical to off/absent)", async () => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "0"); // override beforeEach "1"
		const enforceDisabled = await buildPrompt({ mode: "enforce" });
		const auditDisabled = await buildPrompt({ mode: "audit_only" });
		const off = await buildPrompt({ mode: "off" });
		expect(enforceDisabled).toBe(off); // byte-identical — gate fully suppressed
		expect(auditDisabled).toBe(off);
		expect(enforceDisabled).not.toContain("FOUNDER-UX GATE");
		expect(enforceDisabled).not.toContain("await-founder-ux-gate");
	});
});
