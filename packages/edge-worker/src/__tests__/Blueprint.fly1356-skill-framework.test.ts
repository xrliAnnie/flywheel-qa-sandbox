/**
 * FLY-1356 — skill_framework_mode three-way switch: Blueprint apply layer.
 *
 * Covers:
 *  - default env (flag unset): envelope carries NO skill-framework fields and
 *    adapter args carry NO plugin fields (byte-compat red line #1)
 *  - forced bare/matt: superpowers disabled per-launch; matt additionally
 *    enables the vendored matt-skills plugin (research.md S1/S2 mechanism)
 *  - matt readiness probe failure → superpowers + via=fallback_superpowers
 *    (red line #2: never silently run a crippled B)
 *  - split: hash / override / sticky / inherited / project_opt_out vias
 *  - participation reader throwing → fail-closed pin to A (project_opt_out)
 *  - backend ≠ claude-tmux → via=noop_backend, zero plugin/prompt effect (R1#7)
 *  - FLY-751 mcpProfile merge: mode contributions ride the same fields;
 *    profile alone (default env) stays byte-identical
 *  - prompt layer: `<agent-file>.{matt,bare}.md` variant wins when present,
 *    baseline fallback when absent; A arm always reads the baseline
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	hashModeBucket,
	MATT_SKILLS_PLUGIN_KEY,
	SKILL_FRAMEWORK_MODE_ENV,
	SUPERPOWERS_PLUGIN_KEY,
} from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { EventEnvelope } from "../ExecutionEventEmitter.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

const ID = "FLY-1356";

function makeNode(id = ID): DagNode {
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

interface RunOpts {
	envValue?: string;
	ctxExtra?: Partial<BlueprintContext>;
	participation?: (projectName: string | undefined) => boolean;
	readiness?: (backend: string) => boolean;
	agentDispatcher?: AgentDispatcher;
	projectRoot?: string;
}

interface RunResult {
	envelope: EventEnvelope;
	execArgs: AdapterExecutionContext;
}

async function runBlueprint(opts: RunOpts = {}): Promise<RunResult> {
	if (opts.envValue === undefined) {
		delete process.env[SKILL_FRAMEWORK_MODE_ENV];
	} else {
		process.env[SKILL_FRAMEWORK_MODE_ENV] = opts.envValue;
	}
	const adapter = makeMockAdapter();
	const envelopes: EventEnvelope[] = [];
	const eventEmitter = {
		emitStarted: vi.fn(async (env: EventEnvelope) => {
			envelopes.push(env);
		}),
		emitHeartbeat: vi.fn(async () => {}),
		emitCompleted: vi.fn(async () => {}),
		emitFailed: vi.fn(async () => {}),
	};
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
		eventEmitter as any,
		opts.agentDispatcher,
		undefined, // checkpointConfig
		undefined, // flywheelRepoRoot
		undefined, // docFlowConfig
		undefined, // founderUxGateConfig
		undefined, // ponytailConfig
		undefined, // ponytailReadiness (default)
		opts.participation, // FLY-1356 participation reader
		opts.readiness ?? (() => true), // FLY-1356 matt readiness (default ready)
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		projectName: "testproj",
		issueIdentifier: ID,
		...opts.ctxExtra,
	};
	await blueprint.run(
		makeNode(),
		opts.projectRoot ?? "/tmp/fly1356-blueprint-test",
		ctx,
	);
	const execArgs = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return { envelope: envelopes[0] as EventEnvelope, execArgs };
}

afterEach(() => {
	delete process.env[SKILL_FRAMEWORK_MODE_ENV];
	vi.restoreAllMocks();
});

describe("FLY-1356 Blueprint — envelope + plugin layer", () => {
	it("default env: envelope has no skill-framework fields, args have no plugin fields", async () => {
		const { envelope, execArgs } = await runBlueprint();
		expect("skillFrameworkMode" in envelope).toBe(false);
		expect("skillFrameworkModeVia" in envelope).toBe(false);
		expect("disabledPlugins" in execArgs).toBe(false);
		expect("enabledPluginsExtra" in execArgs).toBe(false);
	});

	it("forced bare: superpowers disabled, no matt enable, envelope bare/forced", async () => {
		const { envelope, execArgs } = await runBlueprint({ envValue: "bare" });
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect(execArgs.disabledPlugins).toEqual([SUPERPOWERS_PLUGIN_KEY]);
		expect(execArgs.enabledPluginsExtra ?? []).not.toContain(
			MATT_SKILLS_PLUGIN_KEY,
		);
	});

	it("forced matt (ready): superpowers disabled + matt-skills enabled, envelope matt/forced", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "matt",
			readiness: () => true,
		});
		expect(envelope.skillFrameworkMode).toBe("matt");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect(execArgs.disabledPlugins).toEqual([SUPERPOWERS_PLUGIN_KEY]);
		expect(execArgs.enabledPluginsExtra).toEqual([MATT_SKILLS_PLUGIN_KEY]);
	});

	it("forced matt (probe FAILS): falls back to superpowers, via=fallback_superpowers, zero plugin effect", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { envelope, execArgs } = await runBlueprint({
			envValue: "matt",
			readiness: () => false,
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("fallback_superpowers");
		expect("disabledPlugins" in execArgs).toBe(false);
		expect("enabledPluginsExtra" in execArgs).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("matt-skills plugin not ready"),
		);
	});

	it("forced superpowers (kill position): recorded forced, zero plugin effect", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "superpowers",
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect("disabledPlugins" in execArgs).toBe(false);
	});

	it("split: first admission hashes the identifier deterministically", async () => {
		const { envelope } = await runBlueprint({ envValue: "split" });
		expect(envelope.skillFrameworkMode).toBe(hashModeBucket(ID));
		expect(envelope.skillFrameworkModeVia).toBe("hash");
	});

	it("split + override: via=override (529 forced-arm path)", async () => {
		const { envelope } = await runBlueprint({
			envValue: "split",
			ctxExtra: { skillFrameworkModeOverride: "bare" },
		});
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("override");
	});

	it("split + prior stamp: via=sticky (same issue keeps its arm)", async () => {
		const { envelope } = await runBlueprint({
			envValue: "split",
			ctxExtra: { skillFrameworkModePrior: "bare" },
		});
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("sticky");
	});

	// FLY-1356 fix round 2 (Codex R1 HIGH-2): the dispatcher's stamp-read
	// failure signal must thread ctx → resolver end to end. ID hashes to
	// "bare" — dropping the threading line in resolveSkillFrameworkForRun
	// turns this red as {mode:"bare", via:"hash"}.
	it("split + stamp read failed: fail-closed superpowers (never the hash arm)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { envelope } = await runBlueprint({
				envValue: "split",
				ctxExtra: { skillFrameworkModeStampReadFailed: true },
			});
			expect(envelope.skillFrameworkMode).toBe("superpowers");
			expect(envelope.skillFrameworkModeVia).toBe("fallback_superpowers");
		} finally {
			warn.mockRestore();
		}
	});

	it("split + parent mode: via=inherited (auto-QA rides the implement arm)", async () => {
		const { envelope } = await runBlueprint({
			envValue: "split",
			ctxExtra: { skillFrameworkModeParent: "bare", sessionRole: "qa" },
		});
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("inherited");
	});

	it("split + project opt-out: pinned to superpowers via project_opt_out", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "split",
			participation: () => false,
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("project_opt_out");
		expect("disabledPlugins" in execArgs).toBe(false);
	});

	it("participation reader THROWS: fail-closed pin to superpowers + warn", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { envelope } = await runBlueprint({
			envValue: "split",
			participation: () => {
				throw new Error("malformed config");
			},
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("project_opt_out");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("participation read failed"),
		);
	});

	it("participation is NOT consulted when the flag is not split (default path zero-IO)", async () => {
		const participation = vi.fn(() => true);
		await runBlueprint({ participation });
		await runBlueprint({ envValue: "bare", participation });
		expect(participation).not.toHaveBeenCalled();
	});

	it("backend ≠ claude-tmux: mode recorded with via=noop_backend, zero plugin effect (R1#7)", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare",
			ctxExtra: { runnerBackend: "kimi-tmux" },
		});
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("noop_backend");
		expect("disabledPlugins" in execArgs).toBe(false);
		expect("enabledPluginsExtra" in execArgs).toBe(false);
	});

	it("FLY-751 profile + forced matt: mode contributions MERGE into the same fields", async () => {
		const { execArgs } = await runBlueprint({
			envValue: "matt",
			ctxExtra: {
				runnerMcpProfile: {
					disabledPlugins: ["heavy-a@x", "heavy-b@y"],
					disableChrome: true,
					enabledPluginsExtra: ["playwright@p"],
				},
			},
		});
		expect(execArgs.disabledPlugins).toEqual([
			"heavy-a@x",
			"heavy-b@y",
			SUPERPOWERS_PLUGIN_KEY,
		]);
		expect(execArgs.enabledPluginsExtra).toEqual([
			"playwright@p",
			MATT_SKILLS_PLUGIN_KEY,
		]);
		expect(execArgs.disableChrome).toBe(true);
	});

	it("FLY-751 profile + default env: fields byte-identical to the profile alone", async () => {
		const { execArgs } = await runBlueprint({
			ctxExtra: {
				runnerMcpProfile: {
					disabledPlugins: ["heavy-a@x"],
					disableChrome: false,
				},
			},
		});
		expect(execArgs.disabledPlugins).toEqual(["heavy-a@x"]);
		expect(execArgs.disableChrome).toBe(false);
		expect(execArgs.enabledPluginsExtra).toBeUndefined();
	});
});

describe("FLY-1356 Blueprint — prompt variant layer", () => {
	function makeProjectWithAgent(files: Record<string, string>): string {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fly1356-agent-"));
		const agentsDir = path.join(tmpRoot, ".flywheel", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			fs.writeFileSync(path.join(agentsDir, name), content);
		}
		return tmpRoot;
	}

	function makeDispatcher(): AgentDispatcher {
		return new AgentDispatcher(
			{
				exec: {
					agent_file: ".flywheel/agents/exec.md",
					match: { labels: ["whatever"] },
				},
			},
			"exec",
			path.resolve(
				path.dirname(new URL(import.meta.url).pathname),
				"../../../..",
			),
		);
	}

	it("bare arm reads the .bare.md variant when present", async () => {
		const root = makeProjectWithAgent({
			"exec.md": "BASELINE-MARKER",
			"exec.bare.md": "BARE-VARIANT-MARKER",
		});
		const { execArgs } = await runBlueprint({
			envValue: "bare",
			agentDispatcher: makeDispatcher(),
			projectRoot: root,
		});
		expect(execArgs.appendSystemPrompt).toContain("BARE-VARIANT-MARKER");
		expect(execArgs.appendSystemPrompt).not.toContain("BASELINE-MARKER");
	});

	it("matt arm reads the .matt.md variant when present", async () => {
		const root = makeProjectWithAgent({
			"exec.md": "BASELINE-MARKER",
			"exec.matt.md": "MATT-VARIANT-MARKER",
		});
		const { execArgs } = await runBlueprint({
			envValue: "matt",
			readiness: () => true,
			agentDispatcher: makeDispatcher(),
			projectRoot: root,
		});
		expect(execArgs.appendSystemPrompt).toContain("MATT-VARIANT-MARKER");
		expect(execArgs.appendSystemPrompt).not.toContain("BASELINE-MARKER");
	});

	it("variant absent → falls back to the baseline file", async () => {
		const root = makeProjectWithAgent({ "exec.md": "BASELINE-MARKER" });
		const { execArgs } = await runBlueprint({
			envValue: "bare",
			agentDispatcher: makeDispatcher(),
			projectRoot: root,
		});
		expect(execArgs.appendSystemPrompt).toContain("BASELINE-MARKER");
	});

	it("A arm (default env) reads the baseline even when variants exist", async () => {
		const root = makeProjectWithAgent({
			"exec.md": "BASELINE-MARKER",
			"exec.bare.md": "BARE-VARIANT-MARKER",
			"exec.matt.md": "MATT-VARIANT-MARKER",
		});
		const { execArgs } = await runBlueprint({
			agentDispatcher: makeDispatcher(),
			projectRoot: root,
		});
		expect(execArgs.appendSystemPrompt).toContain("BASELINE-MARKER");
		expect(execArgs.appendSystemPrompt).not.toContain("BARE-VARIANT-MARKER");
		expect(execArgs.appendSystemPrompt).not.toContain("MATT-VARIANT-MARKER");
	});

	it("non-claude backend never reads variants (noop_backend)", async () => {
		const root = makeProjectWithAgent({
			"exec.md": "BASELINE-MARKER",
			"exec.bare.md": "BARE-VARIANT-MARKER",
		});
		const { execArgs } = await runBlueprint({
			envValue: "bare",
			agentDispatcher: makeDispatcher(),
			projectRoot: root,
			ctxExtra: { runnerBackend: "kimi-tmux" },
		});
		expect(execArgs.appendSystemPrompt).toContain("BASELINE-MARKER");
		expect(execArgs.appendSystemPrompt).not.toContain("BARE-VARIANT-MARKER");
	});
});
