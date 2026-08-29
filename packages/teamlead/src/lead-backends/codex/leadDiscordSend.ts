/**
 * FLY-224 Phase 7 — buildLeadDiscordSend: the outbound `DiscordSendFn` the Bridge
 * `/api/lead-outbound/send` handler uses to actually post a Codex Lead's reply to
 * Discord (plan §6.4). Reuses the existing raw-REST helper
 * `postDiscordMessageToChannel` (chunking + `allowed_mentions:{parse:[]}` ping
 * safety) — no new Discord dependency.
 *
 * The per-Lead bot token is resolved server-side via the injected `resolveBotToken`
 * (keyed by leadId) and NEVER travels in the request. Returns the first chunk's
 * message id (the handler records it for durable dedup).
 *
 * Note: the durable idempotencyKey dedup in CodexLeadOutboundHandler is the
 * exactly-once AUTHORITY; the `nonce` is a secondary in-window guard and is NOT
 * forwarded to Discord here (the shared helper takes no nonce, and modifying it is
 * out of scope) — a clean follow-up if we want the Discord-side guard too.
 */

import { postDiscordMessageToChannel } from "../../bridge/discord-utils.js";
import type { DiscordSendFn } from "./CodexLeadOutboundHandler.js";

export interface BuildLeadDiscordSendOptions {
	/** (projectName, leadId) → that Lead's Discord bot token (server-side resolution,
	 * project-scoped so a reused agentId can't pull another project's token). */
	resolveBotToken: (projectName: string, leadId: string) => string | undefined;
	fetchImpl?: typeof fetch;
}

export function buildLeadDiscordSend(
	opts: BuildLeadDiscordSendOptions,
): DiscordSendFn {
	const fetchImpl = opts.fetchImpl ?? fetch;
	return async ({ projectName, leadId, channelId, text }) => {
		const token = opts.resolveBotToken(projectName, leadId);
		if (!token) {
			throw new Error(
				`buildLeadDiscordSend: no bot token for lead ${leadId} in project ${projectName}`,
			);
		}
		const res = await postDiscordMessageToChannel(
			channelId,
			text,
			token,
			{ origin: "lead_authored" },
			fetchImpl,
		);
		if (!res.ok) {
			throw new Error(res.error ?? "discord post failed");
		}
		const messageId = res.messageIds[0];
		if (!messageId) {
			throw new Error("discord post returned no message id");
		}
		return messageId;
	};
}
