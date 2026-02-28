import type { IFlywheelRunner } from "flywheel-core";
import type { FlywheelConfig } from "flywheel-config";
import type { DagNode } from "flywheel-dag-resolver";
import type { HydratedContext } from "./PreHydrator.js";
import type { PreHydrator } from "./PreHydrator.js";

/** Result of a Blueprint execution */
export interface BlueprintResult {
	success: boolean;
	costUsd: number;
	sessionId?: string;
	ciRounds: number;
}

/** Runtime context for a single Blueprint execution */
export interface BlueprintContext {
	teamName: string;
	runnerName: string;
	budgetPerIssue: number;
	fixBudgetUsd: number;
	resumeSessionId?: string;
}

/** CI check result */
export interface CIResult {
	passed: boolean;
	output: string;
}

/** Shell command runner for deterministic steps (git, lint, CI) — uses execFile, not exec */
export interface ShellRunner {
	execFile(
		cmd: string,
		args: string[],
		cwd: string,
	): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * Blueprint: hybrid deterministic + agent orchestration engine.
 *
 * Flow: Pre-Hydrate → Implement (agent) → Lint → Push + CI → Fix loop
 *
 * Deterministic steps (git, lint, CI) use zero tokens.
 * Only implement and fix steps spawn an agent via IFlywheelRunner.
 */
export class Blueprint {
	private maxCIRounds: number;

	/** Callback for session checkpoint — persist sessionId for crash recovery */
	onSessionCreated?: (nodeId: string, sessionId: string) => Promise<void>;

	constructor(
		private config: FlywheelConfig,
		private hydrator: PreHydrator,
		private getRunner: (name: string) => IFlywheelRunner,
		private shell: ShellRunner,
	) {
		this.maxCIRounds = config.ci?.max_rounds ?? 2;
	}

	async run(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
	): Promise<BlueprintResult> {
		let totalCost = 0;
		const runner = this.getRunner(ctx.runnerName);

		const implTools = this.config.agent_nodes?.implement?.tools ?? [
			"Read",
			"Edit",
			"Write",
			"Bash",
			"Grep",
			"Glob",
		];
		const implMaxTurns =
			this.config.agent_nodes?.implement?.max_turns ?? 50;

		// Step 1: Pre-Hydrate (deterministic, zero token cost)
		const hydrated = await this.hydrator.hydrate(node);

		// Budget guard
		if (ctx.budgetPerIssue <= 0) {
			return { success: false, costUsd: 0, ciRounds: 0 };
		}

		// Step 2: Implement (agent)
		const implResult = await runner.run({
			prompt: this.buildPrompt(hydrated),
			cwd: projectRoot,
			allowedTools: implTools,
			maxTurns: implMaxTurns,
			maxCostUsd: ctx.budgetPerIssue,
			sessionId: ctx.resumeSessionId,
		});

		if (implResult.sessionId && this.onSessionCreated) {
			await this.onSessionCreated(node.id, implResult.sessionId);
		}
		totalCost += implResult.costUsd;

		// Short-circuit if implement failed — don't push broken code
		if (!implResult.success) {
			return {
				success: false,
				costUsd: totalCost,
				sessionId: implResult.sessionId,
				ciRounds: 0,
			};
		}

		// Step 3: Lint + Codegen (deterministic)
		await this.runLint(projectRoot);

		// Step 4-5: Push + CI loop
		for (let round = 1; round <= this.maxCIRounds; round++) {
			await this.gitPush(projectRoot);
			const ciResult = await this.checkCI(projectRoot);

			if (ciResult.passed) {
				return {
					success: true,
					costUsd: totalCost,
					sessionId: implResult.sessionId,
					ciRounds: round,
				};
			}

			if (round < this.maxCIRounds) {
				// Budget check before fix attempt
				const remainingBudget = ctx.budgetPerIssue - totalCost;
				const fixBudget = Math.min(ctx.fixBudgetUsd, remainingBudget);
				if (fixBudget <= 0) {
					return {
						success: false,
						costUsd: totalCost,
						sessionId: implResult.sessionId,
						ciRounds: round,
					};
				}

				const fixResult = await runner.run({
					prompt: `CI failed. Fix these errors:\n${ciResult.output}`,
					cwd: projectRoot,
					allowedTools:
						this.config.agent_nodes?.fix?.tools ?? implTools,
					sessionId: implResult.sessionId,
					maxCostUsd: fixBudget,
				});
				totalCost += fixResult.costUsd;

				await this.runLint(projectRoot);
			}
		}

		return {
			success: false,
			costUsd: totalCost,
			sessionId: implResult.sessionId,
			ciRounds: this.maxCIRounds,
		};
	}

	private buildPrompt(ctx: HydratedContext): string {
		const parts = [
			`# Task: ${ctx.issueTitle}`,
			`\n## Description\n${ctx.issueDescription}`,
		];
		if (ctx.relatedFiles.length > 0) {
			parts.push(`\n## Related Files\n${ctx.relatedFiles.join("\n")}`);
		}
		if (ctx.projectRules) {
			parts.push(`\n## Project Rules\n${ctx.projectRules}`);
		}
		parts.push(
			`\n## Instructions`,
			`Follow TDD. Create PR when done. Do not ask questions — implement your best judgment.`,
		);
		return parts.join("\n");
	}

	private async runLint(root: string): Promise<void> {
		try {
			await this.shell.execFile(
				"npm",
				["run", "lint", "--", "--fix"],
				root,
			);
		} catch {
			// Lint errors are non-fatal in Phase 1
		}
	}

	private async gitPush(root: string): Promise<void> {
		await this.shell.execFile("git", ["push"], root);
	}

	private async checkCI(root: string): Promise<CIResult> {
		// Get current branch for scoped CI check
		const branchResult = await this.shell.execFile(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			root,
		);
		const branch = branchResult.stdout.trim();

		// Poll until CI run completes (with timeout)
		const maxWaitMs = 300_000; // 5 minutes
		const pollIntervalMs = 15_000;
		const start = Date.now();

		while (Date.now() - start < maxWaitMs) {
			const result = await this.shell.execFile(
				"gh",
				[
					"run",
					"list",
					"--branch",
					branch,
					"--limit",
					"1",
					"--json",
					"conclusion,status",
				],
				root,
			);
			try {
				const runs = JSON.parse(result.stdout);
				if (runs.length > 0 && runs[0].status === "completed") {
					return {
						passed: runs[0].conclusion === "success",
						output: result.stdout,
					};
				}
			} catch {
				// Parse error — CI data not ready yet
			}

			await new Promise((resolve) =>
				setTimeout(resolve, pollIntervalMs),
			);
		}

		return { passed: false, output: "CI timed out waiting for workflow" };
	}
}
