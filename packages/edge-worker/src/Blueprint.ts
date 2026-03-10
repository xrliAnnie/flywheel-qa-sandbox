import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
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
import type { ExecutionEventEmitter, EventEnvelope } from "./ExecutionEventEmitter.js";
import type { AgentDispatcher } from "./AgentDispatcher.js";
import type { MemoryService } from "./memory/MemoryService.js";

const MEMORY_TIMEOUT_MS = 30_000; // 30s — generous for Gemini+Qdrant, but prevents indefinite hang

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

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
	// v0.4 — optional; Blueprint fallback to randomUUID()
	executionId?: string;
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
		private getRunner: (name: string) => IFlywheelRunner,
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
		// v0.3 — optional memory service for project memory
		private memoryService?: MemoryService,
	) {}

	async run(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
	): Promise<BlueprintResult> {
		const executionId = ctx.executionId ?? randomUUID();
		// v0.3 — canonical project scope (unified for events + memory)
		const projectScope = ctx.projectName ?? ctx.teamName ?? "unknown";
		const env: EventEnvelope = {
			executionId,
			issueId: node.id,
			projectName: projectScope,
		};

		// Fire-and-forget started event
		this.eventEmitter?.emitStarted(env).catch(() => {});

		try {
			const result = await this.runInner(node, projectRoot, ctx, env);
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
	): Promise<BlueprintResult> {
		const runner = this.getRunner(ctx.runnerName);
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
					error:
						error instanceof Error
							? error.message
							: String(error),
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

		// ── Pre-Hydrate (existing) ────────────────────────────
		const hydrated = await this.hydrator.hydrate(node);

		// Enrich envelope with hydrated fields
		env.issueIdentifier = hydrated.issueIdentifier;
		env.issueTitle = hydrated.issueTitle;

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

		// ── Memory retrieval (v0.3 — best-effort, non-fatal) ─
		let memoryBlock = "";
		if (this.memoryService) {
			try {
				memoryBlock = await withTimeout(
					this.memoryService.searchAndFormat({
						query: `${hydrated.issueTitle} ${hydrated.issueDescription}`.trim(),
						projectName: env.projectName,
					}),
					MEMORY_TIMEOUT_MS,
					"Memory retrieval",
				) ?? "";
			} catch (err) {
				console.warn(
					`[Blueprint] Memory retrieval failed (non-fatal): ${err instanceof Error ? err.stack : String(err)}`,
				);
			}
		}

		// ── Landing signal path (v0.6) ───────────────────────
		const landSignalPath = path.join(cwd, ".flywheel", "runs", executionId, "land-status.json");
		// Landing is only supported in worktree mode (single-repo)
		const landingEnabled = !!this.worktreeManager;
		const hasLandCommand = !!this.skillsConfig?.land_command;
		const canLand = landingEnabled && (skillInjectionSucceeded || hasLandCommand);

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

		systemPromptLines.push("Do not ask questions — implement your best judgment.");
		const baseSystemPrompt = systemPromptLines.join("\n");

		// Agent context (additive — prepend before base system prompt)
		let agentContext = "";
		if (dispatchResult) {
			const agentContent = await readAgentFile(cwd, dispatchResult.agentConfig.agent_file);
			if (agentContent) {
				const parts: string[] = [
					"## Agent Role",
					agentContent.slice(0, 40_000),
					"",
				];
				if (dispatchResult.agentConfig.domain_file) {
					const domainContent = await readAgentFile(cwd, dispatchResult.agentConfig.domain_file);
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

		const systemPrompt = [
			agentContext ? `${agentContext}\n## Baseline Rules\n${baseSystemPrompt}` : baseSystemPrompt,
			memoryBlock,
		].filter(Boolean).join("\n");

		// ── Runner execution (existing — catch runner errors) ─
		const timeoutMs = ctx.sessionTimeoutMs ?? 2_700_000;
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
				sentinelPath: canLand ? landSignalPath : undefined,
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
				canLand ? landSignalPath : undefined,
			);
		}

		// ── Non-worktree cleanup: remove .flywheel/runs/<executionId>/ ──
		if (!this.worktreeManager) {
			const runDir = path.join(cwd, ".flywheel", "runs", executionId);
			try {
				await fs.promises.rm(runDir, { recursive: true, force: true });
			} catch (err) {
				console.warn(`[Blueprint] Failed to clean up ${runDir}: ${err instanceof Error ? err.message : String(err)}`);
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

		// v0.3 — extract memory (fallback path, no decision)
		if (evidence) {
			await this.extractMemory(hydrated, evidence, result, undefined, env.executionId, env.projectName);
		}

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

	private async emitTerminal(env: EventEnvelope, result: BlueprintResult): Promise<void> {
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
			console.warn(`[Blueprint] emitTerminal failed: ${err instanceof Error ? err.message : String(err)}`);
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
		result: FlywheelRunResult,
		cwd: string,
		baseSha: string,
		worktreeInfo: WorktreeInfo | undefined,
		env: EventEnvelope,
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

		// v0.3 — extract memory (decision path)
		await this.extractMemory(hydrated, evidence, result, decision, env.executionId, env.projectName);

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

	private async extractMemory(
		hydrated: { issueId: string; issueTitle: string },
		evidence: ExecutionEvidence,
		result: FlywheelRunResult,
		decision: DecisionResult | undefined,
		executionId: string,
		projectName: string,
	): Promise<void> {
		if (!this.memoryService) return;
		try {
			const sessionResult: "success" | "failure" | "timeout" = result.timedOut
				? "timeout"
				: decision
					? (decision.route === "blocked" ? "failure" : "success")
					: (evidence.commitCount > 0 ? "success" : "failure");

			const memResult = await withTimeout(
				this.memoryService.addSessionMemory({
					projectName,
					executionId,
					issueId: hydrated.issueId,
					issueTitle: hydrated.issueTitle,
					sessionResult,
					commitMessages: evidence.commitMessages,
					diffSummary: evidence.diffSummary ?? "",
					decisionRoute: decision?.route,
					error: result.timedOut
						? "timeout"
						: (!decision && evidence.commitCount === 0)
							? "no commits produced"
							: undefined,
					decisionReasoning: decision
						? [decision.reasoning, ...decision.concerns.map((c: string) => `concern: ${c}`)].join("; ")
						: undefined,
				}),
				MEMORY_TIMEOUT_MS,
				"Memory extraction",
			);
			console.log(
				`[Blueprint] Memory stored: +${memResult.added} added, ~${memResult.updated} updated`,
			);
		} catch (err) {
			console.warn(
				`[Blueprint] Memory extraction failed (non-fatal): ${err instanceof Error ? err.stack : String(err)}`,
			);
		}
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
 * Safely read an agent/domain file relative to the repo root.
 * Returns null if file doesn't exist or path escapes the repo.
 */
async function readAgentFile(repoRoot: string, relativePath: string): Promise<string | null> {
	// Path safety: reject absolute or parent-escaping paths
	if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
		console.warn(`[Blueprint] Unsafe agent path rejected: ${relativePath}`);
		return null;
	}

	const resolved = path.resolve(repoRoot, relativePath);

	// Containment check (resolve-based, no realpath dependency)
	const normalizedRoot = path.resolve(repoRoot);
	if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
		console.warn(`[Blueprint] Agent path escapes repo: ${relativePath}`);
		return null;
	}

	try {
		// Symlink containment: verify real path before reading content
		const realResolved = await fs.promises.realpath(resolved);
		const realRoot = await fs.promises.realpath(repoRoot);
		if (!realResolved.startsWith(realRoot + path.sep)) {
			console.warn(`[Blueprint] Agent file symlinks outside repo: ${relativePath}`);
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
				(err, stdout) => (err ? reject(err) : resolve(path.resolve(cwd, stdout.trim()))),
			);
		});
	} catch (err) {
		console.warn(`[Blueprint] ensureFlywheelRunsExclude skipped: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const infoDir = path.dirname(excludeFile);
	await fs.promises.mkdir(infoDir, { recursive: true });

	let content = "";
	try {
		content = await fs.promises.readFile(excludeFile, "utf-8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[Blueprint] Failed to read ${excludeFile}: ${err instanceof Error ? err.message : String(err)}`);
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
