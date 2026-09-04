/** FLY-2147 — runner memory assembly at the Blueprint spawn boundary. */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerMemoryMode } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import { prepareRunnerMemoryMount } from "../runner-memory.js";
import type { WorktreeManager } from "../WorktreeManager.js";
import { resolvedTestAgent } from "./agent-dispatch-fixtures.js";

type DagNode = Parameters<Blueprint["run"]>[0];

const PROJECT_ROOT = "/tmp/fly859-blueprint-test";
const GOLDEN_CONTEXT: BlueprintContext = {
	teamName: "eng",
	runnerName: "claude",
	leadId: "flywheel-eng-lead",
	executionId: "exec-fly2147-unsupported-golden",
	projectName: "flywheel",
	runnerBackend: "antigravity-tmux",
	sessionRole: "qa",
	shareParentBranch: true,
	startPoint: "abc123",
	generalizedExecutionContext: {
		runId: "run-fly2147-golden",
		nodeId: "qa",
		attempt: 1,
		snapshotDigest: "digest-fly2147-golden",
	},
	workflowCapabilities: {
		shared_branch_writer: false,
		creates_pr: false,
		can_ship: false,
		can_land: false,
		produces_output: false,
		completion_route: "needs_review",
	},
	workflowSubmissionCredential: "submission-ticket",
	workflowSubmissionExpected: true,
	workflowAgentContent: "Verify the bounded workflow node.",
};

type RunnerMemoryPreparer = typeof prepareRunnerMemoryMount;

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
		isAncestorOf: vi.fn(async () => true),
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

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length > 0) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

function makeRealWorktree(): string {
	const worktree = mkdtempSync(join(tmpdir(), "fly2147-blueprint-"));
	cleanups.push(worktree);
	execFileSync("git", ["init", "-q"], { cwd: worktree });
	return worktree;
}

function makeWtManager(worktreePath: string) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-859",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "proj",
			issueId: "FLY-859",
			worktreePath,
			branch: "flywheel-FLY-859",
			mainRepoPath: PROJECT_ROOT,
		})),
	} as unknown as WorktreeManager;
}

function absentManagedPreparer(input: Parameters<RunnerMemoryPreparer>[0]) {
	const root = process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string;
	return prepareRunnerMemoryMount({
		...input,
		managedSettings: {
			managedFile: `${root}.absent-managed.json`,
			managedDropinDir: `${root}.absent-managed.d`,
		},
	});
}

function constructBlueprint(input: {
	adapter: IAdapter;
	worktreePath: string;
	dispatcher?: unknown;
	preparer?: RunnerMemoryPreparer;
	memoryMode?: RunnerMemoryMode;
}): Blueprint {
	// Reflect keeps this RED test runnable before the new constructor-tail seam
	// exists; pre-FLY-2147 JavaScript ignores the extra positional argument.
	const args = [
		makeHydrator(),
		makeMockGitChecker(),
		() => input.adapter,
		makeMockShell(),
		makeWtManager(input.worktreePath),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		input.dispatcher,
		{ brainstorm: { enabled: true }, approve_to_ship: { enabled: true } },
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
	];
	args.push(() => ({
		hasOverride: true,
		raw: input.memoryMode ?? "role",
	}));
	args.push(input.preparer ?? absentManagedPreparer);
	return Reflect.construct(Blueprint, args) as Blueprint;
}

async function runBlueprint(
	input: {
		ctx?: Partial<BlueprintContext>;
		dispatcher?: unknown;
		preparer?: RunnerMemoryPreparer;
		memoryMode?: RunnerMemoryMode;
		projectRoot?: string;
		issueId?: string;
	} = {},
): Promise<{
	adapter: IAdapter;
	adapterContext: AdapterExecutionContext;
	prompt: string;
	worktreePath: string;
}> {
	const adapter = makeMockAdapter();
	const worktreePath = makeRealWorktree();
	const blueprint = constructBlueprint({
		adapter,
		worktreePath,
		dispatcher: input.dispatcher,
		preparer: input.preparer,
		memoryMode: input.memoryMode,
	});
	const ctx = { ...GOLDEN_CONTEXT, ...input.ctx };
	await blueprint.run(
		{ id: input.issueId ?? "FLY-859", blockedBy: [] } satisfies DagNode,
		input.projectRoot ?? PROJECT_ROOT,
		ctx,
	);
	const execute = adapter.execute as ReturnType<typeof vi.fn>;
	const adapterContext = execute.mock.calls[0]?.[0] as
		| AdapterExecutionContext
		| undefined;
	expect(adapterContext).toBeDefined();
	return {
		adapter,
		adapterContext: adapterContext as AdapterExecutionContext,
		prompt: adapterContext?.appendSystemPrompt ?? "",
		worktreePath,
	};
}

function generalizedQa(
	backend: BlueprintContext["runnerBackend"],
	projectName: string | null = "flywheel",
): Partial<BlueprintContext> {
	const resolvedProject = projectName ?? undefined;
	return {
		...GOLDEN_CONTEXT,
		executionId: `exec-fly2147-${backend}-${resolvedProject ?? "none"}`,
		projectName: resolvedProject,
		runnerBackend: backend,
	};
}

function goldenFixture(name: string): string {
	const withRepositoryNewline = readFileSync(
		fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
		"utf8",
	);
	return withRepositoryNewline.endsWith("\n")
		? withRepositoryNewline.slice(0, -1)
		: withRepositoryNewline;
}

function normalizeMachinePaths(prompt: string): string {
	return prompt.replace(
		/node \/[^\s`]+flywheel-comm[^\s`]*/g,
		"node <COMM_CLI>",
	);
}

function expectSelectionLogs(expected: string[]): void {
	const actual = vi
		.mocked(console.info)
		.mock.calls.map(([line]) => line)
		.filter(
			(line): line is string =>
				typeof line === "string" && line.includes("runner-memory selection"),
		);
	expect(actual).toEqual(expected);
}

describe("FLY-2147 Blueprint runner-memory assembly", () => {
	it("keeps off byte-identical to the pre-memory Claude spawn path", async () => {
		const preparer = vi.fn(absentManagedPreparer);
		const { adapterContext, prompt } = await runBlueprint({
			ctx: { runnerBackend: "claude-tmux" },
			memoryMode: "off",
			preparer,
		});
		expect(normalizeMachinePaths(prompt)).toBe(
			normalizeMachinePaths(
				goldenFixture("fly2147-prompt-golden-unsupported-backend.txt"),
			),
		);
		expect(preparer).not.toHaveBeenCalled();
		expect(adapterContext.runnerMemory).toBeUndefined();
		expect(adapterContext).not.toHaveProperty("runnerMemory");
		// Byte identity covers prompt/argv/adapterContext, not the required
		// selection ledger line written to the Bridge log for every spawn.
		expectSelectionLogs([
			"[Blueprint] runner-memory selection mode=off arm=off issue=FLY-859",
		]);
	});

	it("keeps forced shared on the unchanged project-shared spawn path", async () => {
		const preparer = vi.fn(absentManagedPreparer);
		const { adapterContext, prompt } = await runBlueprint({
			ctx: { runnerBackend: "claude-tmux" },
			memoryMode: "shared",
			preparer,
		});
		expect(normalizeMachinePaths(prompt)).toBe(
			normalizeMachinePaths(
				goldenFixture("fly2147-prompt-golden-unsupported-backend.txt"),
			),
		);
		expect(preparer).not.toHaveBeenCalled();
		expect(adapterContext).not.toHaveProperty("runnerMemory");
		expectSelectionLogs([
			"[Blueprint] runner-memory selection mode=shared arm=shared issue=FLY-859",
		]);
	});

	it("applies the stable split arm at the spawn boundary", async () => {
		const rolePreparer = vi.fn(absentManagedPreparer);
		const role = await runBlueprint({
			ctx: { runnerBackend: "claude-tmux" },
			issueId: "FLY-1",
			memoryMode: "split",
			preparer: rolePreparer,
		});
		expect(rolePreparer).toHaveBeenCalledOnce();
		expect(role.adapterContext.runnerMemory).toMatchObject({
			status: "mounted",
		});

		const sharedPreparer = vi.fn(absentManagedPreparer);
		const shared = await runBlueprint({
			ctx: { runnerBackend: "claude-tmux" },
			issueId: "FLY-2",
			memoryMode: "split",
			preparer: sharedPreparer,
		});
		expect(sharedPreparer).not.toHaveBeenCalled();
		expect(shared.adapterContext).not.toHaveProperty("runnerMemory");
		expectSelectionLogs([
			"[Blueprint] runner-memory selection mode=split arm=role issue=FLY-1",
			"[Blueprint] runner-memory selection mode=split arm=shared issue=FLY-2",
		]);
	});

	it("mounts generalized qa memory between Agent Role and Baseline Rules", async () => {
		const root = process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string;
		const { adapterContext, prompt } = await runBlueprint({
			ctx: generalizedQa("claude-tmux"),
		});
		const dir = join(root, "flywheel", "qa");
		expect(adapterContext.runnerMemory).toEqual({ status: "mounted", dir });
		expect(prompt).toContain("## Runner Memory");
		expect(prompt.indexOf("## Agent Role")).toBeLessThan(
			prompt.indexOf("## Runner Memory"),
		);
		expect(prompt.indexOf("## Runner Memory")).toBeLessThan(
			prompt.indexOf("## Baseline Rules"),
		);
		expect(prompt).toContain(
			"Verify the bounded workflow node.\n\n## Runner Memory\n",
		);
		expect(prompt).toMatch(/## Runner Memory\n[\s\S]+\n\n## Baseline Rules/);
		expectSelectionLogs([
			"[Blueprint] runner-memory selection mode=role arm=role issue=FLY-859",
		]);
	});

	it("uses the resolved legacy dispatch agentName as role", async () => {
		const worktree = makeRealWorktree();
		mkdirSync(join(worktree, ".flywheel", "agents"), { recursive: true });
		writeFileSync(
			join(worktree, ".flywheel", "agents", "generic.md"),
			"Legacy generic role.",
		);
		const agentConfig = resolvedTestAgent({
			nodeName: "generic",
			projectRoot: worktree,
			relativeFile: "generic.md",
		});
		const dispatcher = {
			dispatch: vi.fn(() => ({ agentName: "generic", agentConfig })),
			dispatchByName: vi.fn(() => ({ agentName: "generic", agentConfig })),
		};
		const adapter = makeMockAdapter();
		const blueprint = constructBlueprint({
			adapter,
			worktreePath: worktree,
			dispatcher,
		});
		await blueprint.run({ id: "FLY-2147", blockedBy: [] }, PROJECT_ROOT, {
			teamName: "eng",
			runnerName: "claude",
			projectName: "flywheel",
			runnerBackend: "claude-tmux",
			agentName: "generic",
		});
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as AdapterExecutionContext;
		expect(call.runnerMemory).toEqual({
			status: "mounted",
			dir: join(
				process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string,
				"flywheel",
				"generic",
			),
		});
	});

	it("leaves unsupported backend prompt and adapter context byte-identical", async () => {
		const { adapterContext, prompt } = await runBlueprint();
		expect(normalizeMachinePaths(prompt)).toBe(
			normalizeMachinePaths(
				goldenFixture("fly2147-prompt-golden-unsupported-backend.txt"),
			),
		);
		expect(adapterContext.runnerMemory).toBeUndefined();
		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining(
				"runner-memory skipped reason=unsupported_backend",
			),
		);
	});

	it("fails closed and loud when projectName is absent", async () => {
		const { adapterContext, prompt } = await runBlueprint({
			ctx: generalizedQa("claude-tmux", null),
		});
		expect(adapterContext.runnerMemory).toEqual({
			status: "disabled",
			reason: "no_project",
		});
		expect(prompt).toContain("NOT mounted (-/qa): no_project");
		expect(prompt).toContain("auto memory is DISABLED");
		expect(console.info).toHaveBeenCalledWith(
			expect.stringContaining("runner-memory skipped reason=no_project"),
		);
	});

	it("continues spawn but fails closed and loud when the root is not writable", async () => {
		const rootFile = join(
			mkdtempSync(join(tmpdir(), "fly2147-root-file-")),
			"root",
		);
		cleanups.push(rootFile.slice(0, rootFile.lastIndexOf("/")));
		writeFileSync(rootFile, "not a directory");
		process.env.FLYWHEEL_RUNNER_MEMORY_ROOT = rootFile;
		const { adapter, adapterContext, prompt } = await runBlueprint({
			ctx: generalizedQa("claude-tmux"),
		});
		expect(adapter.execute).toHaveBeenCalledOnce();
		expect(adapterContext.runnerMemory).toMatchObject({ status: "disabled" });
		expect(adapterContext.runnerMemory).toEqual({
			status: "disabled",
			reason: expect.stringMatching(/^fs:/),
		});
		expect(prompt).toContain("NOT mounted");
		expect(prompt).toContain("fs:");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("runner-memory failed"),
		);
	});

	it("reads the persistent index on the second execution", async () => {
		const root = process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string;
		await runBlueprint({ ctx: generalizedQa("claude-tmux") });
		writeFileSync(join(root, "flywheel", "qa", "MEMORY.md"), "a\nb\nc\n");
		const { prompt } = await runBlueprint({
			ctx: generalizedQa("claude-tmux"),
		});
		expect(prompt).toContain("Index MEMORY.md: 3 lines / 6 bytes");
	});

	it("gives Codex the shared directory without claiming native loading", async () => {
		const root = process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string;
		const { adapterContext, prompt } = await runBlueprint({
			ctx: generalizedQa("codex-tmux"),
		});
		expect(adapterContext.runnerMemory).toEqual({
			status: "mounted",
			dir: join(root, "flywheel", "qa"),
		});
		expect(prompt).toContain("Native loading for Codex is deferred");
		expect(prompt).toContain("FLYWHEEL_RUNNER_MEMORY_DIR");
		expect(prompt).not.toContain("Claude Code loads");
		expect(prompt).not.toContain("NOT loaded");
		expect(prompt).not.toContain("auto memory is DISABLED");
	});

	it("keeps test writes inside the isolated override instead of HOME", async () => {
		const root = process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string;
		const home = process.env.HOME as string;
		const { adapterContext } = await runBlueprint({
			ctx: generalizedQa("claude-tmux"),
		});
		expect(adapterContext.runnerMemory).toEqual({
			status: "mounted",
			dir: join(root, "flywheel", "qa"),
		});
		expect(existsSync(join(root, "flywheel", "qa", "MEMORY.md"))).toBe(true);
		expect(existsSync(join(home, ".flywheel", "runner-memory"))).toBe(false);
	});

	it("keeps Sub and sub project directories distinct and displays original case", async () => {
		const upper = await runBlueprint({
			ctx: generalizedQa("claude-tmux", "Sub"),
		});
		const lower = await runBlueprint({
			ctx: generalizedQa("claude-tmux", "sub"),
		});
		expect(upper.adapterContext.runnerMemory).toMatchObject({
			status: "mounted",
		});
		expect(lower.adapterContext.runnerMemory).toMatchObject({
			status: "mounted",
		});
		expect((upper.adapterContext.runnerMemory as { dir: string }).dir).not.toBe(
			(lower.adapterContext.runnerMemory as { dir: string }).dir,
		);
		expect(upper.prompt).toContain("Role memory directory (Sub/qa)");
		expect(lower.prompt).toContain("Role memory directory (sub/qa)");
	});

	it("reports policy conflict as unknown, disables best-effort, and creates no role dir", async () => {
		const sandbox = mkdtempSync(join(tmpdir(), "fly2147-policy-"));
		cleanups.push(sandbox);
		const managedFile = join(sandbox, "managed-settings.json");
		writeFileSync(managedFile, JSON.stringify({ autoMemoryEnabled: true }));
		const preparer: RunnerMemoryPreparer = (input) =>
			prepareRunnerMemoryMount({
				...input,
				managedSettings: {
					managedFile,
					managedDropinDir: join(sandbox, "managed-settings.d"),
				},
			});
		const { adapter, adapterContext, prompt } = await runBlueprint({
			ctx: generalizedQa("claude-tmux"),
			preparer,
		});
		expect(adapter.execute).toHaveBeenCalledOnce();
		expect(adapterContext.runnerMemory).toEqual({
			status: "disabled",
			reason: `policy_conflict:${JSON.stringify([
				`${managedFile}:autoMemoryEnabled`,
			])}`,
		});
		expect(prompt).toContain(
			"effective memory state of this session is UNKNOWN",
		);
		expect(prompt).not.toContain("auto memory is DISABLED");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("reason=policy_conflict:"),
		);
		expect(
			existsSync(
				join(
					process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string,
					"flywheel",
					"qa",
				),
			),
		).toBe(false);
	});

	it("passes only bounded identity and path inputs to the test-only preparer seam", async () => {
		const calls: Parameters<RunnerMemoryPreparer>[0][] = [];
		const preparer: RunnerMemoryPreparer = (input) => {
			calls.push(input);
			return absentManagedPreparer(input);
		};
		const { worktreePath } = await runBlueprint({
			ctx: generalizedQa("claude-tmux"),
			preparer,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.env).toBe(process.env);
		expect({ ...calls[0], env: undefined }).toEqual({
			env: undefined,
			backend: "claude-tmux",
			projectName: "flywheel",
			nodeId: "qa",
			agentName: undefined,
			cwd: worktreePath,
			projectRoot: PROJECT_ROOT,
		});
		expect(calls[0]).not.toHaveProperty("managedSettings");
	});

	it("keeps runnerMemoryPreparer as a constructor-tail test seam with no runtime selector", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../Blueprint.ts", import.meta.url)),
			"utf8",
		);
		expect(source.match(/runnerMemoryPreparer/g) ?? []).toHaveLength(2);
		expect(source).toMatch(
			/private runnerMemoryPreparer: typeof prepareRunnerMemoryMount = prepareRunnerMemoryMount,\n\t\) \{\}/,
		);
		expect(source).not.toMatch(
			/(?:process\.env|ctx|config)[^\n]*runnerMemoryPreparer/i,
		);
	});
});
