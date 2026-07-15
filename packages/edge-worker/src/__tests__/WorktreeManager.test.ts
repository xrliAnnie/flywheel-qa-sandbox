import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canonicalizeWorktreePath,
	deriveWorktreeKey,
	type WorktreeExecFn,
	WorktreeManager,
} from "../WorktreeManager.js";

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
	// FLY-1185: create() now resolves the generation-marker admin path via
	// `rev-parse --git-path flywheel.generation` and WRITES the marker file.
	// Intercept that probe (without consuming a scripted response) and hand it
	// a real temp path so mock-exec create() tests keep their response scripts.
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtm-marker-"));
	let markerN = 0;
	const fn: WorktreeExecFn = async (cmd, args, cwd) => {
		calls.push({ cmd, args, cwd });
		if (cmd === "git" && args.includes("flywheel.generation")) {
			return { stdout: path.join(markerDir, `marker-${markerN++}`) };
		}
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
				// FLY-1185 §2.1: creation-generation nonce (UUID) — the create-time
				// authority binding input.
				generation: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
				head: "abc1234",
				isDetached: false,
				isBare: false,
			});
			expect(list[1]).toEqual({
				path: "/home/user/.flywheel/worktrees/proj/repo-GEO-42",
				branch: "repo-GEO-42",
				head: "def5678",
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
		// FLY-99: defensive restore so a failing assertion in one test doesn't
		// leak a `vi.spyOn` into later tests (e.g. fs.existsSync spies bleeding
		// into real-git integration tests and causing confusing passes/fails).
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("removes registered worktree + deletes branch", async () => {
			// Exec sequence (rename is a filesystem op, not exec):
			//   1. `worktree list --porcelain` (from isRegistered)
			//   2. `worktree prune` (remove() Phase 2, after rename)
			//   3. `worktree prune` (Step 1b, unconditional pre-branch-D prune)
			//   4. `branch -D`
			const { fn, calls } = makeMockExec([
				{ stdout: PORCELAIN_TWO_WORKTREES }, // 1. list
				{ stdout: "" }, // 2. prune (Phase 2)
				{ stdout: "" }, // 3. prune (Step 1b)
				{ stdout: "" }, // 4. branch -D
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/home/user/.flywheel/worktrees", bgDeleteFn: noopBgDelete },
				fn,
			);

			// Mock fs.promises.rename to succeed
			vi.spyOn(fs.promises, "rename").mockResolvedValue(undefined);

			const cleaned = await mgr.removeIfExists("/main/repo", "proj", "GEO-42");
			expect(cleaned).toBe(true);

			// FLY-99: assert exec call count so makeMockExec's post-exhaustion
			// default `{ stdout: "" }` can't silently mask an added/removed step.
			expect(calls).toHaveLength(4);
			const pruneCalls = calls.filter(
				(c) => c.args.includes("worktree") && c.args.includes("prune"),
			);
			expect(pruneCalls).toHaveLength(2);

			const branchCall = calls.find(
				(c) => c.args.includes("branch") && c.args.includes("-D"),
			);
			expect(branchCall).toBeDefined();
			expect(branchCall!.args).toContain("repo-GEO-42");
		});

		it("is no-op when nothing exists (first run)", async () => {
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_SINGLE }, // list (isRegistered → false)
				{ stdout: "" }, // FLY-99: Step 1b prune (pre-branch-D)
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
				{ stdout: "" }, // FLY-99: Step 1b prune (pre-branch-D)
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
				{ stdout: "" }, // FLY-99: Step 1b prune (pre-branch-D)
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
				{ stdout: "" }, // FLY-99: Step 1b prune (pre-branch-D)
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
				{ stdout: "" }, // FLY-99: Step 1b prune (pre-branch-D)
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

		// FLY-99 path-mismatch fixture: seed repos under a `real-parent/`
		// subdirectory, then build a `link-parent/` directory symlink that
		// points to it. Callers pass `link-parent/repo` as mainRepoPath so
		// git canonicalizes internally but WorktreeManager's string-compare
		// in isRegistered() sees the unresolved `link-parent/...` form. This
		// does NOT rely on the macOS `/var → /private/var` tmpdir quirk —
		// the symlink is explicit, so Linux CI reproduces the same mismatch.
		async function setupSymlinkedRepo(): Promise<{
			mainRepoCanonical: string;
			mainRepoViaSymlink: string;
		}> {
			const realParent = path.join(workDir, "real-parent");
			fs.mkdirSync(realParent);

			const origin = path.join(realParent, "origin.git");
			await execFileAsync("git", [
				"init",
				"--bare",
				"--initial-branch=main",
				origin,
			]);

			const seed = path.join(realParent, "seed");
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

			const mainRepoCanonical = path.join(realParent, "repo");
			await execFileAsync("git", ["clone", origin, mainRepoCanonical]);
			await execFileAsync("git", [
				"-C",
				mainRepoCanonical,
				"config",
				"user.email",
				"test@example.com",
			]);
			await execFileAsync("git", [
				"-C",
				mainRepoCanonical,
				"config",
				"user.name",
				"Test",
			]);

			const linkParent = path.join(workDir, "link-parent");
			fs.symlinkSync(realParent, linkParent);
			const mainRepoViaSymlink = path.join(linkParent, "repo");

			return { mainRepoCanonical, mainRepoViaSymlink };
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

		it("FLY-99 + FLY-793: symlinked mainRepoPath → isRegistered now canonicalizes (true) → clean rerun", async () => {
			// Production repro via an EXPLICIT directory symlink so the test
			// behaves identically on macOS and Linux CI (does not depend on
			// /var → /private/var auto-normalization).
			//
			// FLY-793 (824 R2 E2E): isRegistered / getRegisteredWorktree now
			// canonicalize BOTH sides before comparing (realpath), so the
			// symlinked caller path correctly matches git's resolved path — no
			// more raw-string mismatch. Sequence:
			//   1. create() via symlinked mainRepoPath. git canonicalizes
			//      internally and records the resolved worktree path.
			//   2. isRegistered() via the same symlinked path now returns TRUE
			//      (both sides realpath-resolved to the same dir).
			//   3. removeIfExists() therefore takes the proper remove() path
			//      (rename + prune), not the orphan-dir fs.rm fallback.
			//   4. Step 1b's prune + branch -D still run; the follow-up create()
			//      (-B reset-or-create) rebuilds cleanly with no "already checked
			//      out at" crash. FLY-99's Step 1b is now belt-and-suspenders
			//      rather than the sole thing keeping the rerun alive.
			const { mainRepoCanonical, mainRepoViaSymlink } =
				await setupSymlinkedRepo();
			const mgr = new WorktreeManager();

			// Precondition: the two paths string-compare differently but
			// resolve to the same directory on disk.
			expect(mainRepoViaSymlink).not.toBe(mainRepoCanonical);
			expect(fs.realpathSync(mainRepoViaSymlink)).toBe(mainRepoCanonical);

			const first = await mgr.create({
				mainRepoPath: mainRepoViaSymlink,
				projectName: "proj",
				issueId: "GEO-99",
			});
			fs.writeFileSync(path.join(first.worktreePath, "wip.txt"), "in-progress");

			// What git actually recorded: the canonical path. This is the
			// mirror image of first.worktreePath (which still holds the
			// unresolved symlink segment).
			const canonicalWtPath = path.join(
				path.dirname(mainRepoCanonical),
				path.basename(first.worktreePath),
			);
			expect(canonicalWtPath).not.toBe(first.worktreePath);

			// FLY-793: isRegistered now canonicalizes both sides, so it returns
			// TRUE for BOTH the symlinked caller path and the canonical one —
			// same underlying worktree, one consistent answer (previously the
			// raw string compare returned false for the symlinked path, the bug
			// that broke the three-stage worktree-removal-proof gate).
			expect(
				await mgr.isRegistered(mainRepoViaSymlink, first.worktreePath),
			).toBe(true);
			expect(await mgr.isRegistered(mainRepoCanonical, canonicalWtPath)).toBe(
				true,
			);

			// Simulate SIGKILL — no cleanup. Rerun via the symlinked path
			// (what Blueprint would do on the next attempt).
			const cleaned = await mgr.removeIfExists(
				mainRepoViaSymlink,
				"proj",
				"GEO-99",
			);
			expect(cleaned).toBe(true);

			// The actual bug manifestation: this create() used to fail with
			// "already checked out at" before Step 1b.
			const second = await mgr.create({
				mainRepoPath: mainRepoViaSymlink,
				projectName: "proj",
				issueId: "GEO-99",
			});
			expect(fs.existsSync(second.worktreePath)).toBe(true);
			// Verify registration via the canonical worktree path, since
			// that is what git records in its admin entry.
			const canonicalWtPath2 = path.join(
				path.dirname(mainRepoCanonical),
				path.basename(second.worktreePath),
			);
			expect(await mgr.isRegistered(mainRepoCanonical, canonicalWtPath2)).toBe(
				true,
			);
			// wip.txt from the killed first Runner must not leak into the
			// rerun — the worktree was rebuilt, not reattached.
			expect(fs.existsSync(path.join(second.worktreePath, "wip.txt"))).toBe(
				false,
			);
		});

		it("FLY-99: 3× kill+rerun cycles via symlinked mainRepoPath never crash", async () => {
			// Stress the kill/rerun loop against the path-mismatch fixture.
			// Each cycle leaves a stale "checked out at canonical path" admin
			// entry that Step 1b must prune before the next create() -B can
			// succeed. Three rounds mirrors the Annie ask: Runner 跑一半中断 →
			// 同一个 issue 重跑 → 不 crash.
			const { mainRepoViaSymlink } = await setupSymlinkedRepo();
			const mgr = new WorktreeManager();

			for (let i = 0; i < 3; i++) {
				const info = await mgr.create({
					mainRepoPath: mainRepoViaSymlink,
					projectName: "proj",
					issueId: "GEO-LOOP",
				});
				fs.writeFileSync(path.join(info.worktreePath, `cycle-${i}.txt`), "x");
				// Skip remove — simulate SIGKILL — then rerun via removeIfExists.
				const cleaned = await mgr.removeIfExists(
					mainRepoViaSymlink,
					"proj",
					"GEO-LOOP",
				);
				expect(cleaned).toBe(true);
			}
			const final = await mgr.create({
				mainRepoPath: mainRepoViaSymlink,
				projectName: "proj",
				issueId: "GEO-LOOP",
			});
			expect(fs.existsSync(final.worktreePath)).toBe(true);
		});
	});

	// ── FLY-603: deriveWorktreeKey + head parse + dirty-safe removal ──
	describe("FLY-603 deriveWorktreeKey()", () => {
		it("main role → identifier unchanged (byte-for-byte)", () => {
			expect(deriveWorktreeKey("FLY-603", "main")).toBe("FLY-603");
			expect(deriveWorktreeKey("FLY-603")).toBe("FLY-603");
			expect(deriveWorktreeKey("FLY-603", undefined)).toBe("FLY-603");
		});
		it("non-main role → identifier-role with role sanitized", () => {
			expect(deriveWorktreeKey("FLY-603", "qa")).toBe("FLY-603-qa");
			expect(deriveWorktreeKey("FLY-603", "designer")).toBe("FLY-603-designer");
		});
		it("identifier is preserved byte-for-byte, only role lowercased/stripped", () => {
			// identifier keeps case (FLY-603 stays FLY-603, NOT fly-603)
			expect(deriveWorktreeKey("FLY-603", "QA")).toBe("FLY-603-qa");
			expect(deriveWorktreeKey("uuid-123", "qa")).toBe("uuid-123-qa");
			// role sanitization parity with Blueprint (QA/../hack → qahack)
			expect(deriveWorktreeKey("FLY-603", "QA/../hack")).toBe("FLY-603-qahack");
			// all-unsafe role → main → bare identifier
			expect(deriveWorktreeKey("FLY-603", "///")).toBe("FLY-603");
			expect(deriveWorktreeKey("FLY-603", "")).toBe("FLY-603");
		});
	});

	describe("FLY-603 list() parses HEAD", () => {
		it("captures head sha from porcelain", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_TWO_WORKTREES }]);
			const mgr = new WorktreeManager({}, fn);
			const list = await mgr.list("/main/repo");
			expect(list[0].head).toBe("abc1234");
			expect(list[1].head).toBe("def5678");
		});
		it("detached head still captured", async () => {
			const { fn } = makeMockExec([{ stdout: PORCELAIN_DETACHED }]);
			const mgr = new WorktreeManager({}, fn);
			const list = await mgr.list("/main/repo");
			expect(list[1]).toMatchObject({ branch: null, head: "9999999" });
		});
	});

	describe("FLY-603 key resolvers", () => {
		it("parseWorktreeKeyFromBranch strips repoSlug- prefix", () => {
			const mgr = new WorktreeManager();
			expect(
				mgr.parseWorktreeKeyFromBranch(
					"/Users/x/Dev/flywheel",
					"flywheel-FLY-603",
				),
			).toBe("FLY-603");
			expect(
				mgr.parseWorktreeKeyFromBranch(
					"/Users/x/Dev/flywheel",
					"flywheel-FLY-603-qa",
				),
			).toBe("FLY-603-qa");
			expect(
				mgr.parseWorktreeKeyFromBranch("/Users/x/Dev/flywheel", "main"),
			).toBeNull();
			expect(
				mgr.parseWorktreeKeyFromBranch("/Users/x/Dev/flywheel", null),
			).toBeNull();
		});
		it("parseWorktreeKeyFromPath uses repoSlug not projectName (projectName !== repoSlug)", () => {
			const mgr = new WorktreeManager();
			// sibling layout: parent = dirname(mainRepoPath)
			expect(
				mgr.parseWorktreeKeyFromPath(
					"/Users/x/Dev/flywheel",
					"SomeOtherProjectName",
					"/Users/x/Dev/flywheel-FLY-603-qa",
				),
			).toBe("FLY-603-qa");
			// wrong parent → fail-closed null
			expect(
				mgr.parseWorktreeKeyFromPath(
					"/Users/x/Dev/flywheel",
					"proj",
					"/somewhere/else/flywheel-FLY-603",
				),
			).toBeNull();
		});
		it("parseWorktreeKeyFromPath honors baseDir layout", () => {
			const mgr = new WorktreeManager({ baseDir: "/wt" });
			expect(
				mgr.parseWorktreeKeyFromPath(
					"/Users/x/Dev/flywheel",
					"proj",
					"/wt/proj/flywheel-FLY-603-qa",
				),
			).toBe("FLY-603-qa");
		});
		it("expectedWorktree returns sibling path + branch", () => {
			const mgr = new WorktreeManager();
			expect(
				mgr.expectedWorktree("/Users/x/Dev/flywheel", "proj", "FLY-603"),
			).toEqual({
				path: "/Users/x/Dev/flywheel-FLY-603",
				branch: "flywheel-FLY-603",
			});
		});
	});

	describe("FLY-603 removeCleanWorktreeByPath()", () => {
		it("uses git worktree remove WITHOUT --force, then branch -D", async () => {
			const { fn, calls } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({}, fn);
			const res = await mgr.removeCleanWorktreeByPath(
				"/main/repo",
				"/main/repo-GEO-42",
				"repo-GEO-42",
			);
			expect(res).toEqual({ removed: true, branchDeleted: true });
			expect(calls[0].args).toEqual([
				"-C",
				"/main/repo",
				"worktree",
				"remove",
				"/main/repo-GEO-42",
			]);
			expect(calls[0].args).not.toContain("--force");
			expect(calls[1].args).toEqual([
				"-C",
				"/main/repo",
				"branch",
				"-D",
				"repo-GEO-42",
			]);
		});
		it("dirty worktree → git refuses → removed:false, no branch -D", async () => {
			const { fn, calls } = makeMockExec([
				new Error("contains modified or untracked files, use --force"),
			]);
			const mgr = new WorktreeManager({}, fn);
			const res = await mgr.removeCleanWorktreeByPath(
				"/main/repo",
				"/main/repo-GEO-42",
				"repo-GEO-42",
			);
			expect(res.removed).toBe(false);
			expect(res.error).toContain("modified or untracked");
			expect(calls).toHaveLength(1); // never reached branch -D
		});
		it("branch already gone → removed:true, branchDeleted:false (not an error)", async () => {
			const { fn } = makeMockExec([
				{ stdout: "" },
				new Error("error: branch 'x' not found."),
			]);
			const mgr = new WorktreeManager({}, fn);
			const res = await mgr.removeCleanWorktreeByPath(
				"/main/repo",
				"/main/repo-GEO-42",
				"repo-GEO-42",
			);
			expect(res).toEqual({ removed: true, branchDeleted: false });
		});
	});

	describe("FLY-603 removeRegisteredWorktree()", () => {
		it("removes by exact wt.path (never recomputed) + deletes branch", async () => {
			const { fn, calls } = makeMockExec([{ stdout: "" }, { stdout: "" }]);
			const mgr = new WorktreeManager({}, fn);
			const wt = {
				path: "/some/weird/manually-made-path",
				branch: "repo-GEO-99",
				head: "deadbeef",
				isDetached: false,
				isBare: false,
			};
			const res = await mgr.removeRegisteredWorktree("/main/repo", wt, {
				deleteBranch: true,
			});
			expect(res.removed).toBe(true);
			// exact path used, not a recomputed sibling path
			expect(calls[0].args).toContain("/some/weird/manually-made-path");
		});
	});
});

describe("canonicalizeWorktreePath (FLY-793 824 R2 E2E)", () => {
	let realBase: string;
	let linkBase: string;

	beforeEach(() => {
		// A real dir + a symlink pointing at it — mirrors macOS /tmp → /private/tmp
		// (the exact shape that made getRegisteredWorktree's exact `===` miss).
		realBase = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "wt-canon-")),
		);
		linkBase = `${realBase}.link`;
		fs.symlinkSync(realBase, linkBase);
	});

	afterEach(() => {
		try {
			fs.unlinkSync(linkBase);
		} catch {}
		try {
			fs.rmSync(realBase, { recursive: true, force: true });
		} catch {}
	});

	it("resolves a symlinked path to its canonical form (existing leaf)", () => {
		fs.mkdirSync(path.join(realBase, "wt"));
		expect(canonicalizeWorktreePath(path.join(linkBase, "wt"))).toBe(
			path.join(realBase, "wt"),
		);
	});

	it("resolves the symlinked prefix even when the leaf does not exist", () => {
		// Deepest-existing-ancestor fallback: leaf 'gone' missing, parent resolves.
		expect(canonicalizeWorktreePath(path.join(linkBase, "gone"))).toBe(
			path.join(realBase, "gone"),
		);
	});

	it("is idempotent on an already-canonical path", () => {
		fs.mkdirSync(path.join(realBase, "wt2"));
		const canon = path.join(realBase, "wt2");
		expect(canonicalizeWorktreePath(canon)).toBe(canon);
	});
});

describe("getRegisteredWorktree / isRegistered path canonicalization (FLY-793)", () => {
	let realBase: string;
	let linkBase: string;

	beforeEach(() => {
		realBase = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "wt-reg-")),
		);
		linkBase = `${realBase}.link`;
		fs.symlinkSync(realBase, linkBase);
		fs.mkdirSync(path.join(realBase, "repo-GEO-42"));
	});

	afterEach(() => {
		try {
			fs.unlinkSync(linkBase);
		} catch {}
		try {
			fs.rmSync(realBase, { recursive: true, force: true });
		} catch {}
	});

	function porcelainFor(canonicalWtPath: string): string {
		return [
			`worktree ${realBase}`,
			"HEAD abc1234",
			"branch refs/heads/main",
			"",
			`worktree ${canonicalWtPath}`,
			"HEAD def5678",
			"branch refs/heads/repo-GEO-42",
			"",
		].join("\n");
	}

	it("getRegisteredWorktree matches a symlinked query against git's canonical path", async () => {
		const canonicalWt = path.join(realBase, "repo-GEO-42");
		const { fn } = makeMockExec([{ stdout: porcelainFor(canonicalWt) }]);
		const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);
		// Query with the SYMLINK path — the shape a session stores (/tmp/...).
		const reg = await mgr.getRegisteredWorktree(
			realBase,
			path.join(linkBase, "repo-GEO-42"),
		);
		expect(reg).not.toBeNull();
		expect(reg?.branch).toBe("repo-GEO-42");
		// Returns git's canonical path — the cleanup removes by THIS, not the query.
		expect(reg?.path).toBe(canonicalWt);
	});

	it("isRegistered is true for a symlinked query", async () => {
		const canonicalWt = path.join(realBase, "repo-GEO-42");
		const { fn } = makeMockExec([{ stdout: porcelainFor(canonicalWt) }]);
		const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);
		expect(
			await mgr.isRegistered(realBase, path.join(linkBase, "repo-GEO-42")),
		).toBe(true);
	});

	it("getRegisteredWorktree still returns null for a genuinely different path", async () => {
		const canonicalWt = path.join(realBase, "repo-GEO-42");
		const { fn } = makeMockExec([{ stdout: porcelainFor(canonicalWt) }]);
		const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);
		const reg = await mgr.getRegisteredWorktree(
			realBase,
			path.join(realBase, "repo-GEO-99"),
		);
		expect(reg).toBeNull();
	});
});
