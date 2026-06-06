/**
 * AgentTeamTransportFactory — selects an adapter based on
 * `FLYWHEEL_AGENT_BACKEND` env var.
 *
 * Per plan v1.27.1 §2.0.5 + §2.0.7, updated by FLY-123 Phase 1:
 * - Default: `claude-code` → ClaudeCodeAdapter
 * - `codex` → CodexAdapter (REAL since FLY-123 — Spike-δ validated; the
 *   former stub boot-throw is removed per plan 1.8). Phase 1 LEAD-context
 *   calls still force claude-code (rollout guard, R1 #8).
 *
 * Production callers SHOULD use `AgentTeamTransportFactory.fromEnv()` rather
 * than constructing adapters directly. Tests MAY construct adapters directly
 * with `ClaudeCodeAdapter`-specific options.
 */

import {
	ClaudeCodeAdapter,
	type ClaudeCodeAdapterOptions,
} from "./claude/ClaudeCodeAdapter.js";
import { CodexAdapter } from "./codex/CodexAdapter.js";
import type { IAgentTeamTransport } from "./types.js";

export type SupportedBackend = "claude-code" | "codex";

export interface FactoryOptions {
	/** Override env-based backend selection (mostly for tests). */
	backend?: SupportedBackend;
	/** Adapter-specific options (passed through to selected adapter). */
	claudeCode?: ClaudeCodeAdapterOptions;
	/**
	 * FLY-123 (Codex design review R1 #8): rollout guard context. During
	 * Phase 1 the LEAD transport is locked to claude-code — a process-wide
	 * `FLYWHEEL_AGENT_BACKEND=codex` must not flip a still-Claude Lead's
	 * Agent-Team flag chain. Callers on the Lead path pass
	 * `context: "lead"`; the factory then forces claude-code with a loud
	 * stderr warning instead of honoring the env.
	 */
	context?: "lead" | "runner";
}

export class AgentTeamTransportFactory {
	/**
	 * Build adapter based on `FLYWHEEL_AGENT_BACKEND` env (default
	 * `claude-code`).
	 *
	 * FLY-123 (plan 1.8): `codex` returns the real CodexAdapter — the
	 * pre-Spike-δ boot-throw is gone. `context: "lead"` forces claude-code
	 * during Phase 1 (see below).
	 */
	static fromEnv(options: FactoryOptions = {}): IAgentTeamTransport {
		const backend = (options.backend ??
			AgentTeamTransportFactory.resolveBackendFromEnv()) as SupportedBackend;

		// FLY-123 Phase 1 rollout guard (Codex R1 #8): Lead transport is
		// locked to claude-code. Defensive fallback + loud warning — never
		// break a still-Claude Lead because of a process-wide env.
		if (options.context === "lead" && backend === "codex") {
			process.stderr.write(
				"[AgentTeamTransportFactory] FLYWHEEL_AGENT_BACKEND=codex ignored on the LEAD path — " +
					"Phase 1 (FLY-123) locks Lead transport to claude-code. " +
					"Runner executor backend is selected separately via FLYWHEEL_RUNNER_BACKEND / roles config.\n",
			);
			return new ClaudeCodeAdapter(options.claudeCode);
		}

		return AgentTeamTransportFactory.forBackend(backend, options);
	}

	/**
	 * FLY-123 (Codex design review R4 #1): explicit backend selection for
	 * paths that must route by the TARGET runner's backend, not by the
	 * process-wide env — e.g. the no-block gate response mailbox wake. The
	 * wake for a Codex runner must reach the Codex mailbox even though the
	 * Bridge process env says claude-code.
	 *
	 * Mapping from executor backend ("codex-tmux") to transport backend
	 * ("codex") lives in ONE typed place:
	 * `role-adapter-resolver.EXECUTOR_TO_TRANSPORT` (R5 note #2) — callers
	 * pass the already-mapped transport backend here.
	 */
	static forBackend(
		backend: SupportedBackend,
		options: FactoryOptions = {},
	): IAgentTeamTransport {
		switch (backend) {
			case "claude-code":
				return new ClaudeCodeAdapter(options.claudeCode);
			case "codex":
				return new CodexAdapter();
			default:
				throw new Error(
					`Unsupported agent-team transport backend: ${backend}. ` +
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
