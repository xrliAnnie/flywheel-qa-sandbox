import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../WorktreeManager.js";
import type {
	CwdRow,
	ReapSummary,
	ReapTarget,
} from "../worktree-process-reaper.js";

const cleanSummary: ReapSummary = {
	matched: 1,
	reaped: [101],
	survivors: [],
	verified: true,
	identityMismatchSkipped: 0,
};

describe("WorktreeManager pruneOrphans convergence", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	function fixture() {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "fly1759-converge-")),
		);
		roots.push(root);
		const mainRepo = path.join(root, "flywheel");
		const projectDir = path.join(root, "worktrees", "proj");
		fs.mkdirSync(mainRepo);
		fs.mkdirSync(projectDir, { recursive: true });
		return { root, mainRepo, projectDir };
	}

	it("E6 seam: reaps and awaits deletion of a stale .removing-* directory", async () => {
		const { root, mainRepo, projectDir } = fixture();
		const residue = path.join(projectDir, "flywheel-FLY-1759.removing-123456");
		fs.mkdirSync(residue);
		const targets: ReapTarget[] = [];
		const manager = new WorktreeManager(
			{
				baseDir: path.join(root, "worktrees"),
				reaperFn: async (target) => {
					targets.push(target);
					return cleanSummary;
				},
				cwdScannerFn: async () => [],
			},
			async () => ({ stdout: "" }),
		);

		const pruned = await manager.pruneOrphans(mainRepo, "proj");

		expect(targets).toHaveLength(1);
		expect(targets[0]).toMatchObject({
			lexicalPath: residue,
			rootProof: "live-dir",
		});
		expect(fs.existsSync(residue)).toBe(false);
		expect(pruned).toContain(residue);
	});

	it("E7 seam: derives a gone worktree root from a deleted nested cwd", async () => {
		const { root, mainRepo, projectDir } = fixture();
		const gone = path.join(projectDir, "flywheel-FLY-1700");
		const cwdRows: CwdRow[] = [
			{
				pid: 101,
				rawCwd: `${gone}/nested (deleted)`,
				logicalCwd: `${gone}/nested`,
				deletedMarker: true,
			},
		];
		const targets: ReapTarget[] = [];
		const manager = new WorktreeManager(
			{
				baseDir: path.join(root, "worktrees"),
				cwdScannerFn: async () => cwdRows,
				reaperFn: async (target) => {
					targets.push(target);
					return cleanSummary;
				},
			},
			async () => ({ stdout: "" }),
		);

		await manager.pruneOrphans(mainRepo, "proj");

		expect(targets).toEqual([
			expect.objectContaining({
				lexicalPath: gone,
				canonicalPath: gone,
				rootProof: "gone",
			}),
		]);
	});

	it("never reaps a registered residue, registered cwd root, or recreated path", async () => {
		const { root, mainRepo, projectDir } = fixture();
		const registered = path.join(projectDir, "flywheel-FLY-1701");
		const recreated = path.join(projectDir, "flywheel-FLY-1702");
		const registeredResidue = path.join(
			projectDir,
			"flywheel-FLY-1703.removing-123",
		);
		fs.mkdirSync(registered);
		fs.mkdirSync(recreated);
		fs.mkdirSync(registeredResidue);
		const reaperFn = vi.fn(async () => cleanSummary);
		const manager = new WorktreeManager(
			{
				baseDir: path.join(root, "worktrees"),
				cwdScannerFn: async () =>
					[registered, recreated].map((cwd, index) => ({
						pid: 101 + index,
						rawCwd: cwd,
						logicalCwd: cwd,
						deletedMarker: false,
					})),
				reaperFn,
			},
			async (_cmd, args) => ({
				stdout: args.includes("list")
					? [
							`worktree ${mainRepo}`,
							"HEAD abc",
							"branch refs/heads/main",
							"",
							`worktree ${registered}`,
							"HEAD def",
							"branch refs/heads/flywheel-FLY-1701",
							"",
							`worktree ${registeredResidue}`,
							"HEAD fed",
							"branch refs/heads/flywheel-FLY-1703.removing-123",
							"",
						].join("\n")
					: "",
			}),
		);

		await manager.pruneOrphans(mainRepo, "proj");

		expect(reaperFn).not.toHaveBeenCalled();
		expect(fs.existsSync(registeredResidue)).toBe(true);
	});
});
