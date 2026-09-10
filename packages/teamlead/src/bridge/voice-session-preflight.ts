import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	probeCodexLeadInboxCapabilities,
	resolveCodexLeadInboxSocketPath,
} from "../lead-backends/codex/CodexLeadInboxSocket.js";
import { effectiveLeadBackend } from "../lead-backends/lead-backend.js";
import {
	computeChannelPermissions,
	DISCORD_PERMISSIONS,
	type DiscordPermissionOverwrite,
	type DiscordPermissionRole,
} from "./channel-permissions.js";
import { DISCORD_API } from "./discord-utils.js";
import { resolveCodexLeadStateDir } from "./lead-inbox-runtime.js";
import { VoiceSessionHttpError } from "./voice-session-routes.js";
import type { VoiceStartPreflightInput } from "./voice-session-start.js";

interface DiscordMember {
	roles: string[];
}

interface DiscordChannel {
	id: string;
	permission_overwrites: DiscordPermissionOverwrite[];
}

function unavailable(reason: string): VoiceSessionHttpError {
	return new VoiceSessionHttpError(503, "voice_unavailable", reason);
}

async function discordJson<T>(
	path: string,
	token: string,
	fetchImpl: typeof fetch,
): Promise<T> {
	const response = await fetchImpl(`${DISCORD_API}${path}`, {
		headers: { Authorization: `Bot ${token}` },
	});
	if (!response.ok) throw unavailable(`discord_http_${response.status}`);
	return (await response.json()) as T;
}

function hasAll(actual: bigint, required: readonly bigint[]): boolean {
	return required.every((permission) => (actual & permission) !== 0n);
}

export async function preflightVoiceSession(
	input: VoiceStartPreflightInput,
	deps: {
		fetchImpl?: typeof fetch;
		probeCapabilities?: typeof probeCodexLeadInboxCapabilities;
	} = {},
): Promise<void> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const huddle = input.project.huddle!;
	try {
		const [voiceIdentity, leadIdentity] = await Promise.all([
			discordJson<{ id?: unknown }>(
				"/users/@me",
				input.voiceBotToken,
				fetchImpl,
			),
			discordJson<{ id?: unknown }>(
				"/users/@me",
				input.lead.botToken!,
				fetchImpl,
			),
		]);
		if (voiceIdentity.id !== huddle.orchestratorBotUserId) {
			throw unavailable("voice_bot_identity_mismatch");
		}
		if (leadIdentity.id !== input.lead.botUserId) {
			throw unavailable("lead_bot_identity_mismatch");
		}

		const [voiceMember, leadMember, roles, voiceChannel, textChannel] =
			await Promise.all([
				discordJson<DiscordMember>(
					`/guilds/${huddle.guildId}/members/${huddle.orchestratorBotUserId}`,
					input.voiceBotToken,
					fetchImpl,
				),
				discordJson<DiscordMember>(
					`/guilds/${huddle.guildId}/members/${input.lead.botUserId}`,
					input.lead.botToken!,
					fetchImpl,
				),
				discordJson<DiscordPermissionRole[]>(
					`/guilds/${huddle.guildId}/roles`,
					input.voiceBotToken,
					fetchImpl,
				),
				discordJson<DiscordChannel>(
					`/channels/${huddle.voiceChannelId}`,
					input.voiceBotToken,
					fetchImpl,
				),
				discordJson<DiscordChannel>(
					`/channels/${input.lead.chatChannel}`,
					input.voiceBotToken,
					fetchImpl,
				),
			]);
		if (
			!Array.isArray(voiceMember.roles) ||
			!Array.isArray(leadMember.roles) ||
			!Array.isArray(roles) ||
			!Array.isArray(voiceChannel.permission_overwrites) ||
			!Array.isArray(textChannel.permission_overwrites)
		) {
			throw unavailable("discord_payload_invalid");
		}
		const voicePermissions = computeChannelPermissions({
			guildId: huddle.guildId,
			memberId: huddle.orchestratorBotUserId!,
			memberRoleIds: voiceMember.roles,
			roles,
			overwrites: voiceChannel.permission_overwrites,
		});
		if (
			!hasAll(voicePermissions, [
				DISCORD_PERMISSIONS.VIEW_CHANNEL,
				DISCORD_PERMISSIONS.CONNECT,
				DISCORD_PERMISSIONS.SPEAK,
			])
		) {
			throw unavailable("voice_permissions");
		}
		const voiceTextPermissions = computeChannelPermissions({
			guildId: huddle.guildId,
			memberId: huddle.orchestratorBotUserId!,
			memberRoleIds: voiceMember.roles,
			roles,
			overwrites: textChannel.permission_overwrites,
		});
		if (
			!hasAll(voiceTextPermissions, [
				DISCORD_PERMISSIONS.VIEW_CHANNEL,
				DISCORD_PERMISSIONS.READ_MESSAGE_HISTORY,
				DISCORD_PERMISSIONS.SEND_MESSAGES_IN_THREADS,
			])
		) {
			throw unavailable("voice_text_permissions");
		}
		const leadTextPermissions = computeChannelPermissions({
			guildId: huddle.guildId,
			memberId: input.lead.botUserId!,
			memberRoleIds: leadMember.roles,
			roles,
			overwrites: textChannel.permission_overwrites,
		});
		if (
			!hasAll(leadTextPermissions, [
				DISCORD_PERMISSIONS.VIEW_CHANNEL,
				DISCORD_PERMISSIONS.READ_MESSAGE_HISTORY,
				DISCORD_PERMISSIONS.SEND_MESSAGES,
				DISCORD_PERMISSIONS.CREATE_PUBLIC_THREADS,
			])
		) {
			throw unavailable("lead_text_permissions");
		}

		if (
			effectiveLeadBackend(input.lead.backend).backend === "codex-app-server"
		) {
			let capabilities: Awaited<
				ReturnType<typeof probeCodexLeadInboxCapabilities>
			>;
			try {
				capabilities = await (
					deps.probeCapabilities ?? probeCodexLeadInboxCapabilities
				)({
					socketPath: resolveCodexLeadInboxSocketPath(
						resolveCodexLeadStateDir(
							input.project.projectName,
							input.lead.agentId,
						),
					),
					leadId: input.lead.agentId,
					authSecret: input.lead.botToken!,
					timeoutMs: 2_000,
				});
			} catch {
				throw unavailable("native_pickup_config");
			}
			if (
				!capabilities ||
				!Array.isArray(capabilities.voiceMirrorIgnoredAuthorIds) ||
				!capabilities.voiceMirrorIgnoredAuthorIds.includes(
					huddle.orchestratorBotUserId!,
				)
			) {
				throw unavailable("native_pickup_mirror");
			}
		} else {
			const stateDir =
				input.lead.discordStateDir ??
				join(homedir(), ".claude", "channels", `discord-${input.lead.agentId}`);
			let access: { allowBots?: unknown };
			try {
				access = JSON.parse(
					readFileSync(join(stateDir, "access.json"), "utf8"),
				) as { allowBots?: unknown };
			} catch {
				throw unavailable("native_pickup_config");
			}
			if (
				Array.isArray(access.allowBots) &&
				access.allowBots.includes(huddle.orchestratorBotUserId)
			) {
				throw unavailable("native_pickup_mirror");
			}
		}
	} catch (error) {
		if (error instanceof VoiceSessionHttpError) throw error;
		throw unavailable("discord_preflight");
	}
}
