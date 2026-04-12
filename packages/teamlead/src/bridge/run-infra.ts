/**
 * FLY-22/FLY-50: Run infrastructure setup — creates per-project Blueprint + RunDispatcher.
 *
 * This is the single source of truth for production run/retry infrastructure.
 * Previously duplicated in scripts/lib/retry-runtime.ts (deleted in FLY-50).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicLLMClient, TmuxAdapter } from "flywheel-claude-runner";
import { type CheckpointsConfig, ConfigLoader } from "flywheel-config";
import type { LLMClient } from "flywheel-core";
import { sanitizeTmuxName } from "flywheel-core";
import {
	AuditLogger,
	CipherReader,
	DecisionLayer,
	defaultRules,
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
import { EventFilter } from "./EventFilter.js";
import { ForumPostCreator } from "./ForumPostCreator.js";
import { ForumTagUpdater } from "./ForumTagUpdater.js";
import { type ProjectRuntime, RunDispatcher } from "./run-dispatcher.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import type { BridgeConfig } from "./types.js";

/** Build a fetchIssue function that tries Linear API, falls back to StateStore. */
function createFetchIssue(store: StateStore) {
	return async (id: string) => {
		const accessToken = process.env.LINEAR_API_KEY;
		if (accessToken) {
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ accessToken });
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
			} catch {
				// Linear API failed — fall through to StateStore fallback
			}
		}

		if (!accessToken) {
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

/** Create a Blueprint for running issues (no Slack, no AgentDispatcher; CIPHER principles loaded). */
async function createRunBlueprint(
	tmuxSessionName: string,
	fetchIssue: ReturnType<typeof createFetchIssue>,
	eventEmitter: DirectEventSink,
	sessionTimeoutMs: number = 14_400_000, // 4h (same as retry runtime)
	checkpointConfig?: CheckpointsConfig, // FLY-47
	worktreeManager?: WorktreeManager, // FLY-95
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
		const makeAdapter = (_name: string) =>
			new TmuxAdapter(
				tmuxSessionName,
				undefined,
				5000,
				sessionTimeoutMs,
				hookServer,
			);
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
			undefined, // skillsConfig
			decisionLayer,
			eventEmitter,
			undefined, // agentDispatcher
			checkpointConfig, // FLY-47
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
export async function setupRunInfrastructure(
	store: StateStore,
	config: BridgeConfig,
	projects: ProjectEntry[],
	registry?: RuntimeRegistry,
): Promise<RunDispatcher> {
	const projectRuntimes = new Map<string, ProjectRuntime>();
	const cleanupHandles: Array<() => Promise<void>> = [];

	const fetchIssue = createFetchIssue(store);

	// FLY-95: Shared WorktreeManager for per-Runner worktree isolation
	const worktreeManager = new WorktreeManager();

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
					`[RunInfra] ${project.projectName}: worktree prune failed:`,
					(err as Error).message,
				);
			}

			const tmuxSessionName = sanitizeTmuxName(`runner-${project.projectName}`);

			const eventFilter = new EventFilter();
			const statusTagMap = config.statusTagMap ?? {};
			const forumTagUpdater = new ForumTagUpdater(statusTagMap);
			// FLY-24: ForumPostCreator so DirectEventSink can create Forum Posts on session_started
			const forumPostCreator = new ForumPostCreator(store, statusTagMap);
			console.log(
				`[RunInfra] ${project.projectName}: ForumPostCreator created, hasRegistry=${!!registry}, hasGlobalBotToken=${!!config.discordBotToken}`,
			);
			const directSink = new DirectEventSink(
				store,
				config,
				projects,
				eventFilter,
				forumTagUpdater,
				registry,
				forumPostCreator,
			);

			// FLY-47: Load per-project checkpoint config
			let checkpointConfig: CheckpointsConfig | undefined;
			const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
			try {
				const configLoader = new ConfigLoader(async (p) =>
					readFileSync(p, "utf-8"),
				);
				const flywheelConfig = await configLoader.load(configPath);
				checkpointConfig = flywheelConfig?.checkpoints;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					// No config file — no checkpoints
				} else {
					throw err;
				}
			}

			const { blueprint, cleanup } = await createRunBlueprint(
				tmuxSessionName,
				fetchIssue,
				directSink,
				undefined, // sessionTimeoutMs — use default
				checkpointConfig,
				worktreeManager, // FLY-95
			);

			projectRuntimes.set(project.projectName, {
				blueprint,
				projectRoot: project.projectRoot,
				tmuxSessionName,
			});
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
			`[RunInfra] ${projectRuntimes.size}/${projects.length} project(s) ready (maxConcurrent: ${config.maxConcurrentRunners})`,
		);
	}

	return new RunDispatcher(
		projectRuntimes,
		cleanupHandles,
		config.maxConcurrentRunners,
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
