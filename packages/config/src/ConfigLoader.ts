import * as path from "node:path";
import { parse } from "yaml";
import type { FlywheelConfig } from "./types.js";

/** Function signature for reading a file — injected for testability */
export type ReadFileFn = (path: string) => Promise<string>;

/**
 * Loads and validates .flywheel/config.yaml.
 *
 * Accepts a readFile function for dependency injection (testable without fs).
 * Validates required fields and cross-references (runner availability).
 */
export class ConfigLoader {
	constructor(private readFile: ReadFileFn) {}

	async load(path: string): Promise<FlywheelConfig> {
		const content = await this.readFile(path);
		const raw = parse(content);
		this.validate(raw);
		return raw as FlywheelConfig;
	}

	private validate(config: unknown): asserts config is FlywheelConfig {
		if (!config || typeof config !== "object") {
			throw new Error("Config must be a YAML object");
		}

		const c = config as Record<string, unknown>;

		// Required top-level fields
		if (!c.project || typeof c.project !== "string") {
			throw new Error("Missing required field: project");
		}

		// linear.team_id
		const linear = c.linear as Record<string, unknown> | undefined;
		if (!linear || !linear.team_id) {
			throw new Error("Missing required field: linear.team_id");
		}

		// runners
		const runners = c.runners as Record<string, unknown> | undefined;
		if (!runners || !runners.default) {
			throw new Error("Missing required field: runners.default");
		}
		const available = runners.available as Record<string, unknown> | undefined;
		if (!available || typeof available !== "object") {
			throw new Error("Missing required field: runners.available");
		}

		// runners.default must be in available
		const defaultRunner = runners.default as string;
		if (!(defaultRunner in available)) {
			throw new Error(`Runner "${defaultRunner}" not in available runners`);
		}

		// teams
		const teams = c.teams as unknown[] | undefined;
		if (!Array.isArray(teams) || teams.length === 0) {
			throw new Error(
				"Missing required field: teams (must be non-empty array)",
			);
		}

		// Validate orchestrator runner references
		for (const team of teams) {
			const t = team as Record<string, unknown>;
			const orchestrators = t.orchestrators as unknown[] | undefined;
			if (Array.isArray(orchestrators)) {
				for (const orch of orchestrators) {
					const o = orch as Record<string, unknown>;
					const runnerRef = o.runner as string;
					if (runnerRef && !(runnerRef in available)) {
						throw new Error(`Runner "${runnerRef}" not in available runners`);
					}
				}
			}
		}

		// decision_layer
		const dl = c.decision_layer as Record<string, unknown> | undefined;
		if (!dl) {
			throw new Error("Missing required field: decision_layer");
		}
		const validLevels = new Set([
			"manual_only",
			"observer",
			"advisor",
			"autonomous",
		]);
		if (!dl.autonomy_level || !validLevels.has(dl.autonomy_level as string)) {
			throw new Error(
				`Invalid decision_layer.autonomy_level: "${dl.autonomy_level}". Must be one of: ${[...validLevels].join(", ")}`,
			);
		}
		if (!dl.escalation_channel || typeof dl.escalation_channel !== "string") {
			throw new Error(
				"Missing required field: decision_layer.escalation_channel",
			);
		}

		// checkpoints (optional — FLY-47)
		const checkpoints = c.checkpoints as Record<string, unknown> | undefined;
		if (
			checkpoints != null &&
			(typeof checkpoints !== "object" || Array.isArray(checkpoints))
		) {
			throw new Error(
				"checkpoints must be a YAML mapping (object), not an array or scalar",
			);
		}
		if (checkpoints && typeof checkpoints === "object") {
			const validBehaviors = new Set(["fail-open", "fail-close"]);
			for (const [name, cpRaw] of Object.entries(checkpoints)) {
				if (!cpRaw || typeof cpRaw !== "object" || Array.isArray(cpRaw)) {
					throw new Error(`checkpoints.${name} must be an object`);
				}
				const cp = cpRaw as Record<string, unknown>;
				if (
					cp.timeout_behavior != null &&
					!validBehaviors.has(cp.timeout_behavior as string)
				) {
					throw new Error(
						`checkpoints.${name}.timeout_behavior must be "fail-open" or "fail-close", got "${cp.timeout_behavior}"`,
					);
				}
				if (
					cp.timeout_ms != null &&
					(typeof cp.timeout_ms !== "number" || cp.timeout_ms <= 0)
				) {
					throw new Error(
						`checkpoints.${name}.timeout_ms must be a positive number`,
					);
				}
				if (
					cp.cleanup_ttl_hours != null &&
					(typeof cp.cleanup_ttl_hours !== "number" ||
						cp.cleanup_ttl_hours <= 0)
				) {
					throw new Error(
						`checkpoints.${name}.cleanup_ttl_hours must be a positive number`,
					);
				}
				if (cp.stage != null && typeof cp.stage !== "string") {
					throw new Error(`checkpoints.${name}.stage must be a string`);
				}
				if (cp.enabled != null && typeof cp.enabled !== "boolean") {
					throw new Error(`checkpoints.${name}.enabled must be a boolean`);
				}
			}
		}

		// agents (optional — v0.6)
		const agents = c.agents as Record<string, unknown> | undefined;
		if (
			agents != null &&
			(typeof agents !== "object" || Array.isArray(agents))
		) {
			throw new Error(
				"agents must be a YAML mapping (object), not an array or scalar",
			);
		}
		if (agents && typeof agents === "object") {
			// FLY-137 v1.27.2: "generic" is reserved (shipped fallback in AgentDispatcher).
			if ("generic" in agents) {
				throw new Error(
					'agents.generic: "generic" is reserved by Flywheel for the shipped-generic fallback. Pick a different agent name.',
				);
			}
			for (const [name, agentRaw] of Object.entries(agents)) {
				const agent = agentRaw as Record<string, unknown>;
				if (!agent.agent_file || typeof agent.agent_file !== "string") {
					throw new Error(
						`agents.${name}: missing required field "agent_file"`,
					);
				}
				const agentFile = agent.agent_file as string;
				this.validateAgentPath(agentFile, `agents.${name}.agent_file`);
				if (agent.domain_file != null) {
					if (typeof agent.domain_file !== "string") {
						throw new Error(`agents.${name}.domain_file must be a string`);
					}
					this.validateAgentPath(
						agent.domain_file as string,
						`agents.${name}.domain_file`,
					);
				}
				// FLY-137 v1.27.2: optional `department` field with bidirectional consistency check.
				const explicitDept = agent.department;
				if (explicitDept != null && typeof explicitDept !== "string") {
					throw new Error(`agents.${name}.department must be a string`);
				}
				const pathDept = this.parseAgentDept(
					agentFile,
					`agents.${name}.agent_file`,
				);
				if (typeof explicitDept === "string") {
					if (pathDept === null) {
						throw new Error(
							`agents.${name}: agent_file "${agentFile}" is at top-level (no dept dir) but department: "${explicitDept}" is declared. Top-level agents must omit the department field.`,
						);
					}
					if (pathDept !== explicitDept) {
						throw new Error(
							`agents.${name}.department="${explicitDept}" mismatches agent_file path "${agentFile}" (expected department="${pathDept}").`,
						);
					}
				}
				// match validation
				if (!agent.match || typeof agent.match !== "object") {
					throw new Error(`agents.${name}: missing required field "match"`);
				}
				const match = agent.match as Record<string, unknown>;
				if (!Array.isArray(match.labels)) {
					throw new Error(`agents.${name}.match.labels must be an array`);
				}
				if (!(match.labels as unknown[]).every((l) => typeof l === "string")) {
					throw new Error(
						`agents.${name}.match.labels must contain only strings`,
					);
				}
				// FLY-137 v1.27.1: `match.keywords` is now optional (Haiku step dropped).
				// Validate ONLY if the field is present.
				if (match.keywords != null) {
					if (!Array.isArray(match.keywords)) {
						throw new Error(
							`agents.${name}.match.keywords must be an array (if present)`,
						);
					}
					if (
						!(match.keywords as unknown[]).every((k) => typeof k === "string")
					) {
						throw new Error(
							`agents.${name}.match.keywords must contain only strings`,
						);
					}
				}
			}
		}

		// default_agent validation (outside agents block)
		const defaultAgent = c.default_agent as string | undefined;
		if (defaultAgent) {
			if (!agents || typeof agents !== "object") {
				throw new Error(
					`default_agent "${defaultAgent}" requires an agents section`,
				);
			}
			if (!(defaultAgent in agents)) {
				throw new Error(`default_agent "${defaultAgent}" not found in agents`);
			}
		}
	}

	private validateAgentPath(relativePath: string, fieldName: string): void {
		if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
			throw new Error(
				`${fieldName}: agent path must be relative, got "${relativePath}"`,
			);
		}
		// Resolve against a dummy root to catch embedded .. segments
		// e.g., "foo/../../etc/passwd" resolves outside the root
		const dummyRoot = "/flywheel-validate";
		const resolved = path.resolve(dummyRoot, relativePath);
		if (!resolved.startsWith(`${dummyRoot}/`)) {
			throw new Error(
				`${fieldName}: agent path must not escape repo, got "${relativePath}"`,
			);
		}
	}

	/**
	 * FLY-137 v1.27.2: extract dept from `.flywheel/agents/<dept>/<file>.md` paths.
	 * Returns:
	 *   - `null` for `.flywheel/agents/<file>.md` (top-level catch-all, depth 0)
	 *   - `<dept>` (string) for `.flywheel/agents/<dept>/<file>.md` (dept-owned, depth 1)
	 * Throws on:
	 *   - paths not starting with `.flywheel/agents/` (legacy `.claude/agents/...` is hard-errored
	 *     — operators run `flywheel migrate-agents-path` to fix)
	 *   - depth ≥ 2 (nested subdirs not supported in v1.27.2)
	 */
	private parseAgentDept(agentFile: string, fieldName: string): string | null {
		const prefix = ".flywheel/agents/";
		if (!agentFile.startsWith(prefix)) {
			throw new Error(
				`${fieldName}: agent_file must live under ".flywheel/agents/", got "${agentFile}". ` +
					`If this is a legacy ".claude/agents/" reference, run \`flywheel migrate-agents-path\` to update.`,
			);
		}
		const rest = agentFile.slice(prefix.length);
		if (rest.length === 0) {
			throw new Error(
				`${fieldName}: agent_file cannot be the agents/ directory itself`,
			);
		}
		const segments = rest.split("/");
		if (segments.length === 1) return null;
		if (segments.length === 2) {
			if (segments[0]!.length === 0) {
				throw new Error(`${fieldName}: empty dept segment in "${agentFile}"`);
			}
			return segments[0]!;
		}
		throw new Error(
			`${fieldName}: nested subdirs not supported (depth ${segments.length - 1}); v1.27.2 allows only flat .flywheel/agents/<dept>/<file>.md`,
		);
	}
}
