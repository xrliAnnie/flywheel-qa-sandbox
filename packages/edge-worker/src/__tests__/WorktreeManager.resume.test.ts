import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type WorktreeExecFn, WorktreeManager } from "../WorktreeManager.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function seedRepo() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-resume-main-"));
	const baseDir = mkdtempSync(join(tmpdir(), "flywheel-resume-worktrees-"));
	const origin = mkdtempSync(join(tmpdir(), "flywheel-resume-origin-"));
	roots.push(root, baseDir, origin);
	git(origin, "init", "--quiet", "--bare");
	git(root, "init", "--quiet", "--initial-branch=main");
	git(root, "config", "user.name", "Flywheel Test");
	git(root, "config", "user.email", "test@flywheel.local");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	writeFileSync(join(root, "rename-me.txt"), "rename\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	git(root, "remote", "add", "origin", origin);
	git(root, "push", "--quiet", "-u", "origin", "main");
	git(
		root,
		"update-ref",
		"refs/flywheel/checkpoints/run-1/attachment-1",
		git(root, "rev-parse", "HEAD"),
	);
	return {
		root,
		baseDir,
		base: git(root, "rev-parse", "HEAD"),
		manager: new WorktreeManager({
			baseDir,
			pushGuardStateDir: join(baseDir, "state"),
			pushGuardSourcePath: join(
				process.cwd(),
				"assets",
				"push-guard",
				"pre-push",
			),
		}),
	};
}

function addSubmodule(repo: ReturnType<typeof seedRepo>) {
	const source = mkdtempSync(join(tmpdir(), "flywheel-resume-submodule-"));
	roots.push(source);
	git(source, "init", "--quiet", "--initial-branch=main");
	git(source, "config", "user.name", "Flywheel Test");
	git(source, "config", "user.email", "test@flywheel.local");
	writeFileSync(join(source, "sub.txt"), "first\n");
	git(source, "add", ".");
	git(source, "commit", "--quiet", "-m", "first");
	git(
		repo.root,
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		"--quiet",
		source,
		"module",
	);
	git(repo.root, "commit", "--quiet", "-am", "add submodule");
	const anchor = git(repo.root, "rev-parse", "HEAD");
	git(
		repo.root,
		"update-ref",
		"refs/flywheel/checkpoints/run-1/attachment-1",
		anchor,
	);
	writeFileSync(join(source, "sub.txt"), "second\n");
	git(source, "add", "sub.txt");
	git(source, "commit", "--quiet", "-m", "second");
	return { anchor, second: git(source, "rev-parse", "HEAD") };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("WorktreeManager.quarantineAndRebuild", () => {
	it("neutralizes repository-local git execution config while preserving quarantine evidence", async () => {
		const repo = seedRepo();
		const calls: string[][] = [];
		const exec: WorktreeExecFn = async (cmd, args, cwd, options) => {
			calls.push(args);
			const { stdout } = await execFileAsync(cmd, args, {
				cwd,
				env: options?.env,
				encoding: "utf8",
			});
			return { stdout: String(stdout) };
		};
		const manager = new WorktreeManager({ baseDir: repo.baseDir }, exec);
		await manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		calls.length = 0;
		await manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "safe-git",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		const rebuild = calls.findIndex(
			(args) => args.includes("worktree") && args.includes("list"),
		);
		const quarantineCalls = rebuild < 0 ? calls : calls.slice(0, rebuild);
		expect(quarantineCalls.length).toBeGreaterThan(0);
		for (const args of quarantineCalls) {
			expect(args).toEqual(
				expect.arrayContaining([
					"core.fsmonitor=false",
					"core.hooksPath=/dev/null",
					"protocol.ext.allow=never",
				]),
			);
		}
	});

	it("preserves distinct staged and worktree states before rebuilding at the explicit anchor", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		writeFileSync(join(created.worktreePath, "tracked.txt"), "staged\n");
		git(created.worktreePath, "add", "tracked.txt");
		writeFileSync(join(created.worktreePath, "tracked.txt"), "worktree\n");
		writeFileSync(join(created.worktreePath, "untracked.txt"), "new\n");

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-1",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(
			repo.base,
		);
		expect(git(result.worktree.worktreePath, "status", "--porcelain")).toBe("");
		git(repo.root, "reflog", "expire", "--all", "--expire=now");
		git(repo.root, "gc", "--prune=now");
		expect(git(repo.root, "show", `${result.quarantineRef}^:tracked.txt`)).toBe(
			"staged",
		);
		expect(git(repo.root, "show", `${result.quarantineRef}:tracked.txt`)).toBe(
			"worktree",
		);
		expect(
			git(repo.root, "show", `${result.quarantineRef}:untracked.txt`),
		).toBe("new");
	});

	it("archives a descendant commit and rewinds the branch to the anchor", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		writeFileSync(join(created.worktreePath, "tracked.txt"), "suffix\n");
		git(created.worktreePath, "add", "tracked.txt");
		git(created.worktreePath, "commit", "--quiet", "-m", "suffix");
		const suffix = git(created.worktreePath, "rev-parse", "HEAD");

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-2",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(git(repo.root, "rev-parse", result.quarantineRef)).toBe(suffix);
		expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(
			repo.base,
		);
	});

	it("holds external divergence without touching the existing worktree", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		git(repo.root, "checkout", "--quiet", "--orphan", "unrelated");
		git(repo.root, "rm", "-q", "-rf", ".");
		writeFileSync(join(repo.root, "other.txt"), "other\n");
		git(repo.root, "add", ".");
		git(repo.root, "commit", "--quiet", "-m", "unrelated");
		const unrelated = git(repo.root, "rev-parse", "HEAD");

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-3",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: unrelated,
		});

		expect(result).toMatchObject({ ok: false, reason: "external_drift" });
		expect(git(created.worktreePath, "rev-parse", "HEAD")).toBe(repo.base);
	});

	it("holds a remote branch advance without touching the existing worktree", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		writeFileSync(join(created.worktreePath, "local.txt"), "keep\n");
		writeFileSync(join(repo.root, "tracked.txt"), "remote advance\n");
		git(repo.root, "add", "tracked.txt");
		git(repo.root, "commit", "--quiet", "-m", "remote advance");
		git(
			repo.root,
			"push",
			"--quiet",
			"origin",
			`HEAD:refs/heads/${created.branch}`,
		);

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-remote-advance",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "external_drift",
			detail: "remote_branch_advanced",
		});
		expect(git(created.worktreePath, "status", "--porcelain")).toContain(
			"local.txt",
		);
	});

	it("returns a typed hold when the admitted anchor ref is missing", async () => {
		const repo = seedRepo();
		await expect(
			repo.manager.quarantineAndRebuild({
				mainRepoPath: repo.root,
				projectName: "flywheel",
				issueId: "FLY-1707",
				runId: "run-1",
				admissionKey: "admission-missing-anchor",
				anchorRef: "refs/flywheel/checkpoints/run-1/missing",
				anchorCommit: repo.base,
			}),
		).resolves.toMatchObject({
			ok: false,
			reason: "external_drift",
			detail: "anchor_unreachable",
		});
	});

	it("rebuilds a missing worktree and branch from the checkpoint anchor", async () => {
		const repo = seedRepo();

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-missing-worktree",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(
			repo.base,
		);
		expect(result.quarantineRef).toBeUndefined();
	});

	it("holds over-limit state without destructive rebuild", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		writeFileSync(join(created.worktreePath, "large.txt"), "too-large\n");

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-4",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
			limits: { maxFiles: 2_000, maxBytes: 1 },
		});

		expect(result).toMatchObject({ ok: false, reason: "quarantine_overflow" });
		expect(git(created.worktreePath, "status", "--porcelain")).toContain(
			"large.txt",
		);
	});

	it("preserves a staged deletion and a worktree recreation as separate states", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		git(created.worktreePath, "rm", "--quiet", "tracked.txt");
		writeFileSync(join(created.worktreePath, "tracked.txt"), "recreated\n");

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-delete-recreate",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(
			git(repo.root, "ls-tree", `${result.quarantineRef}^`, "tracked.txt"),
		).toBe("");
		expect(git(repo.root, "show", `${result.quarantineRef}:tracked.txt`)).toBe(
			"recreated",
		);
	});

	it("preserves staged rename semantics and the later worktree version", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		git(created.worktreePath, "mv", "rename-me.txt", "renamed.txt");
		writeFileSync(
			join(created.worktreePath, "renamed.txt"),
			"worktree rename\n",
		);

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-rename",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(git(repo.root, "show", `${result.quarantineRef}^:renamed.txt`)).toBe(
			"rename",
		);
		expect(
			git(repo.root, "ls-tree", `${result.quarantineRef}^`, "rename-me.txt"),
		).toBe("");
		expect(git(repo.root, "show", `${result.quarantineRef}:renamed.txt`)).toBe(
			"worktree rename",
		);
	});

	it("preserves copy, executable mode, symlink, and deep untracked entries", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		writeFileSync(join(created.worktreePath, "copied.txt"), "base\n");
		git(created.worktreePath, "add", "copied.txt");
		chmodSync(join(created.worktreePath, "tracked.txt"), 0o755);
		symlinkSync("tracked.txt", join(created.worktreePath, "link.txt"));
		mkdirSync(join(created.worktreePath, "deep", "nested"), {
			recursive: true,
		});
		writeFileSync(
			join(created.worktreePath, "deep", "nested", "new.txt"),
			"deep\n",
		);

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-modes",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(
			git(repo.root, "show", `${result.quarantineRef}:rename-me.txt`),
		).toBe("rename");
		expect(git(repo.root, "show", `${result.quarantineRef}:copied.txt`)).toBe(
			"base",
		);
		expect(
			git(repo.root, "ls-tree", result.quarantineRef, "tracked.txt"),
		).toMatch(/^100755 /);
		expect(git(repo.root, "ls-tree", result.quarantineRef, "link.txt")).toMatch(
			/^120000 /,
		);
		expect(git(repo.root, "show", `${result.quarantineRef}:link.txt`)).toBe(
			"tracked.txt",
		);
		expect(
			git(repo.root, "show", `${result.quarantineRef}:deep/nested/new.txt`),
		).toBe("deep");
	});

	it("stores physical worktree bytes without applying configured clean filters", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		git(created.worktreePath, "config", "filter.upper.clean", "tr a-z A-Z");
		git(created.worktreePath, "config", "filter.upper.smudge", "cat");
		writeFileSync(
			join(created.worktreePath, ".gitattributes"),
			"tracked.txt filter=upper\n",
		);
		writeFileSync(join(created.worktreePath, "tracked.txt"), "staged\n");
		git(created.worktreePath, "add", ".gitattributes", "tracked.txt");
		writeFileSync(join(created.worktreePath, "tracked.txt"), "worktree\n");

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-filter",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(git(repo.root, "show", `${result.quarantineRef}^:tracked.txt`)).toBe(
			"STAGED",
		);
		expect(git(repo.root, "show", `${result.quarantineRef}:tracked.txt`)).toBe(
			"worktree",
		);
	});

	it("holds a create-only quarantine ref race without removing the worktree", async () => {
		const repo = seedRepo();
		let raced = false;
		const racingExec: WorktreeExecFn = async (cmd, args, cwd, options) => {
			const ref = args.find((arg) =>
				arg.startsWith("refs/flywheel/quarantine/"),
			);
			if (!raced && args.includes("update-ref") && ref) {
				git(repo.root, "update-ref", ref, repo.base);
				raced = true;
			}
			const { stdout } = await execFileAsync(cmd, args, {
				cwd,
				env: options?.env,
				encoding: "utf8",
			});
			return { stdout: String(stdout) };
		};
		const manager = new WorktreeManager({ baseDir: repo.baseDir }, racingExec);
		const created = await manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		writeFileSync(join(created.worktreePath, "tracked.txt"), "dirty\n");

		const result = await manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-race",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "external_drift",
			detail: "quarantine_ref_race",
		});
		expect(git(created.worktreePath, "status", "--porcelain")).toContain(
			"tracked.txt",
		);
	});

	it("holds an unmerged index without touching the conflicted worktree", async () => {
		const repo = seedRepo();
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: repo.base,
		});
		writeFileSync(join(created.worktreePath, "tracked.txt"), "branch\n");
		git(created.worktreePath, "add", "tracked.txt");
		git(created.worktreePath, "commit", "--quiet", "-m", "branch change");
		writeFileSync(join(repo.root, "tracked.txt"), "main\n");
		git(repo.root, "add", "tracked.txt");
		git(repo.root, "commit", "--quiet", "-m", "main change");
		expect(() => git(created.worktreePath, "merge", "main")).toThrow();

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-conflict",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: repo.base,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "quarantine_overflow",
			detail: "unrepresentable_index",
		});
		expect(
			git(created.worktreePath, "ls-files", "--unmerged", "tracked.txt"),
		).not.toBe("");
	});

	it("archives a clean gitlink pointer change", async () => {
		const repo = seedRepo();
		const submodule = addSubmodule(repo);
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: submodule.anchor,
		});
		git(
			created.worktreePath,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"update",
			"--init",
			"--quiet",
		);
		git(
			join(created.worktreePath, "module"),
			"checkout",
			"--quiet",
			submodule.second,
		);

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-gitlink",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: submodule.anchor,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.reason);
		expect(git(repo.root, "ls-tree", result.quarantineRef, "module")).toContain(
			submodule.second,
		);
	});

	it("holds a dirty submodule without touching its bytes", async () => {
		const repo = seedRepo();
		const submodule = addSubmodule(repo);
		const created = await repo.manager.create({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			startPoint: submodule.anchor,
		});
		git(
			created.worktreePath,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"update",
			"--init",
			"--quiet",
		);
		writeFileSync(join(created.worktreePath, "module", "sub.txt"), "dirty\n");

		const result = await repo.manager.quarantineAndRebuild({
			mainRepoPath: repo.root,
			projectName: "flywheel",
			issueId: "FLY-1707",
			runId: "run-1",
			admissionKey: "admission-dirty-submodule",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: submodule.anchor,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "quarantine_overflow",
			detail: "unrepresentable_index",
		});
		expect(
			execFileSync(
				"git",
				["-C", created.worktreePath, "diff", "--", "module"],
				{
					encoding: "utf8",
				},
			),
		).toContain("-dirty");
	});
});
