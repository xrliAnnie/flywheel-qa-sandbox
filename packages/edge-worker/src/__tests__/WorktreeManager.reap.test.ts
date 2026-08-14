import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../WorktreeManager.js";
import type { ReapSummary, ReapTarget } from "../worktree-process-reaper.js";

const cleanSummary: ReapSummary = {
	matched: 2,
	reaped: [101, 102],
	survivors: [],
	verified: true,
	identityMismatchSkipped: 0,
};

describe("WorktreeManager reap-before-remove integration", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function fixture() {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "fly1759-manager-")),
		);
		roots.push(root);
		const mainRepo = path.join(root, "flywheel");
		const worktree = path.join(root, "flywheel-FLY-1759");
		fs.mkdirSync(mainRepo);
		fs.mkdirSync(worktree);
		return { root, mainRepo, worktree };
	}

	it("remove() waits for reap before rename and returns its verified census", async () => {
		const { mainRepo, worktree } = fixture();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const targets: ReapTarget[] = [];
		const reaperFn = vi.fn(async (target: ReapTarget) => {
			targets.push(target);
			await gate;
			return cleanSummary;
		});
		const execFn = vi.fn(async () => ({ stdout: "" }));
		const manager = new WorktreeManager(
			{ reaperFn, bgDeleteFn: () => {} },
			execFn,
		);

		const removing = manager.remove(mainRepo, worktree);
		await vi.waitFor(() => expect(reaperFn).toHaveBeenCalledOnce());
		expect(fs.existsSync(worktree)).toBe(true);
		expect(execFn).not.toHaveBeenCalled();
		release();

		await expect(removing).resolves.toEqual({
			reaps: [{ path: worktree, summary: cleanSummary }],
		});
		expect(fs.existsSync(worktree)).toBe(false);
		expect(targets[0]).toMatchObject({
			lexicalPath: worktree,
			canonicalPath: worktree,
			expectedParentDir: path.dirname(mainRepo),
			repoSlugPrefix: "flywheel-",
			rootProof: "live-dir",
		});
	});

	it("removeCleanWorktreeByPath() completes reap before git worktree remove", async () => {
		const { mainRepo, worktree } = fixture();
		const order: string[] = [];
		const manager = new WorktreeManager(
			{
				reaperFn: async () => {
					order.push("reap");
					return cleanSummary;
				},
			},
			async (_cmd, args) => {
				order.push(args.includes("remove") ? "remove" : "branch");
				return { stdout: "" };
			},
		);

		const result = await manager.removeCleanWorktreeByPath(
			mainRepo,
			worktree,
			"flywheel-FLY-1759",
		);

		expect(order).toEqual(["reap", "remove", "branch"]);
		expect(result).toEqual({
			removed: true,
			branchDeleted: true,
			reaps: [{ path: worktree, summary: cleanSummary }],
		});
	});

	it("removeIfExists() reaps an unregistered orphan before awaited fs.rm", async () => {
		const { root, mainRepo, worktree } = fixture();
		const order: string[] = [];
		const manager = new WorktreeManager(
			{
				baseDir: root,
				reaperFn: async () => {
					order.push("reap");
					return cleanSummary;
				},
			},
			async (_cmd, args) => {
				if (args.includes("list")) return { stdout: "" };
				return { stdout: "" };
			},
		);
		// baseDir layout includes projectName as one additional directory.
		const projectWorktree = path.join(root, "proj", "flywheel-FLY-1759");
		fs.mkdirSync(path.dirname(projectWorktree));
		fs.renameSync(worktree, projectWorktree);
		const realRm = fs.promises.rm.bind(fs.promises);
		const rm = vi
			.spyOn(fs.promises, "rm")
			.mockImplementation(async (...args) => {
				order.push("rm");
				return realRm(...args);
			});

		await manager.removeIfExists(mainRepo, "proj", "FLY-1759");

		expect(order.slice(0, 2)).toEqual(["reap", "rm"]);
		expect(rm).toHaveBeenCalledWith(projectWorktree, {
			recursive: true,
			force: true,
		});
	});

	it("removeWorktreeForce() reaps before the forceful git primitive", async () => {
		const { mainRepo, worktree } = fixture();
		const order: string[] = [];
		const manager = new WorktreeManager(
			{
				reaperFn: async () => {
					order.push("reap");
					return cleanSummary;
				},
			},
			async () => {
				order.push("remove-force");
				return { stdout: "" };
			},
		);

		const result = await manager.removeWorktreeForce(mainRepo, worktree);

		expect(order).toEqual(["reap", "remove-force"]);
		expect(result.reaps).toEqual([{ path: worktree, summary: cleanSummary }]);
	});
});
