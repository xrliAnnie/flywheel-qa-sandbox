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
}

/** Agent dispatch configuration — v0.6 Step 1; FLY-137 v1.27.2 dept-aware */
export interface AgentConfig {
	/**
	 * Relative path to agent executor file (e.g., `.flywheel/agents/<dept>/<role>-executor.md`
	 * for dept-owned agents, or `.flywheel/agents/<role>-executor.md` for cross-dept catch-all).
	 * REQUIRED. Path validation enforced by ConfigLoader via parsedDept() helper.
	 */
	agent_file: string;
	/** Relative path to domain config file (e.g., .claude/domains/backend.md). Optional. */
	domain_file?: string;
	/**
	 * FLY-137 v1.27.2: optional explicit department. If absent, auto-derived from
	 * agent_file's first subdir under `.flywheel/agents/` (or `undefined` for top-level
	 * cross-dept catch-all). ConfigLoader errors on mismatch between explicit value and
	 * path-derived value.
	 */
	department?: string;
	/** Dispatch matching rules */
	match: {
		/**
		 * Linear labels that map to this agent (case-insensitive). Multiple entries =
		 * multi-alias (e.g. `["designer", "design", "ui", "ux"]` — any label hit matches).
		 */
		labels: string[];
		/**
		 * @deprecated FLY-137 v1.27.1: Haiku classify step removed; keywords no longer consulted.
		 * Kept optional for backward compat with existing config files. ConfigLoader accepts
		 * the field if present (must still be array of strings) but never reads it at dispatch.
		 */
		keywords?: string[];
	};
}

/** Timeout behavior on expiry */
export type TimeoutBehavior = "fail-open" | "fail-close";

/** A single checkpoint definition */
export interface CheckpointConfig {
	/** Whether this checkpoint is active. Default: false */
	enabled?: boolean;
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
	agents?: Record<string, AgentConfig>;
	/** Default agent name when no match. Falls back to generic prompt if undefined. */
	default_agent?: string;
	/** Checkpoint gates — human-in-the-loop confirmation points */
	checkpoints?: CheckpointsConfig;
}
