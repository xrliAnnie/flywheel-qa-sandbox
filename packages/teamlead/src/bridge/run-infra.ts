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
	CodexTmuxAdapter,
	KimiTmuxAdapter,
	scrubOrphanedCodexHomes,
	TmuxAdapter,
} from "flywheel-claude-runner";
import {
	type AgentConfig,
	type CheckpointsConfig,
	ConfigLoader,
	type DocFlowConfig,
	type FounderUxGateConfig,
	type PonytailConfig,
	type RoleBackendMap,
	resolveEffectiveFounderUxConfig,
	type SkillsConfig,
} from "flywheel-config";
import type { LLMClient } from "flywheel-core";
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
	SkillInjector,
	WorktreeManager,
} from "flywheel-edge-worker";
import { Blueprint } from "flywheel-edge-worker/dist/Blueprint.js";
import { PreHydrator } from "flywheel-edge-worker/dist/PreHydrator.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type { AutoQaCoordinator } from "./auto-qa-coordinator.js";
import { ChatThreadCreator } from "./ChatThreadCreator.js";
import { EventFilter } from "./EventFilter.js";
import type { IssueDisplayRefreshHolder } from "./issue-display-refresher.js";
import { LaunchClaimStore } from "./launch-claim-store.js";
import type { PhaseOrchestrator } from "./phase-orchestrator.js";
import type { LifecycleShipInfra } from "./post-ship-finalization.js";
import {
	computeProgressResume,
	type ProgressResumeDeps,
} from "./progress-resume.js";
import {
	type LifecycleAdmissionFn,
	type LifecycleLaunchGuard,
	type ProjectRuntime,
	type ResumeComputer,
	RunDispatcher,
} from "./run-dispatcher.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import type { BridgeConfig } from "./types.js";
import type { WorkflowShadowWriter } from "./workflow-shadow-writer.js";
import type { WorktreeCleanupFn } from "./worktree-cleanup.js";
import { reconcileProjectWorktrees } from "./worktree-reconciler.js";

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
			identifier: session?.issue_identifier ?? id,
		};
	};
}

/**
 * FLY-137 v1.27.2: resolve the Flywheel repo root canonically (single source of truth
 * across all Bridge entrypoints — `scripts/run-bridge.ts`, `packages/teamlead/src/index.ts`).
 * Order: caller-supplied option → `FLYWHEEL_REPO_ROOT` env → `import.meta.url`-derived path.
 * Validates the resolved root contains `agents/generic-executor.md` (sanity check, NOT fail-fast).
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
	const sentinel = join(candidate, "agents", "generic-executor.md");
	if (!existsSync(sentinel)) {
		console.warn(
			`[RunInfra] FLYWHEEL_REPO_ROOT resolved to "${candidate}" but expected sentinel "${sentinel}" not found. ` +
				`AgentDispatcher's shipped-generic fallback will fail at dispatch time. ` +
				`Set FLYWHEEL_REPO_ROOT to the Flywheel repo root that contains agents/generic-executor.md.`,
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
	sessionTimeoutMs: number = 86_400_000, // 24h safety net (FLY-97; idle detection via FLY-92 watchdog)
	checkpointConfig?: CheckpointsConfig, // FLY-47
	worktreeManager?: WorktreeManager, // FLY-95
	agentDispatcher?: AgentDispatcher, // FLY-137 v1.27.2
	flywheelRepoRoot?: string, // FLY-137 v1.27.2 (Codex Track A #1): Blueprint needs this to resolve shipped-generic agent_file
	skillsConfig?: SkillsConfig, // GEO-151: ProofShot + skill commands surfaced to Blueprint
	docFlowConfig?: DocFlowConfig, // FLY-205: doc-flow baseline (DOC-FLOW prompt block when enabled)
	founderUxGateConfig?: FounderUxGateConfig, // FLY-598: founder-UX gate prompt injection when mode != off
	ponytailConfig?: PonytailConfig, // FLY-615: per-project ponytail rollout layer
	ownerStateDbPath?: string, // FLY-766: this Bridge's actual StateStore db path → claude-tmux owner marker
): Promise<{ blueprint: Blueprint; cleanup: () => Promise<void> }> {
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
			docFlowConfig, // FLY-205
			founderUxGateConfig, // FLY-598
			ponytailConfig, // FLY-615: per-project ponytail rollout layer
		);

		const cleanup = async () => {
			await hookServer!.stop();
			await auditLogger!.close();
		};

		return { blueprint, cleanup };
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
	/** Shared ChatThreadCreator — if provided, used instead of per-project creation. */
	chatThreadCreator?: ChatThreadCreator;
	/**
	 * FLY-137 v1.27.2: optional explicit Flywheel repo root. If unset, falls back to
	 * `FLYWHEEL_REPO_ROOT` env var, then to a module-location-derived path. Used by
	 * `AgentDispatcher` to resolve the shipped `agents/generic-executor.md` fallback.
	 */
	flywheelRepoRoot?: string;
	/**
	 * FLY-603 Layer A: worktree-cleanup closure from the Bridge composition
	 * root, set on the DirectEventSink so its post-ship finalization can clean.
	 */
	removeCleanWorktree?: WorktreeCleanupFn;
	/**
	 * FLY-579: late-bound auto-QA coordinator holder, set on the DirectEventSink
	 * so the in-process completed path drives auto-QA + suppresses the founder
	 * gate (Codex R1 HIGH-1). Absent → byte-compatible.
	 */
	autoQaCoordinator?: { current: AutoQaCoordinator | undefined };
	/**
	 * FLY-793: late-bound three-stage PhaseOrchestrator holder, set on the
	 * DirectEventSink so the in-process completion path drives Design→Implement→QA
	 * phase handoffs. Absent / `.current` undefined → byte-compatible (no-op).
	 */
	phaseOrchestrator?: { current: PhaseOrchestrator | undefined };
	/**
	 * FLY-887: ship-time three-stage phase finalizer (closes parked design +
	 * implement sessions before the shared worktree is removed). Built at the
	 * composition root with store + transitionOpts; wired onto the DirectEventSink.
	 */
	finalizeThreeStagePhases?: (
		issueId: string,
		projectName: string,
	) => Promise<void>;
	/**
	 * FLY-907: late-bound unified issue-display refresh holder, set on the
	 * DirectEventSink (its upsertSession status writes bypass the applyTransition
	 * hook, so the sink triggers refreshes itself). Absent → byte-compatible.
	 */
	issueDisplayRefresh?: IssueDisplayRefreshHolder;
	/**
	 * FLY-1185: the ship-entry lifecycle bundle (remote branch CAS + issue
	 * closeout + trailing sweep), set on the DirectEventSink so the in-process
	 * ship path drives the SAME entry-A items as the HTTP paths. Absent →
	 * classic finalization only (byte-compat).
	 */
	lifecycleInfra?: LifecycleShipInfra;
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
	/**
	 * FLY-1232 module ②: the lifecycle shadow writer — constructed by plugin.ts
	 * ONLY when FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1. Threaded into (a) the
	 * RunDispatcher (T1/T2/T7 pre-launch seam + flag-ON fresh launchCommitPath)
	 * and (b) the DirectEventSink (T9 post-ship finalization hook). Absent →
	 * both seams undefined = byte-compatible. NOTE (plan §0 red line): an
	 * EXTERNALLY injected startDispatcher (startBridge option) bypasses this
	 * assembly entirely and is deliberately NOT shadow-wrapped.
	 */
	workflowShadow?: WorkflowShadowWriter;
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

	// FLY-795: per-project doc-flow default department, captured in the setup loop
	// so the restart-resilient resume computer can resolve the deterministic
	// `progress.md` doc base dir (`<dept>/doc`) — the precedence-③ fallback used
	// only when a resumed session has no persisted plan_path. Absent → "doc".
	const docDeptByProject = new Map<string, string | undefined>();

	const fetchIssue = createFetchIssue(store);

	// FLY-95: Shared WorktreeManager for per-Runner worktree isolation
	const worktreeManager = new WorktreeManager();

	// FLY-137 v1.27.2: resolve Flywheel repo root once at startup (canonical source of truth).
	const flywheelRepoRoot = resolveFlywheelRepoRoot(
		runInfraOpts?.flywheelRepoRoot,
	);

	// FLY-123 R1 MED #3 (crash-recovery credential janitor): if the Bridge was
	// killed mid-run the per-runner CODEX_HOME's `finally` token-scrub never
	// fired, leaving a live GH_TOKEN in the retained home's config.toml. Strip
	// it from every retained home that is NOT a currently-live runner
	// (running/awaiting_review keep their token — they may resume). Runs once.
	try {
		const liveExecIds = new Set(
			store
				.getActiveSessions()
				.filter((s) => s.status === "running" || s.status === "awaiting_review")
				.map((s) => s.execution_id),
		);
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
			let agentsConfig: Record<string, AgentConfig> | undefined;
			let defaultAgentName: string | undefined;
			let skillsConfig: SkillsConfig | undefined;
			let rolesConfig: RoleBackendMap | undefined;
			let docFlowConfig: DocFlowConfig | undefined;
			let founderUxGateConfig: FounderUxGateConfig | undefined;
			let ponytailConfig: PonytailConfig | undefined;
			const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
			try {
				const configLoader = new ConfigLoader(async (p) =>
					readFileSync(p, "utf-8"),
				);
				const flywheelConfig = await configLoader.load(configPath);
				checkpointConfig = flywheelConfig?.checkpoints;
				agentsConfig = flywheelConfig?.agents;
				defaultAgentName = flywheelConfig?.default_agent;
				skillsConfig = flywheelConfig?.skills;
				// FLY-123: per-role executor backend bindings (validated by
				// ConfigLoader — unknown roles/backends rejected at load)
				rolesConfig = flywheelConfig?.roles;
				docFlowConfig = flywheelConfig?.doc_flow; // FLY-205
				founderUxGateConfig = flywheelConfig?.founder_ux_gate; // FLY-598
				// FLY-615 v1 = per-issue only (Tadashi): the per-project config
				// layer is DORMANT — we intentionally do NOT load
				// `flywheelConfig?.ponytail`, so the project layer of the resolver
				// never fires (a project's `ponytail.enabled` has no effect yet).
				// The 3-layer resolver + Blueprint `ponytailConfig` param stay in
				// place; v2 activates per-project rollout by loading it here.
				// `ConfigLoader` still validates `ponytail` when present (harmless).
				ponytailConfig = undefined;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					// No config file — no checkpoints, no agents block, no skills.
					// AgentDispatcher will still be constructed (empty agents map) so the
					// shipped-generic fallback kicks in for zero-config projects.
				} else {
					throw err;
				}
			}

			// FLY-869: resolve the RAW `founder_ux_gate` block (absent whenever the
			// config file is missing, the key is omitted, or load failed with
			// ENOENT above) into its EFFECTIVE form through the one resolution
			// choke point. Absent → `enforce` + the default exempt-label list —
			// NEVER a bare `undefined` that a downstream consumer would read as
			// "gate off" (the FLY-598 opt-in behavior this issue reverses).
			// Explicit project config (including an explicit `mode: "off"`
			// kill-switch) passes through untouched. Both DirectEventSink's
			// per-run mode snapshot (below) and Blueprint's prompt-injection
			// config (createRunBlueprint call below) MUST receive this EFFECTIVE
			// object, never the raw (possibly absent) `founderUxGateConfig`.
			const effectiveFounderUxGateConfig =
				resolveEffectiveFounderUxConfig(founderUxGateConfig);

			const directSink = new DirectEventSink(
				store,
				config,
				projects,
				eventFilter,
				registry,
				chatThreadCreator,
				skillsConfig, // GEO-151: ProofShotConfig persisted via emitStarted patch
				effectiveFounderUxGateConfig.mode, // FLY-598/869: EFFECTIVE mode snapshot (absent → enforce)
			);
			// FLY-603 Layer A: wire the shared cleanup closure onto this sink.
			directSink.removeCleanWorktree = runInfraOpts?.removeCleanWorktree;
			// FLY-1185: entry-A bundle for the in-process ship path.
			directSink.lifecycleInfra = runInfraOpts?.lifecycleInfra;
			// FLY-579 (Codex R1 HIGH-1): give the in-process completed path the
			// auto-QA coordinator holder so it spawns QA + holds the founder.
			directSink.autoQaCoordinator = runInfraOpts?.autoQaCoordinator;
			// FLY-793: give the in-process completion path the three-stage
			// PhaseOrchestrator holder so it drives Design→Implement→QA handoffs.
			directSink.phaseOrchestrator = runInfraOpts?.phaseOrchestrator;
			// FLY-887: ship-time finalizer for keep-alive parked design/implement phases.
			directSink.finalizeThreeStagePhases =
				runInfraOpts?.finalizeThreeStagePhases;
			// FLY-907: display-refresh holder for the in-process status writes.
			directSink.issueDisplayRefresh = runInfraOpts?.issueDisplayRefresh;
			// FLY-1185 (Codex R4#1): launch-claim activation at the emitStarted
			// point — the claim advances starting→active only once the session
			// row is durable (plan.md:145).
			directSink.lifecycleActivate =
				runInfraOpts?.lifecycleLaunchGuard?.activateLaunch;
			// FLY-1232 T9: the in-process post-ship finalization hook (external
			// merge paths are covered by the claim-based startup repair instead).
			directSink.workflowShadow = runInfraOpts?.workflowShadow;

			// FLY-137 v1.27.2: construct AgentDispatcher (always — empty agents map is valid,
			// dispatcher returns shipped-generic for every issue in that case).
			const agentDispatcher = new AgentDispatcher(
				agentsConfig ?? {},
				defaultAgentName,
				flywheelRepoRoot,
			);

			const { blueprint, cleanup } = await createRunBlueprint(
				tmuxSessionName,
				fetchIssue,
				directSink,
				undefined, // sessionTimeoutMs — use default
				checkpointConfig,
				worktreeManager, // FLY-95
				agentDispatcher, // FLY-137 v1.27.2
				flywheelRepoRoot, // FLY-137 v1.27.2 (Codex Track A #1)
				skillsConfig, // GEO-151: wired into Blueprint slot 7
				docFlowConfig, // FLY-205
				effectiveFounderUxGateConfig, // FLY-598/869: EFFECTIVE config (absent → enforce)
				ponytailConfig, // FLY-615: per-project ponytail rollout layer
				store.getDbPath(), // FLY-766: owner marker db-path truth
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
				docFlowConfig?.default_department,
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
	//   - kill-switch: FLYWHEEL_PROGRESS_RESUME=0 → always fresh (byte-compatible).
	//   - branch B is read from the ground-truth session row (branch, else the
	//     worktree_path basename, which equals the branch name by construction);
	//     never recomputed from a trusted-key string.
	//   - reads the BRANCH BLOB via `git show` (never the worktree fs — it may be
	//     gone on reboot); non-zero git exit ⇒ null ⇒ start fresh (fail-safe).
	const resumeComputer: ResumeComputer = (issueId, role, projectName) => {
		if (process.env.FLYWHEEL_PROGRESS_RESUME === "0") return null;
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

		const deps: ProgressResumeDeps = {
			docBaseDir,
			issueIdentifier: identifier,
			branchName: () => branchB,
			priorSession: () => ({
				execution_id: prior.execution_id,
				...(prior.plan_path && { plan_path: prior.plan_path }),
				...(prior.session_stage && { session_stage: prior.session_stage }),
			}),
			readBranchFile: (branch, path) => git(["show", `${branch}:${path}`]),
			branchTip: (branch) => git(["rev-parse", branch])?.trim() ?? null,
			// MED-4: when no plan_path is persisted, find the doc dir on the branch
			// that actually holds a committed progress.md, so a co-located slug-named
			// ledger (runner died before design_review) is still found. `git ls-tree`
			// lists committed blobs; we take the dir of the first `${issue}-*/
			// progress.md` under the doc base.
			discoverDocDir: (branch) => {
				const out = git(["ls-tree", "-r", "--name-only", branch]);
				if (!out) return null;
				const prefix = `${docBaseDir}/${identifier}-`;
				const hit = out
					.split("\n")
					.find((p) => p.startsWith(prefix) && p.endsWith("/progress.md"));
				return hit ? hit.slice(0, hit.length - "/progress.md".length) : null;
			},
		};

		// resumeKind = "restart": the generic re-dispatch umbrella. The specific
		// terminate/reboot/handoff distinction is informational only (surfaced to
		// the runner) and not knowable from the dispatch signature here.
		return computeProgressResume(issueId, role, "restart", deps);
	};

	return new RunDispatcher(
		projectRuntimes,
		cleanupHandles,
		config.runnerAdmission,
		launchClaims,
		undefined, // isCommitted — production uses the default file-existence check
		resumeComputer, // FLY-795: live restart-resilient resume
		runInfraOpts?.lifecycleAdmission, // FLY-1185: park admission chokepoint
		runInfraOpts?.lifecycleLaunchGuard, // FLY-1185 R1#5: pre-launch recheck
		runInfraOpts?.workflowShadow, // FLY-1232: T1/T2/T7 pre-launch seam (flag ON only)
		// FLY-1244: admission exists only with the WRITE seam. The preceding
		// shadow dispatch creates/locates the active run; failure here aborts the
		// QA launch before the runner can start without a usable credential.
		runInfraOpts?.workflowShadow
			? {
					admit: (input: {
						projectName: string;
						issueId: string;
						executionId: string;
						node: string;
						attempt: number;
					}) => {
						const run = store.getActiveWorkflowRun(
							input.projectName,
							input.issueId,
						);
						if (!run) throw new Error("active workflow run not found");
						const now = Date.now();
						const admitted = store.admitWorkflowExecution({
							runId: run.run_id,
							nodeId: input.node,
							executionId: input.executionId,
							attempt: input.attempt,
							family: "qa_verdict",
							now: new Date(now).toISOString(),
							expiresAt: new Date(now + 30 * 60_000).toISOString(),
							absoluteDeadlineAt: new Date(now + 2 * 60 * 60_000).toISOString(),
						});
						if (!admitted.ok) throw new Error(admitted.reason);
						return { credential: admitted.credential };
					},
				}
			: undefined,
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
