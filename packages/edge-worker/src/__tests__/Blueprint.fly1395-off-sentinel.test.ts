/**
 * FLY-1395 reverse-compat sentinel for the Codex assembly path.
 *
 * Default env must contribute no attribution, adapter fields, prompt variant,
 * or per-runner skill state. The mutation test drives the same harness through
 * bare and proves every ruler trips when the mechanism is active.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_FRAMEWORK_MODE_ENV } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { EventEnvelope } from "../ExecutionEventEmitter.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";
import {
	resolvedTestAgent,
	testAgentFallbacks,
} from "./agent-dispatch-fixtures.js";

const ID = "FLY-1395";

async function runCodex(envValue?: string): Promise<{
	envelope: EventEnvelope;
	execArgs: AdapterExecutionContext;
}> {
	if (envValue === undefined) delete process.env[SKILL_FRAMEWORK_MODE_ENV];
	else process.env[SKILL_FRAMEWORK_MODE_ENV] = envValue;

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-sentinel-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	const agents = path.join(root, ".flywheel", "agents");
	fs.mkdirSync(agents, { recursive: true });
	fs.writeFileSync(path.join(agents, "exec.md"), "SENTINEL-BASELINE");
	fs.writeFileSync(path.join(agents, "exec.bare.md"), "SENTINEL-BARE");

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
	const envelopes: EventEnvelope[] = [];
	const worktreeManager = {
		expectedWorktree: () => ({ path: root, branch: "flywheel-FLY-1395" }),
		isRegistered: async () => false,
		removeIfExists: async () => true,
		create: async () => ({
			projectName: "flywheel",
			issueId: ID,
			worktreePath: root,
			branch: "flywheel-FLY-1395",
			mainRepoPath: "/tmp/flywheel-main",
		}),
	} as unknown as WorktreeManager;
	const dispatcher = new AgentDispatcher(
		{
			exec: resolvedTestAgent({
				nodeName: "exec",
				labels: ["x"],
				projectRoot: root,
				relativeFile: "exec.md",
			}),
		},
		"exec",
		testAgentFallbacks(root),
	);
	const blueprint = new Blueprint(
		new PreHydrator(async () => ({
			title: "FLY-1395 sentinel",
			description: "fixture",
			labels: [],
		})),
		{
			assertCleanTree: vi.fn(async () => {}),
			captureBaseline: vi.fn(async () => "abc"),
			check: vi.fn(async () => ({
				hasNewCommits: true,
				commitCount: 1,
				filesChanged: 1,
				commitMessages: ["test"],
			})),
		} as unknown as GitResultChecker,
		() => adapter,
		{
			execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
		} as ShellRunner,
		worktreeManager,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			emitStarted: async (envelope: EventEnvelope) => {
				envelopes.push(envelope);
			},
		} as never,
		dispatcher,
		undefined, // checkpointConfig
		undefined, // flywheelRepoRoot
		undefined, // docFlowConfig
		undefined, // ponytailConfig
		undefined, // ponytailReadiness
		undefined, // skillFrameworkParticipation
		() => true, // skillFrameworkReadiness
		() => ({ disableNames: ["superpowers:fixture"] }),
		() => ({
			hasOverride: envValue !== undefined,
			raw: envValue ?? null,
		}),
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "codex",
		runnerBackend: "codex-tmux",
		projectName: "flywheel",
		issueIdentifier: ID,
	};
	await blueprint.run({ id: ID, blockedBy: [] } as DagNode, root, ctx);
	return {
		envelope: envelopes[0] as EventEnvelope,
		execArgs: (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as AdapterExecutionContext,
	};
}

afterEach(() => {
	delete process.env[SKILL_FRAMEWORK_MODE_ENV];
	vi.restoreAllMocks();
});

describe("FLY-1395 Codex OFF sentinel", () => {
	it("default env contributes no assembly state and selects the baseline prompt", async () => {
		const { envelope, execArgs } = await runCodex();
		expect("skillFrameworkMode" in envelope).toBe(false);
		expect("skillFrameworkModeVia" in envelope).toBe(false);
		expect("skillFrameworkMode" in execArgs).toBe(false);
		expect("codexSkillDisableNames" in execArgs).toBe(false);
		expect("codexMattSkillsSourceDir" in execArgs).toBe(false);
		expect(execArgs.appendSystemPrompt).toContain("SENTINEL-BASELINE");
		expect(execArgs.appendSystemPrompt).not.toContain("SENTINEL-BARE");
	});

	it("mutation: bare trips attribution, adapter, and prompt-variant rulers", async () => {
		const { envelope, execArgs } = await runCodex("bare");
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect(execArgs.skillFrameworkMode).toBe("bare");
		expect(execArgs.codexSkillDisableNames).toEqual(["superpowers:fixture"]);
		expect(execArgs.appendSystemPrompt).toContain("SENTINEL-BARE");
		expect(execArgs.appendSystemPrompt).not.toContain("SENTINEL-BASELINE");
	});
});
