/**
 * FLY-350 — lead-actions MCP entrypoint: the narrow, out-of-sandbox action
 * channel for a content-coordination Codex Lead (the FLY-245 gateway's sibling).
 *
 * A stdio MCP server (app-server child, OUTSIDE the exec sandbox), spawned from
 * the TRUSTED teamlead dist. SECRETLESS at spawn: the Discord bot token arrives
 * at startup over the parent runtime's unix-socket broker (Phase E) and lives
 * only in this process's memory — never in the model's env/shell/argv (the model
 * is read-deny + a separate process).
 *
 * Tool surface (FLY-350): `discord_send(target, text)` — proactive send to an
 * ALLOWLISTED channel alias only ("chat"/"roundtable"); the channel id is
 * resolved server-side (the model cannot pass a raw id), rate-limited + made
 * idempotent (FLY-220 loop-safety), and audited. Linear create/assign tools are
 * a FLY-351 follow-on (they slot into this same server once the growth Linear
 * project + prefix exist; until then a Codex Lead has no place to route them).
 *
 * Discipline mirrors gateway-main.ts: the pure pieces (alias-allowlist,
 * send-guard, config) are unit-tested; THIS assembly glue is validated by the
 * §10 real-machine QA (broker-socket connect / read-deny / non-allowlist send).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runDiscordSend } from "../discord-send-core.js";
import { fetchSecretsFromBroker } from "../secret-broker.js";
import type { LeadActionsConfig } from "./config.js";
import { parseLeadActionsConfig } from "./config.js";
import { LEAD_ACTIONS_TOOLS } from "./mcp-config.js";
import {
	SendIdempotencyCache,
	SlidingWindowRateLimiter,
} from "./send-guard.js";

// FLY-350 code-review MED-4: tie the registered tool name to the SHARED constant
// (single source of truth with the §10 gate's LEAD_ACTIONS_TOOLS). The content
// profile exposes EXACTLY one tool; assert that invariant at load so the literal
// below and the gate constant can never drift apart.
const DISCORD_SEND_TOOL = "discord_send";
if (
	LEAD_ACTIONS_TOOLS.length !== 1 ||
	LEAD_ACTIONS_TOOLS[0] !== DISCORD_SEND_TOOL
) {
	throw new Error(
		`lead-actions: LEAD_ACTIONS_TOOLS must be exactly ["${DISCORD_SEND_TOOL}"] (got ${JSON.stringify(LEAD_ACTIONS_TOOLS)})`,
	);
}

/**
 * FLY-304 — resolve the Discord bot token by config MODE, fail-closed.
 *  - "broker" (content-coordination): fetch over the parent SecretBroker unix
 *    socket — the token never touches the model env/config (UNCHANGED).
 *  - "env-token" (full-access): read DISCORD_BOT_TOKEN from the MCP child's own
 *    env. A full-access Lead has no broker but already carries the token in its
 *    allowlisted env (Claude-equal); the runtime forwards it BY NAME via
 *    `env_vars`, never as a literal in argv.
 * Either path throws (fail-closed) if no token is available — a proactive-send
 * server with no token must refuse to start, not limp along.
 */
export async function resolveLeadActionsBotToken(
	cfg: Pick<LeadActionsConfig, "mode" | "brokerSocketPath">,
	env: NodeJS.ProcessEnv,
	deps: { fetchBroker: typeof fetchSecretsFromBroker } = {
		fetchBroker: fetchSecretsFromBroker,
	},
): Promise<string> {
	if (cfg.mode === "broker") {
		if (!cfg.brokerSocketPath) {
			throw new Error(
				"lead-actions: broker mode requires a broker socket path (fail-closed)",
			);
		}
		const secrets = await deps.fetchBroker(cfg.brokerSocketPath);
		const token = secrets.DISCORD_BOT_TOKEN;
		if (!token) {
			throw new Error(
				"lead-actions: broker did not supply DISCORD_BOT_TOKEN (fail-closed)",
			);
		}
		return token;
	}
	// env-token (full-access)
	const token = env.DISCORD_BOT_TOKEN?.trim();
	if (!token) {
		throw new Error(
			"lead-actions: env-token mode but DISCORD_BOT_TOKEN is absent from the MCP child env (fail-closed)",
		);
	}
	return token;
}

/**
 * Assemble + run the lead-actions MCP server: token (broker | env) → McpServer →
 * discord_send tool → stdio transport (awaits forever in production).
 */
export async function leadActionsMain(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const cfg = parseLeadActionsConfig(env);

	// FLY-304: token by MODE — broker (content-coordination) or env (full-access);
	// fail-closed if absent (a secretless action server must refuse, not limp along).
	const botToken = await resolveLeadActionsBotToken(cfg, env);

	const rateLimiter = new SlidingWindowRateLimiter({
		maxPerWindow: cfg.rateMaxPerWindow,
		windowMs: cfg.rateWindowMs,
	});
	const idempotency = new SendIdempotencyCache(cfg.idempotencyTtlMs);
	const auditPath = join(cfg.stateDir, "lead-actions-audit.jsonl");
	// code-review MED-5 + R2 LOW-4: ensure the audit dir exists AND prove the audit
	// log is writable BEFORE registering the send tool — a content Lead with no
	// auditable proactive-send path must refuse to start (fail-closed), rather than
	// silently send unaudited later. mkdir + one probe append; either throwing
	// aborts startup. After this proves writability, runtime appends stay best-effort
	// (a mid-run disk error must not wedge an otherwise-working chat companion — but
	// the boot probe guarantees the common misconfig is caught loudly).
	// NOTE: idempotency/rate-limit are in-process (loop-safety within a live
	// process — FLY-220); cross-restart exactly-once is intentionally out of scope
	// (a restart-window duplicate is acceptable for a chat companion, same trade-off
	// as direct reactive outbound).
	mkdirSync(cfg.stateDir, { recursive: true });
	appendFileSync(
		auditPath,
		`${JSON.stringify({ ts: Date.now(), leadId: cfg.leadId, project: cfg.projectName, outcome: "audit_probe" })}\n`,
	);

	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { StdioServerTransport } = await import(
		"@modelcontextprotocol/sdk/server/stdio.js"
	);
	const { z } = await import("zod");

	const server = new McpServer({
		name: "flywheel-lead-actions",
		version: "0.1.0",
	});

	const asText = (text: string, isError = false) => ({
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
	});

	server.tool(
		DISCORD_SEND_TOOL,
		"Proactively post a message to one of YOUR allowlisted channels. `target` " +
			'is an ALIAS ("chat" = your own channel, "roundtable" = the cross-' +
			"department channel), NOT a channel id. Use this to START a message " +
			"(reactive replies are sent automatically — no tool needed).",
		{
			target: z
				.string()
				.describe('Channel alias: "chat" or "roundtable" (not a raw id)'),
			text: z.string().min(1).describe("Message text to post"),
		},
		async ({ target, text }) => {
			// FLY-350 (R1-4): delegate to the SHARED send core (alias gate →
			// idempotency → rate limit → post → record → metadata audit). The
			// gateway uses the exact same core, so the content-coordination and
			// write-capable paths can never drift.
			const r = await runDiscordSend(target, text, {
				chatChannelId: cfg.chatChannelId,
				crossDeptChannelIds: cfg.crossDeptChannelIds,
				explicitAliases: cfg.explicitAliases,
				botToken,
				rateLimiter,
				idempotency,
				auditPath,
				leadId: cfg.leadId,
				projectName: cfg.projectName,
			});
			return asText(r.text, r.isError);
		},
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(
		`[lead-actions] ${cfg.leadId}@${cfg.projectName} ready (chat=${cfg.chatChannelId}, crossDept=${cfg.crossDeptChannelIds.length})\n`,
	);
}

// Run when executed directly (the app-server MCP config points here).
if (process.argv[1]?.includes("lead-actions-main")) {
	leadActionsMain().catch((err) => {
		process.stderr.write(`[lead-actions] fatal: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
