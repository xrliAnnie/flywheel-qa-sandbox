/**
 * FLY-929 W3b/W6 — Claude Infra Bot notify identity + digest helpers.
 *
 * P-identity (the ONE activation predicate for the whole notify-migration
 * surface): BOTH `CLAUDE_INFRA_BOT_TOKEN` and `FLYWHEEL_NOTIFY_CHANNEL` must be
 * set. Either missing ⇒ undefined = dormant, byte-compat. There is deliberately
 * NO token-only sender helper (Codex design R1#1): reports / standup / digest /
 * owner-mention all share this predicate, so FLY-928 writing the token into
 * .env early can never activate the migration ahead of the enable window
 * (`FLYWHEEL_NOTIFY_CHANNEL` is only written in the FLY-929 §6 enable window).
 *
 * Once P-identity holds there is NO silent fallback to the legacy sender on a
 * delivery failure — fail-loud is owned by the P-expect receipt check
 * (notify-digest-expect.ts). Digest posting here is best-effort by contract:
 * the Alerts-channel posts remain the authoritative incident record.
 */

import type { AccountRotationNotice } from "../account-heal/account-rotation-notice.js";
import {
	type PostDiscordResult,
	postDiscordMessageToChannel,
} from "./discord-utils.js";

export interface InfraNotifyIdentity {
	botToken: string;
	notifyChannelId: string;
}

/** P-identity: both envs present (trimmed non-empty) or the surface is dormant. */
export function resolveInfraNotifyIdentity(
	env: NodeJS.ProcessEnv = process.env,
): InfraNotifyIdentity | undefined {
	const botToken = env.CLAUDE_INFRA_BOT_TOKEN?.trim();
	const notifyChannelId = env.FLYWHEEL_NOTIFY_CHANNEL?.trim();
	if (!botToken || !notifyChannelId) return undefined;
	return { botToken, notifyChannelId };
}

/**
 * Sender-token resolution shared by the reports route (①) and the standup
 * service (③): the Claude Infra Bot when P-identity holds, else the exact
 * legacy fallback the caller passes in (byte-compat when dormant).
 */
export function infraSenderTokenOr(
	fallback: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return resolveInfraNotifyIdentity(env)?.botToken ?? fallback;
}

/**
 * FLY-929 A5 predicate — route a Claude account-cap needs_human to the OWNER
 * BOT (Codex Infra Bot assignment mention) instead of the immediate founder
 * escalation. BOTH must hold, else undefined = legacy founder routing:
 *   - P-identity (the FLY-929 migration surface is live),
 *   - `FLYWHEEL_INFRA_BOT_USER_ID` is a valid snowflake (malformed degrades to
 *     no-mention rather than a rejected allowed_mentions body).
 * (FLY-1243: the FLYWHEEL_ACCOUNT_SELF_HEAL gate is retired.)
 */
export function resolveAccountCapOwnerId(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	// FLY-1243: FLYWHEEL_ACCOUNT_SELF_HEAL retired — the infra-notify identity
	// (companion config) is the remaining gate.
	if (!resolveInfraNotifyIdentity(env)) return undefined;
	const id = env.FLYWHEEL_INFRA_BOT_USER_ID?.trim();
	return id && /^\d{17,20}$/.test(id) ? id : undefined;
}

/**
 * The owner-bot ASSIGNMENT post for an account-cap failure (no_account /
 * failed / not-attemptable). Mirrors the FLY-871 R2/W6 assignment wording so
 * the FLY-267 mention-gate wakes the bot to claim the incident (ARC). The T2
 * "can't fix" judgement (2 retries or 5 minutes) belongs to the bot playbook /
 * FLY-927 — this post only carries the handoff.
 */
export function formatAccountCapOwnerAssignment(
	ownerId: string,
	reason: string,
): string {
	return `<@${ownerId}> 请认领（ARC；修不掉判定 = 重试 2 次或 5 分钟，T2）：${reason}`;
}

/** Structured success payload for the W6 switch digest (see RepairDisposition.notifySuccess). */
export interface SwitchSuccessNotify {
	from?: string;
	to: string;
	scope?: "5h" | "weekly" | "both";
	resetAt?: string;
}

/**
 * W6 success digest — the Annie-facing RESULT line for #flywheel-notify.
 * Deliberately worded differently from the Alerts-channel disposition detail
 * (the bot-facing incident record) so the double-post never reads as a dup.
 * NEVER contains an @-mention.
 */
export function formatSwitchSuccessDigest(n: SwitchSuccessNotify): string {
	const arrow = n.from ? `${n.from} → ${n.to}` : `→ ${n.to}`;
	const parts: string[] = [];
	if (n.scope) parts.push(`${n.scope === "both" ? "5h+weekly" : n.scope} 到`);
	if (n.resetAt) parts.push(`reset ${n.resetAt}`);
	const suffix = parts.length ? `（${parts.join("，")}）` : "";
	return `🟡 Claude 账号已自动切换 ${arrow}${suffix}。新 session 用新账号；当前卡住的 session 等 reset（v1 不搬）。`;
}

/**
 * W6 rotation digest — built from the STRUCTURED account_rotation payload the
 * event route forwards (never re-parsed out of the Alerts line — Codex R1#3).
 */
export function formatRotationDigest(n: AccountRotationNotice): string {
	const provider =
		n.provider === "codex"
			? "Codex"
			: n.provider === "claude"
				? "Claude"
				: n.provider;
	const arrow = n.from ? `${n.from} → ${n.to}` : `→ ${n.to}`;
	const parts: string[] = [];
	if (n.reason) parts.push(ROTATION_REASON_LABEL[n.reason] ?? n.reason);
	if (n.resetAt) parts.push(`reset ${n.resetAt}`);
	const suffix = parts.length ? `（${parts.join("，")}）` : "";
	return `🔁 ${provider} 账号已自动轮转 ${arrow}${suffix}。新 session 用新账号。`;
}

/** Human labels for the fixed rotation reasons `flywheel-codex-with-fallback` emits. */
const ROTATION_REASON_LABEL: Record<string, string> = {
	rate_limit: "额度/限流",
	auth_expired: "认证过期",
	model_unsupported: "模型不支持",
};

export type PostTextFn = (
	channelId: string,
	content: string,
	botToken: string,
) => Promise<PostDiscordResult>;

/**
 * Post one digest line to #flywheel-notify as the Claude Infra Bot.
 * P-identity dormant → no-op (returns false). Best-effort: a delivery failure
 * is logged and never thrown — the Alerts record is the authority; the daily
 * token report has its own P-expect receipt check.
 */
export async function postInfraNotifyDigest(
	content: string,
	deps: {
		env?: NodeJS.ProcessEnv;
		postText?: PostTextFn;
		log?: (msg: string) => void;
	} = {},
): Promise<boolean> {
	const log = deps.log ?? ((m) => console.warn(m));
	const identity = resolveInfraNotifyIdentity(deps.env ?? process.env);
	if (!identity) return false;
	const post =
		deps.postText ??
		((channelId, text, botToken) =>
			postDiscordMessageToChannel(channelId, text, botToken, {
				origin: "automation",
			}));
	try {
		const result = await post(
			identity.notifyChannelId,
			content,
			identity.botToken,
		);
		if (!result.ok) {
			log(`[infra-notify] digest post failed: ${result.error}`);
			return false;
		}
		return true;
	} catch (err) {
		log(`[infra-notify] digest post threw: ${(err as Error).message}`);
		return false;
	}
}
