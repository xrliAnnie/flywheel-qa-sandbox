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
 *  - split: hash / override / sticky / project_opt_out vias
 *  - participation reader throwing → fail-closed pin to A (project_opt_out)
 *  - capability=none backend → via=noop_backend, zero plugin/prompt effect
 *  - Claude and Codex preserve one arm while applying backend-native assembly
 *  - FLY-751 mcpProfile merge: mode contributions ride the same fields;
 *    profile alone (default env) stays byte-identical
 *  - prompt layer: `<agent-file>.{matt,bare}.md` variant wins when present,
 *    baseline fallback when absent; A arm always reads the baseline
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PonytailConfig } from "flywheel-config";
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
import type {
	BlueprintContext,
	CodexSkillAssemblyProbe,
	ShellRunner,
} from "../Blueprint.js";
import { Blueprint, defaultCodexSkillAssemblyProbe } from "../Blueprint.js";
import type { EventEnvelope } from "../ExecutionEventEmitter.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

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
	ponytailReadiness?: (backend: string) => boolean;
	ponytailConfig?: PonytailConfig;
	codexProbe?: CodexSkillAssemblyProbe;
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
	let projectRoot = opts.projectRoot;
	const isCodex = opts.ctxExtra?.runnerBackend === "codex-tmux";
	if (!projectRoot && isCodex) {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-codex-"));
		execFileSync("git", ["init", "-q"], { cwd: projectRoot });
	}
	const worktreeManager =
		isCodex && projectRoot
			? {
					expectedWorktree: vi.fn(() => ({
						path: projectRoot,
						branch: "flywheel-FLY-1395",
					})),
					isRegistered: vi.fn(async () => false),
					removeIfExists: vi.fn(async () => true),
					create: vi.fn(async () => ({
						projectName: "testproj",
						issueId: ID,
						worktreePath: projectRoot,
						branch: "flywheel-FLY-1395",
						mainRepoPath: "/tmp/fly1395-main",
					})),
				}
			: undefined;
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
		worktreeManager as unknown as WorktreeManager | undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		eventEmitter as any,
		opts.agentDispatcher,
		undefined, // checkpointConfig
		undefined, // flywheelRepoRoot
		undefined, // docFlowConfig
		opts.ponytailConfig,
		opts.ponytailReadiness ?? (() => true),
		opts.participation, // FLY-1356 participation reader
		opts.readiness ?? (() => true), // FLY-1356 matt readiness (default ready)
		opts.codexProbe,
		() => ({
			hasOverride: opts.envValue !== undefined,
			raw: opts.envValue ?? null,
		}),
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
		projectRoot ?? "/tmp/fly1356-blueprint-test",
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

describe("FLY-1395 default Codex skill assembly probe", () => {
	function writeSkill(root: string, directory: string, name = directory): void {
		const dir = path.join(root, directory);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: fixture\n---\n`,
		);
	}

	function writeMattFixture(root: string): void {
		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			writeSkill(root, name);
		}
	}

	it("scans each superpowers skill once and emits directory plus distinct frontmatter names", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-scan-"));
		const superpowersRoot = path.join(root, "superpowers");
		writeSkill(superpowersRoot, "alpha");
		writeSkill(superpowersRoot, "beta-dir", "beta-frontmatter");
		const result = defaultCodexSkillAssemblyProbe({
			mode: "bare",
			agentsSkillsDir: root,
			mattSkillsSourceDir: path.join(root, "unused-matt"),
		});
		expect(result).toEqual({
			disableNames: [
				"superpowers:alpha",
				"superpowers:beta-dir",
				"superpowers:beta-frontmatter",
			],
		});
	});

	it("treats a missing machine-global superpowers root as an empty valid list", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-missing-"));
		expect(
			defaultCodexSkillAssemblyProbe({
				mode: "bare",
				agentsSkillsDir: path.join(root, "does-not-exist"),
				mattSkillsSourceDir: path.join(root, "unused-matt"),
			}),
		).toEqual({ disableNames: [] });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("superpowers root is absent"),
		);
	});

	it("fails loudly on non-ENOENT scan errors", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-error-"));
		const notDirectory = path.join(root, "not-a-directory");
		fs.writeFileSync(notDirectory, "fixture");
		expect(() =>
			defaultCodexSkillAssemblyProbe({
				mode: "bare",
				agentsSkillsDir: notDirectory,
				mattSkillsSourceDir: path.join(root, "unused-matt"),
			}),
		).toThrow();
	});

	it("matt verifies all six vendored skills and returns their source", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-matt-"));
		const mattSkillsSourceDir = path.join(root, "matt");
		writeMattFixture(mattSkillsSourceDir);
		expect(
			defaultCodexSkillAssemblyProbe({
				mode: "matt",
				agentsSkillsDir: path.join(root, "missing-superpowers"),
				mattSkillsSourceDir,
			}),
		).toEqual({ disableNames: [], mattSkillsSourceDir });
	});

	it("matt fails loudly when any required vendored skill is missing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-matt-bad-"));
		const mattSkillsSourceDir = path.join(root, "matt");
		writeSkill(mattSkillsSourceDir, "tdd");
		expect(() =>
			defaultCodexSkillAssemblyProbe({
				mode: "matt",
				agentsSkillsDir: path.join(root, "missing-superpowers"),
				mattSkillsSourceDir,
			}),
		).toThrow(/missing required vendored skill/);
	});

	it("matt frontmatter drift falls back to superpowers before provisioning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly1395-matt-drift-"));
		const mattSkillsSourceDir = path.join(root, "matt");
		writeMattFixture(mattSkillsSourceDir);
		writeSkill(mattSkillsSourceDir, "tdd", "drifted-tdd");

		const { envelope, execArgs } = await runBlueprint({
			envValue: "matt",
			ctxExtra: { runnerBackend: "codex-tmux" },
			codexProbe: (args) =>
				defaultCodexSkillAssemblyProbe({
					...args,
					agentsSkillsDir: path.join(root, "missing-superpowers"),
					mattSkillsSourceDir,
				}),
		});

		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("fallback_superpowers");
		expect(execArgs.skillFrameworkMode).toBe("superpowers");
		expect(execArgs.codexSkillDisableNames).toBeUndefined();
		expect(execArgs.codexMattSkillsSourceDir).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("frontmatter name"),
		);
	});
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

	it("forced D records on:arm while assembling exactly bare + ponytail", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare-ponytail",
			ponytailReadiness: () => true,
		});
		expect(envelope.skillFrameworkMode).toBe("bare-ponytail");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect(envelope.ponytailCondition).toBe("on:arm");
		expect(execArgs.enablePonytail).toBe(true);
		expect(execArgs.disabledPlugins).toEqual([SUPERPOWERS_PLUGIN_KEY]);
		expect(execArgs.enabledPluginsExtra ?? []).not.toContain(
			MATT_SKILLS_PLUGIN_KEY,
		);
	});

	it("forced D keeps D attribution when ponytail readiness is unavailable", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare-ponytail",
			ponytailReadiness: () => false,
		});
		expect(envelope.skillFrameworkMode).toBe("bare-ponytail");
		expect(envelope.ponytailCondition).toBe("unavailable:readiness:on:arm");
		expect(execArgs.enablePonytail).toBeUndefined();
		expect(execArgs.disabledPlugins).toEqual([SUPERPOWERS_PLUGIN_KEY]);
	});

	it("D retry preserves a frozen explicit off instead of reopening the arm", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare-ponytail",
			ctxExtra: {
				ponytailRetry: {
					frozen: { want: "off", source: "run" },
					freshSignal: { labels: [], labelStatus: "readable" },
				},
			} as Partial<BlueprintContext>,
		});
		expect(envelope.ponytailCondition).toBe("off:run");
		expect(execArgs.enablePonytail).toBeUndefined();
	});

	it("kill drops frozen arm attribution and re-resolves the fresh label signal", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "superpowers",
			ctxExtra: {
				ponytailRetry: {
					frozen: { want: "on", source: "arm" },
					freshSignal: { labels: ["ponytail"], labelStatus: "readable" },
				},
			} as Partial<BlueprintContext>,
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.ponytailCondition).toBe("on:label");
		expect(execArgs.enablePonytail).toBe(true);
	});

	it.each([
		[
			"no current signal",
			{ labels: [], labelStatus: "readable" as const },
			undefined,
			"off:default",
		],
		[
			"project rollout",
			{ labels: [], labelStatus: "readable" as const },
			{ enabled: true },
			"on:project",
		],
	] as const)(
		"kill re-resolves frozen arm through ordinary FLY-615: %s",
		async (_name, freshSignal, ponytailConfig, expected) => {
			const { envelope } = await runBlueprint({
				envValue: "superpowers",
				ponytailConfig,
				ctxExtra: {
					ponytailRetry: {
						frozen: { want: "on", source: "arm" },
						freshSignal,
					},
				} as Partial<BlueprintContext>,
			});
			expect(envelope.ponytailCondition).toBe(expected);
			expect(envelope.ponytailCondition).not.toContain(":arm");
		},
	);

	it("D reresolve honors a freshly-read ponytail-off label", async () => {
		const { envelope } = await runBlueprint({
			envValue: "bare-ponytail",
			ctxExtra: {
				ponytailRetry: {
					freshSignal: {
						labels: ["ponytail-off"],
						labelStatus: "readable",
					},
				},
			} as Partial<BlueprintContext>,
		});
		expect(envelope.ponytailCondition).toBe("off:label");
	});

	it("D retry with a missing fresh selector fails closed", async () => {
		const { envelope } = await runBlueprint({
			envValue: "bare-ponytail",
			ctxExtra: {
				ponytailRetry: { freshSignal: undefined },
			} as unknown as Partial<BlueprintContext>,
		});
		expect(envelope.ponytailCondition).toBe(
			"unavailable:selector:label_unreadable",
		);
	});

	it.each([
		[
			"run",
			"off:run",
			{ runOverride: "off" as const, labelStatus: "readable" as const },
		],
		[
			"label",
			"off:label",
			{ labels: ["ponytail-off"], labelStatus: "readable" as const },
		],
	])(
		"forced D preserves explicit %s off",
		async (_source, condition, signal) => {
			const { envelope, execArgs } = await runBlueprint({
				envValue: "bare-ponytail",
				ctxExtra: { ponytailInput: { kind: "start_signal", signal } },
			});
			expect(envelope.ponytailCondition).toBe(condition);
			expect(execArgs.enablePonytail).toBeUndefined();
		},
	);

	it("forced bare remains the exact C control with ponytail off", async () => {
		const { envelope, execArgs } = await runBlueprint({ envValue: "bare" });
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.ponytailCondition).toBe("off:default");
		expect(execArgs.enablePonytail).toBeUndefined();
		expect(execArgs.disabledPlugins).toEqual([SUPERPOWERS_PLUGIN_KEY]);
		expect(execArgs.enabledPluginsExtra).toBeUndefined();
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

	it.each(["antigravity-tmux", "kimi-tmux"] as const)(
		"none-capability backend %s records noop_backend with zero plugin effect",
		async (runnerBackend) => {
			const { envelope, execArgs } = await runBlueprint({
				envValue: "bare",
				ctxExtra: { runnerBackend },
			});
			expect(envelope.skillFrameworkMode).toBe("bare");
			expect(envelope.skillFrameworkModeVia).toBe("noop_backend");
			expect("disabledPlugins" in execArgs).toBe(false);
			expect("enabledPluginsExtra" in execArgs).toBe(false);
		},
	);

	it("D on a no-assembly backend stays attributed but is excluded as unavailable", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare-ponytail",
			ctxExtra: { runnerBackend: "kimi-tmux" },
			ponytailReadiness: () => false,
		});
		expect(envelope.skillFrameworkMode).toBe("bare-ponytail");
		expect(envelope.skillFrameworkModeVia).toBe("noop_backend");
		expect(envelope.ponytailCondition).toBe("unavailable:readiness:on:arm");
		expect(execArgs.enablePonytail).toBeUndefined();
		expect(execArgs.disabledPlugins).toBeUndefined();
	});

	it.each([
		["hash", {}, undefined],
		["override", { skillFrameworkModeOverride: "bare" }, "bare"],
		["sticky", { skillFrameworkModePrior: "bare" }, "bare"],
	] as const)(
		"codex-tmux preserves resolver via=%s instead of noop_backend",
		async (expectedVia, ctxExtra, expectedMode) => {
			const { envelope, execArgs } = await runBlueprint({
				envValue: "split",
				ctxExtra: { runnerBackend: "codex-tmux", ...ctxExtra },
			});
			expect(envelope.skillFrameworkMode).toBe(
				expectedMode ?? hashModeBucket(ID),
			);
			expect(envelope.skillFrameworkModeVia).toBe(expectedVia);
			// Claude's plugin mechanism remains backend-specific.
			expect("disabledPlugins" in execArgs).toBe(false);
		},
	);

	it("codex bare scans once and threads the exact disable list to the adapter", async () => {
		const codexProbe = vi.fn(() => ({
			disableNames: [
				"superpowers:brainstorming",
				"superpowers:test-driven-development",
			],
		}));
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare",
			ctxExtra: { runnerBackend: "codex-tmux" },
			codexProbe,
		});
		expect(codexProbe).toHaveBeenCalledTimes(1);
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect(execArgs.skillFrameworkMode).toBe("bare");
		expect(execArgs.codexSkillDisableNames).toEqual([
			"superpowers:brainstorming",
			"superpowers:test-driven-development",
		]);
		expect(execArgs.codexMattSkillsSourceDir).toBeUndefined();
	});

	it("codex D records D but probes and executes the bare base arm", async () => {
		const codexProbe = vi.fn(() => ({
			disableNames: ["superpowers:brainstorming"],
		}));
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare-ponytail",
			ctxExtra: { runnerBackend: "codex-tmux" },
			ponytailReadiness: () => true,
			codexProbe,
		});
		expect(codexProbe).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "bare" }),
		);
		expect(envelope.skillFrameworkMode).toBe("bare-ponytail");
		expect(envelope.ponytailCondition).toBe("on:arm");
		expect(execArgs.skillFrameworkMode).toBe("bare");
		expect(execArgs.enablePonytail).toBe(true);
		expect(execArgs.codexSkillDisableNames).toEqual([
			"superpowers:brainstorming",
		]);
	});

	it("codex matt threads the same scan result plus the verified vendor source", async () => {
		const codexProbe = vi.fn(() => ({
			disableNames: ["superpowers:using-superpowers"],
			mattSkillsSourceDir: "/repo/vendor/matt-skills/skills",
		}));
		const { envelope, execArgs } = await runBlueprint({
			envValue: "matt",
			ctxExtra: { runnerBackend: "codex-tmux" },
			codexProbe,
		});
		expect(codexProbe).toHaveBeenCalledTimes(1);
		expect(envelope.skillFrameworkMode).toBe("matt");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect(execArgs.skillFrameworkMode).toBe("matt");
		expect(execArgs.codexSkillDisableNames).toEqual([
			"superpowers:using-superpowers",
		]);
		expect(execArgs.codexMattSkillsSourceDir).toBe(
			"/repo/vendor/matt-skills/skills",
		);
	});

	it("an explicit successor arm applies backend-native assembly in Claude design and Codex implement", async () => {
		const design = await runBlueprint({ envValue: "matt" });
		const implement = await runBlueprint({
			envValue: "split",
			ctxExtra: {
				runnerBackend: "codex-tmux",
				sessionRole: "implement",
				skillFrameworkModeOverride: design.envelope.skillFrameworkMode,
			},
			codexProbe: () => ({
				disableNames: ["superpowers:using-superpowers"],
				mattSkillsSourceDir: "/repo/vendor/matt-skills/skills",
			}),
		});

		expect(design.envelope.skillFrameworkMode).toBe("matt");
		expect(design.execArgs.disabledPlugins).toContain(SUPERPOWERS_PLUGIN_KEY);
		expect(design.execArgs.enabledPluginsExtra).toContain(
			MATT_SKILLS_PLUGIN_KEY,
		);
		expect(implement.envelope.skillFrameworkMode).toBe("matt");
		expect(implement.envelope.skillFrameworkModeVia).toBe("override");
		expect(implement.execArgs.disabledPlugins).toBeUndefined();
		expect(implement.execArgs.skillFrameworkMode).toBe("matt");
		expect(implement.execArgs.codexSkillDisableNames).toEqual([
			"superpowers:using-superpowers",
		]);
		expect(implement.execArgs.codexMattSkillsSourceDir).toBe(
			"/repo/vendor/matt-skills/skills",
		);
	});

	it("codex probe ambiguity fails closed to A with honest attribution", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const codexProbe = vi.fn(() => {
			throw new Error("EACCES while scanning superpowers");
		});
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare",
			ctxExtra: { runnerBackend: "codex-tmux" },
			codexProbe,
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("fallback_superpowers");
		expect(execArgs.skillFrameworkMode).toBe("superpowers");
		expect(execArgs.codexSkillDisableNames).toBeUndefined();
		expect(execArgs.codexMattSkillsSourceDir).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Codex skill assembly probe failed"),
		);
	});

	it("codex A arm performs no probe and contributes no Codex skill fields", async () => {
		const codexProbe = vi.fn(() => ({ disableNames: ["should:not-run"] }));
		const { execArgs } = await runBlueprint({
			envValue: "superpowers",
			ctxExtra: { runnerBackend: "codex-tmux" },
			codexProbe,
		});
		expect(codexProbe).not.toHaveBeenCalled();
		expect(execArgs.skillFrameworkMode).toBe("superpowers");
		expect(execArgs.codexSkillDisableNames).toBeUndefined();
		expect(execArgs.codexMattSkillsSourceDir).toBeUndefined();
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

	it("D arm reads the same .bare.md variant as C", async () => {
		const root = makeProjectWithAgent({
			"exec.md": "BASELINE-MARKER",
			"exec.bare.md": "BARE-VARIANT-MARKER",
		});
		const { execArgs } = await runBlueprint({
			envValue: "bare-ponytail",
			ponytailReadiness: () => true,
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

	it("none-capability backend never reads variants (noop_backend)", async () => {
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

	it.each([
		["bare", "BARE-VARIANT-MARKER"],
		["matt", "MATT-VARIANT-MARKER"],
	] as const)(
		"codex %s arm reads the matching prompt variant",
		async (envValue, expectedMarker) => {
			const root = makeProjectWithAgent({
				"exec.md": "BASELINE-MARKER",
				"exec.bare.md": "BARE-VARIANT-MARKER",
				"exec.matt.md": "MATT-VARIANT-MARKER",
			});
			const { execArgs } = await runBlueprint({
				envValue,
				agentDispatcher: makeDispatcher(),
				projectRoot: root,
				ctxExtra: { runnerBackend: "codex-tmux" },
				codexProbe: () => ({
					disableNames: ["superpowers:fixture"],
					...(envValue === "matt" && {
						mattSkillsSourceDir: "/repo/vendor/matt-skills/skills",
					}),
				}),
			});
			expect(execArgs.appendSystemPrompt).toContain(expectedMarker);
			expect(execArgs.appendSystemPrompt).not.toContain("BASELINE-MARKER");
		},
	);

	it("codex variant absence falls back to the baseline prompt", async () => {
		const root = makeProjectWithAgent({ "exec.md": "BASELINE-MARKER" });
		const { execArgs } = await runBlueprint({
			envValue: "bare",
			agentDispatcher: makeDispatcher(),
			projectRoot: root,
			ctxExtra: { runnerBackend: "codex-tmux" },
			codexProbe: () => ({ disableNames: ["superpowers:fixture"] }),
		});
		expect(execArgs.appendSystemPrompt).toContain("BASELINE-MARKER");
	});
});
