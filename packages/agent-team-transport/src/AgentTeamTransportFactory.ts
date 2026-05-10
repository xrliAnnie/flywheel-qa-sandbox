/**
 * AgentTeamTransportFactory — selects an adapter based on
 * `FLYWHEEL_AGENT_BACKEND` env var.
 *
 * Per plan v1.27.1 §2.0.5 + §2.0.7:
 * - Default: `claude-code` → ClaudeCodeAdapter
 * - `codex` → CodexAdapter (stub — throws on any method call)
 *
 * Production callers SHOULD use `AgentTeamTransportFactory.fromEnv()` rather
 * than constructing adapters directly. Tests MAY construct adapters directly
 * with `ClaudeCodeAdapter`-specific options.
 */

import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "./claude/ClaudeCodeAdapter.js";
import { CodexAdapter } from "./codex/CodexAdapter.js";
import type { IAgentTeamTransport } from "./types.js";

export type SupportedBackend = "claude-code" | "codex";

export interface FactoryOptions {
	/** Override env-based backend selection (mostly for tests). */
	backend?: SupportedBackend;
	/** Adapter-specific options (passed through to selected adapter). */
	claudeCode?: ClaudeCodeAdapterOptions;
}

export class AgentTeamTransportFactory {
	/**
	 * Build adapter based on `FLYWHEEL_AGENT_BACKEND` env (default
	 * `claude-code`).
	 *
	 * Throws immediately if `FLYWHEEL_AGENT_BACKEND=codex` (CodexAdapter is
	 * stub only — production activation requires Spike-δ first per §11).
	 */
	static fromEnv(options: FactoryOptions = {}): IAgentTeamTransport {
		const backend = (options.backend ?? this.resolveBackendFromEnv()) as SupportedBackend;

		switch (backend) {
			case "claude-code":
				return new ClaudeCodeAdapter(options.claudeCode);
			case "codex": {
				// Construct then immediately throw — surfaces "not implemented"
				// at boot rather than at first runtime call.
				const adapter = new CodexAdapter();
				adapter.capabilities(); // forces throw
				return adapter; // unreachable
			}
			default:
				throw new Error(
					`Unsupported FLYWHEEL_AGENT_BACKEND: ${backend}. ` +
						`Supported: "claude-code", "codex".`,
				);
		}
	}

	private static resolveBackendFromEnv(): SupportedBackend {
		const env = process.env.FLYWHEEL_AGENT_BACKEND;
		if (env === undefined || env.length === 0) {
			return "claude-code";
		}
		if (env === "claude-code" || env === "codex") {
			return env;
		}
		throw new Error(
			`Unsupported FLYWHEEL_AGENT_BACKEND env: "${env}". ` +
				`Supported: "claude-code", "codex".`,
		);
	}
}
