/** FLY-2148 — spawn attribution and closeout contract at the Blueprint boundary. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerMemoryMode } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type {
	EventEnvelope,
	ExecutionEventEmitter,
} from "../ExecutionEventEmitter.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import { prepareRunnerMemoryMount } from "../runner-memory.js";
import type { WorktreeManager } from "../WorktreeManager.js";

type DagNode = Parameters<Blueprint["run"]>[0];
type RunnerMemoryPreparer = typeof prepareRunnerMemoryMount;

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

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length > 0) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

function makeAdapter(order: string[]): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => {
				order.push("execute");
				return {
					success: true,
					sessionId: "sess-fly2148",
					tmuxWindow: "flywheel:@2148",
					durationMs: 1,
				};
			},
		),
	};
}

function makeEmitter(order: string[]): ExecutionEventEmitter & {
	emitRunnerMemorySelection: ReturnType<typeof vi.fn>;
} {
	return {
		emitStarted: vi.fn(async () => {}),
		emitWorktreeReady: vi.fn(async () => {}),
		emitCompleted: vi.fn(async () => {}),
		emitFailed: vi.fn(async () => {}),
		emitHeartbeat: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
		emitRunnerMemorySelection: vi.fn(async () => {
			order.push("attribution");
		}),
	};
}

function constructBlueprint(input: {
	adapter: IAdapter;
	worktreePath: string;
	eventEmitter: ExecutionEventEmitter;
	memoryMode?: RunnerMemoryMode;
	preparer?: RunnerMemoryPreparer;
}): Blueprint {
	const hydrator = new PreHydrator(async (id) => ({
		title: `Issue ${id}`,
		description: `Description ${id}`,
		labels: [],
	}));
	const git = {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		isAncestorOf: vi.fn(async () => true),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 1,
			commitMessages: ["feat: fly2148"],
		})),
	} as unknown as GitResultChecker;
	const shell: ShellRunner = {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
	};
	const worktrees = {
		expectedWorktree: vi.fn(() => ({
			path: input.worktreePath,
			branch: "flywheel-FLY-2148",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "flywheel",
			issueId: "FLY-2148",
			worktreePath: input.worktreePath,
			branch: "flywheel-FLY-2148",
			mainRepoPath: "/tmp/fly2148-project",
		})),
	} as unknown as WorktreeManager;
	const args = [
		hydrator,
		git,
		() => input.adapter,
		shell,
		worktrees,
		undefined,
		undefined,
		undefined,
		undefined,
		input.eventEmitter,
		undefined,
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
		() => ({ hasOverride: true, raw: input.memoryMode ?? "role" }),
		input.preparer ?? absentManagedPreparer,
	];
	return Reflect.construct(Blueprint, args) as Blueprint;
}

async function run(input: {
	backend?: BlueprintContext["runnerBackend"];
	projectName?: string;
	memoryMode?: RunnerMemoryMode;
	emitter?: ReturnType<typeof makeEmitter>;
	order?: string[];
}) {
	const order = input.order ?? [];
	const adapter = makeAdapter(order);
	const emitter = input.emitter ?? makeEmitter(order);
	const worktreePath = mkdtempSync(join(tmpdir(), "fly2148-blueprint-"));
	cleanups.push(worktreePath);
	execFileSync("git", ["init", "-q"], { cwd: worktreePath });
	const blueprint = constructBlueprint({
		adapter,
		worktreePath,
		eventEmitter: emitter,
		memoryMode: input.memoryMode,
	});
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		leadId: "flywheel-eng-lead",
		executionId: "exec-fly2148",
		projectName: input.projectName,
		runnerBackend: input.backend ?? "claude-tmux",
		sessionRole: "qa",
		shareParentBranch: true,
		startPoint: "abc123",
		generalizedExecutionContext: {
			runId: "run-fly2148",
			nodeId: "qa",
			attempt: 1,
			snapshotDigest: "digest-fly2148",
		},
		workflowCapabilities: {
			shared_branch_writer: false,
			creates_pr: false,
			can_ship: false,
			can_land: false,
			produces_output: false,
			completion_route: "needs_review",
		},
		workflowAgentContent: "Verify runner memory.",
	};
	await blueprint.run(
		{ id: "FLY-2148", blockedBy: [] } satisfies DagNode,
		"/tmp/fly2148-project",
		ctx,
	);
	const adapterContext = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]?.[0] as AdapterExecutionContext;
	return { adapterContext, emitter, order };
}

describe("FLY-2148 Blueprint runner-memory closeout contract", () => {
	it("records role/project attribution and gives the runner the same spawn snapshot before execution", async () => {
		const { adapterContext, emitter, order } = await run({
			projectName: "flywheel",
		});
		expect(emitter.emitRunnerMemorySelection).toHaveBeenCalledOnce();
		const [env, record] = emitter.emitRunnerMemorySelection.mock.calls[0] as [
			EventEnvelope,
			{
				arm: string;
				dir: string;
				spawn: unknown;
			},
		];
		expect(env.executionId).toBe("exec-fly2148");
		expect(record).toMatchObject({
			arm: "role",
			dir: join(
				process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string,
				"flywheel",
				"qa",
			),
			spawn: {
				lines: expect.any(Number),
				linesExact: true,
				bytes: expect.any(Number),
				topicFiles: 0,
				sha16: expect.any(String),
			},
		});
		expect(adapterContext.runnerMemory).toEqual({
			status: "mounted",
			dir: record.dir,
			snapshot: record.spawn,
		});
		expect(order).toEqual(["attribution", "execute"]);
		expect(adapterContext.appendSystemPrompt).toContain(
			"BEFORE you run your completion command",
		);
		expect(adapterContext.appendSystemPrompt).toContain(
			"runner-memory closeout",
		);
	});

	it.each([
		["off" as const, "off"],
		["shared" as const, "shared"],
	])("records the %s arm without fabricating a mount", async (mode, arm) => {
		const { adapterContext, emitter } = await run({
			projectName: "flywheel",
			memoryMode: mode,
		});
		expect(emitter.emitRunnerMemorySelection).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-fly2148" }),
			{ arm },
		);
		expect(adapterContext).not.toHaveProperty("runnerMemory");
	});

	it("does not publish attribution for an unsupported backend", async () => {
		const { emitter } = await run({
			backend: "antigravity-tmux",
			projectName: "flywheel",
		});
		expect(emitter.emitRunnerMemorySelection).not.toHaveBeenCalled();
	});

	it("keeps spawning when the optional attribution sink fails", async () => {
		const order: string[] = [];
		const emitter = makeEmitter(order);
		emitter.emitRunnerMemorySelection.mockRejectedValueOnce(
			new Error("sink unavailable"),
		);
		const { adapterContext } = await run({
			projectName: "flywheel",
			emitter,
			order,
		});
		expect(adapterContext.runnerMemory).toMatchObject({ status: "mounted" });
		expect(order).toEqual(["execute"]);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"runner-memory selection attribution failed exec=exec-fly2148: sink unavailable",
			),
		);
	});
});
