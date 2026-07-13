/**
 * FLY-1188 — executor-identity discriminant + codex worktree defense.
 *
 * (1) Execution-semantics branches (the codex-flavored no-block gate text)
 *     key on the RESOLVED executor backend (`runnerBackend === "codex-tmux"`),
 *     never on the transport vendor: `ctx.vendor` is legitimately absent on
 *     identity-less/rollback paths (commdb backend, missing leadId) while the
 *     backend is still codex-tmux — the old vendor keying rendered BLOCKING
 *     gate text a codex exec runner can never satisfy.
 * (2) A codex-tmux spawn MUST be anchored to this execution's own worktree:
 *     no worktree → fail loud (codex_worktree_required); realpath equality
 *     tolerates symlinked paths (FLY-793 macOS /tmp).
 * (3) Claude paths stay byte-compatible (blocking gate text, projectRoot
 *     fallback spawn still allowed).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

function makeNode(id = "FLY-1188"): DagNode {
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
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-uuid",
				tmuxWindow: "flywheel:@42",
				durationMs: 100,
			}),
		),
	};
}

/** Real git dir so ensureFlywheelRunsExclude / exclude writes don't blow up. */
function makeRealWorktree(): string {
	const p = join(
		tmpdir(),
		`fly1188-wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(p, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: p });
	return p;
}

function makeWtManager(worktreePath: string) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-1188",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "proj",
			issueId: "FLY-1188",
			worktreePath,
			branch: "flywheel-FLY-1188",
			mainRepoPath: "/tmp/fly1188-main",
		})),
	} as unknown as WorktreeManager;
}

const CHECKPOINTS = {
	brainstorm: { enabled: true },
	question: { enabled: true },
	approve_to_ship: { enabled: true },
};

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

async function runBlueprint(opts: {
	ctxOverrides?: Partial<BlueprintContext>;
	worktreePath?: string;
}) {
	const adapter = makeMockAdapter();
	const blueprint = new Blueprint(
		makeHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
		opts.worktreePath ? makeWtManager(opts.worktreePath) : undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		CHECKPOINTS,
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "runner",
		leadId: "flywheel-eng-lead",
		...opts.ctxOverrides,
	};
	const result = await blueprint.run(makeNode(), "/tmp/fly1188-project", ctx);
	const executeMock = adapter.execute as ReturnType<typeof vi.fn>;
	const prompt =
		executeMock.mock.calls.length > 0
			? ((executeMock.mock.calls[0]![0] as AdapterExecutionContext)
					.appendSystemPrompt ?? "")
			: "";
	return { result, prompt, executeMock };
}

describe("FLY-1188 executor-identity discriminant (gate text by runnerBackend)", () => {
	it("runnerBackend=codex-tmux with vendor ABSENT → codex no-block gate text (the fixed pathological combo)", async () => {
		const wt = makeRealWorktree();
		cleanups.push(wt);
		const { prompt } = await runBlueprint({
			worktreePath: wt,
			ctxOverrides: { runnerBackend: "codex-tmux" }, // vendor deliberately absent
		});

		// brainstorm: no-block + END TURN, never the blocking text
		expect(prompt).toContain("BRAINSTORM GATE");
		expect(prompt).toContain(
			"gate brainstorm --lead flywheel-eng-lead --exec-id",
		);
		expect(prompt).toMatch(/gate brainstorm[^\n]*--no-block/);
		expect(prompt).not.toContain(
			"This command BLOCKS until your Lead confirms",
		);
		// question: same shape
		expect(prompt).toMatch(/gate question[^\n]*--no-block/);
		expect(prompt).not.toContain(
			"This command BLOCKS until your Lead responds",
		);
		// FLY-1188 M4 (Codex R2): a RESIDENT codex runner POLLS `check` across its
		// turns for the gate reply — it is never auto-resumed (the old exec-cycle
		// "END YOUR TURN + resumed automatically" is gone from the gate branches).
		expect(prompt).toContain("POLL for the reply");
		expect(prompt).not.toContain("resumed automatically");
	});

	it("runnerBackend=codex-tmux WITH vendor=codex → same codex gate text (unchanged combo)", async () => {
		const wt = makeRealWorktree();
		cleanups.push(wt);
		const { prompt } = await runBlueprint({
			worktreePath: wt,
			ctxOverrides: { runnerBackend: "codex-tmux", vendor: "codex" },
		});
		expect(prompt).toMatch(/gate brainstorm[^\n]*--no-block/);
		expect(prompt).not.toContain(
			"This command BLOCKS until your Lead confirms",
		);
	});

	it("claude default (no backend, no vendor) → blocking gate text, byte-compat", async () => {
		const { prompt } = await runBlueprint({});
		expect(prompt).toContain("This command BLOCKS until your Lead confirms");
		expect(prompt).toContain("This command BLOCKS until your Lead responds");
		expect(prompt).not.toMatch(/gate brainstorm[^\n]*--no-block/);
	});

	it("explicit claude backend + vendor claude-code → blocking gate text", async () => {
		const { prompt } = await runBlueprint({
			ctxOverrides: { runnerBackend: "claude-tmux", vendor: "claude-code" },
		});
		expect(prompt).toContain("This command BLOCKS until your Lead confirms");
	});

	it("pathological REVERSE (vendor=codex, backend absent→claude-tmux) → claude blocking text: backend is the ONLY discriminant", async () => {
		// This combo cannot be produced by run-dispatcher (vendor is only set
		// alongside backendFields) — the assertion documents that execution
		// semantics follow the backend, and vendor alone changes nothing.
		const { prompt } = await runBlueprint({
			ctxOverrides: { vendor: "codex" },
		});
		expect(prompt).toContain("This command BLOCKS until your Lead confirms");
		expect(prompt).not.toMatch(/gate brainstorm[^\n]*--no-block/);
	});
});

describe("FLY-1188 codex worktree defense (sandbox anchoring)", () => {
	it("codex-tmux with NO worktree (projectRoot fallback) → fail loud, adapter never spawned", async () => {
		const { result, executeMock } = await runBlueprint({
			ctxOverrides: { runnerBackend: "codex-tmux" },
			// no worktreePath → Blueprint has no worktreeManager → cwd=projectRoot
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("codex_worktree_required");
		expect(executeMock).not.toHaveBeenCalled();
	});

	it("codex-tmux with a symlinked worktree path → realpath equality passes (FLY-793 tolerance)", async () => {
		const real = makeRealWorktree();
		cleanups.push(real);
		const linkParent = join(
			tmpdir(),
			`fly1188-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		mkdirSync(linkParent, { recursive: true });
		cleanups.push(linkParent);
		const link = join(linkParent, "wt-link");
		symlinkSync(real, link);

		const { result, executeMock } = await runBlueprint({
			worktreePath: link,
			ctxOverrides: { runnerBackend: "codex-tmux" },
		});
		expect(result.success).toBe(true);
		expect(executeMock).toHaveBeenCalledOnce();
		const execCtx = executeMock.mock.calls[0]![0] as AdapterExecutionContext;
		expect(execCtx.cwd).toBe(link); // cwd untouched — realpathing is the adapter's job
	});

	it("claude runner with NO worktree keeps the legacy projectRoot spawn (byte-compat)", async () => {
		const { result, executeMock } = await runBlueprint({});
		expect(result.success).toBe(true);
		expect(executeMock).toHaveBeenCalledOnce();
		const execCtx = executeMock.mock.calls[0]![0] as AdapterExecutionContext;
		expect(execCtx.cwd).toBe("/tmp/fly1188-project");
	});
});
