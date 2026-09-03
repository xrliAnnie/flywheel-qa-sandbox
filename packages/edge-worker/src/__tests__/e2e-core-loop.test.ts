/**
 * E2E integration test: single-issue Blueprint pipeline.
 *
 * Exercises a literal issue node through hydration, runner launch, and the
 * git-result success check with all external services mocked.
 */

import type { AdapterExecutionResult, IAdapter } from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function makeAdapter(): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "session-1",
				tmuxWindow: "flywheel:@1",
				durationMs: 5_000,
			}),
		),
	};
}

function makeGitChecker(): GitResultChecker {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 3,
			commitMessages: ["feat: implement"],
		})),
	} as unknown as GitResultChecker;
}

function makeShell(): ShellRunner {
	return {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
	};
}

function makeContext(): BlueprintContext {
	return {
		executionId: "test-exec-id",
		teamName: "eng",
		runnerName: "claude",
	};
}

describe("Core Loop E2E", () => {
	it("runs one issue node through Blueprint and verifies a committed result", async () => {
		const node: DagNode = { id: "GEO-101", blockedBy: [] };
		const adapter = makeAdapter();
		const blueprint = new Blueprint(
			new PreHydrator(async (id) => ({
				title: `Issue ${id}`,
				description: `Description for ${id}`,
			})),
			makeGitChecker(),
			() => adapter,
			makeShell(),
		);

		const result = await blueprint.run(node, "/geoforge3d", makeContext());

		expect(result.success).toBe(true);
		expect(result.sessionId).toBe("session-1");
		const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0];
		expect(runCall.prompt).toContain("GEO-101");
		expect(runCall.prompt).toContain("Issue GEO-101");
	});
});
