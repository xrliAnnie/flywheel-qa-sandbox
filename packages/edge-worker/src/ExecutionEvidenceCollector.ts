import fs from "node:fs";
import type { LandingStatus } from "flywheel-core";
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

	// Landing status (v0.6 — undefined if landing not attempted)
	landingStatus?: LandingStatus;
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
		landSignalPath?: string,
	): Promise<ExecutionEvidence> {
		let partial = false;

		// Required fields — from GitCheckResult
		const {
			commitCount,
			filesChanged: filesChangedCount,
			commitMessages,
		} = gitResult;

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

		const diffSummary = await this.getDiffSummary(cwd, baseSha).catch(() => {
			partial = true;
			return "";
		});

		const headSha = await this.getHeadSha(cwd).catch(() => {
			partial = true;
			return null;
		});

		// Landing status (v0.6 — from land-status.json signal file)
		const landingStatus = landSignalPath
			? await this.readLandingStatus(landSignalPath, cwd)
			: undefined;

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
			landingStatus,
		};
	}

	/**
	 * Read and validate land-status.json signal file.
	 * Three-state semantics:
	 *   - File missing → undefined (landing not attempted)
	 *   - status=pending → failed/signal_missing (landing started but didn't complete)
	 *   - status=merged → verify via GitHub API, then pass through
	 *   - status=failed → pass through
	 *   - Parse error → failed/parse_error
	 */
	private async readLandingStatus(
		signalPath: string,
		cwd: string,
	): Promise<LandingStatus | undefined> {
		try {
			let raw: string;
			try {
				raw = await fs.promises.readFile(signalPath, "utf-8");
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return undefined; // File missing → landing not attempted
				}
				// Permission error, EISDIR, etc. → treat as parse_error (don't silently skip)
				return { status: "failed", failureReason: "parse_error" };
			}
			const signal = JSON.parse(raw);

			if (signal.status === "pending") {
				return { status: "failed", failureReason: "signal_missing" };
			}

			if (signal.status === "merged") {
				// GitHub API verification — run gh in the project's working directory
				if (signal.prNumber) {
					try {
						const result = await this.execFile(
							"gh",
							[
								"pr",
								"view",
								String(signal.prNumber),
								"--json",
								"state,mergedAt",
							],
							cwd,
						);
						const prData = JSON.parse(result.stdout.trim());
						if (prData.state !== "MERGED") {
							return { status: "failed", failureReason: "verification_failed" };
						}
					} catch (err) {
						console.warn(
							`[EvidenceCollector] gh pr view failed for PR #${signal.prNumber}: ${err instanceof Error ? err.message : String(err)}. Trusting signal file.`,
						);
					}
				}
				return {
					status: "merged",
					prNumber: signal.prNumber,
					mergedAt: signal.mergedAt,
					mergeCommitSha: signal.mergeCommitSha,
				};
			}

			if (signal.status === "ready_to_merge") {
				return {
					status: "ready_to_merge",
					prNumber: signal.prNumber,
				};
			}

			if (signal.status === "failed") {
				return {
					status: "failed",
					prNumber: signal.prNumber,
					failureReason: signal.failureReason,
					failureDetail: signal.failureDetail,
				};
			}

			// Unknown status
			return { status: "failed", failureReason: "parse_error" };
		} catch (err) {
			const reason = err instanceof SyntaxError ? "parse_error" : "read_error";
			console.warn(
				`[EvidenceCollector] readLandingStatus failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
			);
			return { status: "failed", failureReason: reason };
		}
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

	private async getDiffSummary(cwd: string, baseSha: string): Promise<string> {
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
