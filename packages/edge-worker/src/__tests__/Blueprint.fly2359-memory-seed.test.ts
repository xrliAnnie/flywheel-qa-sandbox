import type { AdmitCodexAgentHomeResult } from "flywheel-claude-runner";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import { Blueprint, type ShellRunner } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

describe("FLY-2359 Blueprint memory seed wiring", () => {
	it("passes a lazy source loader bound to the exact project, node, and execution", async () => {
		const sourceLoader = vi.fn(() => ({ sources: [], skipped: [] }));
		const adapter: IAdapter = {
			type: "mock",
			supportsStreaming: false,
			checkEnvironment: async () => ({ healthy: true, message: "mock" }),
			execute: vi.fn(
				async (
					_ctx: AdapterExecutionContext,
				): Promise<AdapterExecutionResult> => ({
					success: true,
					sessionId: "session",
					durationMs: 1,
				}),
			),
		};
		const admit = vi.fn(
			async (
				input: Parameters<
					typeof import("flywheel-claude-runner").admitCodexAgentHome
				>[0],
			): Promise<AdmitCodexAgentHomeResult> => {
				expect(input).toMatchObject({
					project: "flywheel",
					role: "implement",
					executionId: "exec-new",
				});
				expect(await input.loadMemorySeedSources?.()).toEqual({
					sources: [],
					skipped: [],
				});
				return {
					handle: {
						project: "flywheel",
						role: "implement",
						home: "/tmp/fly2359-home",
						executionId: "exec-new",
						token: "0123456789abcdef0123456789abcdef",
					},
					effectiveAssemblyArm: "bare",
					inherited: false,
					liveLeases: 1,
					createdLease: true,
					memorySeed: "published",
				};
			},
		);
		const gitChecker = {
			assertCleanTree: vi.fn(async () => {}),
			captureBaseline: vi.fn(async () => "base"),
			check: vi.fn(async () => ({
				hasNewCommits: true,
				commitCount: 1,
				filesChanged: 1,
				commitMessages: ["feat: test"],
			})),
		} as unknown as GitResultChecker;
		const blueprint = new Blueprint(
			new PreHydrator(async () => ({
				title: "Memory seed",
				description: "test",
				labels: [],
			})),
			gitChecker,
			() => adapter,
			{
				execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
			} as ShellRunner,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => true,
			undefined,
			() => true,
			() => ({ disableNames: [] }),
			() => ({ hasOverride: true, raw: "bare" }),
			undefined,
			undefined,
			undefined,
			undefined,
		);
		blueprint.setCodexMemorySeedSources(sourceLoader);
		Object.assign(blueprint, {
			codexAgentHomeAdmitter: admit,
			codexAgentHomeReleaser: vi.fn(async () => {}),
		});

		await blueprint.run(
			{ id: "FLY-2359", blockedBy: [] },
			"/tmp/fly2359-project",
			{
				teamName: "eng",
				runnerName: "codex",
				projectName: "flywheel",
				runnerBackend: "codex-tmux",
				executionId: "exec-new",
				generalizedExecutionContext: {
					nodeId: "implement",
					workkind: "code",
					phase: "implement",
				},
				workflowCapabilities: { completion_route: "needs_review" },
				workflowAgentContent: "Implement the issue",
			},
		);

		expect(admit).toHaveBeenCalledOnce();
		expect(sourceLoader).toHaveBeenCalledWith({
			project: "flywheel",
			role: "implement",
			currentExecutionId: "exec-new",
		});
	});
});
