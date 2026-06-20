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
import { postDiscordMessageToChannel } from "../../../bridge/discord-utils.js";
import { fetchSecretsFromBroker } from "../secret-broker.js";
import {
	AliasResolutionError,
	resolveChannelAlias,
} from "./alias-allowlist.js";
import { parseLeadActionsConfig } from "./config.js";
import {
	deriveSendIdempotencyKey,
	SendIdempotencyCache,
	SlidingWindowRateLimiter,
} from "./send-guard.js";

/** Append one durable audit row (metadata only — never the message text). */
function appendAudit(auditPath: string, row: Record<string, unknown>): void {
	try {
		appendFileSync(auditPath, `${JSON.stringify(row)}\n`);
	} catch {
		// best-effort audit — never fail a send because the audit append failed.
	}
}

/**
 * Assemble + run the lead-actions MCP server: broker secret → McpServer →
 * discord_send tool → stdio transport (awaits forever in production).
 */
export async function leadActionsMain(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const cfg = parseLeadActionsConfig(env);

	// Secret ONLY via the parent broker — fail-closed (a secretless action server
	// must refuse, not limp along).
	const secrets = await fetchSecretsFromBroker(cfg.brokerSocketPath);
	const botToken = secrets.DISCORD_BOT_TOKEN;
	if (!botToken) {
		throw new Error(
			"lead-actions: broker did not supply DISCORD_BOT_TOKEN (fail-closed)",
		);
	}

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
		"discord_send",
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
			// Authority is DERIVED server-side: alias → channel id, fail-closed.
			let channelId: string;
			try {
				channelId = resolveChannelAlias(target, {
					chatChannelId: cfg.chatChannelId,
					crossDeptChannelIds: cfg.crossDeptChannelIds,
					explicitAliases: cfg.explicitAliases,
				});
			} catch (e) {
				const msg =
					e instanceof AliasResolutionError
						? e.message
						: e instanceof Error
							? e.message
							: String(e);
				return asText(`REFUSED: ${msg}`, true);
			}

			const now = Date.now();
			const key = deriveSendIdempotencyKey(channelId, text);
			const prior = idempotency.get(key, now);
			if (prior) {
				return asText(
					`Already sent (idempotent) to ${target} → message ${prior}`,
				);
			}
			if (!rateLimiter.tryAcquire(channelId, now)) {
				appendAudit(auditPath, {
					ts: now,
					leadId: cfg.leadId,
					project: cfg.projectName,
					target,
					channelId,
					outcome: "rate_limited",
				});
				return asText(
					`REFUSED: per-channel rate limit reached for ${target} (loop-safety) — try again shortly`,
					true,
				);
			}

			let res: Awaited<ReturnType<typeof postDiscordMessageToChannel>>;
			try {
				res = await postDiscordMessageToChannel(channelId, text, botToken);
			} catch (e) {
				return asText(
					`REFUSED: discord send threw: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
			if (!res.ok) {
				return asText(`REFUSED: discord send failed: ${res.error}`, true);
			}
			const messageId = res.messageIds[0] ?? "";
			idempotency.record(key, messageId, now);
			appendAudit(auditPath, {
				ts: now,
				leadId: cfg.leadId,
				project: cfg.projectName,
				target,
				channelId,
				messageId,
				textLen: text.length,
				outcome: "sent",
			});
			return asText(`Sent to ${target} (${channelId}) → message ${messageId}`);
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
