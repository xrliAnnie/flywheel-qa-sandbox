/**
 * FLY-350 — lead-actions MCP entrypoint: the narrow proactive-action channel
 * shared by full-access Codex Leads (the FLY-245 gateway's sibling).
 *
 * A stdio MCP server (app-server child), spawned from the trusted teamlead dist.
 * The parent runtime's selected outbound credential is forwarded to the child
 * by env-var name and resolved at startup. Bridge mode has no direct fallback;
 * direct mode retains the existing Discord-token path.
 *
 * Tool surface (FLY-350): `discord_send(target, text)` — proactive send to an
 * ALLOWLISTED channel alias only ("chat"/"roundtable"); the channel id is
 * resolved server-side (the model cannot pass a raw id), rate-limited, durably
 * idempotent through the Bridge outbox, and audited. Linear create/assign tools are
 * a FLY-351 follow-on (they slot into this same server once the growth Linear
 * project + prefix exist; until then a Codex Lead has no place to route them).
 *
 * Discipline mirrors gateway-main.ts: the pure pieces (alias-allowlist,
 * send-guard, config) are unit-tested; THIS assembly glue is validated by the
 * §10 real-machine QA (config gate / non-allowlist send).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { appendRotatedLogSync } from "flywheel-config";
import { CodexOutboundSender } from "../CodexOutboundSender.js";
import { runDiscordSend } from "../discord-send-core.js";
import { parseLeadActionsConfig } from "./config.js";
import { LEAD_ACTIONS_TOOLS } from "./mcp-config.js";
import {
	SendIdempotencyCache,
	SlidingWindowRateLimiter,
} from "./send-guard.js";

// FLY-350 code-review MED-4: tie the registered tool name to the SHARED constant
// (single source of truth with the §10 gate's LEAD_ACTIONS_TOOLS). The server
// exposes EXACTLY one tool; assert that invariant at load so the literal
// below and the gate constant can never drift apart.
const DISCORD_SEND_TOOL = "discord_send";
const ACK_BATCH_TOOL = "ack_batch";
if (
	LEAD_ACTIONS_TOOLS.length !== 2 ||
	LEAD_ACTIONS_TOOLS[0] !== DISCORD_SEND_TOOL ||
	LEAD_ACTIONS_TOOLS[1] !== ACK_BATCH_TOOL
) {
	throw new Error(
		`lead-actions: LEAD_ACTIONS_TOOLS must be exactly ${JSON.stringify([DISCORD_SEND_TOOL, ACK_BATCH_TOOL])} (got ${JSON.stringify(LEAD_ACTIONS_TOOLS)})`,
	);
}

/**
 * Resolve the Bridge API token from the MCP child's env, fail-closed. The
 * runtime forwards it BY NAME via `env_vars`, never as a literal in argv or
 * config.toml. The child deliberately has no Discord credential.
 */
export function resolveLeadActionsApiToken(env: NodeJS.ProcessEnv): string {
	const token = env.TEAMLEAD_API_TOKEN?.trim();
	if (!token) {
		throw new Error(
			"lead-actions: TEAMLEAD_API_TOKEN is absent from the MCP child env (fail-closed)",
		);
	}
	return token;
}

/** Resolve the Discord credential for a direct-mode MCP child, fail-closed. */
export function resolveLeadActionsBotToken(env: NodeJS.ProcessEnv): string {
	const token = env.DISCORD_BOT_TOKEN?.trim();
	if (!token) {
		throw new Error(
			"lead-actions: DISCORD_BOT_TOKEN is absent from the direct-mode MCP child env (fail-closed)",
		);
	}
	return token;
}

export function resolveLeadActionEventId(
	requestedEventId: string | undefined,
	target: string,
	text: string,
	allocate: (target: string, text: string) => string,
): string {
	return requestedEventId ?? allocate(target, text);
}

/**
 * Assemble + run the lead-actions MCP server: env token → McpServer →
 * discord_send tool → stdio transport (awaits forever in production).
 */
export async function leadActionsMain(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const cfg = parseLeadActionsConfig(env);
	mkdirSync(cfg.stateDir, { recursive: true });

	// Resolve only the credential selected by the parent runtime. Each mode fails
	// closed independently and never falls back to the other transport.
	let botToken: string | undefined;
	let outbound: CodexOutboundSender | undefined;
	if (cfg.outboundMode === "bridge") {
		if (!cfg.bridgeUrl) {
			throw new Error(
				"lead-actions: bridge mode parsed without BRIDGE_URL (invariant violation)",
			);
		}
		outbound = new CodexOutboundSender({
			bridgeUrl: cfg.bridgeUrl,
			apiToken: resolveLeadActionsApiToken(env),
			projectName: cfg.projectName,
			leadId: cfg.leadId,
			channelId: cfg.chatChannelId,
			dbPath: join(cfg.stateDir, "lead-actions-outbox.db"),
			proactiveEventIdTtlMs: cfg.idempotencyTtlMs,
		});
	} else {
		botToken = resolveLeadActionsBotToken(env);
	}

	const rateLimiter = new SlidingWindowRateLimiter({
		maxPerWindow: cfg.rateMaxPerWindow,
		windowMs: cfg.rateWindowMs,
	});
	const idempotency = new SendIdempotencyCache(cfg.idempotencyTtlMs);
	const auditPath = join(cfg.stateDir, "lead-actions-audit.jsonl");
	// code-review MED-5 + R2 LOW-4: ensure the audit dir exists AND prove the audit
	// log is writable BEFORE registering the send tool — a Lead with no
	// auditable proactive-send path must refuse to start (fail-closed), rather than
	// silently send unaudited later. mkdir + one probe append; either throwing
	// aborts startup. After this proves writability, runtime appends stay best-effort
	// (a mid-run disk error must not wedge an otherwise-working chat companion — but
	// the boot probe guarantees the common misconfig is caught loudly).
	// NOTE: idempotency/rate-limit are in-process (loop-safety within a live
	// process — FLY-220); cross-restart exactly-once is intentionally out of scope
	// (a restart-window duplicate is acceptable for a chat companion, same trade-off
	// as direct reactive outbound).
	appendRotatedLogSync(
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
			eventId: z
				.string()
				.trim()
				.min(1)
				.max(200)
				.optional()
				.describe(
					"Stable business event id. Reuse only with the exact same target and text.",
				),
		},
		async ({ target, text, eventId: requestedEventId }) => {
			let effectiveEventId = requestedEventId;
			// FLY-350 (R1-4): delegate to the SHARED send core (alias gate →
			// idempotency → rate limit → post → record → metadata audit). The
			// gateway uses the exact same core, so full-access and write-capable
			// paths can never drift.
			const r = await runDiscordSend(target, text, {
				chatChannelId: cfg.chatChannelId,
				crossDeptChannelIds: cfg.crossDeptChannelIds,
				explicitAliases: cfg.explicitAliases,
				...(outbound
					? {
							bridgeSend: async ({
								channelId,
								text: outboundText,
								idempotencyKey,
							}: {
								channelId: string;
								text: string;
								idempotencyKey: string;
							}) => {
								const outboxId = await outbound.enqueue({
									leadId: cfg.leadId,
									text: outboundText,
									idempotencyKey,
									channelId,
								});
								const result = await outbound.deliverWithResult(outboxId);
								if (!result.messageId) {
									throw new Error(
										`Bridge result for ${outboxId} has no durable messageId`,
									);
								}
								return result as { messageId: string; deduped: boolean };
							},
							allocateEventId: (
								resolvedTarget: string,
								outboundText: string,
							) => {
								effectiveEventId = resolveLeadActionEventId(
									requestedEventId,
									resolvedTarget,
									outboundText,
									(targetAlias, body) =>
										outbound.allocateEventId(targetAlias, body),
								);
								return effectiveEventId;
							},
						}
					: { botToken }),
				eventId: requestedEventId,
				rateLimiter,
				idempotency,
				auditPath,
				leadId: cfg.leadId,
				projectName: cfg.projectName,
				roundtableAutoContinue: cfg.roundtableAutoContinue,
			});
			return asText(
				`${r.text}${effectiveEventId ? ` [eventId=${effectiveEventId}]` : ""}`,
				r.isError,
			);
		},
	);

	const commDb = new CommDB(cfg.commDbPath);
	server.tool(
		ACK_BATCH_TOOL,
		"Acknowledge a durable mailbox batch after processing every message in it. Use the batch_id from the mailbox-batch header. Idempotent; late acknowledgements are safe.",
		{
			batch_id: z.string().min(1).describe("The durable mailbox batch id"),
		},
		async ({ batch_id }) => {
			const batchId = batch_id.trim();
			try {
				commDb.insertBatchAckReceipt(cfg.leadId, batchId);
				return asText(`batch ACK queued: ${batchId}`);
			} catch (error) {
				return asText(`Error: ${(error as Error).message}`, true);
			}
		},
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(
		`[lead-actions] ${cfg.leadId}@${cfg.projectName} ready (chat=${cfg.chatChannelId}, crossDept=${cfg.crossDeptChannelIds.length}, outbound=${cfg.outboundMode}, discordCredential=${cfg.outboundMode === "direct" ? "present" : "absent"}, mailboxAck=enabled)\n`,
	);
}

// Run when executed directly (the app-server MCP config points here).
if (process.argv[1]?.includes("lead-actions-main")) {
	leadActionsMain().catch((err) => {
		process.stderr.write(`[lead-actions] fatal: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
