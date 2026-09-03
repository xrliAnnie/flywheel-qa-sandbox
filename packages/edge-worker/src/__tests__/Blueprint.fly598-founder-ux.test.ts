/**
 * FLY-598 — FOUNDER-UX GATE prompt injection contract.
 *
 * Covers:
 *  - mode enforce / audit_only → the FOUNDER-UX GATE block is injected (gate
 *    instruction + self-declare guidance + stage set implement --ux-file).
 *  - OFF sentinel: absent OR mode:"off" → byte-identical prompt with ZERO
 *    founder-UX content (Codex R2-#6 byte-compat; the deliberate prompt change
 *    only happens in audit_only/enforce).
 *  - the retired env no longer changes prompt construction.
 */

import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
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

async function buildPrompt(): Promise<string> {
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

describe("FLY-1808 retired founder-UX gate", () => {
	beforeEach(() => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "1");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("legacy enable env no longer injects a founder-UX gate", async () => {
		const prompt = await buildPrompt();
		expect(prompt).not.toContain("FOUNDER-UX GATE");
		expect(prompt).not.toContain("await-founder-ux-gate --ux-file");
		expect(prompt).not.toContain("declare-founder-ux");
		expect(prompt).not.toContain("stage set implement --ux-file");
	});
});
