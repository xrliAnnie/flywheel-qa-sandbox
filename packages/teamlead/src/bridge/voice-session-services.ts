import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore, VoiceSessionRow } from "../StateStore.js";
import { loadVoiceHostConfig } from "../voice-host-config.js";
import { postDiscordMessageToChannel } from "./discord-utils.js";
import type { BridgeConfig } from "./types.js";
import { pollVoiceSessionOnce } from "./voice-session-poller.js";
import { preflightVoiceSession } from "./voice-session-preflight.js";
import {
	createDiscordVoiceProvisionerDeps,
	runVoiceProvisioner,
} from "./voice-session-provisioner.js";
import {
	createVoiceSessionRouter,
	VoiceSessionHttpError,
} from "./voice-session-routes.js";
import { VoiceSessionRuntime } from "./voice-session-runtime.js";
import { createVoiceStartResolver } from "./voice-session-start.js";

export function createVoiceSessionServices(input: {
	store: StateStore;
	projects: ProjectEntry[];
	config: BridgeConfig;
	env?: Readonly<Record<string, string | undefined>>;
	homeDir?: string;
	cwd?: string;
	fetchImpl?: typeof fetch;
}): {
	router: ReturnType<typeof createVoiceSessionRouter>;
	runtime: VoiceSessionRuntime;
} {
	const env = input.env ?? process.env;
	const homeDir = input.homeDir ?? homedir();
	const voiceHost = loadVoiceHostConfig({
		path: env.FLYWHEEL_VOICE_HOST_CONFIG,
		projects: input.projects,
		homeDir,
	});
	const timing = input.config.voiceSessionTiming ?? {
		leaseTtlMs: 15_000,
		leaseRenewMs: 4_000,
		leaseHttpTimeoutMs: 2_000,
		clockSkewGraceMs: 5_000,
		provisioningStaleMs: 120_000,
		endingTimeoutMs: 30_000,
		pollIntervalMs: 3_000,
	};
	const fetchImpl = input.fetchImpl ?? fetch;
	const discordDeps = createDiscordVoiceProvisionerDeps(fetchImpl);
	const resolve = (session: VoiceSessionRow) => {
		const project = input.projects.find(
			(candidate) => candidate.projectName === session.projectName,
		);
		const lead = project?.leads.find(
			(candidate) => candidate.agentId === session.leadId,
		);
		if (!project?.huddle || !lead?.botToken || !lead.botUserId) {
			throw new Error("voice_session_registry_drift");
		}
		return { project, lead };
	};
	const provision = async (sessionId: string) => {
		const session = input.store.getVoiceSession(sessionId);
		if (!session) return;
		const { lead } = resolve(session);
		const founderUserId = input.config.discordOwnerUserId;
		if (!founderUserId) {
			throw new Error("voice_session_founder_id_unset");
		}
		await runVoiceProvisioner({
			store: input.store,
			sessionId,
			epoch: randomUUID(),
			staleMs: timing.provisioningStaleMs,
			context: {
				chatChannelId: lead.chatChannel,
				leadBotToken: lead.botToken!,
				founderUserId,
			},
			deps: discordDeps,
		});
	};
	const resolveStart = createVoiceStartResolver({
		projects: input.projects,
		voiceHost,
		meetingConfigPath:
			env.FLYWHEEL_MEETING_NOTES_CONFIG ??
			join(input.cwd ?? process.cwd(), ".flywheel", "meeting-notes.yaml"),
		env,
		newSessionId: randomUUID,
		preflight: async (request) => {
			if (!input.config.discordOwnerUserId) {
				throw new VoiceSessionHttpError(
					503,
					"voice_unavailable",
					"founder_id_unset",
				);
			}
			await preflightVoiceSession(request, { fetchImpl });
		},
	});
	const projectSession = (session: VoiceSessionRow) => {
		const { project, lead } = resolve(session);
		return {
			mode: session.mode,
			projectName: session.projectName,
			leadId: session.leadId,
			displayName: lead.agentId,
			realtimeVoice: lead.realtimeVoice ?? "marin",
			guildId: project.huddle!.guildId,
			voiceChannelId: session.voiceChannelId,
			threadId: session.threadId,
			boundChannelIds: session.boundChannelIds,
			founderUserId: input.config.discordOwnerUserId,
			qaAllowUserIds: voiceHost.qaAllowUserIds,
			evidenceDir: session.evidenceDir,
			meetingId: session.meetingId,
		};
	};
	const postStatus = async (session: VoiceSessionRow, text: string) => {
		const { lead } = resolve(session);
		const result = await postDiscordMessageToChannel(
			session.threadId ?? lead.chatChannel,
			text,
			lead.botToken!,
			{ origin: "automation" },
			fetchImpl,
		);
		if (!result.ok) throw new Error(result.error);
	};
	const runtime = new VoiceSessionRuntime({
		store: input.store,
		timing,
		provision,
		poll: async (session) => {
			const { lead } = resolve(session);
			if (!session.leaseToken || !session.rootMessageId) return;
			await pollVoiceSessionOnce({
				store: input.store,
				sessionId: session.sessionId,
				leaseToken: session.leaseToken,
				boundChannelIds: session.boundChannelIds,
				outboundCursor: session.outboundCursor,
				leadBotUserId: lead.botUserId!,
				leadBotToken: lead.botToken!,
				rootMessageId: session.rootMessageId,
				fetchImpl,
			});
		},
		reportPollFailure: (session) => postStatus(session, "📻 回程暂时不通"),
	});
	return {
		router: createVoiceSessionRouter({
			store: input.store,
			leaseTtlMs: timing.leaseTtlMs,
			resolveStart,
			provisionSession: provision,
			reportAbandoned: (session, count) =>
				postStatus(session, `📻 有 ${count} 条语音没有送达`),
			projectSession,
		}),
		runtime,
	};
}
