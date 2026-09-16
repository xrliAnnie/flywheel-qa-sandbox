import {
	computeChannelPermissions,
	type DiscordPermissionOverwrite,
	type DiscordPermissionRole,
	DISCORD_PERMISSIONS as P,
} from "./channel-permissions.js";
import { DISCORD_API } from "./discord-utils.js";
import { probeVoiceSelfFilter } from "./voice-self-filter-probe.js";
import { VoiceSessionHttpError } from "./voice-session-routes.js";
import type { VoiceStartPreflightInput } from "./voice-session-start.js";

export interface VoicePreflightEvidence {
	checkedAt: string;
	stage:
		| "identity"
		| "member"
		| "roles"
		| "voice_channel"
		| "text_channel"
		| "self_filter"
		| "gateway"
		| "ready";
	httpStatus: number | null;
	identityVerified: boolean;
	voicePermissions: boolean | null;
	textPermissions: boolean | null;
	gatewayRemaining: number | null;
	selfFilter: {
		runtimeId: string;
		botUserId: string;
		contractVersion: 1;
		ready: boolean;
		selfDropped: boolean;
		unknownDropped: boolean;
		otherPassed: boolean;
	} | null;
}
export class VoicePreflightError extends VoiceSessionHttpError {
	readonly stage: VoicePreflightEvidence["stage"];
	readonly httpStatus: number | null;
	constructor(
		reason: string,
		readonly evidence: VoicePreflightEvidence,
	) {
		super(503, "voice_unavailable", reason);
		this.stage = evidence.stage;
		this.httpStatus = evidence.httpStatus;
	}
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("payload");
	return value as Record<string, unknown>;
}
function id(value: unknown): value is string {
	return typeof value === "string" && /^\d{17,20}$/.test(value);
}
function permission(value: unknown): value is string {
	return typeof value === "string" && /^\d+$/.test(value);
}
function overwrites(value: unknown): DiscordPermissionOverwrite[] {
	if (!Array.isArray(value)) throw new Error("payload");
	for (const entry of value) {
		const o = record(entry);
		if (
			!id(o.id) ||
			(o.type !== 0 && o.type !== 1) ||
			!permission(o.allow) ||
			!permission(o.deny)
		)
			throw new Error("payload");
	}
	return value as DiscordPermissionOverwrite[];
}

export async function preflightVoiceSession(
	input: VoiceStartPreflightInput,
	deps: {
		fetchImpl?: typeof fetch;
		probeSelfFilter?: typeof probeVoiceSelfFilter;
	} = {},
): Promise<VoicePreflightEvidence> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const room = input.project.voiceRoom;
	const evidence: VoicePreflightEvidence = {
		checkedAt: new Date().toISOString(),
		stage: "identity",
		httpStatus: null,
		identityVerified: false,
		voicePermissions: null,
		textPermissions: null,
		gatewayRemaining: null,
		selfFilter: null,
	};
	const fail = (reason: string): never => {
		throw new VoicePreflightError(reason, { ...evidence });
	};
	if (!room) fail("voice_room_missing");
	if (input.project.huddle != null) fail("legacy_voice_conflict");
	if (!input.voiceBotToken || !id(input.lead.botUserId)) fail("bot_env_unset");
	const botId = input.lead.botUserId!;
	const json = async (
		stage: VoicePreflightEvidence["stage"],
		path: string,
	): Promise<unknown> => {
		evidence.stage = stage;
		evidence.httpStatus = null;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				(async () => {
					const response = await fetchImpl(`${DISCORD_API}${path}`, {
						method: "GET",
						headers: { Authorization: `Bot ${input.voiceBotToken}` },
						signal: controller.signal,
					});
					if (controller.signal.aborted) throw new Error("aborted");
					evidence.httpStatus = response.status;
					if (!response.ok)
						fail(
							response.status === 403 && stage === "voice_channel"
								? "voice_permissions"
								: response.status === 403 && stage === "text_channel"
									? "lead_text_permissions"
									: `discord_http_${response.status}`,
						);
					try {
						return await response.json();
					} catch {
						return fail("discord_payload_invalid");
					}
				})(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new VoicePreflightError("discord_timeout", { ...evidence }));
					}, 2000);
				}),
			]);
		} catch (error) {
			if (error instanceof VoicePreflightError) throw error;
			return fail("discord_preflight");
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		const identity = record(await json("identity", "/users/@me"));
		if (!id(identity.id)) fail("discord_payload_invalid");
		if (identity.id !== botId) fail("lead_bot_identity_mismatch");
		evidence.identityVerified = true;
		const member = record(
			await json("member", `/guilds/${room!.guildId}/members/${botId}`),
		);
		if (!Array.isArray(member.roles) || !member.roles.every(id))
			fail("discord_payload_invalid");
		const roles = await json("roles", `/guilds/${room!.guildId}/roles`);
		if (
			!Array.isArray(roles) ||
			!roles.every((role) => {
				const r = record(role);
				return id(r.id) && permission(r.permissions);
			})
		)
			fail("discord_payload_invalid");
		const channelPermissions = (
			channel: unknown,
			expectedId: string,
		): bigint => {
			const c = record(channel);
			if (c.id !== expectedId) fail("discord_payload_invalid");
			return computeChannelPermissions({
				guildId: room!.guildId,
				memberId: botId,
				memberRoleIds: member.roles as string[],
				roles: roles as DiscordPermissionRole[],
				overwrites: overwrites(c.permission_overwrites),
			});
		};
		const voicePermissions = channelPermissions(
			await json("voice_channel", `/channels/${room!.voiceChannelId}`),
			room!.voiceChannelId,
		);
		evidence.voicePermissions = [P.VIEW_CHANNEL, P.CONNECT, P.SPEAK].every(
			(bit) => (voicePermissions & bit) !== 0n,
		);
		if (!evidence.voicePermissions) fail("voice_permissions");
		const textPermissions = channelPermissions(
			await json("text_channel", `/channels/${input.lead.chatChannel}`),
			input.lead.chatChannel,
		);
		evidence.textPermissions = [
			P.VIEW_CHANNEL,
			P.READ_MESSAGE_HISTORY,
			P.SEND_MESSAGES,
			P.CREATE_PUBLIC_THREADS,
			P.SEND_MESSAGES_IN_THREADS,
		].every((bit) => (textPermissions & bit) !== 0n);
		if (!evidence.textPermissions) fail("lead_text_permissions");
		evidence.stage = "self_filter";
		evidence.httpStatus = null;
		try {
			const proof = await (deps.probeSelfFilter ?? probeVoiceSelfFilter)({
				projectName: input.project.projectName,
				lead: input.lead,
				token: input.voiceBotToken,
			});
			if (
				proof.version !== 1 ||
				proof.leadId !== input.lead.agentId ||
				proof.botUserId !== botId ||
				!proof.ready ||
				!proof.selfDropped ||
				!proof.unknownDropped ||
				!proof.otherPassed
			)
				fail("self_filter_unverified");
			evidence.selfFilter = {
				runtimeId: proof.runtimeId,
				botUserId: proof.botUserId,
				contractVersion: 1,
				ready: proof.ready,
				selfDropped: proof.selfDropped,
				unknownDropped: proof.unknownDropped,
				otherPassed: proof.otherPassed,
			};
		} catch {
			fail("self_filter_unverified");
		}
		const gateway = record(await json("gateway", "/gateway/bot"));
		const remaining = record(gateway.session_start_limit).remaining;
		if (
			typeof remaining !== "number" ||
			!Number.isSafeInteger(remaining) ||
			remaining < 0
		)
			fail("gateway_session_limit_unverified");
		evidence.gatewayRemaining = remaining as number;
		if (remaining === 0) fail("gateway_session_limit");
		evidence.stage = "ready";
		return evidence;
	} catch (error) {
		if (error instanceof VoicePreflightError) throw error;
		return fail("discord_payload_invalid");
	}
}
