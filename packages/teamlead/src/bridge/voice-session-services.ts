import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore, VoiceSessionRow } from "../StateStore.js";
import { loadVoiceHostConfig } from "../voice-host-config.js";
import { generateBootstrap } from "./bootstrap-generator.js";
import {
	editDiscordMessageInChannel,
	postDiscordMessageToChannel,
} from "./discord-utils.js";
import { createLeadCapabilityVoiceRouter } from "./lead-capability-voice.js";
import type { BridgeConfig } from "./types.js";
import { createVoiceHealthDemandRecorder } from "./voice-health-demand-recorder.js";
import {
	kickstartVoiceOnDemand,
	VoiceLaunchdWaker,
	verifyVoiceOnDemandContract,
} from "./voice-launchd-waker.js";
import {
	createVoiceScheduleRouter,
	resolveVoicePrewarmLeadMs,
} from "./voice-schedule-routes.js";
import { VoiceScheduleRuntime } from "./voice-schedule-runtime.js";
import { probeVoiceSelfFilter } from "./voice-self-filter-probe.js";
import { VoiceSessionCardProjector } from "./voice-session-card.js";
import {
	buildVoiceSessionContext,
	deriveVoiceContextBinding,
	digestVoiceContextRoster,
	resolveVoiceContextSources,
	VoiceSessionContextError,
} from "./voice-session-context.js";
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
import {
	createVoiceStartResolver,
	resolveLeadVoiceBinding,
} from "./voice-session-start.js";

export function createVoiceSessionServices(input: {
	store: StateStore;
	projects: ProjectEntry[];
	config: BridgeConfig;
	env?: Readonly<Record<string, string | undefined>>;
	homeDir?: string;
	cwd?: string;
	fetchImpl?: typeof fetch;
	probeSelfFilter?: typeof probeVoiceSelfFilter;
}): {
	router: ReturnType<typeof createVoiceSessionRouter>;
	scheduleRouter: ReturnType<typeof createVoiceScheduleRouter>;
	runtime: VoiceSessionRuntime;
	scheduleRuntime: VoiceScheduleRuntime;
	cardProjector: VoiceSessionCardProjector;
	leadCapabilityRouter: express.Router;
	leadCapabilityReceiptRouter: express.Router;
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
	const repoRoot =
		env.FLYWHEEL_REPO_ROOT?.trim() ||
		resolvePath(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"..",
			"..",
		);
	const recordDemand = createVoiceHealthDemandRecorder({
		helperPath: join(repoRoot, "scripts", "lib", "voice-health.py"),
		stateRoot: env.FLYWHEEL_STATE_DIR?.trim() || join(homeDir, ".flywheel"),
	});
	const voiceLaunchdWaker = new VoiceLaunchdWaker({
		verify: () =>
			verifyVoiceOnDemandContract({
				// The same trusted root this factory already resolved. Using the
				// process cwd would silently fail verification for a Bridge started
				// anywhere but FLYWHEEL_DIR, and still record an accepted wake.
				repoRoot,
				homeDir,
			}),
		wake: () => kickstartVoiceOnDemand(),
		log: (message) => console.warn(`[voice-session] ${message}`),
	});
	const discordDeps = createDiscordVoiceProvisionerDeps(fetchImpl);
	const resolve = (session: VoiceSessionRow) => {
		if (!session.voiceBotUserId) throw new Error("identity_binding_missing");
		const projects = input.projects.filter(
			(candidate) => candidate.projectName === session.projectName,
		);
		const project = projects[0];
		const leads =
			project?.leads.filter(
				(candidate) => candidate.agentId === session.leadId,
			) ?? [];
		const lead = leads[0];
		if (
			projects.length !== 1 ||
			leads.length !== 1 ||
			!lead ||
			!project?.voiceRoom ||
			project.huddle != null ||
			lead.botUserId !== session.voiceBotUserId ||
			project.voiceRoom.guildId !== session.guildId ||
			project.voiceRoom.voiceChannelId !== session.voiceChannelId ||
			input.projects.some(
				(candidate) =>
					candidate.voiceRoom &&
					(candidate.voiceRoom.guildId !== session.guildId ||
						candidate.voiceRoom.voiceChannelId !== session.voiceChannelId),
			)
		)
			throw new Error("voice_session_registry_drift");
		try {
			return {
				project,
				lead,
				token: resolveLeadVoiceBinding(project, lead, env).voiceBotToken,
			};
		} catch {
			throw new Error("voice_session_registry_drift");
		}
	};
	const validateSession = async (session: VoiceSessionRow) => {
		const { project, lead, token } = resolve(session);
		try {
			const proof = await (input.probeSelfFilter ?? probeVoiceSelfFilter)({
				projectName: project.projectName,
				lead,
				token,
			});
			if (
				proof.version !== 1 ||
				proof.leadId !== session.leadId ||
				proof.botUserId !== session.voiceBotUserId ||
				!proof.ready ||
				!proof.selfDropped ||
				!proof.unknownDropped ||
				!proof.otherPassed
			)
				throw new Error("invalid proof");
		} catch {
			throw new Error("self_filter_unverified");
		}
	};

	const provision = async (sessionId: string, signal?: AbortSignal) => {
		const session = input.store.getVoiceSession(sessionId);
		if (!session) return;
		await validateSession(session);
		signal?.throwIfAborted();
		const { lead, token } = resolve(session);
		const founderUserId = input.config.discordOwnerUserId;
		if (!founderUserId) {
			throw new Error("voice_session_founder_id_unset");
		}
		await runVoiceProvisioner({
			signal,
			store: input.store,
			sessionId,
			epoch: randomUUID(),
			staleMs: timing.provisioningStaleMs,
			context: {
				chatChannelId: lead.chatChannel,
				leadBotToken: token,
				founderUserId,
			},
			deps: signal
				? createDiscordVoiceProvisionerDeps((url, init) => {
						signal.throwIfAborted();
						const requestSignal =
							init?.signal ?? (url instanceof Request ? url.signal : undefined);
						return fetchImpl(url, {
							...init,
							signal: requestSignal
								? AbortSignal.any([signal, requestSignal])
								: signal,
						});
					})
				: discordDeps,
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
			await preflightVoiceSession(request, {
				fetchImpl,
				probeSelfFilter: input.probeSelfFilter,
			});
		},
	});
	const projectSession = (session: VoiceSessionRow) => {
		const { lead } = resolve(session);
		return {
			sessionId: session.sessionId,
			mode: session.mode,
			projectName: session.projectName,
			leadId: session.leadId,
			displayName: lead.agentId,
			realtimeVoice: lead.realtimeVoice ?? "marin",
			guildId: session.guildId,
			voiceBotUserId: session.voiceBotUserId,
			voiceChannelId: session.voiceChannelId,
			threadId: session.threadId,
			boundChannelIds: session.boundChannelIds,
			founderUserId: input.config.discordOwnerUserId,
			qaAllowUserIds: voiceHost.qaAllowUserIds,
			evidenceDir: session.evidenceDir,
			meetingId: session.meetingId,
			// FLY-2701: only a booked meeting carries a live floor. Instant
			// sessions keep exactly the projection they have today.
			...(session.notBeforeLiveAt
				? { notBeforeLiveAt: session.notBeforeLiveAt }
				: {}),
			...(session.presenceDeadlineAt
				? { presenceDeadlineAt: session.presenceDeadlineAt }
				: {}),
			...(session.scheduleRevision != null
				? { scheduleRevision: session.scheduleRevision }
				: {}),
		};
	};
	const getSessionContext = async (
		session: VoiceSessionRow,
		authority: { leaseBindingDigest: string },
	) => {
		const { project, lead } = resolve(session);
		const binding = deriveVoiceContextBinding({ project, lead, homeDir });
		const sources = await resolveVoiceContextSources({
			project,
			lead,
			binding,
		});
		const state = await generateBootstrap(
			lead.agentId,
			input.store,
			input.projects,
		).catch(() => {
			throw new VoiceSessionContextError("context_state_unavailable");
		});
		const capturedAt = new Date().toISOString();
		return buildVoiceSessionContext({
			sources,
			rosterDigest: digestVoiceContextRoster(input.projects),
			leaseBindingDigest: authority.leaseBindingDigest,
			capturedAt,
			openInitiatedAt: capturedAt,
			state,
			session: {
				sessionId: session.sessionId,
				mode: session.mode,
				meetingId: session.meetingId,
				topic: session.topic,
				priorMinutes: null,
			},
		});
	};
	const postStatus = async (session: VoiceSessionRow, text: string) => {
		await validateSession(session);
		const { lead, token } = resolve(session);
		const result = await postDiscordMessageToChannel(
			session.threadId ?? lead.chatChannel,
			text,
			token,
			{ origin: "automation" },
			fetchImpl,
		);
		if (!result.ok) throw new Error(result.error);
	};
	const runtime = new VoiceSessionRuntime({
		store: input.store,
		timing,
		recordDemand,
		validateSession,
		provision,
		poll: async (session) => {
			await validateSession(session);
			const { token } = resolve(session);
			if (!session.leaseToken || !session.rootMessageId) return;
			await pollVoiceSessionOnce({
				store: input.store,
				sessionId: session.sessionId,
				leaseToken: session.leaseToken,
				boundChannelIds: session.boundChannelIds,
				outboundCursor: session.outboundCursor,
				leadBotUserId: session.voiceBotUserId!,
				leadBotToken: token,
				rootMessageId: session.rootMessageId,
				fetchImpl,
			});
		},
		// The waker resolves to the settled command result, so a coalesced request
		// spends no budget and a contract fault stops the retries immediately.
		requestWake: () => voiceLaunchdWaker.requestWake(),
		newAttemptId: randomUUID,
		reportPollFailure: (session) => postStatus(session, "📻 回程暂时不通"),
	});
	// FLY-2701: booked meetings live in the Bridge, so the calendar keeps
	// running while no voice process exists. The prewarm lead and the founder
	// presence window are deployment configuration, never request fields.
	const prewarmLeadMs = resolveVoicePrewarmLeadMs(
		input.config.voiceSessionTiming?.prewarmLeadMs,
	);
	const presenceGraceMs =
		input.config.voiceSessionTiming?.presenceGraceMs ?? 600_000;
	const scheduleRuntime = new VoiceScheduleRuntime({
		store: input.store,
		newSessionId: randomUUID,
		provision,
		log: (message) => console.warn(`[voice-schedule] ${message}`),
	});
	const cardProjector = new VoiceSessionCardProjector({
		store: input.store,
		leaseRenewMs: timing.leaseRenewMs,
		validateSession,
		patch: async (session, content, signal) => {
			if (!session.rootMessageId) throw new Error("voice_card_root_missing");
			const { lead, token } = resolve(session);
			const result = await editDiscordMessageInChannel(
				lead.chatChannel,
				session.rootMessageId,
				content,
				token,
				{ origin: "lead_authored", signal },
				fetchImpl,
			);
			if (!result.ok)
				throw new Error(
					`voice_card_patch_failed_${result.status ?? "network"}`,
				);
		},
	});
	const leadCapabilityRouters = createLeadCapabilityVoiceRouter({
		store: input.store,
		leaseRenewMs: timing.leaseRenewMs,
		resolveStart,
		provisionSession: provision,
		projectsPath: env.FLYWHEEL_PROJECTS_FILE,
		homeDir,
		env: { ...env },
	});
	return {
		scheduleRuntime,
		scheduleRouter: createVoiceScheduleRouter({
			store: input.store,
			prewarmLeadMs,
			presenceGraceMs,
			newScheduleId: randomUUID,
			resolveBinding: async ({ projectName, leadId, evidenceDir, topic }) => {
				// Reuse the instant-start resolver so a schedule can never bind an
				// identity, room, or evidence root the live path would refuse.
				const reservation = await resolveStart(
					{
						mode: "meeting",
						projectName,
						leadId,
						evidenceDir,
						...(topic ? { topic } : {}),
					},
					"master",
				);
				return {
					projectName: reservation.projectName,
					leadId: reservation.leadId,
					guildId: reservation.guildId,
					voiceChannelId: reservation.voiceChannelId,
					voiceBotUserId: reservation.voiceBotUserId,
					evidenceDir: reservation.evidenceDir!,
					...(reservation.topic ? { topic: reservation.topic } : {}),
				};
			},
		}),
		router: createVoiceSessionRouter({
			store: input.store,
			leaseTtlMs: timing.leaseTtlMs,
			leaseRenewMs: timing.leaseRenewMs,
			resolveStart,
			provisionSession: provision,
			reportAbandoned: (session, count) =>
				postStatus(session, `📻 有 ${count} 条语音没有送达`),
			projectSession,
			validateSession,
			getSessionContext,
		}),
		runtime,
		cardProjector,
		leadCapabilityRouter: leadCapabilityRouters.operationRouter,
		leadCapabilityReceiptRouter: leadCapabilityRouters.receiptRouter,
	};
}
