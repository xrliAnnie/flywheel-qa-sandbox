/**
 * GitResultChecker — SHA-based session result detection.
 *
 * Used by Blueprint to determine if a Claude Code session produced
 * any commits (success = commitCount > 0 in Phase 1).
 */

export interface GitCheckResult {
	hasNewCommits: boolean;
	commitCount: number;
	filesChanged: number;
	commitMessages: string[];
}

export type ExecFileFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

export class GitResultChecker {
	constructor(private execFile: ExecFileFn) {}

	/**
	 * Discover all git roots under a directory.
	 * Returns paths to directories containing `.git/` (independent repos, not submodules).
	 * Always includes the root itself if it's a git repo.
	 */
	async discoverGitRoots(dir: string): Promise<string[]> {
		const roots: string[] = [];

		// Check if dir itself is a git repo
		try {
			const result = await this.execFile(
				"git",
				["-C", dir, "rev-parse", "--git-dir"],
				dir,
			);
			if (result.stdout.trim()) roots.push(dir);
		} catch { /* not a git repo */ }

		// Scan immediate children for independent git repos
		try {
			const result = await this.execFile(
				"find",
				[dir, "-maxdepth", "2", "-name", ".git", "-type", "d"],
				dir,
			);
			for (const gitDir of result.stdout.trim().split("\n").filter(Boolean)) {
				const repoDir = gitDir.replace(/\/\.git$/, "");
				if (repoDir !== dir && !roots.includes(repoDir)) {
					roots.push(repoDir);
				}
			}
		} catch { /* find failed — just use what we have */ }

		return roots;
	}

	/**
	 * Fail fast if the working tree has staged, unstaged, or untracked changes.
	 * Must be called before captureBaseline to prevent misattribution.
	 */
	async assertCleanTree(cwd: string): Promise<void> {
		const result = await this.execFile(
			"git",
			["-C", cwd, "status", "--porcelain"],
			cwd,
		);
		if (result.stdout.trim().length > 0) {
			throw new Error(
				`Git working tree is not clean in ${cwd}. Aborting to prevent misattribution.`,
			);
		}
	}

	/**
	 * Capture the current HEAD SHA as a baseline before running a session.
	 */
	async captureBaseline(cwd: string): Promise<string> {
		const result = await this.execFile(
			"git",
			["-C", cwd, "rev-parse", "HEAD"],
			cwd,
		);
		return result.stdout.trim();
	}

	/**
	 * Check for new commits since baseSha.
	 */
	async check(cwd: string, baseSha: string): Promise<GitCheckResult> {
		try {
			const [countResult, logResult, diffResult] = await Promise.all([
				this.execFile(
					"git",
					["-C", cwd, "rev-list", "--count", `${baseSha}..HEAD`],
					cwd,
				),
				this.execFile(
					"git",
					["-C", cwd, "log", "--format=%s", `${baseSha}..HEAD`],
					cwd,
				),
				this.execFile(
					"git",
					["-C", cwd, "diff", "--shortstat", `${baseSha}..HEAD`],
					cwd,
				),
			]);

			const commitCount = parseInt(countResult.stdout.trim(), 10) || 0;
			const commitMessages = logResult.stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);
			const filesChanged = this.parseFilesChanged(
				diffResult.stdout.trim(),
			);

			return {
				hasNewCommits: commitCount > 0,
				commitCount,
				filesChanged,
				commitMessages,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Expected: baseSha not in history (e.g., force-push, shallow clone)
			if (
				msg.includes("unknown revision") ||
				msg.includes("bad revision") ||
				msg.includes("bad object")
			) {
				console.warn(
					`[GitResultChecker] baseSha "${baseSha}" not found in ${cwd}, treating as zero commits`,
				);
				return {
					hasNewCommits: false,
					commitCount: 0,
					filesChanged: 0,
					commitMessages: [],
				};
			}
			// Unexpected infrastructure error — propagate
			throw new Error(
				`[GitResultChecker] Unexpected git error in ${cwd}: ${msg}`,
			);
		}
	}

	private parseFilesChanged(shortstat: string): number {
		if (!shortstat) return 0;
		// Format: " 5 files changed, 100 insertions(+), 20 deletions(-)"
		const match = shortstat.match(/(\d+)\s+files?\s+changed/);
		return match ? parseInt(match[1]!, 10) : 0;
	}
}
