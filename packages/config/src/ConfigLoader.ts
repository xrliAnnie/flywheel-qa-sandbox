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
	}
}
