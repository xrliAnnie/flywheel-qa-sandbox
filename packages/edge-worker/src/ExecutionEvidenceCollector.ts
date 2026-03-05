import type { ExecFileFn, GitCheckResult } from "./GitResultChecker.js";

/**
 * Evidence collected from a Claude Code session's git output.
 * Step 2a scope: git history only. Step 2b extends with fullDiff, testResults, warnings.
 */
export interface ExecutionEvidence {
	// From GitCheckResult (required)
	commitCount: number;
	filesChangedCount: number;
	commitMessages: string[];

	// Extended evidence (best-effort — degrade gracefully)
	changedFilePaths: string[];
	linesAdded: number;
	linesRemoved: number;
	diffSummary: string;
	headSha: string | null;

	// Metadata
	partial: boolean;
	durationMs: number;
}

/**
 * Collects rich execution evidence from git history.
 * Required fields come from GitCheckResult (already validated).
 * Extended fields are best-effort — each wrapped in try/catch.
 */
export class ExecutionEvidenceCollector {
	constructor(private execFile: ExecFileFn) {}

	async collect(
		cwd: string,
		baseSha: string,
		gitResult: GitCheckResult,
		durationMs: number,
	): Promise<ExecutionEvidence> {
		let partial = false;

		// Required fields — from GitCheckResult
		const { commitCount, filesChanged: filesChangedCount, commitMessages } =
			gitResult;

		// Best-effort fields
		const changedFilePaths = await this.getChangedFiles(cwd, baseSha).catch(
			() => {
				partial = true;
				return [] as string[];
			},
		);

		const { added, removed } = await this.getDiffStats(cwd, baseSha).catch(
			() => {
				partial = true;
				return { added: 0, removed: 0 };
			},
		);

		const diffSummary = await this.getDiffSummary(cwd, baseSha).catch(
			() => {
				partial = true;
				return "";
			},
		);

		const headSha = await this.getHeadSha(cwd).catch(() => {
			partial = true;
			return null;
		});

		return {
			commitCount,
			filesChangedCount,
			commitMessages,
			changedFilePaths,
			linesAdded: added,
			linesRemoved: removed,
			diffSummary,
			headSha,
			partial,
			durationMs,
		};
	}

	private async getChangedFiles(
		cwd: string,
		baseSha: string,
	): Promise<string[]> {
		const result = await this.execFile(
			"git",
			["-C", cwd, "diff", "--name-only", `${baseSha}..HEAD`],
			cwd,
		);
		return result.stdout
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
	}

	private async getDiffStats(
		cwd: string,
		baseSha: string,
	): Promise<{ added: number; removed: number }> {
		const result = await this.execFile(
			"git",
			["-C", cwd, "diff", "--numstat", `${baseSha}..HEAD`],
			cwd,
		);
		let added = 0;
		let removed = 0;
		for (const line of result.stdout.trim().split("\n")) {
			if (!line) continue;
			const [addStr, removeStr] = line.split("\t");
			// Binary files show "-\t-\tfilename"
			if (addStr !== "-") added += parseInt(addStr!, 10) || 0;
			if (removeStr !== "-") removed += parseInt(removeStr!, 10) || 0;
		}
		return { added, removed };
	}

	private async getDiffSummary(
		cwd: string,
		baseSha: string,
	): Promise<string> {
		const result = await this.execFile(
			"git",
			["-C", cwd, "diff", `${baseSha}..HEAD`],
			cwd,
		);
		return result.stdout.slice(0, 2000);
	}

	/** Full untruncated diff — called lazily by DecisionLayer only for auto_approve path */
	async getFullDiff(cwd: string, baseSha: string): Promise<string> {
		const result = await this.execFile(
			"git",
			["-C", cwd, "diff", `${baseSha}..HEAD`],
			cwd,
		);
		return result.stdout;
	}

	private async getHeadSha(cwd: string): Promise<string> {
		const result = await this.execFile(
			"git",
			["-C", cwd, "rev-parse", "HEAD"],
			cwd,
		);
		return result.stdout.trim();
	}
}
