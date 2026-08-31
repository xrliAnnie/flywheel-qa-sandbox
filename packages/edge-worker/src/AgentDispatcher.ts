import type { AgentConfig } from "flywheel-config";

/**
 * FLY-137 v1.27.2: dept-aware deterministic dispatch.
 *
 * 3-step chain (Haiku classify step dropped in v1.27.1; dept-awareness added in v1.27.2):
 *   1. Override via `dispatchByName(name)` — used by Lead when an explicit `agentName`
 *      arrives in `POST /api/runs/start`.
 *   2. Label match in `dispatch({ issueLabels, owningDept })`, using registry-owned
 *      department membership before registry-owned top-level catch-all entries.
 *   3. Shipped-generic fallback: use the bundled registry's resolved `general` node.
 *      If a `default_agent` is configured AND its name exists in the agents map,
 *      that wins over the shipped-generic synthesized fallback.
 */

/** v1.27.2: how the dispatcher arrived at this result. */
export type AgentMatchMethod =
	| "label"
	| "default"
	| "shipped-generic"
	| "shipped-qa"
	| "override";

export interface AgentDispatchResult {
	agentName: string;
	agentConfig: AgentConfig;
	matchMethod: AgentMatchMethod;
	/** Owning department selected for this dispatch, if any. */
	department?: string;
}

/** Options passed per-dispatch by the Bridge caller. */
export interface DispatchOptions {
	/** Lowercased Linear labels (caller normalizes once at the boundary). */
	issueLabels: string[];
	/**
	 * Owning-dept resolved via `DepartmentRegistry.getDepartmentForIssue` in runs-route.
	 * - `string`: exactly one Lead's labels matched the issue.
	 * - `"multiple"`: 2+ Leads matched (FLY-127 ambiguous case; usually 403'd at Bridge,
	 *   but dispatcher still handles deterministically for retry/feature-off paths).
	 * - `undefined`: no Lead matched, or no project Lead config exists.
	 */
	owningDept: string | "multiple" | undefined;
}

/** Thrown by `dispatchByName` when the caller supplies an unknown agent name. */
export class InvalidAgentNameError extends Error {
	constructor(
		public readonly providedName: string,
		public readonly available: string[],
	) {
		super(
			`Unknown agent name: "${providedName}". Available: ${
				available.length > 0 ? available.join(", ") : "(none)"
			}`,
		);
		this.name = "InvalidAgentNameError";
	}
}

/** Reserved dept-config key (clashes with shipped-generic synthesized result). */
const RESERVED_GENERIC_AGENT_NAME = "generic";

/**
 * Reserved QA agent name for explicit DAG or manual QA dispatch. A
 * project-declared `agents.qa` takes precedence; otherwise the bundled registry's
 * resolved QA node is used.
 */
const RESERVED_QA_AGENT_NAME = "qa";

export interface AgentFallbacks {
	generic: AgentConfig;
	qa: AgentConfig;
}

export class AgentDispatcher {
	private readonly entries: Array<[string, AgentConfig]>;

	constructor(
		private readonly agents: Readonly<Record<string, AgentConfig>>,
		private readonly defaultAgent: string | undefined,
		private readonly fallbacks: AgentFallbacks,
	) {
		for (const [name, fallback] of Object.entries(fallbacks)) {
			if (!fallback.agentFile || !fallback.agentFileRoot) {
				throw new Error(`AgentDispatcher: ${name} fallback must be resolved`);
			}
		}
		this.entries = Object.entries(agents);
	}

	/**
	 * FLY-137 v1.27.2: deterministic 3-step dispatch.
	 * Caller must pre-normalize `issueLabels` to lowercase and resolve `owningDept`
	 * via `DepartmentRegistry.getDepartmentForIssue(...)`.
	 */
	dispatch(options: DispatchOptions): AgentDispatchResult {
		const { issueLabels, owningDept } = options;

		// Step 2a — own-dept scope (only when owningDept is a known string, not "multiple"/undefined)
		if (typeof owningDept === "string" && owningDept !== "multiple") {
			for (const [name, cfg] of this.entries) {
				// FLY-901: an agent participates in this dept's scope iff owningDept is a
				// member of its registered dept SET (dual-register). Top-level agents
				// (registeredDepts === null) never match here — they're handled in step-2b.
				if (!cfg.departments.includes(owningDept)) continue;
				if (this.labelsMatch(cfg, issueLabels)) {
					return {
						agentName: name,
						agentConfig: cfg,
						matchMethod: "label",
						department: owningDept,
					};
				}
			}
		}

		// Step 2b — top-level catch-all (always evaluated)
		for (const [name, cfg] of this.entries) {
			if (cfg.departments.length !== 0) continue;
			if (this.labelsMatch(cfg, issueLabels)) {
				return {
					agentName: name,
					agentConfig: cfg,
					matchMethod: "label",
					department: undefined,
				};
			}
		}

		// Step 3a — project default_agent (if declared and exists)
		if (this.defaultAgent) {
			const cfg = this.agents[this.defaultAgent];
			if (cfg) {
				return {
					agentName: this.defaultAgent,
					agentConfig: cfg,
					matchMethod: "default",
					department: cfg.department,
				};
			}
		}

		// Step 3b — shipped-generic absolute fallback
		return {
			agentName: RESERVED_GENERIC_AGENT_NAME,
			agentConfig: this.fallbacks.generic,
			matchMethod: "shipped-generic",
			department: undefined,
		};
	}

	/**
	 * v1.27.2: Lead override path. Bypasses label match — used when the spawning Lead
	 * passes an explicit `agentName` body field on `/api/runs/start`.
	 * Throws `InvalidAgentNameError` for unknown names (caller maps to FLY-127-style
	 * `INVALID_AGENT_NAME` HTTP response).
	 */
	dispatchByName(name: string): AgentDispatchResult {
		if (name === RESERVED_GENERIC_AGENT_NAME) {
			return {
				agentName: name,
				agentConfig: this.fallbacks.generic,
				matchMethod: "shipped-generic",
				department: undefined,
			};
		}
		// FLY-579: reserved "qa" resolves to a project override when declared,
		// else the shipped project-agnostic QA executor — so every project gets
		// an independent QA runner without declaring one.
		if (name === RESERVED_QA_AGENT_NAME && !this.agents[name]) {
			return {
				agentName: name,
				agentConfig: this.fallbacks.qa,
				matchMethod: "shipped-qa",
				department: undefined,
			};
		}
		const cfg = this.agents[name];
		if (!cfg) {
			throw new InvalidAgentNameError(name, this.availableNames());
		}
		return {
			agentName: name,
			agentConfig: cfg,
			matchMethod: "override",
			department: cfg.department,
		};
	}

	/** v1.27.2: introspection helper for INVALID_AGENT_NAME responses + tests. */
	availableNames(): string[] {
		// FLY-579: "qa" is always available (shipped fallback) even when the
		// project doesn't declare it. Dedup if the project DOES declare `qa`.
		const names = new Set([
			...Object.keys(this.agents),
			RESERVED_GENERIC_AGENT_NAME,
			RESERVED_QA_AGENT_NAME,
		]);
		return [...names];
	}

	private labelsMatch(cfg: AgentConfig, issueLabels: string[]): boolean {
		// issueLabels are pre-normalized to lowercase by the caller (runs-route).
		// match.labels[] may be mixed case; compare case-insensitively here.
		for (const configured of cfg.match.labels) {
			if (issueLabels.includes(configured.toLowerCase())) return true;
		}
		return false;
	}
}
