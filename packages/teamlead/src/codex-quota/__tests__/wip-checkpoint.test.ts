import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkpointWorktree,
	WIP_CHECKPOINT_BUDGET_MS,
} from "../wip-checkpoint.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	}).trim();
}

function repo(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2900-wip-")));
	roots.push(root);
	git(root, "init", "-q", "-b", "feat");
	writeFileSync(join(root, "a.txt"), "one\n");
	writeFileSync(join(root, "b.txt"), "bee\n");
	writeFileSync(join(root, ".gitignore"), "ignored.log\n");
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "base");
	return root;
}

function objectCount(root: string): number {
	return Number(
		/count: (\d+)/.exec(git(root, "count-objects", "-v"))?.[1] ?? "0",
	);
}

const recordOk =
	(commits: string[]) => (commit: string, updateRef: () => void) => {
		commits.push(commit);
		updateRef();
		return { ok: true as const };
	};

describe("FLY-2900 C6 — WIP checkpoint of a parked worktree", () => {
	it("reports a clean tree without committing", () => {
		const root = repo();
		const head = git(root, "rev-parse", "HEAD");
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk([]),
			}),
		).toEqual({ kind: "clean", head });
	});

	it("commits worktree content (staged+unstaged, delete, rename, symlink, mode) and syncs the index", () => {
		const root = repo();
		writeFileSync(join(root, "a.txt"), "staged\n");
		git(root, "add", "a.txt");
		writeFileSync(join(root, "a.txt"), "worktree wins\n");
		unlinkSync(join(root, "b.txt"));
		writeFileSync(join(root, "new file.txt"), "untracked\n");
		writeFileSync(join(root, "run.sh"), "#!/bin/sh\n");
		chmodSync(join(root, "run.sh"), 0o755);
		symlinkSync("a.txt", join(root, "link"));
		writeFileSync(join(root, "ignored.log"), "noise\n");
		const before = git(root, "rev-parse", "HEAD");
		const commits: string[] = [];
		const result = checkpointWorktree({
			cwd: root,
			executionId: "exec-1",
			entrySeq: 1,
			issueId: "FLY-2900",
			record: recordOk(commits),
		});
		expect(result).toMatchObject({ kind: "committed" });
		const head = git(root, "rev-parse", "HEAD");
		expect(head).toBe(commits[0]);
		expect(git(root, "rev-parse", "HEAD~1")).toBe(before);
		expect(git(root, "status", "--porcelain=v2", "--untracked-files=all")).toBe(
			"",
		);
		expect(git(root, "show", "HEAD:a.txt")).toBe("worktree wins");
		expect(git(root, "ls-tree", "HEAD", "--name-only")).not.toContain("b.txt");
		expect(git(root, "ls-tree", "HEAD", "link")).toMatch(/^120000/);
		expect(git(root, "ls-tree", "HEAD", "run.sh")).toMatch(/^100755/);
		expect(git(root, "ls-tree", "HEAD", "--name-only")).not.toContain(
			"ignored.log",
		);
		expect(readFileSync(join(root, "ignored.log"), "utf8")).toBe("noise\n");
		expect(git(root, "log", "-1", "--format=%B")).toContain(
			"Flywheel-Quota-Checkpoint: exec-1:1",
		);
		expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
	});

	it("refuses an over-limit tree before writing any object", () => {
		const root = repo();
		for (let i = 0; i < 2001; i += 1)
			writeFileSync(join(root, `f${i}.txt`), "x");
		const objects = objectCount(root);
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk([]),
			}),
		).toEqual({ kind: "refused", code: "too_many_files" });
		expect(objectCount(root)).toBe(objects);
	});

	it("bounds the whole checkpoint: a spent budget refuses before any git write", () => {
		const root = repo();
		writeFileSync(join(root, "a.txt"), "dirty\n");
		const before = git(root, "rev-parse", "HEAD");
		const objects = objectCount(root);
		expect(WIP_CHECKPOINT_BUDGET_MS).toBeLessThanOrEqual(20_000);
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk([]),
				budgetMs: 0,
			}),
		).toEqual({ kind: "refused", code: "git_unavailable" });
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
		expect(objectCount(root)).toBe(objects);
	});

	it("refuses unmerged entries", () => {
		const root = repo();
		git(root, "checkout", "-q", "-b", "other");
		writeFileSync(join(root, "a.txt"), "other\n");
		git(root, "commit", "-q", "-am", "other");
		git(root, "checkout", "-q", "feat");
		writeFileSync(join(root, "a.txt"), "mine\n");
		git(root, "commit", "-q", "-am", "mine");
		try {
			git(root, "merge", "-q", "other");
		} catch {
			/* conflict expected */
		}
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk([]),
			}),
		).toEqual({ kind: "refused", code: "unmerged_entries" });
	});

	it("refuses a submodule change", () => {
		const root = repo();
		const head = git(root, "rev-parse", "HEAD");
		git(
			root,
			"update-index",
			"--add",
			"--cacheinfo",
			`160000,${head},vendored`,
		);
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk([]),
			}),
		).toEqual({ kind: "refused", code: "submodule_change" });
	});

	it("leaves the branch untouched when the fenced transaction refuses", () => {
		const root = repo();
		writeFileSync(join(root, "a.txt"), "dirty\n");
		const before = git(root, "rev-parse", "HEAD");
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: () => ({ ok: false, reason: "operator_close_intent" }),
			}),
		).toEqual({ kind: "refused", code: "operator_close_intent" });
		expect(git(root, "rev-parse", "HEAD")).toBe(before);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("dirty\n");
	});

	it("adopts a checkpoint whose ref moved before a crash, without committing twice", () => {
		const root = repo();
		writeFileSync(join(root, "a.txt"), "dirty\n");
		const commits: string[] = [];
		// Simulate: ref updated, then the process died before the index sync.
		checkpointWorktree({
			cwd: root,
			executionId: "exec-1",
			entrySeq: 1,
			issueId: "FLY-2900",
			record: recordOk(commits),
			git: (args, options) => {
				if (args[0] === "read-tree" && !options?.env) throw new Error("crash");
				const stdout = execFileSync("git", ["-C", root, ...args], {
					encoding: "utf8",
					env: { ...process.env, ...options?.env },
				});
				return { stdout, status: 0 };
			},
		});
		expect(git(root, "rev-parse", "HEAD")).toBe(commits[0]);
		const again: string[] = [];
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk(again),
			}),
		).toEqual({ kind: "adopted", commit: commits[0] });
		expect(again).toEqual([commits[0]]);
		expect(git(root, "rev-list", "--count", "HEAD")).toBe("2");
		expect(git(root, "status", "--porcelain=v2", "--untracked-files=all")).toBe(
			"",
		);
	});

	it("refuses to adopt a crashed checkpoint once the worktree drifted, leaving index and DB untouched", () => {
		const root = repo();
		writeFileSync(join(root, "a.txt"), "dirty\n");
		const commits: string[] = [];
		checkpointWorktree({
			cwd: root,
			executionId: "exec-1",
			entrySeq: 1,
			issueId: "FLY-2900",
			record: recordOk(commits),
			git: (args, options) => {
				if (args[0] === "read-tree" && !options?.env) throw new Error("crash");
				const stdout = execFileSync("git", ["-C", root, ...args], {
					encoding: "utf8",
					env: { ...process.env, ...options?.env },
				});
				return { stdout, status: 0 };
			},
		});
		expect(git(root, "rev-parse", "HEAD")).toBe(commits[0]);
		// After the crash someone stages new work and edits the tree.
		writeFileSync(join(root, "b.txt"), "staged later\n");
		git(root, "add", "b.txt");
		writeFileSync(join(root, "a.txt"), "edited later\n");
		const indexBefore = git(root, "ls-files", "-s");
		const again: string[] = [];
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk(again),
			}),
		).toEqual({ kind: "refused", code: "checkpoint_adoption_drift" });
		expect(again).toEqual([]);
		expect(git(root, "ls-files", "-s")).toBe(indexBefore);
		expect(git(root, "rev-parse", "HEAD")).toBe(commits[0]);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited later\n");
	});

	it("prechecks limits before comparing a crashed checkpoint, writing no object for an over-limit drift", () => {
		const root = repo();
		writeFileSync(join(root, "a.txt"), "dirty\n");
		const commits: string[] = [];
		checkpointWorktree({
			cwd: root,
			executionId: "exec-1",
			entrySeq: 1,
			issueId: "FLY-2900",
			record: recordOk(commits),
			git: (args, options) => {
				if (args[0] === "read-tree" && !options?.env) throw new Error("crash");
				const stdout = execFileSync("git", ["-C", root, ...args], {
					encoding: "utf8",
					env: { ...process.env, ...options?.env },
				});
				return { stdout, status: 0 };
			},
		});
		expect(git(root, "rev-parse", "HEAD")).toBe(commits[0]);
		for (let i = 0; i < 2001; i += 1)
			writeFileSync(join(root, `late${i}.txt`), `late ${i}`);
		const objects = objectCount(root);
		const again: string[] = [];
		expect(
			checkpointWorktree({
				cwd: root,
				executionId: "exec-1",
				entrySeq: 1,
				issueId: "FLY-2900",
				record: recordOk(again),
			}),
		).toEqual({ kind: "refused", code: "too_many_files" });
		expect(objectCount(root)).toBe(objects);
		expect(again).toEqual([]);
	});
});
