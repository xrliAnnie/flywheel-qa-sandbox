import type {
	IFlywheelRunner,
	FlywheelRunResult,
	DecisionResult,
	ExecutionContext,
} from "flywheel-core";
import type { SkillsConfig } from "flywheel-config";
import type { DagNode } from "flywheel-dag-resolver";
import type { PreHydrator } from "./PreHydrator.js";
import type { GitResultChecker } from "./GitResultChecker.js";
import type { WorktreeManager, WorktreeInfo } from "./WorktreeManager.js";
import type { SkillInjector } from "./SkillInjector.js";
import type {
	ExecutionEvidenceCollector,
	ExecutionEvidence,
} from "./ExecutionEvidenceCollector.js";
import type { IDecisionLayer } from "./decision/DecisionLayer.js";

/** Result of a Blueprint execution */
export interface BlueprintResult {
	success: boolean;
	costUsd?: number;
	sessionId?: string;
	tmuxWindow?: string;
	durationMs?: number;
	error?: string;
	// v0.2
	worktreePath?: string;
	evidence?: ExecutionEvidence;
	// v0.2 Step 2b
	decision?: DecisionResult;
}

/** Runtime context for a single Blueprint execution */
export interface BlueprintContext {
	teamName: string;
	runnerName: string;
	// v0.2 — optional for backward compat
	projectName?: string;
	sessionTimeoutMs?: number;
	// v0.2 Step 2b — tracked by caller (DagDispatcher)
	consecutiveFailures?: number;
}

/** Shell command runner for tmux window cleanup */
export interface ShellRunner {
	execFile(
		cmd: string,
		args: string[],
		cwd: string,
	): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * Blueprint: interactive-mode orchestration engine.
 *
 * Flow: [Worktree setup] → Git preflight → Pre-Hydrate → [Skill injection] →
 *       Launch Claude (tmux) → Wait → Git check → [Evidence collection] →
 *       [Decision Layer] → Result
 *
 * v0.1.1: No worktree, no skills, no evidence, no decision.
 * v0.2: Worktree isolation + skill injection + evidence collection.
 * v0.2 Step 2b: Decision Layer integration (optional).
 */
export class Blueprint {
	constructor(
		private hydrator: PreHydrator,
		private gitChecker: GitResultChecker,
		private getRunner: (name: string) => IFlywheelRunner,
		private shell: ShellRunner,
		// v0.2 — optional for backward compat
		private worktreeManager?: WorktreeManager,
		private skillInjector?: SkillInjector,
		private evidenceCollector?: ExecutionEvidenceCollector,
		private skillsConfig?: SkillsConfig,
		// v0.2 Step 2b — optional for backward compat
		private decisionLayer?: IDecisionLayer,
	) {}

	async run(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
	): Promise<BlueprintResult> {
		const runner = this.getRunner(ctx.runnerName);
		const startTime = Date.now();
		let cwd = projectRoot;
		let worktreeInfo: WorktreeInfo | undefined;

		// ── Worktree setup (v0.2 — own try/catch) ──────────────
		if (this.worktreeManager) {
			const projectName = ctx.projectName ?? ctx.teamName;
			try {
				await this.worktreeManager.removeIfExists(
					projectRoot,
					projectName,
					node.id,
				);
				worktreeInfo = await this.worktreeManager.create({
					mainRepoPath: projectRoot,
					projectName,
					issueId: node.id,
				});
				cwd = worktreeInfo.worktreePath;
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: String(error),
					worktreePath: worktreeInfo?.worktreePath,
				};
			}
		}

		// ── Git preflight (existing — THROWS on failure) ──────
		await this.gitChecker.assertCleanTree(cwd);
		const baseSha = await this.gitChecker.captureBaseline(cwd);

		// ── Pre-Hydrate (existing) ────────────────────────────
		const hydrated = await this.hydrator.hydrate(node);

		// ── Skill injection (v0.2 — best-effort, non-blocking) ─
		if (this.skillInjector) {
			const projectName = ctx.projectName ?? ctx.teamName;
			try {
				await this.skillInjector.inject(cwd, {
					issueId: hydrated.issueId,
					issueTitle: hydrated.issueTitle,
					issueDescription: hydrated.issueDescription,
					projectName,
					testCommand: this.skillsConfig?.test_command,
					lintCommand: this.skillsConfig?.lint_command,
					buildCommand: this.skillsConfig?.build_command,
					testFramework: this.skillsConfig?.test_framework,
				});
			} catch (err) {
				console.warn(
					`[Blueprint] Skill injection failed (non-fatal): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		// ── Build prompt + system prompt ──────────────────────
		const prompt = `Implement ${hydrated.issueId}: ${hydrated.issueTitle}.\n\n${hydrated.issueDescription}`;
		const systemPrompt = [
			"You are working on a Linear issue. Follow these steps:",
			"1. Read the codebase and understand the context (CLAUDE.md, relevant files).",
			"2. Implement the requested changes following TDD.",
			"3. Create a feature branch, commit your changes.",
			"4. Push the branch and create a GitHub PR.",
			"5. Verify CI passes. If CI fails, fix and push again.",
			"6. When all work is complete, stop and wait.",
			"Do not ask questions — implement your best judgment.",
		].join("\n");

		// ── Runner execution (existing — catch runner errors) ─
		const timeoutMs = ctx.sessionTimeoutMs ?? 1_800_000;
		let result: FlywheelRunResult;
		try {
			result = await runner.run({
				prompt,
				cwd,
				label: buildWindowLabel(
					hydrated.issueId,
					ctx.runnerName,
					hydrated.issueTitle,
				),
				issueId: hydrated.issueId,
				permissionMode: "bypassPermissions",
				appendSystemPrompt: systemPrompt,
				timeoutMs,
				sessionDisplayName: `${hydrated.issueId} ${hydrated.issueTitle}`,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error(
				`[Blueprint] Runner failed for ${hydrated.issueId}: ${errorMsg}`,
			);
			return {
				success: false,
				durationMs: Date.now() - startTime,
				error: errorMsg,
				worktreePath: worktreeInfo?.worktreePath,
			};
		}

		// ── Git result check (existing — THROWS on infra error) ─
		const gitResult = await this.gitChecker.check(cwd, baseSha);

		// ── Evidence collection (v0.2 — conditional) ──────────
		let evidence: ExecutionEvidence | undefined;
		if (this.evidenceCollector) {
			evidence = await this.evidenceCollector.collect(
				cwd,
				baseSha,
				gitResult,
				result.durationMs ?? 0,
			);
		}

		// ── Decision Layer (v0.2 Step 2b — optional) ──────────
		if (this.decisionLayer && evidence) {
			return this.runWithDecision(
				node,
				ctx,
				hydrated,
				evidence,
				result,
				cwd,
				baseSha,
				worktreeInfo,
			);
		}

		// ── v0.1.1 fallback: no DecisionLayer ─────────────────
		const success = gitResult.commitCount > 0 && !result.timedOut;

		if (result.tmuxWindow) {
			if (success) {
				await this.killTmuxWindow(result.tmuxWindow);
			}
		}

		return {
			success,
			costUsd: result.costUsd,
			sessionId: result.sessionId,
			tmuxWindow: success ? undefined : result.tmuxWindow,
			durationMs: result.durationMs,
			worktreePath: worktreeInfo?.worktreePath,
			evidence,
		};
	}

	private async runWithDecision(
		_node: DagNode,
		ctx: BlueprintContext,
		hydrated: {
			issueId: string;
			issueTitle: string;
			labels: string[];
			projectId: string;
			issueIdentifier: string;
		},
		evidence: ExecutionEvidence,
		result: FlywheelRunResult,
		cwd: string,
		baseSha: string,
		worktreeInfo: WorktreeInfo | undefined,
	): Promise<BlueprintResult> {
		// Build ExecutionContext
		const execCtx: ExecutionContext = {
			issueId: hydrated.issueId,
			issueIdentifier: hydrated.issueIdentifier,
			issueTitle: hydrated.issueTitle,
			labels: hydrated.labels,
			projectId: hydrated.projectId,
			exitReason: result.timedOut
				? "timeout"
				: !result.success
					? "error"
					: "completed",
			baseSha,
			commitCount: evidence.commitCount,
			commitMessages: evidence.commitMessages,
			changedFilePaths: evidence.changedFilePaths,
			filesChangedCount: evidence.filesChangedCount,
			linesAdded: evidence.linesAdded,
			linesRemoved: evidence.linesRemoved,
			diffSummary: evidence.diffSummary,
			headSha: evidence.headSha,
			durationMs: evidence.durationMs,
			consecutiveFailures: ctx.consecutiveFailures ?? 0,
			partial: evidence.partial,
		};

		let decision: DecisionResult;
		try {
			decision = await this.decisionLayer!.decide(execCtx, cwd);
		} catch (err) {
			// DecisionLayer failure → conservative needs_review
			decision = {
				route: "needs_review",
				confidence: 0,
				reasoning: `Decision layer error: ${err instanceof Error ? err.message : String(err)}`,
				concerns: ["Decision layer failed"],
				decisionSource: "decision_error_fallback",
			};
		}

		// Route → success mapping
		const success =
			decision.route === "auto_approve" ||
			decision.route === "needs_review";

		// Window lifecycle based on decision
		if (result.tmuxWindow) {
			if (decision.route === "auto_approve") {
				await this.killTmuxWindow(result.tmuxWindow);
			}
			// needs_review / blocked → preserve window for inspection
		}

		return {
			success,
			costUsd: result.costUsd,
			sessionId: result.sessionId,
			tmuxWindow:
				decision.route === "auto_approve"
					? undefined
					: result.tmuxWindow,
			durationMs: result.durationMs,
			worktreePath: worktreeInfo?.worktreePath,
			evidence,
			decision,
		};
	}

	private async killTmuxWindow(tmuxWindow: string): Promise<void> {
		try {
			await this.shell.execFile(
				"tmux",
				["kill-window", "-t", tmuxWindow],
				"/",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[Blueprint] Failed to kill tmux window ${tmuxWindow}: ${msg}`,
			);
		}
	}
}

/**
 * Build a human-readable tmux window label.
 * Strip priority tags like [P0], [P1] and collapse repeated dashes.
 * issueId is omitted — tmux session name already carries it.
 * Format: "{runner}:{cleanTitle}"
 */
function buildWindowLabel(
	_issueId: string,
	runner: string,
	title: string,
): string {
	const cleanTitle = title
		.replace(/\[P\d+\]\s*/gi, "") // strip [P0], [P1], etc.
		.replace(/\s*—\s*/g, "-") // em-dash → single dash
		.trim();
	return `${runner}:${cleanTitle}`;
}
