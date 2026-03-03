import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WorktreeManager,
	type WorktreeExecFn,
} from "../WorktreeManager.js";

// ─── Helpers ─────────────────────────────────────

function makeMockExec(
	responses: Array<{ stdout: string } | Error> = [],
): { fn: WorktreeExecFn; calls: Array<{ cmd: string; args: string[]; cwd: string }> } {
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

const PORCELAIN_TWO_WORKTREES = [
	"worktree /main/repo",
	"HEAD abc1234",
	"branch refs/heads/main",
	"",
	"worktree /home/user/.flywheel/worktrees/proj/flywheel-GEO-42",
	"HEAD def5678",
	"branch refs/heads/flywheel-GEO-42",
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

const PORCELAIN_BARE = [
	"worktree /bare/repo",
	"HEAD abc1234",
	"bare",
	"",
].join("\n");

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
			expect(calls[0].args).toContain("-b");
			expect(calls[0].args).toContain("flywheel-GEO-42");
			expect(calls[0].args.some((a) => a.includes("origin/main^{commit}"))).toBe(true);
		});

		it("sets push.autoSetupRemote", async () => {
			const { fn, calls } = makeMockExec([
				{ stdout: "" },
				{ stdout: "" },
			]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(calls[1].args).toEqual(
				expect.arrayContaining(["config", "--local", "push.autoSetupRemote", "true"]),
			);
		});

		it("uses custom startPoint", async () => {
			const { fn, calls } = makeMockExec([
				{ stdout: "" },
				{ stdout: "" },
			]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
				startPoint: "feature/base",
			});

			expect(calls[0].args.some((a) => a.includes("feature/base^{commit}"))).toBe(true);
		});

		it("creates correct worktree path", async () => {
			const { fn } = makeMockExec([
				{ stdout: "" },
				{ stdout: "" },
			]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			const info = await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(info.worktreePath).toBe("/tmp/wt/proj/flywheel-GEO-42");
		});

		it("returns complete WorktreeInfo", async () => {
			const { fn } = makeMockExec([
				{ stdout: "" },
				{ stdout: "" },
			]);
			const mgr = new WorktreeManager({ baseDir: "/tmp/wt" }, fn);

			const info = await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(info).toEqual({
				projectName: "proj",
				issueId: "GEO-42",
				worktreePath: "/tmp/wt/proj/flywheel-GEO-42",
				branch: "flywheel-GEO-42",
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
				new Error("fatal: 'flywheel-GEO-42' is already checked out"),
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

		it("uses default baseDir when config omitted", async () => {
			const { fn } = makeMockExec([
				{ stdout: "" },
				{ stdout: "" },
			]);
			const mgr = new WorktreeManager(undefined, fn);

			const info = await mgr.create({
				mainRepoPath: "/main/repo",
				projectName: "proj",
				issueId: "GEO-42",
			});

			expect(info.worktreePath).toContain(
				path.join(os.homedir(), ".flywheel", "worktrees"),
			);
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
			const worktreeDir = path.join(tmpDir, "flywheel-GEO-42");
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
			const worktreeDir = path.join(tmpDir, "flywheel-GEO-42");
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
			const worktreeDir = path.join(tmpDir, "flywheel-GEO-42");
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
				mgr.remove("/main/repo", "/tmp/wt/flywheel-GEO-42"),
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

			await mgr.remove("/main/repo", "/tmp/wt/flywheel-GEO-42");

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
				"/home/user/.flywheel/worktrees/proj/flywheel-GEO-42",
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
				path: "/home/user/.flywheel/worktrees/proj/flywheel-GEO-42",
				branch: "flywheel-GEO-42",
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
				"worktree /base/proj/flywheel-GEO-42",
				"HEAD def5678",
				"branch refs/heads/flywheel-GEO-42",
				"",
				"worktree /base/proj/flywheel-GEO-43",
				"HEAD ghi9012",
				"branch refs/heads/flywheel-GEO-43",
				"",
			].join("\n");

			const { fn } = makeMockExec([
				{ stdout: porcelain }, // list
				{ stdout: "" },        // prune (from remove of GEO-43)
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/base", bgDeleteFn: noopBgDelete },
				fn,
			);

			// Mock fs.existsSync: GEO-42 exists, GEO-43 doesn't
			const origExists = fs.existsSync;
			vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.includes("flywheel-GEO-42")) return true;
				if (s.includes("flywheel-GEO-43")) return false;
				return origExists(s);
			});

			// Mock rename (for remove — dir doesn't exist)
			vi.spyOn(fs.promises, "rename").mockRejectedValue(
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			);

			const pruned = await mgr.pruneOrphans("/main/repo", "proj");

			expect(pruned).toContain("/base/proj/flywheel-GEO-43");
			expect(pruned).not.toContain("/base/proj/flywheel-GEO-42");

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
			expect(branchCall!.args).toContain("flywheel-GEO-42");

			vi.restoreAllMocks();
		});

		it("is no-op when nothing exists (first run)", async () => {
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_SINGLE },  // list (isRegistered → false)
				new Error("error: branch 'flywheel-GEO-99' not found"), // git branch -D
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
				new Error("error: branch 'flywheel-GEO-42' not found"), // branch -D
			]);
			const mgr = new WorktreeManager(
				{ baseDir: "/home/user/.flywheel/worktrees", bgDeleteFn: noopBgDelete },
				fn,
			);

			// Mock rename to throw ENOENT (dir already gone)
			vi.spyOn(fs.promises, "rename").mockRejectedValue(
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			);

			const cleaned = await mgr.removeIfExists("/main/repo", "proj", "GEO-42");
			expect(cleaned).toBe(false);

			vi.restoreAllMocks();
		});

		it("propagates non-'not found' errors from branch -D", async () => {
			const { fn } = makeMockExec([
				{ stdout: PORCELAIN_SINGLE }, // list (isRegistered → false)
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
	});
});
