/**
 * FLY-350 — lead-actions MCP config parse (pure, fail-loud).
 *
 * The lead-actions MCP child (out-of-sandbox, spawned from trusted dist) reads
 * its coordinates from env at startup — the SAME discipline as the FLY-245
 * gateway (`parseGatewayConfig`). The Discord bot token is resolved separately
 * by the entrypoint and never stored in this config object.
 */

import { parseExplicitAliases } from "./alias-allowlist.js";

export interface LeadActionsConfig {
	leadId: string;
	projectName: string;
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
	/** FLY-676 — EFFECTIVE roundtable autoContinue, computed by the RUNTIME (replyInThread
	 * enabled && THREAD_AUTOCONTINUE !== "0") and forwarded as a non-secret coordinate. The
	 * child must NOT independently interpret raw THREAD_AUTOCONTINUE (it would misjudge
	 * default-on when REPLY_IN_THREAD is off — Codex R4#1). When true, a proactive
	 * `target="roundtable"` send is fail-soft refused (FLY-680). Default false (byte-compat). */
	roundtableAutoContinue: boolean;
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
		// FLY-676: runtime-computed effective flag (NOT raw THREAD_AUTOCONTINUE). Default
		// false when absent → no proactive-roundtable refusal (byte-compat).
		roundtableAutoContinue:
			env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE === "1",
	};
}
