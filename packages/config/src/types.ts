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
}
