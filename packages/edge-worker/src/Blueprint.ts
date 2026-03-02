import type { IFlywheelRunner, FlywheelRunResult } from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import type { PreHydrator } from "./PreHydrator.js";
import type { GitResultChecker } from "./GitResultChecker.js";

/** Result of a Blueprint execution */
export interface BlueprintResult {
	success: boolean;
	costUsd?: number;
	sessionId?: string;
	tmuxWindow?: string;
	durationMs?: number;
	error?: string;
}

/** Runtime context for a single Blueprint execution */
export interface BlueprintContext {
	teamName: string;
	runnerName: string;
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
 * Flow: Git preflight → Pre-Hydrate → Launch Claude (tmux) → Wait → Git check
 *
 * v0.1.1: No lint/CI/push loop — Claude Code does all real work.
 * Success = commitCount > 0 (via GitResultChecker).
 */
export class Blueprint {
	constructor(
		private hydrator: PreHydrator,
		private gitChecker: GitResultChecker,
		private getRunner: (name: string) => IFlywheelRunner,
		private shell: ShellRunner,
	) {}

	async run(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
	): Promise<BlueprintResult> {
		const runner = this.getRunner(ctx.runnerName);
		const startTime = Date.now();

		// Step 1: Git preflight — fail fast if working tree is dirty
		await this.gitChecker.assertCleanTree(projectRoot);
		const baseSha = await this.gitChecker.captureBaseline(projectRoot);

		// Step 2: Pre-Hydrate (deterministic, zero token cost)
		const hydrated = await this.hydrator.hydrate(node);

		// Step 3: Build prompt + system prompt
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

		// Step 4: Launch Claude session
		let result: FlywheelRunResult;
		try {
			result = await runner.run({
				prompt,
				cwd: projectRoot,
				label: `${hydrated.issueId}-${hydrated.issueTitle}`,
				permissionMode: "bypassPermissions",
				appendSystemPrompt: systemPrompt,
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
			};
		}

		// Step 5: Check git for results
		// Let infrastructure errors propagate — they should NOT be masked as "0 commits"
		const gitResult = await this.gitChecker.check(projectRoot, baseSha);

		// Timeout = failure: session may still be running, unsafe to dispatch next issue
		// Phase 1 serial execution requires clean completion before proceeding
		const success = gitResult.commitCount > 0 && !result.timedOut;

		// Step 6: Window lifecycle
		// - Kill on success (cleanup)
		// - Preserve on failure or timeout (for debugging / still running)
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
