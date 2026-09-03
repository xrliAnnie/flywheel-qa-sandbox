/**
 * FLY-22/FLY-50: Run infrastructure setup — creates per-project Blueprint + RunDispatcher.
 *
 * This is the single source of truth for production run/retry infrastructure.
 * Previously duplicated in scripts/lib/retry-runtime.ts (deleted in FLY-50).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AnthropicLLMClient,
	AntigravityTmuxAdapter,
	CodexExecutionOwnershipRegistry,
	type CodexRecoveryCommitHooks,
	CodexTmuxAdapter,
	type CodexTransportCloseEvidence,
	KimiTmuxAdapter,
	type RunnerTuiWindowLostEvidence,
	scrubOrphanedCodexHomes,
	TmuxAdapter,
} from "flywheel-claude-runner";
import {
	type AgentConfig,
	agentConfigsRequireRegistry,
	type CheckpointsConfig,
	ConfigLoader,
	type DocFlowConfig,
	loadBundledRegistry,
	type PonytailConfig,
	type RoleBackendMap,
	resolveAgentConfigs,
	resolveProjectRegistry,
	type SkillsConfig,
} from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	LLMClient,
} from "flywheel-core";
import { AdapterRegistry, sanitizeTmuxName } from "flywheel-core";
import {
	AgentDispatcher,
	AuditLogger,
	CipherReader,
	DecisionLayer,
	defaultRules,
	deriveWorktreeKey,
	ExecutionEvidenceCollector,
	FallbackHeuristic,
	GitResultChecker,
	HaikuTriageAgent,
	HaikuVerifier,
	HardRuleEngine,
	HookCallbackServer,
	resolveWorktreeKey,
	SkillInjector,
	WorktreeManager,
} from "flywheel-edge-worker";
import {
	Blueprint,
	type BlueprintResult,
} from "flywheel-edge-worker/dist/Blueprint.js";
import { PreHydrator } from "flywheel-edge-worker/dist/PreHydrator.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	isStateStoreIrreversibleTerminalForZombie,
	type Session,
	type StateStore,
} from "../StateStore.js";
import type { AdmissionCrossingBarrier } from "./admission-crossing-barrier.js";
import { ChatThreadCreator } from "./ChatThreadCreator.js";
import type { CodexReviewHoldCoordinator } from "./codex-review-hold.js";
import { ContinuityAudit } from "./continuity-audit.js";
import {
	lookupOpenPullRequests,
	materializeRemoteBranch,
	type OpenPullRequest,
} from "./continuity-preflight.js";
import { EventFilter } from "./EventFilter.js";
import { withExecutionMutationLease } from "./execution-mutation-lease.js";
import {
	type FlagStoreRuntime,
	storeDocFlowEnabled,
	storePonytailEnabled,
	storeProofshotEnabled,
	storeSkillFrameworkModeControl,
	storeSkillFrameworkSplitParticipation,
} from "./flag-store-runtime.js";
import type { IssueDisplayRefreshHolder } from "./issue-display-refresher.js";
import { LaunchClaimStore } from "./launch-claim-store.js";
import type { MaterializedHeadAuthority } from "./materialized-head-authority.js";
import {
	parsePaneLossGenerationParams,
	persistPaneLossGenerationCredential,
} from "./pane-loss-reconcile.js";
import type { LifecycleShipInfra } from "./post-ship-finalization.js";
import {
	computeProgressResume,
	type ProgressResumeDeps,
	type ProgressResumeInfo,
} from "./progress-resume.js";
import type { ReviewAuthorizationAlerts } from "./review-authorization-alerts.js";
import {
	type ContinuityComputer,
	type DoaBackoffAdmissionFn,
	type FreshStartAuditRecorder,
	type LifecycleAdmissionFn,
	type LifecycleLaunchGuard,
	type PhaseRetryStartPoint,
	type PhaseRetryStartPointComputer,
	type ProjectRuntime,
	type ResumeComputer,
	RunDispatcher,
} from "./run-dispatcher.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import type { TerminalCommDbSync } from "./terminal-commdb-sync.js";
import type { TerminalArchiveAdmission } from "./terminal-thread-archive.js";
import type { TurnBeltReconciler } from "./turn-belt-reconcile.js";
import type { BridgeConfig } from "./types.js";
import { grantPrelaunchWorkflowTurn } from "./workflow-turn-bundle.js";
import type { WorktreeCleanupFn } from "./worktree-cleanup.js";
import { reconcileProjectWorktrees } from "./worktree-reconciler.js";

export interface CodexRecoveryRuntime {
	resume(
		context: AdapterExecutionContext,
		hooks: CodexRecoveryCommitHooks,
	): Promise<AdapterExecutionResult>;
	failExhausted(session: Session, attempts: number): Promise<void>;
}

type CodexRecoveryRuntimeInput = {
	adapter: Pick<CodexTmuxAdapter, "resumeExistingExecution">;
	sink: Pick<DirectEventSink, "emitCompleted" | "emitFailed">;
};

export function createCodexRecoveryRuntime(
	input: CodexRecoveryRuntimeInput,
): CodexRecoveryRuntime {
	return {
		resume: (context, hooks) =>
			runCodexRecoveryOwner({
				adapter: input.adapter,
				sink: input.sink,
				context,
				hooks,
			}),
		failExhausted: async (session, attempts) => {
			const reason = `Codex recovery exhausted after ${attempts} attempts`;
			await input.sink.emitFailed(
				{
					executionId: session.execution_id,
					issueId: session.issue_id,
					projectName: session.project_name,
					issueIdentifier: session.issue_identifier ?? session.issue_id,
					...(session.session_role
						? {
								sessionRole: session.session_role,
								chatThreadRole:
									session.chat_thread_role ?? session.session_role,
							}
						: {}),
					runnerBackend: "codex-tmux",
					...(session.runner_model
						? { runnerModel: session.runner_model }
						: {}),
					...(session.skill_framework_mode
						? { skillFrameworkMode: session.skill_framework_mode }
						: {}),
				},
				reason,
				undefined,
				{ failureKind: "reown_exhausted", failureReason: reason },
			);
		},
	};
}

/**
 * Run one rescue owner through the same DirectEventSink terminal path as a
 * first-dispatch Blueprint. A pre-commit recovery failure is deliberately not
 * terminal: the StateStore episode budget owns the retry decision.
 */
export async function runCodexRecoveryOwner(input: {
	adapter: Pick<CodexTmuxAdapter, "resumeExistingExecution">;
	sink: Pick<DirectEventSink, "emitCompleted" | "emitFailed">;
	context: AdapterExecutionContext;
	hooks: CodexRecoveryCommitHooks;
}): Promise<AdapterExecutionResult> {
	let committed = false;
	const result = await input.adapter.resumeExistingExecution(input.context, {
		onRecoveryOwnershipEstablished: async (receipt) => {
			await input.hooks.onRecoveryOwnershipEstablished(receipt);
			committed = true;
		},
	});
	if (!committed) return result;
	const env = {
		executionId: input.context.executionId,
		issueId: input.context.issueId,
		projectName: input.context.projectName ?? "",
		issueIdentifier: input.context.issueId,
		...(input.context.phaseKeepAlive?.role
			? {
					sessionRole: input.context.phaseKeepAlive.role,
					chatThreadRole: input.context.phaseKeepAlive.role,
				}
			: {}),
		runnerBackend: "codex-tmux",
		...(input.context.model ? { runnerModel: input.context.model } : {}),
		...(input.context.skillFrameworkMode
			? { skillFrameworkMode: input.context.skillFrameworkMode }
			: {}),
	};
	if (result.success) {
		const blueprintResult: BlueprintResult = {
			success: true,
			sessionId: result.sessionId,
			durationMs: result.durationMs,
			tmuxWindow: result.tmuxWindow,
			sessionParams: result.sessionParams,
		};
		await input.sink.emitCompleted(env, blueprintResult, undefined);
	} else {
		await input.sink.emitFailed(
			env,
			result.resultText ?? "Codex recovery owner failed after commit",
			undefined,
			result.failure,
		);
	}
	return result;
}

/** FLY-1718: compute one resume snapshot from one Git ref at a time. */
export function computeProgressResumeAcrossRefs(input: {
	issueId: string;
	role: string;
	docBaseDir: string;
	issueIdentifier: string;
	branch: string;
	refs: string[];
	prior: {
		execution_id: string;
		plan_path?: string;
		session_stage?: string;
	};
	git: (args: string[]) => string | null;
}): ProgressResumeInfo | null {
	for (const ref of input.refs) {
		const tip = input.git(["rev-parse", `${ref}^{commit}`])?.trim();
		if (!tip) continue;
		const deps: ProgressResumeDeps = {
			docBaseDir: input.docBaseDir,
			issueIdentifier: input.issueIdentifier,
			branchName: () => input.branch,
			priorSession: () => input.prior,
			readBranchFile: (_branch, path) => input.git(["show", `${ref}:${path}`]),
			branchTip: () => tip,
			discoverDocDir: () => {
				const out = input.git(["ls-tree", "-r", "--name-only", ref]);
				if (!out) return null;
				const prefix = `${input.docBaseDir}/${input.issueIdentifier}-`;
				const hit = out
					.split("\n")
					.find(
						(path) => path.startsWith(prefix) && path.endsWith("/progress.md"),
					);
				return hit ? hit.slice(0, hit.length - "/progress.md".length) : null;
			},
		};
		const resume = computeProgressResume(
			input.issueId,
			input.role,
			"restart",
			deps,
		);
		if (resume) return resume;
	}
	return null;
}

export function liveCodexHomeExecutionIds(
	store: Pick<StateStore, "getActiveSessions">,
): Set<string> {
	return new Set(
		store
			.getActiveSessions()
			.filter(
				(session) =>
					session.status === "running" ||
					session.status === "ship_parked" ||
					session.status === "awaiting_review",
			)
			.map((session) => session.execution_id),
	);
}

/**
 * FLY-1257 M3: inspect one fully-qualified local branch ref with a
 * machine-readable three-state exit contract. Exit 1 from `--verify --quiet`
 * is the only confirmed-missing result; every other failure is indeterminate.
 */
export function probePhaseRetryBranchTip(
	projectRoot: string,
	branch: string,
): PhaseRetryStartPoint {
	try {
		const stdout = execFileSync(
			"git",
			[
				"-C",
				projectRoot,
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/heads/${branch}^{commit}`,
			],
			{
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 20_000,
			},
		).trim();
		if (!stdout) {
			return {
				kind: "indeterminate",
				error: `git rev-parse returned an empty sha for refs/heads/${branch}`,
			};
		}
		return { kind: "found", sha: stdout };
	} catch (error) {
		const failure = error as {
			status?: unknown;
			signal?: unknown;
			message?: unknown;
			stderr?: unknown;
		};
		if (failure.status === 1) return { kind: "missing" };
		const detail = [
			`exit=${String(failure.status ?? "spawn-error")}`,
			failure.signal ? `signal=${String(failure.signal)}` : "",
			failure.message ? String(failure.message) : "",
		]
			.filter(Boolean)
			.join(" ");
		return { kind: "indeterminate", error: detail };
	}
}

/**
 * Build a fetchIssue function that tries Linear API, falls back to StateStore.
 *
 * Exported for unit testing (FLY-137 wire-up fix Bug 2 regression coverage).
 */
export function createFetchIssue(store: StateStore) {
	return async (id: string) => {
		const apiKey = process.env.LINEAR_API_KEY;
		if (apiKey) {
			try {
				const { LinearClient } = await import("@linear/sdk");
				// FLY-137 wire-up fix: LINEAR_API_KEY is a personal API key, not an
				// OAuth access token. Passing it as `accessToken` causes the SDK to
				// prefix it with `Bearer ` and Linear rejects with "It looks like
				// you're trying to use an API key as a Bearer token." The
				// surrounding catch swallowed that error, so every PreHydrator call
				// silently returned no labels → session.issue_labels stored as "[]"
				// → AgentDispatcher / dept-scope / event-route stage routing all
				// degraded. `runs-route.ts` uses `apiKey` correctly; aligning here.
				const client = new LinearClient({ apiKey });
				const issue = await client.issue(id);
				if (issue) {
					const labels = await issue.labels();
					const labelNames = labels.nodes.map((l) => l.name);
					return {
						title: issue.title,
						description: issue.description ?? "",
						descriptionSource: "authoritative" as const,
						updatedAt: issue.updatedAt.toISOString(),
						labels: labelNames,
						projectId: issue.project ? (await issue.project)?.id : undefined,
						identifier: issue.identifier,
					};
				}
			} catch (err) {
				// FLY-137 wire-up fix: log the real error so future regressions are
				// visible (previously this catch was silent — concealed the
				// accessToken→apiKey misconfiguration for months).
				console.warn(
					`[RunInfra] Linear fetchIssue(${id}) failed — falling back to StateStore: ${(err as Error).message}`,
				);
			}
		}

		if (!apiKey) {
			console.warn(
				"[RunInfra] LINEAR_API_KEY not set — run will lack labels/projectId",
			);
		}
		const session = store.getSessionByIssue(id);
		return {
			title: session?.issue_title ?? `Issue ${id}`,
			description: session?.summary ?? `Execution for issue ${id}`,
			descriptionSource: "fallback" as const,
			identifier: session?.issue_identifier ?? id,
		};
	};
}

/**
 * FLY-137 v1.27.2: resolve the Flywheel repo root canonically (single source of truth
 * across all Bridge entrypoints — `scripts/run-bridge.ts`, `packages/teamlead/src/index.ts`).
 * Order: caller-supplied option → `FLYWHEEL_REPO_ROOT` env → `import.meta.url`-derived path.
 * Validates the resolved root contains the bundled agent registry.
 */
function resolveFlywheelRepoRoot(explicit?: string): string {
	const candidate =
		explicit?.trim() ||
		process.env.FLYWHEEL_REPO_ROOT?.trim() ||
		(() => {
			// __filename of this module → walk up to the repo root. Module sits at:
			//   <repo>/packages/teamlead/dist/bridge/run-infra.js (built)
			//   <repo>/packages/teamlead/src/bridge/run-infra.ts  (dev)
			// In either case 4 levels up = the repo root.
			const here = dirname(fileURLToPath(import.meta.url));
			return resolve(here, "..", "..", "..", "..");
		})();
	const sentinel = join(candidate, ".flywheel", "agents", "registry.yaml");
	if (!existsSync(sentinel)) {
		console.warn(
			`[RunInfra] FLYWHEEL_REPO_ROOT resolved to "${candidate}" but expected sentinel "${sentinel}" not found. ` +
				`Agent registry resolution will fail. ` +
				`Set FLYWHEEL_REPO_ROOT to the root that contains .flywheel/agents/registry.yaml.`,
		);
	} else {
		console.log(
			`[RunInfra] FLYWHEEL_REPO_ROOT resolved to "${candidate}" (sentinel found).`,
		);
	}
	return candidate;
}

/** Create a Blueprint for running issues. CIPHER principles loaded; AgentDispatcher wired (FLY-137 v1.27.2). */
async function createRunBlueprint(
	tmuxSessionName: string,
	fetchIssue: ReturnType<typeof createFetchIssue>,
	eventEmitter: DirectEventSink,
	sessionTimeoutMs: number = 86_400_000, // 24h safety net (FLY-97; FLY-92 idle detection retired in FLY-1560)
	checkpointConfig?: CheckpointsConfig, // FLY-47
	worktreeManager?: WorktreeManager, // FLY-95
	agentDispatcher?: AgentDispatcher, // FLY-137 v1.27.2
	flywheelRepoRoot?: string, // FLY-137 v1.27.2 (Codex Track A #1): Blueprint needs this to resolve shipped-generic agent_file
	skillsConfig?: SkillsConfig, // GEO-151: ProofShot + skill commands surfaced to Blueprint
	docFlowDept?: Pick<DocFlowConfig, "default_department">, // FLY-205/2103: non-flag doc-flow path metadata
	ponytailProjectLayer?: () => PonytailConfig | undefined, // FLY-615/2103: call-time per-project rollout layer
	ownerStateDbPath?: string, // FLY-766: this Bridge's actual StateStore db path → claude-tmux owner marker
	skillFrameworkParticipation?: (projectName: string | undefined) => boolean, // FLY-1356: fresh per-dispatch split-participation read (project opt-out lever)
	skillFrameworkModeControl?: () => {
		hasOverride: boolean;
		raw: string | null;
	}, // FLY-1778: call-time SQLite raw control; Blueprint keeps issue-aware resolution
	onTuiWindowLost?: (
		evidence: RunnerTuiWindowLostEvidence,
	) => void | Promise<void>,
	onTuiWindowRestored?: (executionId: string) => void | Promise<void>,
	onCodexTransportClose?: (
		evidence: CodexTransportCloseEvidence,
	) => void | Promise<void>,
	docFlowEnabled?: () => boolean,
	codexExecutionOwners?: CodexExecutionOwnershipRegistry,
): Promise<{
	blueprint: Blueprint;
	cleanup: () => Promise<void>;
	codexRecoveryRuntime: CodexRecoveryRuntime;
}> {
	// Track resources for cleanup-on-error (mirrored from setup.ts)
	let hookServer: InstanceType<typeof HookCallbackServer> | undefined;
	let auditLogger: InstanceType<typeof AuditLogger> | undefined;

	try {
		hookServer = new HookCallbackServer(0);
		await hookServer.start();

		const flywheelDir = join(homedir(), ".flywheel");
		mkdirSync(flywheelDir, { recursive: true });

		auditLogger = new AuditLogger(join(flywheelDir, "audit.db"));
		await auditLogger.init();

		const execFn = async (cmd: string, args: string[], cwd: string) => {
			const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
			return { stdout: result };
		};

		const evidenceCollector = new ExecutionEvidenceCollector(execFn);
		const skillInjector = new SkillInjector();

		// DecisionLayer — with or without LLM
		const hardRules = new HardRuleEngine(defaultRules());
		const fallback = new FallbackHeuristic();
		let triage: HaikuTriageAgent;
		let verifier: HaikuVerifier;
		if (process.env.ANTHROPIC_API_KEY) {
			const llmClient = new AnthropicLLMClient();
			triage = new HaikuTriageAgent(
				llmClient,
				"claude-haiku-4-5-20251001",
				2000,
			);
			verifier = new HaikuVerifier(llmClient, "claude-haiku-4-5-20251001");
		} else {
			const noLlm: LLMClient = {
				chat: () => {
					throw new Error("No ANTHROPIC_API_KEY");
				},
			};
			triage = new HaikuTriageAgent(noLlm, "", 0);
			verifier = new HaikuVerifier(noLlm, "");
		}

		// CIPHER: read-only principles for DecisionLayer integration
		const cipherDbPath = join(flywheelDir, "cipher.db");
		const cipherReader = new CipherReader(cipherDbPath);

		const decisionLayer = new DecisionLayer(
			hardRules,
			triage,
			verifier,
			fallback,
			auditLogger,
			evidenceCollector,
			cipherReader,
		);

		// CIPHER: register active principles as HardRules
		try {
			const principles = await cipherReader.loadActivePrinciples();
			for (const p of principles) {
				const constraints = parseCipherConstraints(p.sourcePattern);

				hardRules.registerRule({
					id: p.id,
					description: p.description,
					priority: p.priority,
					evaluate: (ctx) => {
						const noMatch = {
							triggered: false,
							action: p.ruleType,
							reason: "",
							ruleId: p.id,
						};
						// No constraints → don't fire (safety: never make a principle global)
						if (constraints.length === 0) return noMatch;

						const derived = deriveDimensions(ctx);
						for (const c of constraints) {
							if (!matchesDimension(c, ctx, derived)) return noMatch;
						}
						return {
							triggered: true,
							action: p.ruleType,
							reason: `CIPHER principle: ${p.description} (source: ${p.sourcePattern})`,
							ruleId: p.id,
						};
					},
				});
			}
			if (principles.length > 0) {
				console.log(
					`[RunInfra] CIPHER: ${principles.length} active principle(s) registered as HardRules`,
				);
			}
		} catch {
			console.log(
				"[RunInfra] CIPHER: no principles loaded (db may not exist yet)",
			);
		}

		const hydrator = new PreHydrator(fetchIssue);
		const gitChecker = new GitResultChecker(execFn);
		// FLY-142 PR 1.4 — Wire transport into Runner spawn when mailbox
		// backend is active. Without this, `TmuxAdapter.tryBuildTransportSpawnConfig`
		// short-circuits (no transport ref) and Runner spawns WITHOUT
		// `--agent-id` / `--team-name` flags → claude-code never enters
		// Agent Team mode → `useInboxPoller` never starts → mailbox writes
		// silently land in a file no one reads. QA E1 verify caught this
		// after Bug #1+#2+#3 were fixed (2026-05-12).
		//
		// Transport instantiation throws loudly on Codex backend or env
		// misconfig — same bar as `createLeadRuntime` preflight gate.
		// CommDB rollback path stays untouched (transport undefined).
		//
		// FLY-142 PR #186 Codex Round 1 MEDIUM: share `resolveCommBackend`
		// with plugin.ts so unknown/typo'd `FLYWHEEL_COMM_BACKEND` values
		// fall back to mailbox consistently with Bridge runtime selection.
		// Previously a typo silently stripped transport here while plugin.ts
		// kept selecting the mailbox runtime → Bridge wrote mailbox but
		// Runner spawn had no Agent Team identity (wake bug returned).
		const { resolveCommBackend } = await import("./plugin.js");
		const commBackend = resolveCommBackend();
		let transport:
			| import("flywheel-agent-team-transport").IAgentTeamTransport
			| undefined;
		let codexTransport:
			| import("flywheel-agent-team-transport").IAgentTeamTransport
			| undefined;
		if (commBackend === "mailbox") {
			const { AgentTeamTransportFactory } = await import(
				"flywheel-agent-team-transport"
			);
			transport = AgentTeamTransportFactory.fromEnv();
			// FLY-123 (R4 #1): the Codex executor needs the CODEX transport for
			// its mailbox watcher — explicit forBackend, never the env-selected
			// transport above (which is claude-code in Phase 1 production).
			codexTransport = AgentTeamTransportFactory.forBackend("codex");
		}
		// FLY-123 (R1 #6): AdapterRegistry with FACTORY registrations replaces
		// the name-ignoring makeAdapter closure. Factories preserve the
		// per-execution-fresh instance semantics the closure had — singleton
		// instances would share preflightDone/watcher state across concurrent
		// Runners. 6th positional arg is the FLY-142 transport (positions 2-5:
		// execFileFn/pollIntervalMs/defaultTimeoutMs/hookServer).
		const adapterRegistry = new AdapterRegistry();
		adapterRegistry.registerFactory(
			"claude-tmux",
			() =>
				new TmuxAdapter(
					tmuxSessionName,
					undefined,
					5000,
					sessionTimeoutMs,
					hookServer,
					transport,
					ownerStateDbPath, // FLY-766: threaded to the per-runner owner marker
				),
		);
		adapterRegistry.registerFactory(
			"codex-tmux",
			() =>
				new CodexTmuxAdapter(
					tmuxSessionName,
					undefined,
					5000,
					sessionTimeoutMs,
					hookServer,
					// Structural seam (same pattern as TmuxAdapter's
					// RunnerSpawnTransport): claude-runner declares a minimal
					// CodexRunnerTransport shape to avoid importing the transport
					// package; IAgentTeamTransport satisfies it at runtime but the
					// mailbox-message param variance needs the assert.
					codexTransport as unknown as import("flywheel-claude-runner").CodexRunnerTransport,
					{
						executionOwners: codexExecutionOwners,
						...(onTuiWindowLost ? { onTuiWindowLost } : {}),
						...(onTuiWindowRestored ? { onTuiWindowRestored } : {}),
						...(onCodexTransportClose
							? { onTransportClose: onCodexTransportClose }
							: {}),
					},
				),
		);
		// FLY-493: Antigravity (`agy`) executor backend — v1 transport=none, so
		// NO transport arg (agy has no claude-code Agent Team mailbox). The
		// vendor-neutral completion/timeout/comm.db machinery is inherited from
		// TmuxAdapter; only the agy binary + args + fail-closed auth preflight
		// differ. A no-transport runner finishes at `pr_handoff` (build+PR).
		adapterRegistry.registerFactory(
			"antigravity-tmux",
			() =>
				new AntigravityTmuxAdapter(
					tmuxSessionName,
					undefined,
					5000,
					sessionTimeoutMs,
					hookServer,
				),
		);
		// FLY-494: Kimi Code (`kimi`) executor backend — v1 transport=none, so
		// NO transport arg (kimi has no claude-code Agent Team mailbox). Same
		// vendor-neutral completion/timeout/comm.db machinery inherited from
		// TmuxAdapter; only the kimi binary + args + fail-closed auth preflight
		// differ. A no-transport runner finishes at `pr_handoff` (build+PR).
		adapterRegistry.registerFactory(
			"kimi-tmux",
			() =>
				new KimiTmuxAdapter(
					tmuxSessionName,
					undefined,
					5000,
					sessionTimeoutMs,
					hookServer,
				),
		);
		adapterRegistry.setDefault("claude-tmux");
		const makeAdapter = (name: string) => adapterRegistry.get(name);
		const shell = {
			execFile: async (cmd: string, args: string[], cwd: string) => {
				try {
					const stdout = execFileSync(cmd, args, {
						cwd,
						encoding: "utf-8",
					});
					return { stdout, exitCode: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; status?: number };
					return { stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
				}
			},
		};

		const blueprint = new Blueprint(
			hydrator,
			gitChecker,
			makeAdapter,
			shell,
			worktreeManager, // FLY-95: per-Runner worktree isolation
			skillInjector,
			evidenceCollector,
			skillsConfig, // GEO-151: wired through from project .flywheel/config.yaml
			decisionLayer,
			eventEmitter,
			agentDispatcher, // FLY-137 v1.27.2: wired (was undefined pre-v1.27.2)
			checkpointConfig, // FLY-47
			flywheelRepoRoot, // FLY-137 v1.27.2: Blueprint resolves shipped-generic agent_file from this root
			docFlowDept, // FLY-205/2103
			ponytailProjectLayer, // FLY-615/2103: per-project rollout reader
			undefined, // ponytailReadiness — use Blueprint's default probe
			skillFrameworkParticipation, // FLY-1356: split-participation reader
			undefined, // skillFrameworkReadiness — use Blueprint default
			undefined, // codexSkillAssemblyProbe — use Blueprint default
			skillFrameworkModeControl,
			docFlowEnabled,
		);

		const cleanup = async () => {
			await hookServer!.stop();
			await auditLogger!.close();
		};
		const codexRecoveryRuntime = createCodexRecoveryRuntime({
			adapter: adapterRegistry.get("codex-tmux") as CodexTmuxAdapter,
			sink: eventEmitter,
		});

		return { blueprint, cleanup, codexRecoveryRuntime };
	} catch (err) {
		// Cleanup partially initialized resources on setup failure
		if (auditLogger) {
			try {
				await auditLogger.close();
			} catch {
				/* best-effort */
			}
		}
		if (hookServer) {
			try {
				await hookServer.stop();
			} catch {
				/* best-effort */
			}
		}
		throw err;
	}
}

/**
 * Set up per-project Blueprint runtimes and return a RunDispatcher.
 *
 * Called by startBridge when no external startDispatcher is provided.
 */
/** FLY-91 Round 3 + FLY-137 v1.27.2: Optional external dependencies for run infrastructure. */
export interface RunInfraOptions {
	/** FLY-1778: boot-snapshotted authority; values remain read-on-use. */
	flagStore?: FlagStoreRuntime;
	/** FLY-2211 owner truth shared with the boot/periodic re-own reconciler. */
	codexExecutionOwners?: CodexExecutionOwnershipRegistry;
	/** Filled during setup so Bridge recovery can reuse each project's runtime. */
	codexRecoveryRuntimes?: Map<string, CodexRecoveryRuntime>;
	/** Shared ChatThreadCreator — if provided, used instead of per-project creation. */
	chatThreadCreator?: ChatThreadCreator;
	/** Founder-visible existing alert path for a ConfigLoader-rejected project. */
	onProjectConfigInvalid?: (input: {
		projectName: string;
		configPath: string;
		error: Error;
	}) => void | Promise<void>;
	/** FLY-1718: shared structural repo lock used by fetch + worktree mutation. */
	withRepoLock?: <T>(repoPath: string, fn: () => Promise<T>) => Promise<T>;
	/**
	 * FLY-137 v1.27.2: optional explicit Flywheel repo root. If unset, falls back to
	 * `FLYWHEEL_REPO_ROOT` env var, then to a module-location-derived path. Used by
	 * registry loaders to resolve bundled node implementations.
	 */
	flywheelRepoRoot?: string;
	/**
	 * FLY-603 Layer A: worktree-cleanup closure from the Bridge composition
	 * root, set on the DirectEventSink so its post-ship finalization can clean.
	 */
	removeCleanWorktree?: WorktreeCleanupFn;
	codexReviewHold?: { current: CodexReviewHoldCoordinator | undefined };
	reviewAuthorizationAlerts?: {
		current: ReviewAuthorizationAlerts | undefined;
	};
	turnBeltReconciler?: { current: TurnBeltReconciler | undefined };
	/**
	 * FLY-887: ship-time DAG workflow finalizer (closes parked design +
	 * implement sessions before the shared worktree is removed). Built at the
	 * composition root with store + transitionOpts; wired onto the DirectEventSink.
	 */
	finalizeWorkflowPhaseRoles?: (
		issueId: string,
		projectName: string,
	) => Promise<void>;
	/**
	 * FLY-907: late-bound unified issue-display refresh holder, set on the
	 * DirectEventSink (its upsertSession status writes bypass the applyTransition
	 * hook, so the sink triggers refreshes itself). Absent → byte-compatible.
	 */
	issueDisplayRefresh?: IssueDisplayRefreshHolder;
	/** FLY-1066: shared non-blocking failed/blocked CommDB sync queue. */
	terminalCommDbSync?: Pick<TerminalCommDbSync, "enqueue">;
	/**
	 * FLY-1185: the ship-entry lifecycle bundle (remote branch CAS + issue
	 * closeout + trailing sweep), set on the DirectEventSink so the in-process
	 * ship path drives the SAME entry-A items as the HTTP paths. Absent →
	 * classic finalization only (byte-compat).
	 */
	lifecycleInfra?: LifecycleShipInfra;
	/**
	 * FLY-1282 Part C: targeted terminal-archive enqueue (pre-binding buffer →
	 * FLY-1165 scheduler consumer), set on the DirectEventSink completion path.
	 * Production always passes it; optionality is retained for embedding/tests.
	 */
	terminalArchiveEnqueue?: (issueId: string) => TerminalArchiveAdmission;
	/** FLY-1307 PR-7.5: trusted receipt-backed head for output-backed reviews. */
	materializedHeadAuthority?: MaterializedHeadAuthority;
	/**
	 * FLY-1185 (R11#1): lifecycle spawn admission (founder-park tombstone +
	 * durable starting claim), threaded to the RunDispatcher chokepoint.
	 * Absent → legacy admission only (byte-compat).
	 */
	lifecycleAdmission?: LifecycleAdmissionFn;
	/**
	 * FLY-1185 (Codex R1#5): the dispatcher-side park-vs-start arbitration —
	 * last pre-launch recheck + launch-claim CAS hooks. Absent → byte-compat.
	 */
	lifecycleLaunchGuard?: LifecycleLaunchGuard;
	/** FLY-1718 P4: canonical predecessor admission before branch continuity. */
	doaBackoffAdmission?: DoaBackoffAdmissionFn;
	/** FLY-1944: typed terminal runner-window visibility evidence. */
	onTuiWindowLost?: (
		evidence: RunnerTuiWindowLostEvidence,
	) => void | Promise<void>;
	onTuiWindowRestored?: (executionId: string) => void | Promise<void>;
	onCodexTransportClose?: (
		evidence: CodexTransportCloseEvidence,
	) => void | Promise<void>;
	/** FLY-1944: process-local pre-claim quiescence evidence. */
	admissionCrossingBarrier?: AdmissionCrossingBarrier;
}

export function resolveWorkflowTmuxWindowAuthority(
	store: Pick<
		StateStore,
		| "getSession"
		| "getWorkflowExecutionBinding"
		| "getWorkflowLaunchOwner"
		| "getWorkflowNodeCompletion"
	>,
	launchExecutionId: string,
	candidate: {
		windowId: string;
		windowName: string;
		executionId?: string;
		launchGeneration?: number;
		launchFingerprint?: string;
	},
): "prune" | "keep" {
	if (!candidate.executionId) return "keep";
	if (candidate.executionId === launchExecutionId) {
		if (
			candidate.launchGeneration === undefined ||
			!candidate.launchFingerprint
		) {
			return "keep";
		}
		const persisted = parsePaneLossGenerationParams(
			store.getSession(launchExecutionId)?.session_params,
		);
		if (
			persisted?.window_id !== candidate.windowId ||
			persisted.execution_id !== launchExecutionId ||
			persisted.launch_generation !== candidate.launchGeneration ||
			persisted.launch_fingerprint !== candidate.launchFingerprint
		) {
			return "keep";
		}
		const owner = store.getWorkflowLaunchOwner(launchExecutionId);
		return (owner?.released_generation ?? 0) >= candidate.launchGeneration
			? "prune"
			: "keep";
	}
	const session = store.getSession(candidate.executionId);
	if (!isStateStoreIrreversibleTerminalForZombie(session?.status)) {
		return "keep";
	}
	if (session?.status !== "completed") return "prune";
	const binding = store.getWorkflowExecutionBinding(candidate.executionId);
	if (!binding) return "prune";
	const completion = store.getWorkflowNodeCompletion(
		binding.run_id,
		binding.node_id,
		binding.attempt,
	);
	return completion?.execution_id === candidate.executionId ? "prune" : "keep";
}

/**
 * Single production constructor call for RunDispatcher. Keeping the positional
 * wiring here makes the hot runtime + always-available admission capability
 * directly testable without booting external adapters.
 */
export function createRunInfraDispatcher(input: {
	store: StateStore;
	projectRuntimes: Map<string, ProjectRuntime>;
	cleanupHandles: Array<() => Promise<void>>;
	runnerAdmission?: BridgeConfig["runnerAdmission"];
	launchClaims?: LaunchClaimStore;
	resumeComputer?: ResumeComputer;
	lifecycleAdmission?: LifecycleAdmissionFn;
	lifecycleLaunchGuard?: LifecycleLaunchGuard;
	doaBackoffAdmission?: DoaBackoffAdmissionFn;
	phaseRetryStartPointComputer?: PhaseRetryStartPointComputer;
	continuityComputer?: ContinuityComputer;
	freshStartAudit?: FreshStartAuditRecorder;
	admissionCrossingBarrier?: AdmissionCrossingBarrier;
	flagStore?: FlagStoreRuntime;
	/** Test-only subclass seam for suppressing external CommDB registration. */
	dispatcherClass?: typeof RunDispatcher;
}): RunDispatcher {
	const Dispatcher = input.dispatcherClass ?? RunDispatcher;
	const flagStore = input.flagStore;
	return new Dispatcher(
		input.projectRuntimes,
		input.cleanupHandles,
		input.runnerAdmission,
		input.launchClaims,
		undefined,
		input.resumeComputer,
		input.lifecycleAdmission,
		input.lifecycleLaunchGuard,
		input.phaseRetryStartPointComputer,
		// FLY-1356 (R1#4): sticky-stamp lookup — same issue keeps its arm.
		(issueId) => input.store.getSkillFrameworkStamp(issueId),
		(executionId, info) =>
			persistPaneLossGenerationCredential(input.store, executionId, info),
		(launchExecutionId, candidate) =>
			resolveWorkflowTmuxWindowAuthority(
				input.store,
				launchExecutionId,
				candidate,
			),
		input.continuityComputer,
		input.freshStartAudit,
		input.doaBackoffAdmission,
		(executionId) =>
			isStateStoreIrreversibleTerminalForZombie(
				input.store.getSession(executionId)?.status,
			),
		input.admissionCrossingBarrier,
		flagStore ? () => storeSkillFrameworkModeControl(flagStore) : undefined,
		(turnInput) => {
			const priorHolder = turnInput.db.getTurn(
				turnInput.issueId,
			)?.holder_exec_id;
			return withExecutionMutationLease({
				store: input.store,
				executionId: priorHolder,
				holder: `turn-writer:spawn:${turnInput.executionId}`,
				mutate: () => grantPrelaunchWorkflowTurn(turnInput),
			});
		},
	);
}

/** FLY-1718 P1: production branch-key authority + remote materializer wiring. */
export function createBranchContinuityComputer(input: {
	projectRuntimes: Map<string, ProjectRuntime>;
	worktreeManager: WorktreeManager;
	materialize: (args: {
		repoPath: string;
		branch: string;
	}) => Promise<
		| { kind: "exists"; sha: string }
		| { kind: "missing" }
		| { kind: "indeterminate"; error: string }
	>;
	lookupOpenPrs: (args: {
		repoPath: string;
		branch: string;
	}) => Promise<OpenPullRequest[]>;
	log?: (message: string) => void;
}): ContinuityComputer {
	return async ({ issueId, role, projectName, shareParentBranch }) => {
		const runtime = input.projectRuntimes.get(projectName);
		if (!runtime) {
			return {
				kind: "indeterminate",
				error: `project runtime ${projectName} is unavailable`,
			};
		}
		try {
			// Blueprint receives node.id=req.issueId and runs this exact key chain.
			// issueIdentifier is display metadata and deliberately cannot enter it.
			const worktreeKey = resolveWorktreeKey(issueId, {
				sessionRole: role,
				shareParentBranch,
			});
			const { branch } = input.worktreeManager.expectedWorktree(
				runtime.projectRoot,
				projectName,
				worktreeKey,
			);
			const decision = await input.materialize({
				repoPath: runtime.projectRoot,
				branch,
			});
			if (decision.kind === "missing") return { ...decision, branch };
			if (decision.kind === "indeterminate") return decision;
			const prs = await input.lookupOpenPrs({
				repoPath: runtime.projectRoot,
				branch,
			});
			if (prs.length > 0) {
				(input.log ?? console.log)(
					`[continuity] ${branch} open PR inventory: ${prs.map((pr) => `#${pr.number}`).join(", ")}`,
				);
			}
			const current = prs[0];
			return {
				kind: "found",
				branch,
				sha: decision.sha,
				...(current && { prNumber: current.number, prUrl: current.url }),
			};
		} catch (error) {
			return {
				kind: "indeterminate",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};
}

export async function setupRunInfrastructure(
	store: StateStore,
	config: BridgeConfig,
	projects: ProjectEntry[],
	registry?: RuntimeRegistry,
	runInfraOpts?: RunInfraOptions,
): Promise<RunDispatcher> {
	const projectRuntimes = new Map<string, ProjectRuntime>();
	const cleanupHandles: Array<() => Promise<void>> = [];
	const codexExecutionOwners =
		runInfraOpts?.codexExecutionOwners ?? new CodexExecutionOwnershipRegistry();

	// FLY-795: per-project doc-flow default department, captured in the setup loop
	// so the restart-resilient resume computer can resolve the deterministic
	// `progress.md` doc base dir (`<dept>/doc`) — the precedence-③ fallback used
	// only when a resumed session has no persisted plan_path. Absent → "doc".
	const docDeptByProject = new Map<string, string | undefined>();

	const fetchIssue = createFetchIssue(store);

	// FLY-95: Shared WorktreeManager for per-Runner worktree isolation
	const worktreeManager = new WorktreeManager(
		runInfraOpts?.withRepoLock
			? { withRepoLock: runInfraOpts.withRepoLock }
			: undefined,
	);
	const continuityAudit = new ContinuityAudit(
		join(homedir(), ".flywheel", "state", "continuity-audit.db"),
	);
	cleanupHandles.push(async () => continuityAudit.close());

	// FLY-137 v1.27.2: resolve Flywheel repo root once at startup (canonical source of truth).
	const flywheelRepoRoot = resolveFlywheelRepoRoot(
		runInfraOpts?.flywheelRepoRoot,
	);
	const bundledAgentRegistry = loadBundledRegistry(
		join(flywheelRepoRoot, ".flywheel", "agents", "registry.yaml"),
	);
	const flywheelAgentRegistry = resolveProjectRegistry({
		bundled: bundledAgentRegistry,
		projectName: "flywheel",
		projectRoot: flywheelRepoRoot,
	});
	const fallbackAgentConfigs = resolveAgentConfigs(
		{
			generic: { node: "general", match: { labels: [] } },
			qa: { node: "qa", match: { labels: [] } },
		},
		flywheelAgentRegistry,
	);
	const agentFallbacks = {
		generic: fallbackAgentConfigs.generic!,
		qa: fallbackAgentConfigs.qa!,
	};

	// FLY-123 R1 MED #3 (crash-recovery credential janitor): if the Bridge was
	// killed mid-run the per-runner CODEX_HOME's `finally` token-scrub never
	// fired, leaving a live GH_TOKEN in the retained home's config.toml. Strip
	// it from every retained home that is NOT a currently-live runner
	// (running/ship_parked/awaiting_review keep their token — they may resume).
	// Runs once.
	try {
		const liveExecIds = liveCodexHomeExecutionIds(store);
		const scrubbed = scrubOrphanedCodexHomes(liveExecIds);
		if (scrubbed > 0) {
			console.log(
				`[RunInfra] FLY-123: scrubbed credentials from ${scrubbed} orphaned codex home(s) at startup`,
			);
		}
	} catch (err) {
		console.warn(
			"[RunInfra] FLY-123: codex-home credential scrub failed:",
			(err as Error).message,
		);
	}

	for (const project of projects) {
		try {
			// FLY-95: Prune orphan worktrees from previous runs on startup
			try {
				await worktreeManager.pruneOrphans(
					project.projectRoot,
					project.projectName,
				);
			} catch (err) {
				console.warn(
					`[RunInfra] ${project.projectName}: worktree prune failed (non-fatal):`,
					(err as Error).message,
				);
			}

			// FLY-603 Layer B: boot reconciler sweep — drains merged+clean
			// worktrees the on-merge hook missed (unhappy paths). Fail-closed +
			// non-fatal: any setup failure (gh unavailable / list error) → no-op.
			try {
				const reconciled = await reconcileProjectWorktrees(
					store,
					worktreeManager,
					project,
				);
				if (reconciled.length > 0) {
					console.log(
						`[RunInfra] ${project.projectName}: reconciled ${reconciled.length} merged worktree(s)`,
					);
				}
			} catch (err) {
				console.warn(
					`[RunInfra] ${project.projectName}: worktree reconcile failed (non-fatal):`,
					(err as Error).message,
				);
			}

			const tmuxSessionName = sanitizeTmuxName(`runner-${project.projectName}`);

			const eventFilter = new EventFilter();
			// FLY-91: Use shared ChatThreadCreator if provided (Round 3), else create per-project (backward compat)
			const chatThreadCreator =
				runInfraOpts?.chatThreadCreator ??
				(config.chatThreadsEnabled ? new ChatThreadCreator(store) : undefined);
			console.log(
				`[RunInfra] ${project.projectName}: hasRegistry=${!!registry}, hasGlobalBotToken=${!!config.discordBotToken}, chatThreads=${!!chatThreadCreator}`,
			);
			// GEO-151: Load per-project .flywheel/config.yaml BEFORE DirectEventSink
			// so we can pass skillsConfig.proofshot into both DirectEventSink ctor
			// (for session_started persistence) and createRunBlueprint (Blueprint slot).
			// Restructured from previous post-DirectEventSink load.
			// FLY-47 + FLY-137 v1.27.2: also loads per-project checkpoint + agents config
			let checkpointConfig: CheckpointsConfig | undefined;
			let agentsConfig: Readonly<Record<string, AgentConfig>> | undefined;
			let defaultAgentName: string | undefined;
			let skillsConfig: SkillsConfig | undefined;
			let rolesConfig: RoleBackendMap | undefined;
			let docFlowDept: Pick<DocFlowConfig, "default_department"> | undefined;
			const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
			try {
				const configLoader = new ConfigLoader(async (p) =>
					readFileSync(p, "utf-8"),
				);
				const flywheelConfig = await configLoader.load(configPath);
				checkpointConfig = flywheelConfig?.checkpoints;
				if (flywheelConfig.agents) {
					const projectAgentRegistry = agentConfigsRequireRegistry(
						flywheelConfig.agents,
					)
						? resolveProjectRegistry({
								bundled: bundledAgentRegistry,
								projectName: project.projectName,
								projectRoot: project.projectRoot,
							})
						: undefined;
					agentsConfig = resolveAgentConfigs(
						flywheelConfig.agents,
						projectAgentRegistry,
						project.projectRoot,
					);
				}
				defaultAgentName = flywheelConfig?.default_agent;
				skillsConfig = flywheelConfig?.skills;
				// FLY-123: per-role executor backend bindings (validated by
				// ConfigLoader — unknown roles/backends rejected at load)
				rolesConfig = flywheelConfig?.roles;
				docFlowDept = flywheelConfig?.doc_flow; // FLY-205/2103: path metadata only
			} catch (err) {
				if (isMissingProjectConfigError(err, configPath)) {
					// No config file — no checkpoints, no agents block, no skills.
					// AgentDispatcher will still be constructed (empty agents map) so the
					// shipped-generic fallback kicks in for zero-config projects.
				} else {
					const error = err instanceof Error ? err : new Error(String(err));
					try {
						await runInfraOpts?.onProjectConfigInvalid?.({
							projectName: project.projectName,
							configPath,
							error,
						});
					} catch (alertError) {
						console.error(
							`[RunInfra] ${project.projectName}: project-config alert failed (non-fatal):`,
							alertError instanceof Error ? alertError.message : alertError,
						);
					}
					throw err;
				}
			}

			const flagStore = runInfraOpts?.flagStore;
			const directSink = new DirectEventSink(
				store,
				config,
				projects,
				eventFilter,
				registry,
				chatThreadCreator,
				skillsConfig, // GEO-151: ProofShotConfig persisted via emitStarted patch
				flagStore
					? (projectName) => storeProofshotEnabled(flagStore, projectName)
					: undefined,
			);
			// FLY-603 Layer A: wire the shared cleanup closure onto this sink.
			directSink.removeCleanWorktree = runInfraOpts?.removeCleanWorktree;
			// FLY-1185: entry-A bundle for the in-process ship path.
			directSink.lifecycleInfra = runInfraOpts?.lifecycleInfra;
			directSink.codexReviewHold = runInfraOpts?.codexReviewHold;
			directSink.reviewAuthorizationAlerts =
				runInfraOpts?.reviewAuthorizationAlerts;
			directSink.turnBeltReconciler = runInfraOpts?.turnBeltReconciler;
			// FLY-887: ship-time finalizer for keep-alive parked design/implement phases.
			directSink.finalizeWorkflowPhaseRoles =
				runInfraOpts?.finalizeWorkflowPhaseRoles;
			// FLY-907: display-refresh holder for the in-process status writes.
			directSink.issueDisplayRefresh = runInfraOpts?.issueDisplayRefresh;
			// FLY-1066: DirectEventSink writes terminal StateStore rows directly.
			directSink.terminalCommDbSync = runInfraOpts?.terminalCommDbSync;
			// FLY-1185 (Codex R4#1): launch-claim activation at the emitStarted
			// point — the claim advances starting→active only once the session
			// row is durable (plan.md:145).
			directSink.lifecycleActivate =
				runInfraOpts?.lifecycleLaunchGuard?.activateLaunch;
			directSink.materializedHeadAuthority =
				runInfraOpts?.materializedHeadAuthority;
			// FLY-1282 Part C: targeted terminal-archive enqueue for the
			// in-process completion path.
			directSink.terminalArchiveEnqueue = runInfraOpts?.terminalArchiveEnqueue;
			directSink.codexExecutionOwners = codexExecutionOwners;

			// FLY-137 v1.27.2: construct AgentDispatcher (always — empty agents map is valid,
			// dispatcher returns shipped-generic for every issue in that case).
			const agentDispatcher = new AgentDispatcher(
				agentsConfig ?? {},
				defaultAgentName,
				agentFallbacks,
			);

			// FLY-1356/2103: read split participation from scoped SQLite at every
			// dispatch. A missing store pins the project to A instead of silently
			// admitting it to an experimental arm.
			const skillFrameworkParticipation = flagStore
				? (projectName: string | undefined) =>
						storeSkillFrameworkSplitParticipation(
							flagStore,
							projectName ?? project.projectName,
						)
				: () => false;
			const docFlowEnabled = flagStore
				? () => storeDocFlowEnabled(flagStore, project.projectName)
				: undefined;
			const ponytailProjectLayer = flagStore
				? () =>
						storePonytailEnabled(flagStore, project.projectName)
							? { enabled: true }
							: undefined
				: undefined;
			const skillFrameworkModeControl = flagStore
				? () => storeSkillFrameworkModeControl(flagStore)
				: undefined;

			const { blueprint, cleanup, codexRecoveryRuntime } =
				await createRunBlueprint(
					tmuxSessionName,
					fetchIssue,
					directSink,
					undefined, // sessionTimeoutMs — use default
					checkpointConfig,
					worktreeManager, // FLY-95
					agentDispatcher, // FLY-137 v1.27.2
					flywheelRepoRoot, // FLY-137 v1.27.2 (Codex Track A #1)
					skillsConfig, // GEO-151: wired into Blueprint slot 7
					docFlowDept, // FLY-205/2103
					ponytailProjectLayer, // FLY-615/2103: store-backed project layer
					store.getDbPath(), // FLY-766: owner marker db-path truth
					skillFrameworkParticipation, // FLY-1356
					skillFrameworkModeControl, // FLY-1778
					runInfraOpts?.onTuiWindowLost,
					runInfraOpts?.onTuiWindowRestored,
					runInfraOpts?.onCodexTransportClose,
					docFlowEnabled,
					codexExecutionOwners,
				);
			runInfraOpts?.codexRecoveryRuntimes?.set(
				project.projectName,
				codexRecoveryRuntime,
			);

			projectRuntimes.set(project.projectName, {
				blueprint,
				projectRoot: project.projectRoot,
				tmuxSessionName,
				agentDispatcher, // FLY-137 v1.27.2: exposed for sync agentName validation in runs-route
				rolesConfig, // FLY-123: project roles layer for RoleAdapterResolver
			});
			// FLY-795: remember the doc-flow default department for the resume computer.
			docDeptByProject.set(
				project.projectName,
				docFlowDept?.default_department,
			);
			cleanupHandles.push(cleanup);

			console.log(`[RunInfra] ${project.projectName} ready`);
		} catch (err) {
			console.error(
				`[RunInfra] Failed to setup ${project.projectName}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	if (projectRuntimes.size === 0) {
		console.warn(
			"[RunInfra] No project runtimes initialized — start/retry will be unavailable",
		);
	} else {
		console.log(
			`[RunInfra] ${projectRuntimes.size}/${projects.length} project(s) ready (admission: resource-based, uncapped — FLY-123 WS-D)`,
		);
	}

	// FLY-245 R1 HIGH-3: durable launch claim keyed by execId — survives a Bridge
	// crash so a gateway retry replay converges to exactly one started Runner.
	const launchClaims = new LaunchClaimStore(
		join(homedir(), ".flywheel", "state", "launch-claims.db"),
	);

	// FLY-795: restart-resilient resume computer. On every (re-)dispatch, look for
	// a prior session + a committed progress.md on that issue's branch B and, if
	// found, tell the dispatcher to resume from the real cursor (reuse FLY-793's
	// shareParentBranch/startPoint worktree mechanism) instead of starting over.
	// This is the live wiring of the c3 core (`computeProgressResume`) — the pure
	// git/StateStore lookups are provided here so the dispatcher stays generic.
	//   - branch B is read from the ground-truth session row (branch, else the
	//     worktree_path basename, which equals the branch name by construction);
	//     never recomputed from a trusted-key string.
	//   - reads the BRANCH BLOB via `git show` (never the worktree fs — it may be
	//     gone on reboot); non-zero git exit ⇒ null ⇒ start fresh (fail-safe).
	const resumeComputer: ResumeComputer = async (issueId, role, projectName) => {
		// A QA runner (auto-QA, FLY-579) pins its own worktree to the reviewed commit
		// and writes NO progress ledger — it must never be resumed from a prior
		// ledger (code-review MED-3). Only writer roles resume.
		if (role === "qa") return null;
		const runtime = projectRuntimes.get(projectName);
		if (!runtime) return null;
		const projectRoot = runtime.projectRoot;

		// The latest RESUMABLE prior session for THIS issue AND role — role/status
		// scoped (code-review MED-3): excludes completed/shelved (never resume merged
		// or parked work) and the wrong role's latest session. `issueId` may be the
		// UUID or the identifier; the query matches either.
		const prior = store.getResumableSessionForIssueRole(issueId, role);
		if (!prior) return null;

		const identifier = prior.issue_identifier ?? issueId;
		const dept = docDeptByProject.get(projectName);
		const docBaseDir = dept ? `${dept}/doc` : "doc";
		const repoSlug = basename(projectRoot).toLowerCase();
		// Branch B ground truth: the persisted branch, else the worktree dir name
		// (WorktreeManager names the worktree dir identically to branch B), else a
		// deterministic recompute matching WorktreeManager.worktreeName.
		const branchB =
			prior.branch ||
			(prior.worktree_path ? basename(prior.worktree_path) : undefined) ||
			`${repoSlug}-${deriveWorktreeKey(identifier, role)}`;

		// shareParentBranch key-drift guard (code-review MED-3): a computed resume
		// always sets shareParentBranch:true, so the rebuilt worktree lands on the
		// MAIN-key branch (`<repoSlug>-<identifier>`). That is correct for role="main"
		// and for FLY-793 phases (they already share the main-key branch), but a
		// role-aware branch (`<repoSlug>-<identifier>-<role>`) would drift onto the
		// main-key branch. If branch B is not the main-key branch, do NOT resume
		// (fresh is safe) rather than continue the runner's work on the wrong branch.
		const mainKeyBranch = `${repoSlug}-${deriveWorktreeKey(identifier, "main")}`;
		if (branchB !== mainKeyBranch) return null;

		// FLY-1718 P1: refresh the remote-tracking ref before reading the branch
		// blob. An indeterminate origin must fall through to continuity's hard
		// preflight (which will reject the launch); a confirmed missing origin can
		// still resume a surviving local branch with unpushed progress.
		const remoteDecision = await materializeRemoteBranch(
			{ repoPath: projectRoot, branch: branchB },
			{ withRepoLock: runInfraOpts?.withRepoLock },
		);
		if (remoteDecision.kind === "indeterminate") return null;

		const git = (args: string[]): string | null => {
			try {
				return execFileSync("git", args, {
					cwd: projectRoot,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
			} catch {
				return null; // branch/file absent or git error → fail-safe (fresh)
			}
		};

		const branchRefs = (branch: string) => [
			`refs/heads/${branch}`,
			`refs/remotes/origin/${branch}`,
		];
		// Resolve one ref for the entire snapshot: tip, doc discovery, and ledger
		// bytes may never independently fall through to different histories.
		return computeProgressResumeAcrossRefs({
			issueId,
			role,
			docBaseDir,
			issueIdentifier: identifier,
			branch: branchB,
			refs: branchRefs(branchB),
			prior: {
				execution_id: prior.execution_id,
				...(prior.plan_path && { plan_path: prior.plan_path }),
				...(prior.session_stage && {
					session_stage: prior.session_stage,
				}),
			},
			git,
		});
	};

	// FLY-1257 M3: phase retries recover branch B's own tip, using the same
	// WorktreeManager path/branch authority as Blueprint. This runs for every
	// phase retry even when DAG workflow keep-alive is disabled: the recreate path
	// still needs to rebuild from branch B rather than silently reset to main.
	const phaseRetryStartPointComputer: PhaseRetryStartPointComputer = (
		issueId,
		role,
		projectName,
	) => {
		const runtime = projectRuntimes.get(projectName);
		if (!runtime) {
			return {
				kind: "indeterminate",
				error: `project runtime ${projectName} is unavailable`,
			};
		}
		try {
			const key = resolveWorktreeKey(issueId, {
				sessionRole: role,
				shareParentBranch: true,
			});
			const { branch } = worktreeManager.expectedWorktree(
				runtime.projectRoot,
				projectName,
				key,
			);
			return probePhaseRetryBranchTip(runtime.projectRoot, branch);
		} catch (error) {
			return {
				kind: "indeterminate",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	const continuityComputer = createBranchContinuityComputer({
		projectRuntimes,
		worktreeManager,
		materialize: (args) =>
			materializeRemoteBranch(args, {
				withRepoLock: runInfraOpts?.withRepoLock,
			}),
		lookupOpenPrs: (args) => lookupOpenPullRequests(args),
	});

	return createRunInfraDispatcher({
		store,
		projectRuntimes,
		cleanupHandles,
		runnerAdmission: config.runnerAdmission,
		launchClaims,
		resumeComputer, // FLY-795: live restart-resilient resume
		lifecycleAdmission: runInfraOpts?.lifecycleAdmission,
		lifecycleLaunchGuard: runInfraOpts?.lifecycleLaunchGuard,
		doaBackoffAdmission: runInfraOpts?.doaBackoffAdmission,
		phaseRetryStartPointComputer, // FLY-1257: branch B tip before retry TURN/launch
		continuityComputer,
		freshStartAudit: (record) => continuityAudit.recordFreshStart(record),
		admissionCrossingBarrier: runInfraOpts?.admissionCrossingBarrier,
		flagStore: runInfraOpts?.flagStore,
	});
}

export function isMissingProjectConfigError(
	error: unknown,
	configPath: string,
): boolean {
	return (
		(error as NodeJS.ErrnoException).code === "ENOENT" &&
		!existsSync(configPath)
	);
}

// ── CIPHER helpers ──────────────────────────────────────────────────

interface DimConstraint {
	dim: string;
	val: string;
}

interface DerivedDimensions {
	sizeBucket: string;
	touchesAuth: boolean;
	hasTests: boolean;
	areaTouched: string;
}

const AUTH_RE = /\/(auth|login|session|token|password|middleware|guard)\b/i;
const TEST_RE = /\.(test|spec)\.(ts|js|tsx|jsx)$|\/__tests__\//;
const FE_RE = /\/(components?|pages?|views?|hooks?|styles?|css)\b/i;
const CFG_RE = /\.(ya?ml|json|toml|env|config)\b/i;

/**
 * Parse CIPHER source pattern into dimension constraints.
 * Format: "dims:values" — e.g., "label:bug", "label+size:bug+small"
 */
function parseCipherConstraints(sourcePattern: string): DimConstraint[] {
	const constraints: DimConstraint[] = [];
	const colonIdx = sourcePattern.indexOf(":");
	if (colonIdx <= 0) return constraints;

	const dimsPart = sourcePattern.substring(0, colonIdx);
	const valsPart = sourcePattern.substring(colonIdx + 1);
	const dims = dimsPart.split("+");

	if (dims.length === 1) {
		constraints.push({ dim: dims[0]!, val: valsPart });
	} else {
		// Split from right: last N-1 tokens are controlled values,
		// everything else is the first value (may contain '+').
		const valTokens = valsPart.split("+");
		const tailCount = dims.length - 1;
		if (valTokens.length >= dims.length) {
			const headVal = valTokens
				.slice(0, valTokens.length - tailCount)
				.join("+");
			constraints.push({ dim: dims[0]!, val: headVal });
			for (let i = 1; i < dims.length; i++) {
				constraints.push({
					dim: dims[i]!,
					val: valTokens[valTokens.length - tailCount + (i - 1)]!,
				});
			}
		}
	}

	return constraints;
}

/** Derive bucketed dimensions from raw ExecutionContext fields. */
function deriveDimensions(ctx: {
	linesAdded: number;
	linesRemoved: number;
	changedFilePaths: string[];
}): DerivedDimensions {
	const totalLines = ctx.linesAdded + ctx.linesRemoved;
	const sizeBucket =
		totalLines <= 20
			? "tiny"
			: totalLines <= 100
				? "small"
				: totalLines <= 500
					? "medium"
					: "large";
	const touchesAuth = ctx.changedFilePaths.some((p) => AUTH_RE.test(p));
	const hasTests = ctx.changedFilePaths.some((p) => TEST_RE.test(p));

	let areaTouched = "mixed";
	if (ctx.changedFilePaths.length > 0) {
		let fe = 0,
			be = 0,
			au = 0,
			te = 0,
			cf = 0;
		for (const fp of ctx.changedFilePaths) {
			if (AUTH_RE.test(fp)) au++;
			else if (TEST_RE.test(fp)) te++;
			else if (CFG_RE.test(fp)) cf++;
			else if (FE_RE.test(fp)) fe++;
			else be++;
		}
		const total = ctx.changedFilePaths.length;
		areaTouched =
			au > total * 0.5
				? "auth"
				: te > total * 0.5
					? "test"
					: cf > total * 0.5
						? "config"
						: fe > 0 && be > 0
							? "mixed"
							: fe > be
								? "frontend"
								: "backend";
	}

	return { sizeBucket, touchesAuth, hasTests, areaTouched };
}

/** Check if a single dimension constraint matches the execution context. */
function matchesDimension(
	c: DimConstraint,
	ctx: {
		labels: string[];
		exitReason: string;
		consecutiveFailures: number;
		commitCount: number;
		filesChangedCount: number;
	},
	derived: DerivedDimensions,
): boolean {
	if (c.dim === "label") return (ctx.labels[0] ?? "unlabeled") === c.val;
	if (c.dim === "size") return derived.sizeBucket === c.val;
	if (c.dim === "area") return derived.areaTouched === c.val;
	if (c.dim === "auth") return String(derived.touchesAuth) === c.val;
	if (c.dim === "tests") return String(derived.hasTests) === c.val;
	if (c.dim === "exit") {
		const exitStatus =
			ctx.exitReason === "timeout"
				? "timeout"
				: ctx.exitReason === "error"
					? "error"
					: "completed";
		return exitStatus === c.val;
	}
	if (c.dim === "failures")
		return String(ctx.consecutiveFailures > 0) === c.val;
	if (c.dim === "commits") {
		const vol =
			ctx.commitCount <= 1 ? "single" : ctx.commitCount <= 5 ? "few" : "many";
		return vol === c.val;
	}
	if (c.dim === "diff") {
		const scale =
			ctx.filesChangedCount <= 2
				? "trivial"
				: ctx.filesChangedCount <= 5
					? "small"
					: ctx.filesChangedCount <= 15
						? "medium"
						: "large";
		return scale === c.val;
	}
	return true; // unknown dimension → don't block
}
