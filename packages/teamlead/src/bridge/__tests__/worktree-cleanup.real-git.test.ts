import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorktreeManager } from "flywheel-edge-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergedWorktreeProof } from "../merged-worktree-proof.js";
import {
	gitWorktreeClean,
	makeWorktreeCleanup,
	type WorktreeCleanupDeps,
} from "../worktree-cleanup.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

type Fixture = ReturnType<typeof createFixture>;

function createFixture(branch: string, merge: boolean) {
	const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "fly2664-")));
	const root = path.join(parent, "flywheel");
	const worktreePath = path.join(parent, "flywheel-FLY-2601");
	mkdirSync(root);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Flywheel Test"]);
	git(root, ["config", "user.email", "flywheel-test@example.invalid"]);
	writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
	git(root, ["add", "README.md"]);
	git(root, ["commit", "-m", "base"]);
	const baseHead = git(root, ["rev-parse", "HEAD"]);
	git(root, ["worktree", "add", "-b", branch, worktreePath, "main"]);
	writeFileSync(path.join(worktreePath, "change.txt"), `${branch}\n`, "utf8");
	git(worktreePath, ["add", "change.txt"]);
	git(worktreePath, ["commit", "-m", "change"]);
	const branchHead = git(worktreePath, ["rev-parse", "HEAD"]);
	if (merge) git(root, ["merge", "--ff-only", branch]);
	const markerPath = git(worktreePath, [
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"flywheel.generation",
	]);
	writeFileSync(markerPath, "generation-2601\n", "utf8");
	return { parent, root, worktreePath, branch, baseHead, branchHead };
}

function mergedProof(
	fixture: Fixture,
	mergedPrHead: string,
): MergedWorktreeProof {
	return {
		operationId: "land:2601",
		operationGeneration: 2,
		projectName: "flywheel",
		issueId: "issue-2601",
		runId: "run-2601",
		repoIdentity: "xrliAnnie/flywheel",
		projectRoot: fixture.root,
		prNumber: 1232,
		baseRefName: "main",
		mergedPrHead,
		mergeSha: fixture.branchHead,
		mergeReceiptId: "land:2601:aux:merged_worktree_proof",
		observedAt: "2026-09-17T20:00:00.000Z",
	};
}

function cleanupFor(
	fixture: Fixture,
	overrides: Partial<WorktreeCleanupDeps> = {},
) {
	const manager = new WorktreeManager();
	const parent = statSync(fixture.parent);
	const recordLandOperationStep = vi.fn(() => ({
		ok: true as const,
		idempotentReplay: false,
	}));
	const deps: WorktreeCleanupDeps = {
		store: {
			getSession: () => undefined,
			getWorktreeBinding: () => undefined,
			insertEvent: vi.fn(),
			getLandOperation: () => ({ closeout_reservation_epoch: 1 }),
			recordLandOperationStep,
		} as never,
		worktreeManager: manager,
		resolveProjectRoot: () => fixture.root,
		isWorktreeClean: gitWorktreeClean,
		autoclean: true,
		withRepoLock: async (_repo, fn) => fn(),
		protectedBranchesForProject: () => [],
		isOperationAuthorityCurrent: () => true,
		...overrides,
	};
	const run = (proof?: MergedWorktreeProof) =>
		makeWorktreeCleanup(deps)({
			issueId: "issue-2601",
			issueIdentifier: "FLY-2601",
			projectName: "flywheel",
			tmuxClosed: true,
			tmuxErrors: [],
			operationContext: {
				operationAudit: {
					operationId: "land:2601",
					ownerId: "land-worker",
					generation: 2,
					runId: "run-2601",
					sourceExecutionId: null,
				},
				target: {
					kind: "bound_worktree",
					path: fixture.worktreePath,
					branch: "flywheel-FLY-2601",
					generation: "generation-2601",
					projectRoot: fixture.root,
					parentIdentity: {
						path: fixture.parent,
						dev: Number(parent.dev),
						ino: Number(parent.ino),
					},
					sourceExecutionIds: ["implement-2601"],
					sourceRunId: "run-2601",
					sourceReceipt: "state_session_binding:implement-2601:generation-2601",
				},
				...(proof ? { mergedWorktreeProof: proof } : {}),
			},
		} as never);
	return { run, recordLandOperationStep };
}

function expectRemoved(fixture: Fixture): void {
	expect(existsSync(fixture.worktreePath)).toBe(false);
	expect(git(fixture.root, ["worktree", "list", "--porcelain"])).not.toContain(
		`worktree ${fixture.worktreePath}`,
	);
	expect(
		spawnSync(
			"git",
			[
				"-C",
				fixture.root,
				"show-ref",
				"--quiet",
				"--verify",
				`refs/heads/${fixture.branch}`,
			],
			{ stdio: "ignore" },
		).status,
	).toBe(1);
}

function expectPreserved(fixture: Fixture): void {
	expect(existsSync(fixture.worktreePath)).toBe(true);
	expect(git(fixture.root, ["worktree", "list", "--porcelain"])).toContain(
		`worktree ${fixture.worktreePath}`,
	);
	expect(
		git(fixture.root, [
			"show-ref",
			"--hash",
			"--verify",
			`refs/heads/${fixture.branch}`,
		]),
	).toBe(fixture.branchHead);
}

describe("FLY-2664 real git worktree cleanup", () => {
	const parents: string[] = [];
	afterEach(() => {
		for (const parent of parents.splice(0)) {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("keeps the legacy derived-name path working and really removes directory, registration, and ref", async () => {
		const fixture = createFixture("flywheel-FLY-2601", true);
		parents.push(fixture.parent);
		const result = await cleanupFor(fixture).run();

		expect(result).toMatchObject({
			removed: true,
			cleanupState: "removed",
			branchDeleted: true,
			verificationMode: "derived_branch",
		});
		expectRemoved(fixture);
	});

	it("removes a clean docs branch only when the exact PR head is proven merged", async () => {
		const fixture = createFixture("docs/FLY-2601-founder-page-copy", true);
		parents.push(fixture.parent);
		const { run, recordLandOperationStep } = cleanupFor(fixture);
		const result = await run(mergedProof(fixture, fixture.branchHead));

		expect(result).toMatchObject({
			removed: true,
			cleanupState: "removed",
			branchDeleted: true,
			actualBranch: fixture.branch,
			verificationMode: "merged_branch_verified",
			mergeProof: { via: "exact_pr_head" },
		});
		expectRemoved(fixture);
		expect(recordLandOperationStep).toHaveBeenCalledWith(
			expect.objectContaining({
				receipt: expect.objectContaining({
					reason: "merged_branch_verified",
					registeredBranch: fixture.branch,
					expectedBranch: "flywheel-FLY-2601",
					mergeSha: fixture.branchHead,
				}),
			}),
		);
	});

	it("reports a partial remove_failed outcome when the merged branch ref moves before CAS", async () => {
		const fixture = createFixture("docs/FLY-2601-ref-moved", true);
		parents.push(fixture.parent);
		const cas = vi.fn(
			async () => ({ deleted: false, reason: "ref_moved" }) as never,
		);
		const result = await cleanupFor(fixture, {
			casDeleteLocalBranchFn: cas,
		}).run(mergedProof(fixture, fixture.branchHead));

		expect(result).toMatchObject({
			removed: true,
			cleanupState: "blocked",
			branchDeleted: false,
			branchDeleteReason: "ref_moved",
			skippedReason: "remove_failed:ref_moved",
			failure: { token: "remove_failed" },
		});
		expect(existsSync(fixture.worktreePath)).toBe(false);
		expect(
			git(fixture.root, ["worktree", "list", "--porcelain"]),
		).not.toContain(`worktree ${fixture.worktreePath}`);
		expect(
			git(fixture.root, [
				"show-ref",
				"--hash",
				"--verify",
				`refs/heads/${fixture.branch}`,
			]),
		).toBe(fixture.branchHead);
	});

	it("preserves an unmerged docs branch and never marks it cleaned", async () => {
		const fixture = createFixture("docs/FLY-2601-unmerged", false);
		parents.push(fixture.parent);
		const result = await cleanupFor(fixture).run(
			mergedProof(fixture, fixture.baseHead),
		);

		expect(result).toMatchObject({
			removed: false,
			cleanupState: "blocked",
			skippedReason: "branch_mismatch",
		});
		expectPreserved(fixture);
	});

	it.each(["tracked", "untracked"])(
		"preserves a merged docs branch when the worktree is dirty (%s)",
		async (dirtyKind) => {
			const fixture = createFixture("docs/FLY-2601-dirty", true);
			parents.push(fixture.parent);
			if (dirtyKind === "tracked") {
				writeFileSync(
					path.join(fixture.worktreePath, "change.txt"),
					"dirty\n",
					"utf8",
				);
			} else {
				writeFileSync(
					path.join(fixture.worktreePath, "untracked.txt"),
					"dirty\n",
					"utf8",
				);
			}

			const result = await cleanupFor(fixture).run(
				mergedProof(fixture, fixture.branchHead),
			);

			expect(result).toMatchObject({
				removed: false,
				cleanupState: "blocked",
				skippedReason: "dirty",
				verificationMode: "merged_branch_verified",
			});
			expectPreserved(fixture);
		},
	);
});
