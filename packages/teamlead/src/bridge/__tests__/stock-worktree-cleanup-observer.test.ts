import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createStockCleanupPreviewer,
	parseRegisteredWorktrees,
} from "../stock-worktree-cleanup-observer.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

describe("stock worktree cleanup observer", () => {
	it("parses NUL-delimited registered worktrees including lock and detached state", () => {
		const parsed = parseRegisteredWorktrees(
			[
				"worktree /repo",
				`HEAD ${"a".repeat(40)}`,
				"branch refs/heads/main",
				"",
				"worktree /repo-feature",
				`HEAD ${"b".repeat(40)}`,
				"detached",
				"locked cleanup pending",
				"",
			].join("\0"),
		);
		expect(parsed).toEqual([
			{
				path: "/repo",
				head: "a".repeat(40),
				branch: "main",
				detached: false,
				locked: false,
			},
			{
				path: "/repo-feature",
				head: "b".repeat(40),
				branch: undefined,
				detached: true,
				locked: true,
			},
		]);
	});

	it("enumerates only through read operations and classifies an exact merged target", async () => {
		const root = await mkdtemp(join(tmpdir(), "fly2778-preview-"));
		roots.push(root);
		const projectRoot = join(root, "flywheel");
		const worktree = join(root, "flywheel-FLY-3000");
		await mkdir(projectRoot);
		await mkdir(worktree);
		await writeFile(join(worktree, ".git"), "gitdir: fixture\n");
		const head = "a".repeat(40);
		const gitCalls: string[][] = [];
		const gitExec = vi.fn(async (args: string[]) => {
			gitCalls.push(args);
			if (args.join(" ") === `-C ${projectRoot} worktree list --porcelain -z`) {
				return {
					code: 0,
					stdout: [
						`worktree ${projectRoot}`,
						`HEAD ${head}`,
						"branch refs/heads/main",
						"",
						`worktree ${worktree}`,
						`HEAD ${head}`,
						"branch refs/heads/flywheel-FLY-3000",
						"",
					].join("\0"),
					stderr: "",
				};
			}
			if (args.includes("status")) return { code: 0, stdout: "", stderr: "" };
			if (args.includes("get-url")) {
				return {
					code: 0,
					stdout: "https://github.com/xrliAnnie/flywheel.git\n",
					stderr: "",
				};
			}
			throw new Error(`unexpected git command: ${args.join(" ")}`);
		});
		const authorityCheck = vi.fn();
		const isCurrent = vi.fn(() => true);
		const observe = vi.fn(async () => ({
			identity: {
				executionId: "execution-3000",
				activationId: "activation-3000",
				generation: 1,
				lifecycleRevision: 0,
				adapter: "codex-tmux" as const,
			},
			ownerToken: "owner-3000",
			spawnEpoch: 1,
			verdict: "dead" as const,
			observedAt: "2026-09-26T20:00:00.000Z",
			expiresAt: "2026-09-26T20:01:00.000Z",
			bindingDigest: "c".repeat(64),
			reason: "writers_and_controller_gone",
		}));
		const observeNeverStarted = vi.fn(async () => ({
			identity: {
				executionId: "execution-3000",
				activationId: "activation-3000",
				generation: 1,
				lifecycleRevision: 0,
				adapter: "codex-tmux" as const,
			},
			source: {
				origin: "live_preflight" as const,
				projectName: "flywheel",
				issueId: "issue-3000",
				executionRunId: "run-3000",
				sourceEventId: "event-3000",
				proofDigest: "d".repeat(64),
				launchClaimState: "closed" as const,
				daemonLedger: "no_group" as const,
				daemonLedgerShape: "prelaunch_home_only" as const,
			},
			ownership: {
				state: "absent" as const,
				spawnInflight: false as const,
				restartInProgress: false as const,
				censusDigest: "e".repeat(64),
			},
			socket: {
				state: "absent" as const,
				evidenceDigest: "f".repeat(64),
			},
			lock: { state: "absent" as const, evidenceDigest: "1".repeat(64) },
			verdict: "dead" as const,
			observedAt: "2026-09-26T20:00:00.000Z",
			expiresAt: "2026-09-26T20:01:00.000Z",
			bindingDigest: "2".repeat(64),
			reason: "trusted_pre_spawn_body_absent",
		}));
		const isCurrentNeverStarted = vi.fn(() => true);
		const previewer = createStockCleanupPreviewer({
			projects: [
				{
					projectName: "flywheel",
					projectRoot,
					projectRepo: "xrliAnnie/flywheel",
				},
			],
			store: {
				listWorktreeBindings: () => [
					{
						execution_id: "execution-3000",
						status: "completed",
						path: worktree,
						branch: "flywheel-FLY-3000",
						generation: "generation-1",
					},
				],
				getSession: () => ({
					execution_id: "execution-3000",
					issue_id: "issue-3000",
					issue_identifier: "FLY-3000",
					project_name: "flywheel",
					status: "completed",
					adapter_type: "codex-tmux",
					lifecycle_revision: 0,
					pr_number: 3000,
					pr_head_sha: head,
				}),
				getWorkflowExecutionBinding: () => ({
					activation_id: "activation-3000",
					run_id: "run-3000",
				}),
			},
			gitExec,
			readGeneration: async () => "generation-1",
			inspectPullRequest: async () => ({
				number: 3000,
				state: "MERGED",
				headRef: "flywheel-FLY-3000",
				headSha: head,
				baseRef: "main",
				mergeCommitSha: "b".repeat(40),
				mergedAt: "2026-09-26T20:00:00.000Z",
			}),
			compareCommits: async () => "identical",
			bodyObserver: {
				observe,
				isCurrent,
				observeNeverStarted,
				isCurrentNeverStarted,
			},
			listCwds: async () => [],
			resolveTerminalAuthority: async () => ({
				state: "valid",
				identity: "land:operation-3000:0",
				operationId: "operation-3000",
			}),
			now: () => new Date("2026-09-26T20:00:00.000Z"),
		});

		const result = await previewer.preview({
			projectName: "flywheel",
			actor: "lead:eng",
			authorityCheck,
		});

		expect(result.manifest.targets).toHaveLength(1);
		expect(result.manifest.targets[0]).toMatchObject({
			canonicalPath: await realpath(worktree),
			eligible: true,
			exclusionReasons: [],
		});
		expect(authorityCheck).toHaveBeenCalled();
		expect(isCurrent).toHaveBeenCalledTimes(2);
		expect(gitCalls.flat()).not.toEqual(
			expect.arrayContaining(["fetch", "remove", "prune", "reset", "clean"]),
		);

		observe.mockImplementationOnce(async () => undefined);
		const neverStartedResult = await previewer.preview({
			projectName: "flywheel",
			actor: "lead:eng",
			authorityCheck,
		});
		expect(neverStartedResult.manifest.targets[0]).toMatchObject({
			eligible: true,
			exclusionReasons: [],
		});
		expect(observeNeverStarted).toHaveBeenCalledWith("execution-3000");
		expect(isCurrentNeverStarted).toHaveBeenCalledTimes(2);

		observe.mockImplementationOnce(async () => undefined);
		isCurrentNeverStarted.mockReturnValueOnce(false);
		const driftedResult = await previewer.preview({
			projectName: "flywheel",
			actor: "lead:eng",
			authorityCheck,
		});
		expect(driftedResult.manifest.targets[0]).toMatchObject({
			eligible: false,
			exclusionReasons: expect.arrayContaining(["body_unknown"]),
		});
	});

	it("finds an ignored nested repository without following symlinks", async () => {
		const root = await mkdtemp(join(tmpdir(), "fly2778-nested-"));
		roots.push(root);
		const nestedGit = join(root, "paired", "child", ".git");
		await mkdir(dirname(nestedGit), { recursive: true });
		await writeFile(nestedGit, "gitdir: elsewhere\n");
		const { scanNestedRepositories } = await import(
			"../stock-worktree-cleanup-observer.js"
		);
		expect(await scanNestedRepositories(root, [root])).toEqual("present");
	});
});
