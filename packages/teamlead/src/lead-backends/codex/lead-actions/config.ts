/**
 * FLY-350 — lead-actions MCP config parse (pure, fail-loud).
 *
 * The lead-actions MCP child (out-of-sandbox, spawned from trusted dist) reads
 * its config from env at startup — the SAME discipline as the FLY-245 gateway
 * (`parseGatewayConfig`). NO secrets here: the Discord bot token (and, later,
 * the Linear key) arrive only over the parent broker (`brokerSocketPath`). The
 * model never sees this env (read-deny shell + separate process).
 */

import { parseExplicitAliases } from "./alias-allowlist.js";

export interface LeadActionsConfig {
	leadId: string;
	projectName: string;
	/** Unix socket the parent runtime's SecretBroker listens on. */
	brokerSocketPath: string;
	/** The Lead's own chat channel (alias "chat"). */
	chatChannelId: string;
	/** Configured cross-department channels (alias "roundtable" when exactly one). */
	crossDeptChannelIds: string[];
	/** Explicit alias→channelId pins (disambiguate multi/zero roundtable). */
	explicitAliases: Record<string, string>;
	/** Dir for the durable proactive-send audit log. */
	stateDir: string;
	/** Per-channel send cap per window (loop-safety). */
	rateMaxPerWindow: number;
	/** Rate-limit window length (ms). */
	rateWindowMs: number;
	/** Idempotency TTL (ms) — a repeat (channel, text) within this collapses. */
	idempotencyTtlMs: number;
}

function posIntEnv(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse + validate the lead-actions env. Fail-loud: lists ALL missing required
 * vars at once. crossDept may be empty (then "roundtable" is unavailable —
 * resolveChannelAlias fails closed at call time). */
export function parseLeadActionsConfig(
	env: NodeJS.ProcessEnv,
): LeadActionsConfig {
	const missing: string[] = [];
	const req = (name: string): string => {
		const v = env[name]?.trim();
		if (!v) missing.push(name);
		return v ?? "";
	};
	const leadId = req("FLYWHEEL_LEAD_ID");
	const projectName = req("FLYWHEEL_PROJECT_NAME");
	const brokerSocketPath = req("FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET");
	const chatChannelId = req("FLYWHEEL_LEAD_CHAT_CHANNEL_ID");
	const stateDir = req("FLYWHEEL_LEAD_ACTIONS_STATE_DIR");
	if (missing.length > 0) {
		throw new Error(
			`lead-actions: missing required env: ${missing.join(", ")}`,
		);
	}
	if (/[/\\]|\.\./.test(projectName)) {
		throw new Error(`lead-actions: invalid project name "${projectName}"`);
	}
	const crossDeptChannelIds = (env.FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return {
		leadId,
		projectName,
		brokerSocketPath,
		chatChannelId,
		crossDeptChannelIds,
		explicitAliases: parseExplicitAliases(
			env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES,
		),
		stateDir,
		rateMaxPerWindow: posIntEnv(env.FLYWHEEL_LEAD_ACTIONS_RATE_MAX, 5),
		rateWindowMs: posIntEnv(env.FLYWHEEL_LEAD_ACTIONS_RATE_WINDOW_MS, 60_000),
		idempotencyTtlMs: posIntEnv(
			env.FLYWHEEL_LEAD_ACTIONS_IDEMPOTENCY_TTL_MS,
			60_000,
		),
	};
}
