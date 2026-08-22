/**
 * FLY-1356 — reverse-compat OFF sentinel (FLY-205 OFF-sentinel discipline).
 *
 * RED LINE #1: with the flag at its default (FLYWHEEL_SKILL_FRAMEWORK_MODE
 * unset, no project skill_framework key), Blueprint's outputs are
 * byte-compatible with the pre-FLY-1356 shape:
 *   - the session_started envelope carries NONE of the new fields
 *   - adapter.execute receives NO plugin-layer fields (absent, not empty)
 *   - the agent prompt is the BASELINE file even when variants exist on disk
 *
 * MUTATION VALIDATION (vacuous-green discipline): the same harness with the
 * flag deliberately set MUST trip every one of those assertions — proving the
 * sentinel's ruler actually measures the mechanism it guards.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";
import type { BlueprintContext } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { EventEnvelope } from "../ExecutionEventEmitter.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function makeNode(): DagNode {
	return { id: "FLY-1356", blockedBy: [] };
}

async function runOnce(opts: {
	envValue?: string;
	projectRoot?: string;
	agentDispatcher?: AgentDispatcher;
	participation?: (projectName: string | undefined) => boolean;
}): Promise<{ envelope: EventEnvelope; execArgs: AdapterExecutionContext }> {
	const envelopes: EventEnvelope[] = [];
	const adapter: IAdapter = {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess",
				tmuxWindow: "w:@1",
				durationMs: 1,
			}),
		),
	};
	const blueprint = new Blueprint(
		new PreHydrator(async (id) => ({
			title: `Issue ${id}`,
			description: "d",
			labels: [],
		})),
		{
			assertCleanTree: vi.fn(async () => {}),
			captureBaseline: vi.fn(async () => "abc"),
			check: vi.fn(async () => ({
				hasNewCommits: false,
				commitCount: 0,
				filesChanged: 0,
				commitMessages: [],
			})),
		} as unknown as GitResultChecker,
		() => adapter,
		{ execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })) },
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			emitStarted: async (e: EventEnvelope) => {
				envelopes.push(e);
			},
		} as any,
		opts.agentDispatcher,
		undefined, // checkpointConfig
		undefined, // flywheelRepoRoot
		undefined, // docFlowConfig
		undefined, // ponytailConfig
		undefined, // ponytailReadiness
		opts.participation,
		() => true, // matt readiness stub (irrelevant at default)
		undefined, // codexSkillAssemblyProbe
		() => ({
			hasOverride: opts.envValue !== undefined,
			raw: opts.envValue ?? null,
		}),
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		projectName: "testproj",
		issueIdentifier: "FLY-1356",
	};
	await blueprint.run(
		makeNode(),
		opts.projectRoot ?? "/tmp/fly1356-sentinel",
		ctx,
	);
	return {
		envelope: envelopes[0] as EventEnvelope,
		execArgs: (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext,
	};
}

afterEach(() => vi.restoreAllMocks());

const NEW_ENVELOPE_KEYS = ["skillFrameworkMode", "skillFrameworkModeVia"];
const NEW_EXEC_KEYS = ["disabledPlugins", "enabledPluginsExtra"];

describe("FLY-1356 OFF sentinel — default env is byte-compatible", () => {
	it("envelope + adapter args carry NONE of the FLY-1356 fields at default", async () => {
		const { envelope, execArgs } = await runOnce({});
		for (const key of NEW_ENVELOPE_KEYS) {
			expect(key in envelope, `envelope leaked ${key}`).toBe(false);
		}
		for (const key of NEW_EXEC_KEYS) {
			expect(key in execArgs, `execArgs leaked ${key}`).toBe(false);
		}
	});

	it("A arm reads the BASELINE agent file even when variants exist on disk", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1356-sent-"));
		const dir = path.join(root, ".flywheel", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "exec.md"), "SENTINEL-BASELINE");
		fs.writeFileSync(path.join(dir, "exec.bare.md"), "SENTINEL-VARIANT");
		const dispatcher = new AgentDispatcher(
			{
				exec: {
					agent_file: ".flywheel/agents/exec.md",
					match: { labels: ["x"] },
				},
			},
			"exec",
			root,
		);
		const { execArgs } = await runOnce({
			projectRoot: root,
			agentDispatcher: dispatcher,
		});
		expect(execArgs.appendSystemPrompt).toContain("SENTINEL-BASELINE");
		expect(execArgs.appendSystemPrompt).not.toContain("SENTINEL-VARIANT");
	});

	// MUTATION: the same ruler must go RED when the mechanism fires. If these
	// stop tripping, the sentinel above has gone vacuous — fix the harness.
	it("mutation: env=split makes the envelope gain the new fields (ruler works)", async () => {
		const { envelope } = await runOnce({ envValue: "split" });
		expect(envelope.skillFrameworkMode).toBeDefined();
		expect(envelope.skillFrameworkModeVia).toBe("hash");
	});

	it("the injected split control gates participation before issue-aware resolution", async () => {
		const participation = vi.fn(() => false);
		const { envelope } = await runOnce({
			envValue: "split",
			participation,
		});
		expect(participation).toHaveBeenCalledWith("testproj");
		expect(envelope).toMatchObject({
			skillFrameworkMode: "superpowers",
			skillFrameworkModeVia: "project_opt_out",
		});
	});

	it("mutation: env=bare makes the adapter args gain disabledPlugins (ruler works)", async () => {
		const { execArgs } = await runOnce({ envValue: "bare" });
		expect(execArgs.disabledPlugins).toBeDefined();
	});

	it("mutation: env=bare flips the agent file to the variant (ruler works)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1356-sent-"));
		const dir = path.join(root, ".flywheel", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "exec.md"), "SENTINEL-BASELINE");
		fs.writeFileSync(path.join(dir, "exec.bare.md"), "SENTINEL-VARIANT");
		const dispatcher = new AgentDispatcher(
			{
				exec: {
					agent_file: ".flywheel/agents/exec.md",
					match: { labels: ["x"] },
				},
			},
			"exec",
			root,
		);
		const { execArgs } = await runOnce({
			envValue: "bare",
			projectRoot: root,
			agentDispatcher: dispatcher,
		});
		expect(execArgs.appendSystemPrompt).toContain("SENTINEL-VARIANT");
	});
});
