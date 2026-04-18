import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WorktreeExecFn, WorktreeManager } from "../WorktreeManager.js";

const execFileAsync = promisify(execFile);
async function gitCmd(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
}

// ─── Helpers ─────────────────────────────────────

function makeMockExec(responses: Array<{ stdout: string } | Error> = []): {
	fn: WorktreeExecFn;
	calls: Array<{ cmd: string; args: string[]; cwd: string }>;
} {
	const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
	let idx = 0;
	const fn: WorktreeExecFn = async (cmd, args, cwd) => {
		calls.push({ cmd, args, cwd });
		const resp = responses[idx++];
		if (resp instanceof Error) throw resp;
		return resp ?? { stdout: "" };
	};
	return { fn, calls };
}

function noopBgDelete() {}

// mainRepoPath="/main/repo" → repoSlug="repo" → branch/dir prefix="repo-"
const PORCELAIN_TWO_WORKTREES = [
	"worktree /main/repo",
	"HEAD abc1234",
	"branch refs/heads/main",
	"",
	"worktree /home/user/.flywheel/worktrees/proj/repo-GEO-42",
	"HEAD def5678",
	"branch refs/heads/repo-GEO-42",
	"",
].join("\n");

const PORCELAIN_DETACHED = [
	"worktree /main/repo",
	"HEAD abc1234",
	"branch refs/heads/main",
	"",
	"worktree /some/path",
	"HEAD 9999999",
	"detached",
	"",
].join("\n");

const PORCELAIN_BARE = ["worktree /bare/repo", "HEAD abc1234", "bare", ""].join(
	"\n",
);

const PORCELAIN_SINGLE = [
	"worktree /main/repo",
	"HEAD abc1234",
	"branch refs/heads/main",
	"",
].join("\n");

// ─── Tests ───────────────────────────────────────

describe("WorktreeManager", () => {
	// ── create() ──

	describe("create()", () => {
		it("calls correct git worktree add command", async () => {
			const { fn, calls } = makeMockExec([
				{ stdout: "" }, // git worktree add
				{ stdout: "" }, // git config
			]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(calls[0].cmd).toBe("git");
			// FLY-99: -B (reset-or-create) replaces -b so a stale local branch
			// left behind by a crashed Runner is reset to startPoint instead of
			// failing with "branch already exists".
			expect(calls[0].args).toContain("-B");
			expect(calls[0].args).not.toContain("-b");
			expect(calls[0].args).toContain("repo-GEO-42");
			expect(
				calls[0].args.some((a) => a.includes("origin/main^{commit}")),
			).toBe(true);
		});

		it("sets push.autoSetupRemote", async () => {
			const { fn, calls } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(calls[1].args).toEqual(
				expect.arrayContaining([
					"config",
					"--local",
					"push.autoSetupRemote",
					"true",
				]),
			);
		});

		it("uses custom startPoint", async () => {
			const { fn, calls } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
				startPoint: "feature/base",
			});

			expect(
				calls[0].args.some((a) => a.includes("feature/base^{commit}")),
			).toBe(true);
		});

		it("FLY-115: falls back to FLYWHEEL_RUNNER_START_POINT env when opts.startPoint unset", async () => {
			const { fn, calls } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);
			const prev = process.env.FLYWHEEL_RUNNER_START_POINT;
			process.env.FLYWHEEL_RUNNER_START_POINT = "refs/remotes/origin/feat/x";
			try {
				await mgr.create({
					mainRepoPath: "/main/repo",
					projectName: "proj",
					issueId: "GEO-42",
				});
				expect(
					calls[0].args.some((a) =>
						a.includes("refs/remotes/origin/feat/x^{commit}"),
					),
				).toBe(true);
			} finally {
				if (prev === undefined) delete process.env.FLYWHEEL_RUNNER_START_POINT;
				else process.env.FLYWHEEL_RUNNER_START_POINT = prev;
			}
		});

		it("FLY-115: opts.startPoint still wins over FLYWHEEL_RUNNER_START_POINT env", async () => {
			const { fn, calls } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);
			const prev = process.env.FLYWHEEL_RUNNER_START_POINT;
			process.env.FLYWHEEL_RUNNER_START_POINT = "refs/remotes/origin/ignored";
			try {
				await mgr.create({
					mainRepoPath: "/main/repo",
					projectName: "proj",
					issueId: "GEO-43",
					startPoint: "feature/base",
				});
				expect(
					calls[0].args.some((a) => a.includes("feature/base^{commit}")),
				).toBe(true);
				expect(calls[0].args.some((a) => a.includes("ignored"))).toBe(false);
			} finally {
				if (prev === undefined) delete process.env.FLYWHEEL_RUNNER_START_POINT;
				else process.env.FLYWHEEL_RUNNER_START_POINT = prev;
			}
		});

		it("creates correct worktree path (with baseDir)", async () => {
			const { fn } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			const info = await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(info.worktreePath).toBe("/tmp/wt/proj/repo-GEO-42");
		});

		it("returns complete WorktreeInfo", async () => {
			const { fn } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			const info = await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(info).toEqual({
				projectName: "proj",
				issueId: "GEO-42",
				worktreePath: "/tmp/wt/proj/repo-GEO-42",
				branch: "repo-GEO-42",
				mainRepoPath: "/main/repo",
			});
		});

		it("throws on git lock error", async () => {
			const { fn } = makeMockExec([
				new Error("fatal: Unable to create '.git/worktrees/lock': File exists"),
			]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			await expect(
				mgr.create({
					mainRepoPath: "/main/repo",
					projectName: "proj",
					issueId: "GEO-42",
				}),
			).rejects.toThrow(/lock/i);
		});

		it("throws on branch already checked out", async () => {
			const { fn } = makeMockExec([
				new Error("fatal: 'repo-GEO-42' is already checked out"),
			]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			await expect(
				mgr.create({
					mainRepoPath: "/main/repo",
					projectName: "proj",
					issueId: "GEO-42",
				}),
			).rejects.toThrow(/already checked out/i);
		});

		it("FLY-95: derives worktree path from projectDir when no baseDir", async () => {
			const { fn } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager(undefined, fn);

			const info = await mgr.create({
				mainRepoPath: "/Users/x/Dev/GeoForge3D",
				projectName: "proj",
				issueId: "GEO-42",
			});

			// /Users/x/Dev/geoforge3d-GEO-42  (sibling, lowercase basename)
			expect(info.worktreePath).toBe("/Users/x/Dev/geoforge3d-GEO-42");
			expect(info.branch).toBe("geoforge3d-GEO-42");
		});
	});

	// ── remove() ──

	describe("remove()", () => {
		let tmpDir: string;

		afterEach(() => {
			if (tmpDir && fs.existsSync(tmpDir)) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("renames worktree dir to temp location", async () => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-remove-"));
			const worktreeDir = path.join(tmpDir, "repo-GEO-42");
			fs.mkdirSync(worktreeDir);

			const { fn } = makeMockExec([{ stdout: "" }]); // git worktree prune
			const mgr = new WorktreeManager(
				{ baseDir: tmpDir, bgDeleteFn: noopBgDelete },
				fn,
			);

			await mgr.remove("/main/repo", worktreeDir);

			// Original dir should no longer exist (renamed)
			expect(fs.existsSync(worktreeDir)).toBe(false);
		});

		it("calls git worktree prune after rename", async () => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-prune-"));
			const worktreeDir = path.join(tmpDir, "repo-GEO-42");
			fs.mkdirSync(worktreeDir);

			const { fn, calls } = makeMockExec([{ stdout: "" }]);
			const mgr = new WorktreeManager(
				{ baseDir: tmpDir, bgDeleteFn: noopBgDelete },
				fn,
			);

			await mgr.remove("/main/repo", worktreeDir);

			expect(calls.some((c) => c.args.includes("prune"))).toBe(true);
		});

		it("spawns background /bin/rm -rf", async () => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-rm-"));
			const worktreeDir = path.join(tmpDir, "repo-GEO-42");
			fs.mkdirSync(worktreeDir);

			const bgCalls: Array<{ cmd: string; args: string[] }> = [];
			const { fn } = makeMockExec([{ stdout: "" }]);
			const mgr = new WorktreeManager(
				{
					baseDir: tmpDir,
					bgDeleteFn: (cmd, args) => bgCalls.push({ cmd, args }),
				},
				fn,
			);

			await mgr.remove("/main/repo", worktreeDir);

			expect(bgCalls).toHaveLength(1);
			expect(bgCalls[0].cmd).toBe("/bin/rm");
			expect(bgCalls[0].args[0]).toBe("-rf");
		});

		it("throws on rename failure (non-ENOENT)", async () => {
			const { fn } = makeMockExec([]);
			const mgr = new WorktreeManager(
				{ baseDir: "/tmp/wt", bgDeleteFn: noopBgDelete },
				fn,
			);

			vi.spyOn(fs.promises, "rename").mockRejectedValue(
				Object.assign(new Error("EACCES"), { code: "EACCES" }),
			);

			await expect(
				mgr.remove("/main/repo", "/tmp/wt/repo-GEO-42"),
			).rejects.toThrow("EACCES");

			vi.restoreAllMocks();
		});

		it("handles ENOENT (dir already gone) — skips rename, only prunes", async () => {
			const { fn, calls } = makeMockExec([{ stdout: "" }]); // prune
			const mgr = new WorktreeManager(
				{ baseDir: "/tmp/wt", bgDeleteFn: noopBgDelete },
				fn,
			);

			vi.spyOn(fs.promises, "rename").mockRejectedValue(
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			);

			await mgr.remove("/main/repo", "/tmp/wt/repo-GEO-42");

			expect(calls.some((c) => c.args.includes("prune"))).toBe(true);

			vi.restoreAllMocks();
		});
	});

	// ── isRegistered() ──

	describe("isRegistered()", () => {
		it("returns true for registered worktree", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_TWO_WORKTREES }]);
			const mgr = new WorktreeManager({}, fn);

			const result = await mgr.isRegistered(
				"/main/repo",
				"/home/user/.flywheel/worktrees/proj/repo-GEO-42",
			);
			expect(result).toBe(true);
		});

		it("returns false for unregistered path", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_TWO_WORKTREES }]);
			const mgr = new WorktreeManager({}, fn);

			const result = await mgr.isRegistered("/main/repo", "/some/other/path");
			expect(result).toBe(false);
		});
	});

	// ── list() ──

	describe("list()", () => {
		it("parses porcelain output", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_TWO_WORKTREES }]);
			const mgr = new WorktreeManager({}, fn);

			const list = await mgr.list("/main/repo");
			expect(list).toHaveLength(2);
			expect(list[0]).toEqual({
				path: "/main/repo",
				branch: "main",
				isDetached: false,
				isBare: false,
			});
			expect(list[1]).toEqual({
				path: "/home/user/.flywheel/worktrees/proj/repo-GEO-42",
				branch: "repo-GEO-42",
				isDetached: false,
				isBare: false,
			});
		});

		it("handles detached HEAD", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_DETACHED }]);
			const mgr = new WorktreeManager({}, fn);

			const list = await mgr.list("/main/repo");
			expect(list[1]).toMatchObject({
				path: "/some/path",
				branch: null,
				isDetached: true,
			});
		});

		it("handles bare worktree", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_BARE }]);
			const mgr = new WorktreeManager({}, fn);

			const list = await mgr.list("/main/repo");
			expect(list[0]).toMatchObject({
				path: "/bare/repo",
				isBare: true,
			});
		});

		it("returns single entry for single-worktree repo", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_SINGLE }]);
			const mgr = new WorktreeManager({}, fn);

			const list = await mgr.list("/main/repo");
			expect(list).toHaveLength(1);
		});
	});

	// ── pruneOrphans() ──

	describe("pruneOrphans()", () => {
		it("prunes missing directories", async () => {
			const porcelain = [
				"worktree /main/repo",
				"HEAD abc1234",
				"branch refs/heads/main",
				"",
				"worktree /base/proj/repo-GEO-42",
				"HEAD def5678",
				"branch refs/heads/repo-GEO-42",
				"",
				"worktree /base/proj/repo-GEO-43",
				"HEAD ghi9012",
				"branch refs/heads/repo-GEO-43",
				"",
			].join("\n");

			const { fn } = makeMockExec([
				{ stdout: porcelain }, // list
				{ stdout: "" }, // prune (from remove of GEO-43)
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/base", bgDeleteFn: noopBgDelete },
				fn,
			);

			// Mock fs.existsSync: GEO-42 exists, GEO-43 doesn't
			const origExists = fs.existsSync;
			vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.includes("repo-GEO-42")) return true;
				if (s.includes("repo-GEO-43")) return false;
				return origExists(s);
			});

			// Mock rename (for remove — dir doesn't exist)
			vi.spyOn(fs.promises, "rename").mockRejectedValue(
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			);

			const pruned = await mgr.pruneOrphans("/main/repo", "proj");

			expect(pruned).toContain("/base/proj/repo-GEO-43");
			expect(pruned).not.toContain("/base/proj/repo-GEO-42");

			vi.restoreAllMocks();
		});

		it("returns empty array when no orphans", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_SINGLE }]);
			const mgr = new WorktreeManager({}, fn);

			const pruned = await mgr.pruneOrphans("/main/repo", "proj");
			expect(pruned).toEqual([]);
		});
	});

	// ── removeIfExists() ──

	describe("removeIfExists()", () => {
		it("removes registered worktree + deletes branch", async () => {
			const { fn, calls } = makeMockExec([
				{ stdout: PORCELAIN_TWO_WORKTREES }, // list (isRegistered)
				{ stdout: "" }, // rename (remove phase 1) — will use fs.rename mock
				{ stdout: "" }, // git worktree prune (remove phase 2)
				{ stdout: "" }, // git branch -D
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/home/user/.flywheel/worktrees", bgDeleteFn: noopBgDelete },
				fn,
			);

			// Mock fs.promises.rename to succeed
			vi.spyOn(fs.promises, "rename").mockResolvedValue(undefined);

			const cleaned = await mgr.removeIfExists("/main/repo", "proj", "GEO-42");
			expect(cleaned).toBe(true);

			// Verify branch -D was called
			const branchCall = calls.find(
				(c) => c.args.includes("branch") && c.args.includes("-D"),
			);
			expect(branchCall).toBeDefined();
			expect(branchCall!.args).toContain("repo-GEO-42");

			vi.restoreAllMocks();
		});

		it("is no-op when nothing exists (first run)", async () => {
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_SINGLE }, // list (isRegistered → false)
				{ stdout: "" }, // FLY-99: Step 1b prune --expire=now
				new Error("error: branch 'repo-GEO-99' not found"), // git branch -D
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/home/user/.flywheel/worktrees", bgDeleteFn: noopBgDelete },
				fn,
			);

			const cleaned = await mgr.removeIfExists("/main/repo", "proj", "GEO-99");
			expect(cleaned).toBe(false);
		});

		it("succeeds even if branch doesn't exist (worktree only)", async () => {
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_TWO_WORKTREES }, // list (isRegistered → true)
				{ stdout: "" }, // git worktree prune (remove — ENOENT path)
				{ stdout: "" }, // FLY-99: Step 1b prune --expire=now
				new Error("error: branch 'repo-GEO-42' not found"), // branch -D
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/home/user/.flywheel/worktrees", bgDeleteFn: noopBgDelete },
				fn,
			);

			// Mock rename to throw ENOENT (dir already gone)
			vi.spyOn(fs.promises, "rename").mockRejectedValue(
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			);

			// FLY-99: `cleaned` is now true because the registered worktree was
			// cleaned via remove() — even though branch -D reported "not found".
			const cleaned = await mgr.removeIfExists("/main/repo", "proj", "GEO-42");
			expect(cleaned).toBe(true);

			vi.restoreAllMocks();
		});

		it("FLY-99: cleans up orphan directory synchronously (exists but not registered)", async () => {
			const bgDeleteCalls: Array<{ cmd: string; args: string[] }> = [];
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_SINGLE }, // list (isRegistered → false)
				{ stdout: "" }, // FLY-99: Step 1b prune --expire=now
				{ stdout: "" }, // branch -D succeeds (stale branch still present)
			]);
			const mgr = new WorktreeManager(
				{
					baseDir: "/home/user/.flywheel/worktrees",
					bgDeleteFn: (cmd, args) => bgDeleteCalls.push({ cmd, args }),
				},
				fn,
			);

			// Mock existsSync to return true for orphan dir
			vi.spyOn(fs, "existsSync").mockReturnValue(true);
			const rmSpy = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);

			const cleaned = await mgr.removeIfExists("/main/repo", "proj", "GEO-42");
			expect(cleaned).toBe(true);

			// FLY-99: orphan dir cleanup uses awaited fs.promises.rm, NOT bgDelete.
			expect(rmSpy).toHaveBeenCalledWith(
				"/home/user/.flywheel/worktrees/proj/repo-GEO-42",
				{ recursive: true, force: true },
			);
			expect(bgDeleteCalls).toHaveLength(0);

			vi.restoreAllMocks();
		});

		it("propagates non-'not found' errors from branch -D", async () => {
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_SINGLE }, // list (isRegistered → false)
				{ stdout: "" }, // FLY-99: Step 1b prune --expire=now
				new Error("fatal: unexpected git error"), // branch -D
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/home/user/.flywheel/worktrees", bgDeleteFn: noopBgDelete },
				fn,
			);

			await expect(
				mgr.removeIfExists("/main/repo", "proj", "GEO-42"),
			).rejects.toThrow("unexpected git error");
		});

		// FLY-99: Race regression — removeIfExists() must await fs.rm on the orphan
		// directory so the subsequent create() doesn't race a still-running delete.
		// If anyone ever reverts the orphan-dir cleanup to fire-and-forget, this
		// test fails deterministically (rmStarted won't fire or settled flips early).
		it("FLY-99: orphan directory cleanup awaits fs.rm before returning", async () => {
			const bgDeleteCalls: Array<{ cmd: string; args: string[] }> = [];
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_SINGLE }, // isRegistered → false
				{ stdout: "" }, // FLY-99: Step 1b prune --expire=now
				new Error("error: branch 'repo-GEO-42' not found"), // branch -D
			]);
			const mgr = new WorktreeManager(
				{
					baseDir: "/home/user/.flywheel/worktrees",
					bgDeleteFn: (cmd, args) => bgDeleteCalls.push({ cmd, args }),
				},
				fn,
			);

			// Orphan dir exists on disk
			vi.spyOn(fs, "existsSync").mockReturnValue(true);

			// Two deferreds: rmStarted proves fs.rm was invoked; rmPromise
			// controls when rm resolves.
			let rmStartedResolve!: () => void;
			const rmStarted = new Promise<void>((r) => {
				rmStartedResolve = r;
			});
			let rmResolve!: () => void;
			const rmPromise = new Promise<void>((r) => {
				rmResolve = r;
			});
			const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementationOnce(() => {
				rmStartedResolve();
				return rmPromise;
			});

			const removePromise = mgr.removeIfExists("/main/repo", "proj", "GEO-42");

			let settled = false;
			removePromise.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);

			// Wait until fs.rm is actually invoked — proves code reached
			// `await fs.promises.rm(...)`. We can't rely on a fixed number of
			// microtask flushes because removeIfExists() has several awaits
			// (isRegistered → list → exec) before the rm call.
			await rmStarted;
			// Let any enqueued continuation run.
			await Promise.resolve();

			// removeIfExists must still be pending — its await on fs.rm is blocked.
			expect(settled).toBe(false);

			rmResolve();
			// cleaned === true because orphan dir was removed, even though branch -D
			// reported "not found".
			await expect(removePromise).resolves.toBe(true);

			expect(rmSpy).toHaveBeenCalledWith(
				"/home/user/.flywheel/worktrees/proj/repo-GEO-42",
				{ recursive: true, force: true },
			);
			// No bgDelete — orphan-dir cleanup is now awaited, not fire-and-forget.
			expect(bgDeleteCalls).toHaveLength(0);

			vi.restoreAllMocks();
		});
	});

	// ── FLY-99 real-git integration ──
	// These tests run actual `git` against a throwaway bare origin + clone so we
	// verify the real semantics of `-B` and the orphan-dir → create() cycle, not
	// just the mocked exec surface.
	describe("FLY-99 real git integration", () => {
		let workDir: string;

		async function setupRepo(): Promise<{
			mainRepo: string;
			commit1: string;
			commit2: string;
		}> {
			const origin = path.join(workDir, "origin.git");
			await execFileAsync("git", [
				"init",
				"--bare",
				"--initial-branch=main",
				origin,
			]);

			// Seed origin via a throwaway clone so it has an `origin/main` head
			// the worktree tests can use as startPoint.
			const seed = path.join(workDir, "seed");
			await execFileAsync("git", ["clone", origin, seed]);
			await execFileAsync("git", [
				"-C",
				seed,
				"config",
				"user.email",
				"test@example.com",
			]);
			await execFileAsync("git", ["-C", seed, "config", "user.name", "Test"]);
			fs.writeFileSync(path.join(seed, "f.txt"), "v1");
			await execFileAsync("git", ["-C", seed, "add", "."]);
			await execFileAsync("git", ["-C", seed, "commit", "-m", "v1"]);
			await execFileAsync("git", ["-C", seed, "push", "-u", "origin", "main"]);
			fs.writeFileSync(path.join(seed, "f.txt"), "v2");
			await execFileAsync("git", ["-C", seed, "add", "."]);
			await execFileAsync("git", ["-C", seed, "commit", "-m", "v2"]);
			await execFileAsync("git", ["-C", seed, "push", "origin", "main"]);

			const mainRepo = path.join(workDir, "repo");
			await execFileAsync("git", ["clone", origin, mainRepo]);
			await execFileAsync("git", [
				"-C",
				mainRepo,
				"config",
				"user.email",
				"test@example.com",
			]);
			await execFileAsync("git", [
				"-C",
				mainRepo,
				"config",
				"user.name",
				"Test",
			]);

			const commit2 = await gitCmd(mainRepo, "rev-parse", "origin/main");
			const commit1 = await gitCmd(mainRepo, "rev-parse", "origin/main~1");
			return { mainRepo, commit1, commit2 };
		}

		beforeEach(() => {
			// realpath: macOS tmpdir is a /var → /private/var symlink; git
			// worktree list returns the resolved path, so normalize up front to
			// keep isRegistered() path comparisons accurate.
			workDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "wt-fly99-")),
			);
		});

		afterEach(() => {
			if (workDir && fs.existsSync(workDir)) {
				fs.rmSync(workDir, { recursive: true, force: true });
			}
		});

		it("FLY-99: -B resets a stale local branch to startPoint without failing", async () => {
			const { mainRepo, commit1, commit2 } = await setupRepo();
			const mgr = new WorktreeManager();

			// Simulate a crashed Runner that left a stale `repo-GEO-42` local
			// branch pointing at an older commit.
			await execFileAsync("git", [
				"-C",
				mainRepo,
				"branch",
				"repo-GEO-42",
				commit1,
			]);

			// Under -b (create-only) this would fail with "branch already exists".
			// Under -B (reset-or-create) it must succeed and reset to origin/main.
			const info = await mgr.create({
				mainRepoPath: mainRepo,
				projectName: "proj",
				issueId: "GEO-42",
			});

			const branchSha = await gitCmd(
				mainRepo,
				"rev-parse",
				"refs/heads/repo-GEO-42",
			);
			expect(branchSha).toBe(commit2);
			expect(info.worktreePath).toBe(
				path.join(path.dirname(mainRepo), "repo-GEO-42"),
			);
			expect(fs.existsSync(info.worktreePath)).toBe(true);
		});

		it("FLY-99: orphan dir + orphan branch → removeIfExists → create full cycle", async () => {
			const { mainRepo } = await setupRepo();
			const mgr = new WorktreeManager();

			const worktreePath = path.join(path.dirname(mainRepo), "repo-GEO-42");

			// Residual state from a crashed Runner:
			//   1. a directory on disk at the worktree path that is NOT registered
			//      (git worktree add would refuse with "already exists"), and
			//   2. a stale local branch at the same name (git worktree add -b
			//      would refuse with "branch already exists").
			fs.mkdirSync(worktreePath);
			fs.writeFileSync(path.join(worktreePath, "leftover.txt"), "stale");
			await execFileAsync("git", ["-C", mainRepo, "branch", "repo-GEO-42"]);

			const cleaned = await mgr.removeIfExists(mainRepo, "proj", "GEO-42");
			expect(cleaned).toBe(true);
			expect(fs.existsSync(worktreePath)).toBe(false);

			// The create() that follows is what was actually crashing Runners in
			// prod: previously a non-awaited rm could still be deleting the orphan
			// dir, and `git worktree add` would see a partial tree. Now that
			// removeIfExists awaits the rm, this must succeed first try.
			const info = await mgr.create({
				mainRepoPath: mainRepo,
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(fs.existsSync(info.worktreePath)).toBe(true);
			expect(await mgr.isRegistered(mainRepo, info.worktreePath)).toBe(true);
			expect(fs.existsSync(path.join(info.worktreePath, "f.txt"))).toBe(true);
		});

		it("FLY-99: registered worktree + branch still 'checked out' after kill → removeIfExists → create succeeds", async () => {
			// Production repro: Runner called create() successfully, started work,
			// then got SIGKILL. The worktree is registered in .git/worktrees/<name>/
			// and the branch is still considered "checked out at" that gitdir.
			// Without --expire=now on prune, git's default gc.worktreePruneExpire
			// (3 months) leaves the admin dir untouched, so `branch -D` fails
			// with "Cannot delete branch X checked out at Y" and the subsequent
			// `worktree add -B` fails with "already checked out at".
			const { mainRepo } = await setupRepo();
			const mgr = new WorktreeManager();

			const first = await mgr.create({
				mainRepoPath: mainRepo,
				projectName: "proj",
				issueId: "GEO-99",
			});
			expect(await mgr.isRegistered(mainRepo, first.worktreePath)).toBe(true);
			fs.writeFileSync(path.join(first.worktreePath, "wip.txt"), "in-progress");

			// Simulate SIGKILL — Runner dies. Do NOT call remove/cleanup. The
			// worktree stays registered, the branch stays "checked out".

			const cleaned = await mgr.removeIfExists(mainRepo, "proj", "GEO-99");
			expect(cleaned).toBe(true);

			const second = await mgr.create({
				mainRepoPath: mainRepo,
				projectName: "proj",
				issueId: "GEO-99",
			});
			expect(fs.existsSync(second.worktreePath)).toBe(true);
			expect(await mgr.isRegistered(mainRepo, second.worktreePath)).toBe(true);
			// The stale file from the first (killed) Runner must not bleed into
			// the rerun — worktree was fully cleaned, not re-attached.
			expect(fs.existsSync(path.join(second.worktreePath, "wip.txt"))).toBe(
				false,
			);
		});

		it("FLY-99: 3× kill+rerun cycles on same issue never crash", async () => {
			// Stress the full kill/rerun loop. Mirrors the Annie ask: Runner 跑一半
			// 中断 → 同一个 issue 重跑 → 不 crash. Three rounds in a row.
			const { mainRepo } = await setupRepo();
			const mgr = new WorktreeManager();

			for (let i = 0; i < 3; i++) {
				const info = await mgr.create({
					mainRepoPath: mainRepo,
					projectName: "proj",
					issueId: "GEO-LOOP",
				});
				fs.writeFileSync(path.join(info.worktreePath, `cycle-${i}.txt`), "x");
				const cleaned = await mgr.removeIfExists(mainRepo, "proj", "GEO-LOOP");
				expect(cleaned).toBe(true);
			}
			const final = await mgr.create({
				mainRepoPath: mainRepo,
				projectName: "proj",
				issueId: "GEO-LOOP",
			});
			expect(fs.existsSync(final.worktreePath)).toBe(true);
		});
	});
});
