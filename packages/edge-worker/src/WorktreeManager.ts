import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "flywheel-core";

const logger = createLogger({ component: "WorktreeManager" });

// ─── Types ───────────────────────────────────────

export type WorktreeExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

export type BgDeleteFn = (cmd: string, args: string[]) => void;

export interface WorktreeConfig {
	baseDir?: string;
	/** @internal — override background delete for testing */
	bgDeleteFn?: BgDeleteFn;
}

export interface WorktreeInfo {
	projectName: string;
	issueId: string;
	worktreePath: string;
	branch: string;
	mainRepoPath: string;
}

export interface ExternalWorktree {
	path: string;
	branch: string | null;
	isDetached: boolean;
	isBare: boolean;
}

// ─── Default exec ────────────────────────────────

// Uses execFile (array args, no shell) — safe from injection by design.
const defaultExec: WorktreeExecFn = (cmd, args, cwd) =>
	new Promise((resolve, reject) => {
		execFile(cmd, args, { cwd }, (err, stdout) => {
			if (err) return reject(err);
			resolve({ stdout });
		});
	});

// Uses spawn with array args — no shell injection risk.
function defaultBgDelete(cmd: string, args: string[]): void {
	const proc = spawn(cmd, args, { detached: true, stdio: "ignore" });
	proc.unref();
	proc.on("error", (err) => {
		logger.warn("Background rm failed (non-critical)", {
			cmd,
			args,
			error: err.message,
		});
	});
}

// ─── WorktreeManager ────────────────────────────

export class WorktreeManager {
	private readonly baseDir: string | undefined;
	private readonly exec: WorktreeExecFn;
	private readonly bgDelete: BgDeleteFn;

	constructor(config?: WorktreeConfig, execFn?: WorktreeExecFn) {
		this.baseDir = config?.baseDir;
		this.exec = execFn ?? defaultExec;
		this.bgDelete = config?.bgDeleteFn ?? defaultBgDelete;
	}

	/**
	 * FLY-95: Compute worktree directory as a sibling of the main repo.
	 * e.g. mainRepoPath=/Users/x/Dev/GeoForge3D → /Users/x/Dev/flywheel-GEO-42
	 * Falls back to explicit baseDir/projectName/ if configured (backward compat).
	 */
	private worktreeDir(
		mainRepoPath: string,
		projectName: string,
		issueId: string,
	): string {
		if (this.baseDir) {
			return path.join(this.baseDir, projectName, `flywheel-${issueId}`);
		}
		// FLY-95: Derive from projectDir — e.g. /Users/x/Dev/GeoForge3D → /Users/x/Dev/geoforge3d-GEO-42
		const repoSlug = path.basename(mainRepoPath).toLowerCase();
		return path.join(path.dirname(mainRepoPath), `${repoSlug}-${issueId}`);
	}

	/** FLY-95: Project-scoped prefix for pruneOrphans filtering. */
	private worktreePrefix(
		mainRepoPath: string,
		projectName: string,
	): string {
		if (this.baseDir) {
			return path.join(this.baseDir, projectName) + path.sep;
		}
		const repoSlug = path.basename(mainRepoPath).toLowerCase();
		return path.dirname(mainRepoPath) + path.sep + repoSlug + "-";
	}

	async create(opts: {
		mainRepoPath: string;
		projectName: string;
		issueId: string;
		startPoint?: string;
	}): Promise<WorktreeInfo> {
		const branch = `flywheel-${opts.issueId}`;
		const worktreePath = this.worktreeDir(opts.mainRepoPath, opts.projectName, opts.issueId);
		const startPoint = opts.startPoint ?? "origin/main";

		// git worktree add
		await this.exec(
			"git",
			[
				"-C",
				opts.mainRepoPath,
				"worktree",
				"add",
				worktreePath,
				"-b",
				branch,
				`${startPoint}^{commit}`,
			],
			opts.mainRepoPath,
		);

		// git config push.autoSetupRemote
		await this.exec(
			"git",
			["-C", worktreePath, "config", "--local", "push.autoSetupRemote", "true"],
			worktreePath,
		);

		return {
			projectName: opts.projectName,
			issueId: opts.issueId,
			worktreePath,
			branch,
			mainRepoPath: opts.mainRepoPath,
		};
	}

	async remove(mainRepoPath: string, worktreePath: string): Promise<void> {
		// Phase 1: rename to temp dir (same filesystem — avoids EXDEV)
		const tmpPath = `${worktreePath}.removing-${Date.now()}`;
		try {
			await fs.promises.rename(worktreePath, tmpPath);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				logger.info("Worktree dir already gone, skipping rename", {
					worktreePath,
				});
				// Skip to prune
				await this.exec(
					"git",
					["-C", mainRepoPath, "worktree", "prune"],
					mainRepoPath,
				);
				return;
			}
			throw err;
		}

		// Phase 2: git worktree prune
		await this.exec(
			"git",
			["-C", mainRepoPath, "worktree", "prune"],
			mainRepoPath,
		);

		// Phase 3: background delete (macOS-safe, detached — non-blocking)
		this.bgDelete("/bin/rm", ["-rf", tmpPath]);
	}

	async isRegistered(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<boolean> {
		const worktrees = await this.list(mainRepoPath);
		return worktrees.some((wt) => wt.path === worktreePath);
	}

	async list(mainRepoPath: string): Promise<ExternalWorktree[]> {
		const { stdout } = await this.exec(
			"git",
			["-C", mainRepoPath, "worktree", "list", "--porcelain"],
			mainRepoPath,
		);
		return parsePorcelain(stdout);
	}

	/**
	 * Safe rerun cleanup: remove worktree + delete local branch.
	 * Keeps path construction internal to WorktreeManager.
	 * Returns true if something was cleaned up, false if nothing existed.
	 */
	async removeIfExists(
		mainRepoPath: string,
		projectName: string,
		issueId: string,
	): Promise<boolean> {
		const branch = `flywheel-${issueId}`;
		const worktreePath = this.worktreeDir(mainRepoPath, projectName, issueId);

		// Step 1: remove worktree if registered
		if (await this.isRegistered(mainRepoPath, worktreePath)) {
			await this.remove(mainRepoPath, worktreePath);
		} else if (fs.existsSync(worktreePath)) {
			// Orphan directory: exists on disk but not registered as a worktree.
			// This can happen after a crash or interrupted removal. Clean it up
			// so the subsequent create() doesn't fail on "path already exists".
			this.bgDelete("/bin/rm", ["-rf", worktreePath]);
		}

		// Step 2: delete local branch if it still exists
		// git worktree prune does NOT delete the branch — only the worktree registration.
		// Without this, next create() with -b flywheel-{issueId} fails:
		//   "fatal: a branch named 'flywheel-GEO-42' already exists"
		try {
			await this.exec(
				"git",
				["-C", mainRepoPath, "branch", "-D", branch],
				mainRepoPath,
			);
			return true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("not found")) throw err;
			return false;
		}
	}

	async pruneOrphans(
		mainRepoPath: string,
		projectName: string,
	): Promise<string[]> {
		const worktrees = await this.list(mainRepoPath);
		const pruned: string[] = [];

		const projectPrefix = this.worktreePrefix(mainRepoPath, projectName);

		for (const wt of worktrees) {
			// Only prune flywheel-* branches under this project's directory
			if (!wt.branch?.startsWith("flywheel-")) continue;
			if (!wt.path.startsWith(projectPrefix)) continue;
			if (fs.existsSync(wt.path)) continue;

			// Dir missing → orphan
			logger.info("Pruning orphan worktree", { path: wt.path });
			await this.remove(mainRepoPath, wt.path);
			pruned.push(wt.path);
		}

		return pruned;
	}
}

// ─── Porcelain parser ────────────────────────────

function parsePorcelain(output: string): ExternalWorktree[] {
	const worktrees: ExternalWorktree[] = [];
	const blocks = output.trim().split("\n\n");

	for (const block of blocks) {
		if (!block.trim()) continue;
		const lines = block.trim().split("\n");

		let wtPath = "";
		let branch: string | null = null;
		let isDetached = false;
		let isBare = false;

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				wtPath = line.slice("worktree ".length);
			} else if (line.startsWith("branch refs/heads/")) {
				branch = line.slice("branch refs/heads/".length);
			} else if (line === "detached") {
				isDetached = true;
			} else if (line === "bare") {
				isBare = true;
			}
		}

		if (wtPath) {
			worktrees.push({ path: wtPath, branch, isDetached, isBare });
		}
	}

	return worktrees;
}
