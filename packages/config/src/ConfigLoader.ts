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
		const available = runners.available as
			| Record<string, unknown>
			| undefined;
		if (!available || typeof available !== "object") {
			throw new Error("Missing required field: runners.available");
		}

		// runners.default must be in available
		const defaultRunner = runners.default as string;
		if (!(defaultRunner in available)) {
			throw new Error(
				`Runner "${defaultRunner}" not in available runners`,
			);
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
						throw new Error(
							`Runner "${runnerRef}" not in available runners`,
						);
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

		// agents (optional — v0.6)
		const agents = c.agents as Record<string, unknown> | undefined;
		if (agents && typeof agents === "object") {
			for (const [name, agentRaw] of Object.entries(agents)) {
				const agent = agentRaw as Record<string, unknown>;
				if (!agent.agent_file || typeof agent.agent_file !== "string") {
					throw new Error(
						`agents.${name}: missing required field "agent_file"`,
					);
				}
				this.validateAgentPath(agent.agent_file as string, `agents.${name}.agent_file`);
				if (agent.domain_file != null) {
					if (typeof agent.domain_file !== "string") {
						throw new Error(
							`agents.${name}.domain_file must be a string`,
						);
					}
					this.validateAgentPath(agent.domain_file as string, `agents.${name}.domain_file`);
				}
			}

			// default_agent must reference an existing agent
			const defaultAgent = c.default_agent as string | undefined;
			if (defaultAgent && !(defaultAgent in agents)) {
				throw new Error(
					`default_agent "${defaultAgent}" not found in agents`,
				);
			}
		}
	}

	private validateAgentPath(relativePath: string, fieldName: string): void {
		if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
			throw new Error(
				`${fieldName}: agent path must be relative, got "${relativePath}"`,
			);
		}
		if (relativePath.startsWith("..")) {
			throw new Error(
				`${fieldName}: agent path must not escape repo, got "${relativePath}"`,
			);
		}
	}
}
