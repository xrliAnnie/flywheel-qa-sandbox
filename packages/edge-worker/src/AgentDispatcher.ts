import type { AgentConfig } from "flywheel-config";

/**
 * FLY-137 v1.27.2: dept-aware deterministic dispatch.
 *
 * 3-step chain (Haiku classify step dropped in v1.27.1; dept-awareness added in v1.27.2):
 *   1. Override via `dispatchByName(name)` — used by Lead when an explicit `agentName`
 *      arrives in `POST /api/runs/start`.
 *   2. Label match in `dispatch({ issueLabels, owningDept })`, broken into:
 *      2a. Try to match within the issue's owning-dept subdir first
 *          (entries whose agent_file is under `.flywheel/agents/<owningDept>/`).
 *      2b. Fall through to top-level catch-all entries
 *          (agent_file directly under `.flywheel/agents/<file>.md`, no dept subdir).
 *   3. Shipped-generic fallback: synthesize an AgentConfig pointing to
 *      `agents/generic-executor.md` at the Flywheel repo root.
 *      If a `default_agent` is configured AND its name exists in the agents map,
 *      that wins over the shipped-generic synthesized fallback.
 */

/** v1.27.2: discriminates whether agent_file resolves against project cwd or Flywheel repo root. */
export type AgentFileRoot = "project" | "flywheel";

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
	/** Project agent files relative to cwd; shipped generic relative to Flywheel repo. */
	agentFileRoot: AgentFileRoot;
	/** v1.27.2: resolved department (auto-derived from agent_file path if not explicit on config). */
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

/** Thrown by `parsedDept` (and surfaced through ConfigLoader) when an agent_file path is malformed. */
export class InvalidAgentFilePathError extends Error {
	constructor(
		public readonly agentFile: string,
		message: string,
	) {
		super(`Invalid agent_file "${agentFile}": ${message}`);
		this.name = "InvalidAgentFilePathError";
	}
}

const AGENTS_PREFIX = ".flywheel/agents/";

/**
 * FLY-137 v1.27.2: extract the dept (first path segment) from an agent_file under
 * `.flywheel/agents/`. Strict contract:
 *   - Returns `null` when file is directly under `.flywheel/agents/<file>.md`
 *     (depth 0 → top-level cross-dept catch-all).
 *   - Returns the dept name when file is at `.flywheel/agents/<dept>/<file>.md`
 *     (depth 1 → dept-owned).
 *   - Throws `InvalidAgentFilePathError` on:
 *       - paths not starting with `.flywheel/agents/` (e.g. legacy `.claude/agents/...`)
 *       - depth ≥ 2 (nested subdirs; v1.27.2 supports only flat dept dirs)
 */
export function parsedDept(agentFile: string): string | null {
	if (!agentFile.startsWith(AGENTS_PREFIX)) {
		throw new InvalidAgentFilePathError(
			agentFile,
			`expected path to start with "${AGENTS_PREFIX}"`,
		);
	}
	const rest = agentFile.slice(AGENTS_PREFIX.length);
	if (rest.length === 0) {
		throw new InvalidAgentFilePathError(
			agentFile,
			"agent_file cannot be the agents/ directory itself",
		);
	}
	const segments = rest.split("/");
	if (segments.length === 1) {
		// e.g. ".flywheel/agents/general-executor.md" — top-level catch-all
		return null;
	}
	if (segments.length === 2) {
		// e.g. ".flywheel/agents/product/backend-executor.md" — dept-owned
		const dept = segments[0]!;
		if (dept.length === 0) {
			throw new InvalidAgentFilePathError(
				agentFile,
				"empty dept segment (leading slash?)",
			);
		}
		return dept;
	}
	throw new InvalidAgentFilePathError(
		agentFile,
		`nested subdirs not supported (depth ${segments.length - 1}); v1.27.2 allows only flat .flywheel/agents/<dept>/<file>.md`,
	);
}

/**
 * FLY-901: the set of owning-departments an agent is registered under for
 * label-based dispatch (step-2a). Returns:
 *   - `null` for top-level (catch-all) agents — they never participate in step-2a
 *     (and ConfigLoader rejects a `departments` field on them).
 *   - the explicit `departments` array when declared (dual-register).
 *   - `[home]` (the single path-derived dept) when `departments` is omitted —
 *     byte-compatible with the pre-FLY-901 single-dept behavior.
 */
export function registeredDepts(cfg: AgentConfig): string[] | null {
	const home = parsedDept(cfg.agent_file);
	if (home === null) return null;
	return cfg.departments ?? [home];
}

/** Reserved dept-config key (clashes with shipped-generic synthesized result). */
const RESERVED_GENERIC_AGENT_NAME = "generic";

/**
 * FLY-579: reserved QA agent name. The Auto-QA coordinator spawns with
 * `agentName: "qa"`. Resolution: a project-declared `agents.qa` (e.g.
 * flywheel's `.flywheel/agents/engineering/qa-executor.md`) takes precedence
 * (project override); otherwise the shipped project-agnostic
 * `agents/qa-executor.md` is used — so EVERY project gets an independent QA
 * runner without declaring one.
 */
const RESERVED_QA_AGENT_NAME = "qa";

/**
 * Synthesize the shipped-generic AgentConfig. The `agent_file` is relative to the
 * Flywheel repo root; Blueprint resolves it via the `agentFileRoot: "flywheel"` discriminant.
 */
function shippedGenericResult(): AgentDispatchResult {
	return {
		agentName: RESERVED_GENERIC_AGENT_NAME,
		agentConfig: {
			agent_file: "agents/generic-executor.md",
			match: { labels: [] },
		},
		matchMethod: "shipped-generic",
		agentFileRoot: "flywheel",
		department: undefined,
	};
}

/**
 * FLY-579: synthesize the shipped project-agnostic QA AgentConfig. `agent_file`
 * is relative to the Flywheel repo root (resolved via `agentFileRoot: "flywheel"`).
 */
function shippedQaResult(): AgentDispatchResult {
	return {
		agentName: RESERVED_QA_AGENT_NAME,
		agentConfig: {
			agent_file: "agents/qa-executor.md",
			match: { labels: [] },
		},
		matchMethod: "shipped-qa",
		agentFileRoot: "flywheel",
		department: undefined,
	};
}

export class AgentDispatcher {
	private readonly entries: Array<[string, AgentConfig]>;

	constructor(
		private readonly agents: Record<string, AgentConfig>,
		private readonly defaultAgent: string | undefined,
		flywheelRepoRoot: string,
	) {
		if (!flywheelRepoRoot || flywheelRepoRoot.length === 0) {
			throw new Error(
				"AgentDispatcher: flywheelRepoRoot is required (caller should resolve via setupRunInfrastructure)",
			);
		}
		// flywheelRepoRoot is validated at construction but consumed by Blueprint via the
		// `agentFileRoot: "flywheel"` discriminant — no need to retain on the instance.
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
				const depts = registeredDepts(cfg);
				if (!depts || !depts.includes(owningDept)) continue;
				if (this.labelsMatch(cfg, issueLabels)) {
					return {
						agentName: name,
						agentConfig: cfg,
						matchMethod: "label",
						agentFileRoot: "project",
						department: owningDept,
					};
				}
			}
		}

		// Step 2b — top-level catch-all (always evaluated)
		for (const [name, cfg] of this.entries) {
			if (parsedDept(cfg.agent_file) !== null) continue;
			if (this.labelsMatch(cfg, issueLabels)) {
				return {
					agentName: name,
					agentConfig: cfg,
					matchMethod: "label",
					agentFileRoot: "project",
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
					agentFileRoot: "project",
					department: parsedDept(cfg.agent_file) ?? undefined,
				};
			}
		}

		// Step 3b — shipped-generic absolute fallback
		return shippedGenericResult();
	}

	/**
	 * v1.27.2: Lead override path. Bypasses label match — used when the spawning Lead
	 * passes an explicit `agentName` body field on `/api/runs/start`.
	 * Throws `InvalidAgentNameError` for unknown names (caller maps to FLY-127-style
	 * `INVALID_AGENT_NAME` HTTP response).
	 */
	dispatchByName(name: string): AgentDispatchResult {
		if (name === RESERVED_GENERIC_AGENT_NAME) {
			return shippedGenericResult();
		}
		// FLY-579: reserved "qa" resolves to a project override when declared,
		// else the shipped project-agnostic QA executor — so every project gets
		// an independent QA runner without declaring one.
		if (name === RESERVED_QA_AGENT_NAME && !this.agents[name]) {
			return shippedQaResult();
		}
		const cfg = this.agents[name];
		if (!cfg) {
			throw new InvalidAgentNameError(name, this.availableNames());
		}
		return {
			agentName: name,
			agentConfig: cfg,
			matchMethod: "override",
			agentFileRoot: "project",
			department: parsedDept(cfg.agent_file) ?? undefined,
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
