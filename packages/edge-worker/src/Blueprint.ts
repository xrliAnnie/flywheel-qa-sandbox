import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillsConfig } from "flywheel-config";
import type {
	AdapterExecutionResult,
	DecisionResult,
	ExecutionContext,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import type { AgentDispatcher } from "./AgentDispatcher.js";
import type { IDecisionLayer } from "./decision/DecisionLayer.js";
import type {
	EventEnvelope,
	ExecutionEventEmitter,
} from "./ExecutionEventEmitter.js";
import type {
	ExecutionEvidence,
	ExecutionEvidenceCollector,
} from "./ExecutionEvidenceCollector.js";
import type { GitResultChecker } from "./GitResultChecker.js";
import type { HydratedContext, PreHydrator } from "./PreHydrator.js";
import type { SkillInjector } from "./SkillInjector.js";
import type { WorktreeInfo, WorktreeManager } from "./WorktreeManager.js";

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
	// CIPHER — passed through for event emitter → saveSnapshot
	labels?: string[];
	projectId?: string;
	exitReason?: string;
	consecutiveFailures?: number;
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
	// v0.4 — optional; Blueprint fallback to randomUUID()
	executionId?: string;
	// GEO-168 — retry context for re-executed issues
	retryContext?: {
		predecessorExecutionId: string;
		previousError?: string;
		previousDecisionRoute?: string;
		previousReasoning?: string;
		attempt: number;
		reason?: string;
	};
	// GEO-206 — Lead ID for bidirectional communication prompt
	leadId?: string;
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
 * v0.6: Agent dispatch (project-aware prompt assembly).
 */
export class Blueprint {
	constructor(
		private hydrator: PreHydrator,
		private gitChecker: GitResultChecker,
		private getAdapter: (name: string) => IAdapter,
		private shell: ShellRunner,
		// v0.2 — optional for backward compat
		private worktreeManager?: WorktreeManager,
		private skillInjector?: SkillInjector,
		private evidenceCollector?: ExecutionEvidenceCollector,
		private skillsConfig?: SkillsConfig,
		// v0.2 Step 2b — optional for backward compat
		private decisionLayer?: IDecisionLayer,
		// v0.4 — optional event emitter for TeamLead pipeline
		private eventEmitter?: ExecutionEventEmitter,
		// v0.6 — optional agent dispatcher for project-aware prompts
		private agentDispatcher?: AgentDispatcher,
	) {}

	async run(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
	): Promise<BlueprintResult> {
		const executionId = ctx.executionId ?? randomUUID();
		// v0.3 — canonical project scope (unified for events + memory)
		const projectScope = ctx.projectName ?? ctx.teamName ?? "unknown";

		// Hydrate BEFORE emitStarted so labels are available in session_started payload
		const hydrated = await this.hydrator.hydrate(node);

		const env: EventEnvelope = {
			executionId,
			issueId: node.id,
			projectName: projectScope,
			issueIdentifier: hydrated.issueIdentifier,
			issueTitle: hydrated.issueTitle,
			labels: hydrated.labels,
			retryPredecessor: ctx.retryContext?.predecessorExecutionId,
			runAttempt: ctx.retryContext?.attempt,
		};

		// Fire-and-forget started event (labels now populated)
		this.eventEmitter?.emitStarted(env).catch(() => {});

		try {
			const result = await this.runInner(node, projectRoot, ctx, env, hydrated);
			await this.emitTerminal(env, result);
			return result;
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			const failResult: BlueprintResult = { success: false, error: errorMsg };
			await this.emitTerminal(env, failResult);
			throw err;
		}
	}

	private async runInner(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
		env: EventEnvelope,
		hydrated: HydratedContext,
	): Promise<BlueprintResult> {
		const adapter = this.getAdapter(ctx.runnerName);
		const startTime = Date.now();
		const executionId = env.executionId;
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
					error: error instanceof Error ? error.message : String(error),
					worktreePath: worktreeInfo?.worktreePath,
				};
			}
		}

		// ── Git exclude for .flywheel/runs/ (v0.6 — BEFORE assertCleanTree) ──
		try {
			await ensureFlywheelRunsExclude(cwd);
		} catch (err) {
			console.warn(
				`[Blueprint] Failed to set up .flywheel/runs/ git exclude: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// ── Git preflight (existing — THROWS on failure) ──────
		await this.gitChecker.assertCleanTree(cwd);
		const baseSha = await this.gitChecker.captureBaseline(cwd);

		// ── Skill injection (v0.2 — best-effort, non-blocking) ─
		let skillInjectionSucceeded = false;
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
				skillInjectionSucceeded = true;
			} catch (err) {
				console.warn(
					`[Blueprint] Skill injection failed (non-fatal): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		// ── Agent dispatch (v0.6 — after hydrate, before prompt) ─
		const dispatchResult = this.agentDispatcher
			? await this.agentDispatcher.dispatch(hydrated)
			: null;

		// ── Landing signal path (v0.6) ───────────────────────
		const landSignalPath = path.join(
			cwd,
			".flywheel",
			"runs",
			executionId,
			"land-status.json",
		);
		// Landing is only supported in worktree mode (single-repo)
		const landingEnabled = !!this.worktreeManager;
		const hasLandCommand = !!this.skillsConfig?.land_command;
		const canLand =
			landingEnabled && (skillInjectionSucceeded || hasLandCommand);

		// ── Build prompt + system prompt ──────────────────────
		const prompt = `Implement ${hydrated.issueId}: ${hydrated.issueTitle}.\n\n${hydrated.issueDescription}`;

		const systemPromptLines = [
			"You are working on a Linear issue. Follow these steps:",
			"1. Read the codebase and understand the context (CLAUDE.md, relevant files).",
			"2. Implement the requested changes following TDD.",
			"3. Create a feature branch, commit your changes.",
			"4. Push the branch and create a GitHub PR.",
		];

		if (canLand) {
			// v0.6: land after PR creation (v1.0 Phase 2: no merge — report readiness only)
			if (hasLandCommand) {
				systemPromptLines.push(
					`5. After creating the PR, use ${this.skillsConfig!.land_command} to monitor CI readiness.`,
					`   You MUST write the landing signal file. Do NOT merge the PR — write {"status":"ready_to_merge"} and exit.`,
				);
			} else {
				systemPromptLines.push(
					"5. After creating the PR, follow the flywheel-land skill to monitor CI and report readiness.",
				);
			}
			systemPromptLines.push(
				"6. After writing the landing signal (ready_to_merge or failed), exit the session.",
				`Landing signal path: ${landSignalPath}`,
			);
		} else {
			// Legacy behavior: stop after PR
			systemPromptLines.push(
				"5. Verify CI passes. If CI fails, fix and push again.",
				"6. When all work is complete, stop and wait.",
			);
		}

		if (ctx.retryContext) {
			const rc = ctx.retryContext;
			systemPromptLines.push("");
			systemPromptLines.push(`## Retry Context (Attempt #${rc.attempt})`);
			systemPromptLines.push(
				`This is a retry of a previous execution that ${rc.previousDecisionRoute === "blocked" ? "was blocked" : "failed"}.`,
			);
			if (rc.previousError)
				systemPromptLines.push(`Previous error: ${rc.previousError}`);
			if (rc.previousReasoning)
				systemPromptLines.push(`Previous reasoning: ${rc.previousReasoning}`);
			if (rc.reason) systemPromptLines.push(`CEO instruction: ${rc.reason}`);
			systemPromptLines.push(
				"Please address the issues from the previous attempt.",
			);
		}

		// GEO-206: Inject flywheel-comm ask instructions when Lead is available
		if (ctx.leadId) {
			const __filename = fileURLToPath(import.meta.url);
			const commCliPath = path.resolve(
				path.dirname(__filename),
				"../../flywheel-comm/dist/index.js",
			);
			systemPromptLines.push(
				`Prefer independent implementation. If you encounter a major ambiguity ` +
					`(architecture choice, API design, priority conflict) that you cannot safely ` +
					`resolve alone, use \`node ${commCliPath} ask --lead ${ctx.leadId} --exec-id ${executionId} "your question"\` ` +
					`to ask your Lead. Then continue with other work and periodically run ` +
					`\`node ${commCliPath} check {question_id}\` to check for a response. ` +
					`If no response arrives before your session ends, use your best judgment.`,
			);
			// GEO-206 Phase 2: Inbox instructions for Lead proactive commands
			systemPromptLines.push(
				`Additionally, your Lead may send you proactive instructions. ` +
					`Periodically check for instructions with ` +
					`\`node ${commCliPath} inbox --exec-id ${executionId}\`. ` +
					`Check at task boundaries (before committing, when starting a new subtask). ` +
					`If you receive instructions, evaluate their urgency: follow immediately ` +
					`if the Lead explicitly demands it, otherwise incorporate at the next ` +
					`natural breakpoint.`,
			);
		} else {
			systemPromptLines.push(
				"Do not ask questions — implement your best judgment.",
			);
		}
		const baseSystemPrompt = systemPromptLines.join("\n");

		// Agent context (additive — prepend before base system prompt)
		let agentContext = "";
		if (dispatchResult) {
			const agentContent = await readAgentFile(
				cwd,
				dispatchResult.agentConfig.agent_file,
			);
			if (agentContent) {
				const parts: string[] = [
					"## Agent Role",
					agentContent.slice(0, 40_000),
					"",
				];
				if (dispatchResult.agentConfig.domain_file) {
					const domainContent = await readAgentFile(
						cwd,
						dispatchResult.agentConfig.domain_file,
					);
					if (domainContent) {
						parts.push(`## Domain Config\n${domainContent.slice(0, 10_000)}`);
						parts.push("");
					}
				}
				agentContext = parts.join("\n");
			} else {
				console.warn(
					`[Blueprint] Agent file not found: ${dispatchResult.agentConfig.agent_file}, using generic prompt`,
				);
			}
		}

		const systemPrompt = agentContext
			? `${agentContext}\n## Baseline Rules\n${baseSystemPrompt}`
			: baseSystemPrompt;

		// ── Adapter execution (GEO-157: IAdapter.execute()) ──
		const timeoutMs = ctx.sessionTimeoutMs ?? 2_700_000;

		// GEO-206: Compute commDbPath for Lead ↔ Runner communication.
		// ctx.projectName is resolved from projects config canonical name in
		// run-issue.ts. claude-lead.sh accepts matching project-name as 3rd arg.
		const commDbPath =
			ctx.leadId && ctx.projectName
				? path.join(
						process.env.HOME ?? "/tmp",
						".flywheel",
						"comm",
						ctx.projectName,
						"comm.db",
					)
				: undefined;

		let result: AdapterExecutionResult;
		try {
			result = await adapter.execute({
				executionId,
				issueId: hydrated.issueId,
				prompt,
				cwd,
				label: buildWindowLabel(
					hydrated.issueId,
					ctx.runnerName,
					hydrated.issueTitle,
				),
				permissionMode: "bypassPermissions",
				appendSystemPrompt: systemPrompt,
				timeoutMs,
				sessionDisplayName: `${hydrated.issueId} ${hydrated.issueTitle}`,
				sentinelPath: canLand ? landSignalPath : undefined,
				commDbPath,
				waitingTimeoutMs: 14_400_000, // GEO-206 Phase 2: 4h when waiting for Lead
				leadId: ctx.leadId,
				projectName: ctx.projectName,
				onHeartbeat: () => {
					this.eventEmitter?.emitHeartbeat(env).catch(() => {});
				},
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error(
				`[Blueprint] Adapter failed for ${hydrated.issueId}: ${errorMsg}`,
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
				canLand ? landSignalPath : undefined,
			);
		}

		// ── Non-worktree cleanup: remove .flywheel/runs/<executionId>/ ──
		if (!this.worktreeManager) {
			const runDir = path.join(cwd, ".flywheel", "runs", executionId);
			try {
				await fs.promises.rm(runDir, { recursive: true, force: true });
			} catch (err) {
				console.warn(
					`[Blueprint] Failed to clean up ${runDir}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
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
				env,
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

	private async emitTerminal(
		env: EventEnvelope,
		result: BlueprintResult,
	): Promise<void> {
		if (!this.eventEmitter) return;
		try {
			if (result.success || result.decision) {
				const summary = this.buildSummary(result);
				await Promise.race([
					this.eventEmitter.emitCompleted(env, result, summary),
					new Promise<void>((r) => setTimeout(r, 1000)),
				]);
			} else {
				await Promise.race([
					this.eventEmitter.emitFailed(env, result.error ?? "unknown"),
					new Promise<void>((r) => setTimeout(r, 1000)),
				]);
			}
		} catch (err) {
			console.warn(
				`[Blueprint] emitTerminal failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private buildSummary(result: BlueprintResult): string | undefined {
		if (!result.evidence) return undefined;
		const parts: string[] = [];
		if (result.evidence.diffSummary) parts.push(result.evidence.diffSummary);
		if (result.evidence.commitMessages?.length) {
			parts.push(`Commits: ${result.evidence.commitMessages.join("; ")}`);
		}
		return parts.join(" | ") || undefined;
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
		result: AdapterExecutionResult,
		cwd: string,
		baseSha: string,
		worktreeInfo: WorktreeInfo | undefined,
		env: EventEnvelope,
	): Promise<BlueprintResult> {
		// Build ExecutionContext
		const execCtx: ExecutionContext = {
			executionId: env.executionId,
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
			landingStatus: evidence.landingStatus,
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
			decision.route === "auto_approve" || decision.route === "needs_review";

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
				decision.route === "auto_approve" ? undefined : result.tmuxWindow,
			durationMs: result.durationMs,
			worktreePath: worktreeInfo?.worktreePath,
			evidence,
			decision,
			labels: hydrated.labels,
			projectId: hydrated.projectId,
			exitReason: execCtx.exitReason,
			consecutiveFailures: execCtx.consecutiveFailures,
		};
	}

	private async killTmuxWindow(tmuxWindow: string): Promise<void> {
		try {
			await this.shell.execFile("tmux", ["kill-window", "-t", tmuxWindow], "/");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[Blueprint] Failed to kill tmux window ${tmuxWindow}: ${msg}`,
			);
		}
	}
}

/**
 * Safely read an agent/domain file relative to the repo root.
 * Returns null if file doesn't exist or path escapes the repo.
 */
async function readAgentFile(
	repoRoot: string,
	relativePath: string,
): Promise<string | null> {
	// Path safety: reject absolute or parent-escaping paths
	if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
		console.warn(`[Blueprint] Unsafe agent path rejected: ${relativePath}`);
		return null;
	}

	const resolved = path.resolve(repoRoot, relativePath);

	// Containment check (resolve-based, no realpath dependency)
	const normalizedRoot = path.resolve(repoRoot);
	if (
		!resolved.startsWith(normalizedRoot + path.sep) &&
		resolved !== normalizedRoot
	) {
		console.warn(`[Blueprint] Agent path escapes repo: ${relativePath}`);
		return null;
	}

	try {
		// Symlink containment: verify real path before reading content
		const realResolved = await fs.promises.realpath(resolved);
		const realRoot = await fs.promises.realpath(repoRoot);
		if (!realResolved.startsWith(realRoot + path.sep)) {
			console.warn(
				`[Blueprint] Agent file symlinks outside repo: ${relativePath}`,
			);
			return null;
		}

		const content = await fs.promises.readFile(realResolved, "utf-8");
		return content || null; // empty file → null
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw err;
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

const RUNS_EXCLUDE_ENTRY = ".flywheel/runs/";

/**
 * Ensure .flywheel/runs/ is in git info/exclude.
 * Must run BEFORE assertCleanTree() to prevent land-status.json from
 * making the tree appear dirty.
 */
async function ensureFlywheelRunsExclude(cwd: string): Promise<void> {
	let excludeFile: string;
	try {
		excludeFile = await new Promise<string>((resolve, reject) => {
			execFile(
				"git",
				["-C", cwd, "rev-parse", "--git-path", "info/exclude"],
				(err, stdout) =>
					err ? reject(err) : resolve(path.resolve(cwd, stdout.trim())),
			);
		});
	} catch (err) {
		console.warn(
			`[Blueprint] ensureFlywheelRunsExclude skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	const infoDir = path.dirname(excludeFile);
	await fs.promises.mkdir(infoDir, { recursive: true });

	let content = "";
	try {
		content = await fs.promises.readFile(excludeFile, "utf-8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(
				`[Blueprint] Failed to read ${excludeFile}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (!content.includes(RUNS_EXCLUDE_ENTRY)) {
		const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
		await fs.promises.writeFile(
			excludeFile,
			`${content}${suffix}${RUNS_EXCLUDE_ENTRY}\n`,
		);
	}
}
