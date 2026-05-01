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

	/** Lowercase slug derived from the repo directory name. */
	private repoSlug(mainRepoPath: string): string {
		return path.basename(mainRepoPath).toLowerCase();
	}

	/**
	 * FLY-95: Branch + directory name for a worktree.
	 * e.g. mainRepoPath=/Users/x/Dev/GeoForge3D, issueId=GEO-42 → "geoforge3d-GEO-42"
	 */
	private worktreeName(mainRepoPath: string, issueId: string): string {
		return `${this.repoSlug(mainRepoPath)}-${issueId}`;
	}

	/**
	 * FLY-95: Compute worktree directory as a sibling of the main repo.
	 * e.g. mainRepoPath=/Users/x/Dev/GeoForge3D → /Users/x/Dev/geoforge3d-GEO-42
	 * Falls back to explicit baseDir/projectName/ if configured (backward compat).
	 */
	private worktreeDir(
		mainRepoPath: string,
		projectName: string,
		issueId: string,
	): string {
		const name = this.worktreeName(mainRepoPath, issueId);
		if (this.baseDir) {
			return path.join(this.baseDir, projectName, name);
		}
		return path.join(path.dirname(mainRepoPath), name);
	}

	/** FLY-95: Project-scoped prefix for pruneOrphans filtering. */
	private worktreePrefix(mainRepoPath: string, projectName: string): string {
		if (this.baseDir) {
			return path.join(this.baseDir, projectName) + path.sep;
		}
		return `${path.dirname(mainRepoPath)}${path.sep}${this.repoSlug(mainRepoPath)}-`;
	}

	async create(opts: {
		mainRepoPath: string;
		projectName: string;
		issueId: string;
		startPoint?: string;
	}): Promise<WorktreeInfo> {
		const branch = this.worktreeName(opts.mainRepoPath, opts.issueId);
		const worktreePath = this.worktreeDir(
			opts.mainRepoPath,
			opts.projectName,
			opts.issueId,
		);
		// FLY-115: QA test-injection hook. When opts.startPoint is not supplied
		// by the caller, fall back to the FLYWHEEL_RUNNER_START_POINT env var so
		// test-deploy.sh can pin Runner worktrees to a PR branch on the sandbox
		// fork. Unset in prod → falls through to origin/main (unchanged).
		const startPoint =
			opts.startPoint ??
			process.env.FLYWHEEL_RUNNER_START_POINT ??
			"origin/main";

		// git worktree add
		// FLY-99: -B (reset-or-create) replaces -b (create-only) so a stale
		// local branch left behind by a crashed Runner is reset to startPoint
		// instead of failing with "branch already exists". removeIfExists() still
		// runs `branch -D` up front — -B is the belt, branch -D is the suspenders.
		// -B still fails if the branch is currently checked out in another
		// worktree, but that is a concurrent-scheduling concern, not FLY-99 scope.
		await this.exec(
			"git",
			[
				"-C",
				opts.mainRepoPath,
				"worktree",
				"add",
				worktreePath,
				"-B",
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
				// Skip to prune. Plain `git worktree prune` drops any admin
				// entry whose gitdir target is missing — no time threshold
				// applies (CLI default). `gc.worktreePruneExpire` only governs
				// `git gc`'s auto-prune, not this explicit invocation.
				await this.exec(
					"git",
					["-C", mainRepoPath, "worktree", "prune"],
					mainRepoPath,
				);
				return;
			}
			throw err;
		}

		// Phase 2: git worktree prune — drops the admin entry for the
		// just-renamed gitdir (now missing from its original path).
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
		const branch = this.worktreeName(mainRepoPath, issueId);
		const worktreePath = this.worktreeDir(mainRepoPath, projectName, issueId);

		let cleaned = false;

		// Step 1: remove worktree if registered, OR clean up orphan dir on disk.
		if (await this.isRegistered(mainRepoPath, worktreePath)) {
			// remove() uses rename + prune + background rm — race-free because
			// the original path is renamed first, so a follow-up create() can
			// immediately reclaim it.
			await this.remove(mainRepoPath, worktreePath);
			cleaned = true;
		} else if (fs.existsSync(worktreePath)) {
			// Orphan directory: exists on disk but not registered as a worktree.
			// This can happen after a crash or interrupted removal.
			//
			// FLY-99: Use *awaited* fs.promises.rm instead of the fire-and-forget
			// bgDelete() used by remove(). The caller here is Blueprint, which
			// immediately follows up with create() — any non-awaited rm would
			// race the next `git worktree add`, causing "path already exists"
			// or a partially-deleted tree to be re-registered.
			await fs.promises.rm(worktreePath, { recursive: true, force: true });
			cleaned = true;
		}

		// Step 1b: FLY-99 — always prune stale admin entries before branch -D.
		//
		// Root cause: `isRegistered()` compares git's canonical worktree path
		// (from `git worktree list --porcelain`, always fully resolved) against
		// the caller-provided `mainRepoPath`-derived path. If the caller passes
		// an unresolved path that traverses a symlink (e.g. `/var/foo` when git
		// records `/private/var/foo` on macOS, or any user-configured symlink
		// chain on Linux), the string comparison fails and `isRegistered`
		// returns false. The orphan-dir branch above then `fs.rm`s the target
		// via the symlink, but the admin entry at `.git/worktrees/<name>/`
		// still records the branch as "checked out at <canonical-path>" — so
		// without this prune, `branch -D` fails with "Cannot delete branch X
		// checked out at Y" and the subsequent `worktree add -B` fails with
		// "already checked out at Y". Step 1b unconditionally drops the now-
		// stale admin entry so the rerun succeeds.
		await this.exec(
			"git",
			["-C", mainRepoPath, "worktree", "prune"],
			mainRepoPath,
		);

		// Step 2: delete local branch if it still exists.
		// `git worktree prune` does NOT delete the branch — only the worktree
		// registration. Without this, a subsequent create() without -B would
		// fail with "branch already exists". With FLY-99's switch to -B this is
		// no longer a hard requirement, but branch -D still serves as repo
		// hygiene (removes stale local refs) and handles the degenerate case
		// where only the branch survived a prior cleanup attempt.
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
			// Branch missing is fine; report whether anything else was cleaned.
			return cleaned;
		}
	}

	async pruneOrphans(
		mainRepoPath: string,
		projectName: string,
	): Promise<string[]> {
		const worktrees = await this.list(mainRepoPath);
		const pruned: string[] = [];

		const projectPrefix = this.worktreePrefix(mainRepoPath, projectName);

		const branchPrefix = `${this.repoSlug(mainRepoPath)}-`;

		for (const wt of worktrees) {
			// Only prune project-scoped branches under this project's directory
			if (!wt.branch?.startsWith(branchPrefix)) continue;
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
