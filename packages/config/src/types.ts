/** Decision Layer autonomy progression */
export type AutonomyLevel =
	| "manual_only"
	| "observer"
	| "advisor"
	| "autonomous";

/** Runner configuration for a specific agent */
export interface RunnerConfig {
	/** Runner type: "claude" | "openai" | "gemini" | "local" | ... */
	type: string;
	/** Model ID (e.g. "sonnet", "gpt-4o", "gemini-2.5-pro") */
	model?: string;
	/** Per-session budget cap in USD */
	max_budget_usd?: number;
}

/** Agent node configuration (model-agnostic) */
export interface AgentNodeConfig {
	implement?: {
		/** CLI --allowedTools */
		tools?: string[];
		/** CLI --max-turns, default: 50 */
		max_turns?: number;
	};
	fix?: {
		/** Per-fix budget in USD, default: 2.0 */
		budget_usd?: number;
		tools?: string[];
	};
}

/** Orchestrator within a team */
export interface OrchestratorConfig {
	type: string;
	/** References runners.available key */
	runner: string;
	/** Budget per issue in USD */
	budget_per_issue: number;
}

/** Team configuration */
export interface TeamConfig {
	name: string;
	orchestrators: OrchestratorConfig[];
}

/** Decision Layer configuration */
export interface DecisionLayerConfig {
	autonomy_level: AutonomyLevel;
	escalation_channel: string;
	digest_interval?: number;
}

/** CI configuration */
export interface CIConfig {
	/** Max CI retry rounds, default: 2 */
	max_rounds?: number;
	/** CI failure patterns to retry on */
	retry_on?: string[];
}

/** Parallel execution configuration (v0.2) */
export interface ParallelConfig {
	/** Maximum concurrent sessions, default: 3 */
	max_parallel?: number;
	/** Base directory for git worktrees, default: ~/.flywheel/worktrees */
	worktree_base_dir?: string;
	/** Port for HookCallbackServer, default: 0 (auto-assign) */
	hook_port?: number;
	/** Per-session timeout in minutes, default: 240 */
	session_timeout_minutes?: number;
}

/** Skills injection configuration (v0.2) */
export interface SkillsConfig {
	/** Enable skill injection, default: true */
	enabled?: boolean;
	/** Test command, default: "pnpm test" */
	test_command?: string;
	/** Lint command, default: "pnpm lint" */
	lint_command?: string;
	/** Build command, default: "pnpm build" */
	build_command?: string;
	/** Test framework name, default: "vitest" */
	test_framework?: string;
	/** Custom landing command (e.g. "/ship-pr"). If unset, uses default flywheel-land skill. */
	land_command?: string;
	/** GEO-151 ProofShot integration: browser/UI/3D visual verification */
	proofshot?: ProofShotAuthoringConfig;
}

/**
 * GEO-151 ProofShot integration config — auto-trigger visual capture on stage_changed,
 * route artifacts to Lead → Discord via reliable LeadEvent journal.
 *
 * Loaded from `<projectRoot>/.flywheel/config.yaml` `skills.proofshot` section.
 * Persisted into `session_params.proofshot.config` by DirectEventSink.emitStarted()
 * so Bridge event-route handlers can read it without re-loading project config.
 */
export interface ProofShotConfig {
	/** Enable ProofShot auto-trigger. Default: false (safer rollout). */
	enabled?: boolean;
	/** Dev server start command (e.g., "pnpm dev"). Required for L2 web verification. */
	dev_command?: string;
	/** Preferred dev server port. Wrapper picks free port near this. Default: 3000. */
	port?: number;
	/** Pipeline stages where auto-trigger fires. Default: ["test","code_review","pr_created"]. */
	capture_stages?: string[];
	/** Run V1 (Runner Read selected artifacts) after capture. Default: true. */
	vision_default?: boolean;
	/** Vision token budget cap for selectVisionArtifacts(). Default: 10000. */
	vision_token_budget?: number;
	/** 3D model viewer URL template. GeoForge3D-specific (no default). */
	model_viewer_url?: string;
	/** 3D capture angles. Default: ["front","side","iso","top"]. */
	model_capture_angles?: string[];
	/** Artifact path allowlist (regex). Default: ['^/Users/.+/\\.flywheel/screens/','^/tmp/flywheel-screens/']. */
	artifact_path_allowlist?: string[];
}

/** Project-YAML ProofShot fields; enablement lives in the scoped flag store. */
export type ProofShotAuthoringConfig = Omit<ProofShotConfig, "enabled">;

export interface AgentMatchConfig {
	labels: string[];
	keywords?: string[];
}

/** Registry-backed agent dispatch rule after a project activates the new catalog. */
export interface RegistryAgentConfigSource {
	/** Stable node identity registered in `.flywheel/agents/registry.yaml`. */
	node: string;
	agent_file?: never;
	department?: never;
	departments?: never;
	/** Relative path to domain config file (e.g., .claude/domains/backend.md). Optional. */
	domain_file?: string;
	/** Dispatch matching rules */
	match: AgentMatchConfig;
}

/**
 * Pre-activation agent dispatch rule. Kept only so projects remain runnable
 * until their explicit `migrate-agent-registry` activation succeeds.
 */
export interface LegacyAgentConfigSource {
	node?: never;
	agent_file: string;
	domain_file?: string;
	department?: string;
	departments?: string[];
	match: AgentMatchConfig;
}

/** Authoring-only agent dispatch rule from `.flywheel/config.yaml`. */
export type AgentConfigSource =
	| RegistryAgentConfigSource
	| LegacyAgentConfigSource;

/** Immutable runtime dispatch config resolved from AgentConfigSource × registry. */
export interface ResolvedAgentConfig {
	nodeName: string;
	label: string;
	agentFile: string;
	agentFileRoot: string;
	domainFile?: string;
	department?: string;
	departments: readonly string[];
	match: Readonly<AgentMatchConfig>;
}

/** Runtime agent config consumed by AgentDispatcher. */
export type AgentConfig = ResolvedAgentConfig;

/** Timeout behavior on expiry */
export type TimeoutBehavior = "fail-open" | "fail-close";

/** A single checkpoint definition */
export interface CheckpointConfig {
	/**
	 * Timeout in ms before timeout_behavior kicks in.
	 * Default: 172_800_000 (48h, FLY-159 `DEFAULT_GATE_TIMEOUT_MS`).
	 * Floor: 14_400_000 (4h, FLY-159 `MIN_GATE_TIMEOUT_MS`) — values below
	 * the floor are auto-raised by ConfigLoader (warn, not throw).
	 */
	timeout_ms?: number;
	/**
	 * What happens on timeout (no response received).
	 * Default: 'fail-close' (FLY-159 `DEFAULT_TIMEOUT_BEHAVIOR`).
	 * Set to 'fail-open' explicitly only when the gate is genuinely advisory.
	 */
	timeout_behavior?: TimeoutBehavior;
	/** TTL in hours for cleanup after gate resolves. Default: 24 */
	cleanup_ttl_hours?: number;
	/** Stage name to report to Bridge. Defaults to checkpoint name if in VALID_STAGES. */
	stage?: string;
}

/** Checkpoint configuration map — added to FlywheelConfig */
export type CheckpointsConfig = Record<string, CheckpointConfig>;

/**
 * FLY-205: department-first doc-flow baseline configuration.
 *
 * When the scoped flag-store row is enabled, Runners receive a DOC-FLOW block
 * them to produce process docs (exploration/research/plan) under
 * `<department>/doc/<ISSUE-KEY>-<slug>/` according to the Lead-judged
 * doc tier. The scoped flag-store row controls enablement; this YAML block
 * carries authoring metadata only.
 */
export interface DocFlowConfig {
	/**
	 * Department directory name (e.g. "content", "product"). Required whenever
	 * the metadata block is present; enablement is owned by SQLite.
	 * Used as the doc-path fallback whenever the issue's owning department
	 * cannot be resolved to a concrete string.
	 */
	default_department: string;
}

/**
 * FLY-1185: lifecycle cleanup policy block (`cleanup:` in .flywheel/config.yaml).
 */
export interface CleanupConfig {
	/** Exact branch names or trailing-`*` prefixes never auto-deleted. */
	protected_branches?: string[];
}

/**
 * FLY-222: per-collection learning cadence.
 */
export type XiaohongshuCadence = "daily" | "weekly" | "biweekly" | "monthly";

/** FLY-222: the set of valid cadence values (runtime guard for validation). */
export const XIAOHONGSHU_CADENCES: readonly XiaohongshuCadence[] = [
	"daily",
	"weekly",
	"biweekly",
	"monthly",
];

/** FLY-222: hard ceiling on per-run fetch (MCP `limit` cap; collection has no cursor). */
export const XIAOHONGSHU_MAX_FETCH_CEILING = 200;
/** FLY-222: default per-run fetch when a collection omits `max_fetch`. */
export const XIAOHONGSHU_DEFAULT_MAX_FETCH = 20;

/**
 * FLY-286: where the founder's post-hoc review of a learning run is delivered +
 * collected. `web-local` = a Bridge-localhost interactive page (same-origin
 * comment/action submit) reviewed at the computer. `web-public` (phone/public
 * write backend) is FLY-298 and is NOT accepted by FLY-286's validation yet.
 */
export type XiaohongshuReviewChannel = "web-local";

/** FLY-286: review channels FLY-286 accepts (FLY-298 will add "web-public"). */
export const XIAOHONGSHU_REVIEW_CHANNELS: readonly XiaohongshuReviewChannel[] =
	["web-local"];
/** FLY-286: default review channel when a collection omits `review_channel`. */
export const XIAOHONGSHU_DEFAULT_REVIEW_CHANNEL: XiaohongshuReviewChannel =
	"web-local";
/** FLY-286: default cap on auto-created issues during the first (baseline) run. */
export const XIAOHONGSHU_DEFAULT_FIRST_RUN_CAP = 15;

/**
 * FLY-222: one Xiaohongshu collection a Lead periodically "studies".
 *
 * `lead_id` / `department_label` / `target_linear_project` are three distinct
 * routing fields (Codex R1 plan §2.5): `department_label` is the real Linear
 * label used to route the scheduler-created trigger issue to the right Lead;
 * `target_linear_project` is where output ("things to do") issues land. The
 * full routing-tuple cross-check (Lead exists + canSpawnRunners, label routes
 * uniquely to lead_id, Linear team/project/label resolve) is a RUNTIME check
 * the scheduler performs (graceful skip + bounded alert on failure) — NOT a
 * config-load-time throw. ConfigLoader only validates static shape here.
 */
export interface XiaohongshuCollectionConfig {
	/** MCP collection id (from `list_collections`). */
	collection_id: string;
	/** Human label for logs / trigger issue title (e.g. "AI-视频"). */
	label: string;
	/** Lead agentId that studies this collection (must exist + canSpawnRunners). */
	lead_id: string;
	/** Real Linear label routing the trigger issue to `lead_id` (name, not id). */
	department_label: string;
	/** Linear project (by name) where output "things to do" issues are created. */
	target_linear_project: string;
	/** Study cadence. Default: "weekly". */
	cadence?: XiaohongshuCadence;
	/** Max notes processed per run (1..200). Default: 20. Unseen overflow stays pending. */
	max_fetch?: number;
	/**
	 * FLY-286: where the post-hoc review is delivered. Default: "web-local".
	 * FLY-286 only accepts "web-local"; "web-public" (phone) ships in FLY-298.
	 */
	review_channel?: XiaohongshuReviewChannel;
	/**
	 * FLY-286: cap on issues AUTO-created during the first (baseline) run, so a
	 * large historical backlog does not flood the founder's Linear. Default: 15.
	 * Overflow useful posts become review-page candidates (not created). 0 = the
	 * first run auto-creates nothing (all useful posts become candidates).
	 */
	first_run_cap?: number;
	/**
	 * FLY-286: max notes the first (baseline) run ANALYZES, distinct from the
	 * steady-state `max_fetch`. Default: the MCP window cap (200). The first run
	 * analyzes historical content rather than only baselining it.
	 */
	first_run_analyze_limit?: number;
	/**
	 * FLY-709: runner model for this collection's daily runs. Passed verbatim as
	 * the `/api/runs/start` `model` dispatch param (FLY-728 Part C), so it must
	 * be a recognized tier id or alias (`normalizeDispatchModel`). Absent =
	 * today's behavior (project default / account default).
	 */
	model?: string;
}

/**
 * FLY-222: department-Lead periodic Xiaohongshu-collection "study" baseline.
 *
 * When enabled in the scoped flag store, a thin scheduler periodically spawns a Runner (via a fixed,
 * reused trigger Linear issue per collection) that fetches the collection,
 * analyzes notes (incl. video body), proposes Linear-issue drafts to Annie via
 * a prune gate, then creates the kept issues + records learnings to project
 * memory. The YAML block only carries non-flag collection metadata.
 */
export interface XiaohongshuLearningConfig {
	/**
	 * One-time consent to send downloaded video bodies to Google/Gemini for
	 * analysis. Default: false. When false, video notes degrade to
	 * caption+comments — yt-dlp/Gemini are NOT invoked.
	 */
	video_opt_in?: boolean;
	/** Collections to study. Each is independently scheduled + state-tracked. */
	collections?: XiaohongshuCollectionConfig[];
}

/** Reactions configuration (Phase 2+, interface reserved) */
export interface ReactionsConfig {
	"changes-requested"?: {
		action: "send-to-agent";
		retries?: number;
		escalateAfter?: string;
	};
	"approved-and-green"?: {
		action: "notify" | "auto-merge";
	};
}

/**
 * FLY-123: role names recognized by the role → adapter resolver.
 * Phase 1 implements lead + runner; reviewer/triager are reserved.
 */
export type RoleName = "lead" | "runner" | "reviewer" | "triager";

export const ROLE_NAMES: readonly RoleName[] = [
	"lead",
	"runner",
	"reviewer",
	"triager",
];

/**
 * Executor backends. Names match AdapterRegistry keys registered in run-infra
 * (`claude-tmux` → TmuxAdapter, `codex-tmux` → CodexTmuxAdapter,
 * `antigravity-tmux` → AntigravityTmuxAdapter, `kimi-tmux` → KimiTmuxAdapter).
 *
 * FLY-123: claude-tmux + codex-tmux. FLY-493: antigravity-tmux (Antigravity
 * `agy` CLI, transport=none in v1). FLY-494: kimi-tmux (Kimi Code `kimi` CLI,
 * transport=none in v1).
 */
export type ExecutorBackend =
	| "claude-tmux"
	| "codex-tmux"
	| "antigravity-tmux"
	| "kimi-tmux";

export const EXECUTOR_BACKENDS: readonly ExecutorBackend[] = [
	"claude-tmux",
	"codex-tmux",
	"antigravity-tmux",
	"kimi-tmux",
];

/**
 * FLY-671: per-role reasoning-effort levels — the Claude Code CLI `--effort`
 * enum. Local copy of teamlead's `LeadEffort`/`EFFORT_LEVELS` (the FLY-123
 * cross-package boundary forbids `config` depending on `teamlead`).
 */
export type RoleEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const ROLE_EFFORT_LEVELS: readonly RoleEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** FLY-123: per-role backend binding in project config. */
export interface RoleBackendConfig {
	/** Executor backend (AdapterRegistry key), e.g. "codex-tmux". */
	backend: ExecutorBackend;
	/** Optional model override for this role. */
	model?: string;
	/**
	 * FLY-671: optional reasoning-effort override for this role (runner side).
	 * Flows `resolveRoleAdapter → runnerEffort → --effort`. Absent = no
	 * `--effort` flag (account default). Only the claude-tmux runner consumes it.
	 */
	effort?: RoleEffort;
}

/** FLY-123: role → backend map (`roles:` block in .flywheel/config.yaml). */
export type RoleBackendMap = Partial<Record<RoleName, RoleBackendConfig>>;

/**
 * Root Flywheel project configuration.
 * Loaded from .flywheel/config.yaml in the target project.
 */
export interface FlywheelConfig {
	project: string;
	linear: {
		team_id: string;
		labels?: string[];
	};
	runners: {
		/** Default runner name, e.g. "claude" */
		default: string;
		/** Model-agnostic runner registry */
		available: Record<string, RunnerConfig>;
	};
	agent_nodes?: AgentNodeConfig;
	teams: TeamConfig[];
	decision_layer: DecisionLayerConfig;
	ci?: CIConfig;
	reactions?: ReactionsConfig;
	parallel?: ParallelConfig;
	skills?: SkillsConfig;
	/** Agent dispatch rules (project-aware). Optional for backward compat. */
	agents?: Record<string, AgentConfigSource>;
	/**
	 * Default agent when no label matches — the mechanism for expressing an
	 * unmatched-label catch-all (an empty match.labels alone is name-only and
	 * never a wildcard; FLY-1335). Falls back to the shipped generic prompt
	 * when undefined.
	 */
	default_agent?: string;
	/** Checkpoint gates — human-in-the-loop confirmation points */
	checkpoints?: CheckpointsConfig;
	/**
	 * FLY-123: optional per-role executor backend bindings.
	 * Absent → built-in defaults (everything claude-tmux). Validated by
	 * ConfigLoader: unknown role keys and unknown backends are REJECTED
	 * (misspelled keys must not silently no-op).
	 */
	roles?: RoleBackendMap;
	/** FLY-205: department-first doc-flow authoring metadata. */
	doc_flow?: DocFlowConfig;
	/** FLY-222: periodic Xiaohongshu-collection authoring metadata. */
	xiaohongshu_learning?: XiaohongshuLearningConfig;
	/**
	 * FLY-1185: lifecycle-closeout cleanup policy. Config, NOT a feature flag —
	 * absent / empty list = today's behavior. `protected_branches` entries are
	 * exact branch names or trailing-`*` prefixes; a protected branch is exempt
	 * from EVERY automatic deletion, on both the branch and worktree side.
	 * A malformed block disables ALL cleanup deleters for the project
	 * (fail-closed, resolved by the Bridge's CleanupPolicy builder — the loader
	 * itself never hard-fails on this optional key).
	 */
	cleanup?: CleanupConfig;
	/** FLY-1687: per-project Lead patrol cadence; absent uses fleet/global policy. */
	patrol?: PatrolConfig;
}

/** Bridge patrol timing only. The Lead-side checklist is intentionally not config. */
export interface PatrolConfig {
	interval_minutes?: number;
}
