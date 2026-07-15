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

function harness() {
	const adapter: IAdapter = {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "session",
				durationMs: 1,
			}),
		),
	};
	const hydrator = new PreHydrator(async (id) => ({
		title: `Issue ${id}`,
		description: "Bounded generalized task",
		labels: ["sonnet"],
	}));
	const git = {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "base"),
		check: vi.fn(async () => ({
			hasNewCommits: false,
			commitCount: 0,
			filesChanged: 0,
			commitMessages: [],
		})),
	} as unknown as GitResultChecker;
	const shell = {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
	} as ShellRunner;
	return {
		adapter,
		blueprint: new Blueprint(hydrator, git, () => adapter, shell),
	};
}

const node: DagNode = { id: "FLY-1281", blockedBy: [] };
const generalized: BlueprintContext = {
	teamName: "eng",
	runnerName: "codex",
	projectName: "flywheel",
	executionId: "exec-1",
	generalizedExecutionContext: {
		runId: "run-1",
		nodeId: "research",
		attempt: 1,
		snapshotDigest: "snapshot-digest",
	},
	workflowCapabilities: {
		shared_branch_writer: false,
		creates_pr: false,
		can_ship: false,
		can_land: false,
		produces_output: true,
		completion_route: "no_code",
	},
	workflowAgentContent: "Research the issue and produce one JSON artifact.",
	workflowOutputCredential: "output-ticket",
};

describe("Blueprint generalized workflow capability contract", () => {
	it("uses pinned agent/capabilities, injects the output ticket, and suppresses write/ship", async () => {
		const { blueprint, adapter } = harness();
		await blueprint.run(node, "/tmp/fly1281-generalized", generalized);
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const prompt = call.appendSystemPrompt ?? "";
		expect(prompt).toContain(
			"Research the issue and produce one JSON artifact.",
		);
		expect(prompt).toContain("workflow-output --payload-file");
		expect(prompt).toContain("complete --route no_code");
		expect(prompt).toContain("do not modify the shared branch");
		expect(prompt).toContain("Do not request ship approval");
		expect(prompt).not.toContain("BRAINSTORM GATE");
		expect(call.workflowOutputCredential).toBe("output-ticket");
	});

	it("fails closed when pinned generalized inputs are incomplete or unsupported", async () => {
		const first = harness();
		await expect(
			first.blueprint.run(node, "/tmp/fly1281-generalized", {
				...generalized,
				workflowAgentContent: "",
			}),
		).rejects.toThrow(/missing pinned capabilities or agent content/i);

		const second = harness();
		await expect(
			second.blueprint.run(node, "/tmp/fly1281-generalized", {
				...generalized,
				workflowCapabilities: {
					...generalized.workflowCapabilities,
					completion_route: "needs_review",
				},
			}),
		).rejects.toThrow(/unsupported generalized completion route/i);
	});
});
