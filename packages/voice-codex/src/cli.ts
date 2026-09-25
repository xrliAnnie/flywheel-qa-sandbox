#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireProcessLifetimeFileLock } from "flywheel-teamlead/process-lock";
import { createDiscordDeps } from "flywheel-voice-bridge";
import {
	buildGptLiveBackend,
	CompositeSpeech,
	JsonlTranscriptSink,
	OpenAiTts,
	type RoomIO,
	resolveConfig as resolveVoiceCoreConfig,
	type VoiceHandoffIntentKind,
	type VoiceUtterance,
} from "flywheel-voice-core";
import { BridgeVoiceClient as HeadphoneBridgeVoiceClient } from "flywheel-voice-headphone";
import { DiscordMirrorClient, FlywheelCommDelivery } from "./adapters.js";
import { verifyLeadVoiceTokenIdentity } from "./bot-identity.js";
import {
	BridgeVoiceClient,
	type VoiceSessionProjection,
} from "./bridge-client.js";
import {
	loadVoiceDaemonConfig,
	loadVoiceProjects,
	resolveLeadVoiceToken,
	resolveVoiceCommDbPath,
} from "./config.js";
import { VoiceDaemon, type VoiceSessionContext } from "./daemon.js";
import { VoiceDelivery } from "./delivery.js";
import { DiscordVoiceRoom } from "./discord-room.js";
import {
	createEngineAHeadphoneSession,
	resolveEngineAVoice,
} from "./engine-a-composition.js";
import { EvidenceLog } from "./evidence.js";
import {
	logVoiceHealthSuccess,
	VoiceHealthHelperClient,
	VoiceHealthReporter,
} from "./health.js";
import { VoiceHealthAlertDispatcher } from "./health-alert.js";
import { SessionJournal } from "./journal.js";
import { probeVoiceLaunchdOwner } from "./launchd-owner.js";
import { LiveLeadAdapter } from "./live-lead-adapter.js";
import { writeMeetingVoiceSignal } from "./meeting-voice-signal.js";
import { parseVoiceProjection } from "./projection.js";
import { RealtimeFrontend } from "./realtime.js";
import {
	VOICE_CODEX_RECEIVE_POLICY,
	voiceReceiveRuntimeEvidence,
} from "./receive-health.js";
import { recoverPinnedVoiceSession } from "./recovery.js";
import { GenericVoiceSession, type HeadphoneControl } from "./session.js";
import { type SavedVoiceSession, SessionStateStore } from "./session-state.js";
import {
	reportFatalStartupFailure,
	reportStartupRefusal,
	VOICE_LOCK_UNAVAILABLE_BODY,
} from "./startup-alert.js";

function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function discordNonce(): string {
	return randomUUID().replaceAll("-", "").slice(0, 25);
}

function evidencePath(
	voiceRoot: string,
	sessionId: string,
	projection: VoiceSessionProjection,
): string {
	return projection.mode === "meeting" && projection.evidenceDir
		? join(projection.evidenceDir, "voice-evidence", "events.jsonl")
		: join(voiceRoot, "sessions", sessionId, "events.jsonl");
}

/** Plan §7: one fixed session-start ceiling over preflight and both branches. */
const SESSION_START_DEADLINE_MS = 120_000;

function classifyLeadIntent(utterance: VoiceUtterance): VoiceHandoffIntentKind {
	if (/(执行|修改|创建|提交|发送|部署|合并|删除|更新)/u.test(utterance.text))
		return "action";
	if (/(判断|建议|应该|选择|评估|决定|怎么看)/u.test(utterance.text))
		return "judgment";
	return "query";
}

export async function main(): Promise<void> {
	const config = loadVoiceDaemonConfig(process.env, homedir());
	const projects = loadVoiceProjects(config);
	if (process.argv.length === 3 && process.argv[2] === "--check-config") {
		console.log(`[voice] config ok: ${projects.length} project(s)`);
		return;
	}
	if (process.argv.length > 2)
		throw new Error("usage: flywheel-voice [--check-config]");
	const engineA = config.engine === "openai-live";
	mkdirSync(config.voiceRoot, { recursive: true, mode: 0o700 });
	const lock = await acquireProcessLifetimeFileLock(
		join(config.voiceRoot, "voice.lock"),
	);
	if (lock.status === "conflict") {
		// FLY-2701: on demand, a wake can land while the previous instance is
		// still finishing. That race is designed, not a fault — but only when the
		// host can be shown to already own a running voice job. Evidence source:
		// launchd's own record for the fixed label (see launchd-owner.ts).
		const owner = await probeVoiceLaunchdOwner();
		if (owner.kind === "launchd_running") {
			console.log(
				`[voice] benign_owner_conflict label=${owner.label} owner_pid=${owner.pid} source=${owner.source}`,
			);
			return;
		}
		reportStartupRefusal({
			reason: "voice_process_lock_conflict",
			title: "Voice process lock unavailable",
			body: "Another daemon owns the standalone voice process lock.",
		});
		return;
	}
	if (lock.status === "unavailable") {
		reportStartupRefusal({
			reason: "voice_process_lock_unavailable",
			title: "Voice process lock unavailable",
			body: VOICE_LOCK_UNAVAILABLE_BODY,
		});
		return;
	}

	const discordDeps = await createDiscordDeps(VOICE_CODEX_RECEIVE_POLICY);
	if (!discordDeps.receiveRuntime) {
		throw new Error("voice_receive_runtime_unavailable");
	}
	const receiveRuntime = discordDeps.receiveRuntime;
	console.log(
		`[voice] receive runtime ${JSON.stringify(
			voiceReceiveRuntimeEvidence({
				observedAt: new Date().toISOString(),
				buildSha: config.buildSha,
				runtime: receiveRuntime,
			}),
		)}`,
	);
	const bridge = new BridgeVoiceClient({
		baseUrl: config.bridgeUrl,
		token: config.apiToken,
		httpTimeoutMs: config.leaseHttpTimeoutMs,
		idleHttpTimeoutMs: config.idleHttpTimeoutMs,
	});
	const stateStore = new SessionStateStore(config.voiceRoot);
	const daemonBootId = randomUUID();
	stateStore.saveBoot(daemonBootId);
	const reportHealthUnavailable = () =>
		console.error(
			"[voice] health observation unavailable reasonClass=health_observation_unavailable operation=health_store",
		);
	const healthAlerts = new VoiceHealthAlertDispatcher({
		leadAlertPath: join(
			dirname(dirname(config.voiceHealthHelperPath)),
			"lead-alert.sh",
		),
		onUnavailable: reportHealthUnavailable,
	});
	const health = new VoiceHealthReporter({
		client: new VoiceHealthHelperClient({
			helperPath: config.voiceHealthHelperPath,
			stateRoot: config.healthStateRoot,
		}),
		bootId: daemonBootId,
		stateRoot: config.healthStateRoot,
		onUnavailable: reportHealthUnavailable,
		onNotification: (intentId) => healthAlerts.notify(intentId),
		onSuccessLog: logVoiceHealthSuccess,
	});
	await health.registerBoot();
	const tokenFor = (projection: VoiceSessionProjection) =>
		resolveLeadVoiceToken(projection, projects, process.env);
	const buildDelivery = (
		saved: SavedVoiceSession,
		token: string,
		assertLease: () => void,
		status: (text: string) => Promise<void>,
	) => {
		const mirror = new DiscordMirrorClient({
			token,
			timeoutMs: config.discordTimeoutMs,
		});
		const comm = new FlywheelCommDelivery({
			cliPath: config.commCliPath,
			dbPath: resolveVoiceCommDbPath(
				config,
				saved.projection.projectName,
				homedir(),
			),
			founderUserId: saved.projection.founderUserId,
		});
		const evidence = new EvidenceLog(
			evidencePath(config.voiceRoot, saved.sessionId, saved.projection),
		);
		return new VoiceDelivery({
			sessionId: saved.sessionId,
			leadId: saved.projection.leadId,
			threadId: saved.projection.threadId,
			founderUserId: saved.projection.founderUserId,
			journal: new SessionJournal(
				join(config.voiceRoot, "sessions", saved.sessionId, "journal.jsonl"),
			),
			assertLease,
			mirror: ({ text, nonce }) =>
				mirror.post(saved.projection.threadId, text, nonce),
			ingest: (input) => comm.ingest(input),
			readDelivery: (deliveryId) => comm.read(deliveryId),
			status,
			evidence: (record) => evidence.append(record),
			mirrorRetries: config.mirrorRetries,
			mirrorRetryWindowMs: config.mirrorRetryWindowMs,
			ingestRetries: config.ingestRetries,
			deliveryRetryMs: config.deliveryRetryMs,
			retryDelay: pause,
		});
	};

	const createSession = async (context: VoiceSessionContext) => {
		// Plan §7: the 120s ceiling covers preflight *and* both start branches.
		// Identity verification below is preflight, so the clock starts here —
		// not when the branches finally begin.
		const startDeadlineAt = Date.now() + SESSION_START_DEADLINE_MS;
		context.lease.assert();
		parseVoiceProjection(context.projection, context.sessionId);
		const generation = context.projection.sessionGeneration;
		if (
			engineA &&
			(!Number.isSafeInteger(generation) || Number(generation) < 1)
		) {
			throw new Error("voice_projection_generation_required");
		}
		const token = tokenFor(context.projection);
		await verifyLeadVoiceTokenIdentity(
			token,
			context.projection.voiceBotUserId,
		);
		context.lease.assert();
		const scratch = join(config.voiceRoot, "scratch", context.sessionId);
		mkdirSync(scratch, { recursive: true, mode: 0o700 });
		const evidence = new EvidenceLog(
			evidencePath(config.voiceRoot, context.sessionId, context.projection),
		);
		evidence.append(
			voiceReceiveRuntimeEvidence({
				observedAt: new Date().toISOString(),
				buildSha: config.buildSha,
				runtime: receiveRuntime,
			}),
		);
		let room: DiscordVoiceRoom | undefined;
		const saved: SavedVoiceSession = {
			sessionId: context.sessionId,
			leaseToken: context.leaseToken,
			projection: context.projection,
		};
		const mirror = new DiscordMirrorClient({
			token,
			timeoutMs: config.discordTimeoutMs,
		});
		const delivery = buildDelivery(
			saved,
			token,
			() => context.lease.assert(),
			async (text) => {
				if (room) await room.status(text);
				else
					await mirror.post(context.projection.threadId, text, discordNonce());
			},
		);
		const session = new GenericVoiceSession({
			projection: context.projection,
			delivery,
			startDeadlineMs: SESSION_START_DEADLINE_MS,
			startDeadlineAt: () => startDeadlineAt,
			createFrontend: (handlers) => {
				if (engineA) {
					return {
						start: async () => undefined,
						appendAudio: () => undefined,
						appendSpeech: async () => {
							throw new Error("engine_a_speech_must_use_v1");
						},
						cancelSpeech: () => undefined,
						stop: async () => undefined,
					};
				}
				return new RealtimeFrontend({
					apiKey: config.realtimeApiKey,
					voice: context.projection.realtimeVoice,
					displayName: context.projection.displayName,
					minimumSessionLifetimeMs: config.presenceGraceMs + 25_000,
					onEvidence: (record) =>
						evidence.appendBuffered({
							ts: new Date().toISOString(),
							transport: "openai_realtime_direct",
							modelAlias: "gpt-realtime-1.5",
							voiceSessionId: context.sessionId,
							frontendGeneration: 1,
							buildSha: config.buildSha,
							...record,
						}),
					...handlers,
				});
			},
			createRoom: (handlers) => {
				room = new DiscordVoiceRoom({
					...(engineA
						? {
								sessionId: context.sessionId,
								generation: generation as number,
								roomKey: `${context.projection.guildId}:${context.projection.voiceChannelId}`,
							}
						: {}),
					onDiagnostic: (record) =>
						evidence.appendBuffered({
							ts: new Date().toISOString(),
							...record,
						}),
					deps: discordDeps,
					token,
					expectedBotUserId: context.projection.voiceBotUserId,
					guildId: context.projection.guildId,
					voiceChannelId: context.projection.voiceChannelId,
					threadId: context.projection.threadId,
					founderUserId: context.projection.founderUserId,
					qaAllowUserIds: context.projection.qaAllowUserIds,
					...handlers,
				});
				return room;
			},
			...(engineA
				? {
						createHeadphoneSession: (
							roomIO: RoomIO,
							control: HeadphoneControl,
						) => {
							const coreConfig = resolveVoiceCoreConfig({}, process.env);
							// FLY-2863 §5: the Lead's own GPT voice for the Live face and
							// the announcer alike; never a synthetic (edge-tts) voice.
							const speaker = resolveEngineAVoice(
								context.projection,
								process.env,
							);
							const liveBackend = buildGptLiveBackend(coreConfig, {
								apiKey: config.realtimeApiKey,
							});
							const transcriptSink = new JsonlTranscriptSink(
								join(
									config.voiceRoot,
									"sessions",
									context.sessionId,
									"transcript.jsonl",
								),
								(error) =>
									evidence.append({
										ts: new Date().toISOString(),
										kind: "voice_transcript_write_failed",
										message: error.message,
									}),
							);
							const tts = new OpenAiTts({
								apiKey: config.realtimeApiKey,
								model: coreConfig.openaiLive.announcerModel,
								endpoint: coreConfig.openaiLive.announcerEndpoint,
								timeoutMs: coreConfig.timeouts.ttsMs,
							});
							evidence.appendBuffered({
								ts: new Date().toISOString(),
								kind: "voice_speaker_resolved",
								ttsEngine: "openai",
								voice: speaker.voice,
								mode: speaker.mode,
								leadId: context.projection.leadId,
							});
							const speech = new CompositeSpeech({
								sessionId: context.sessionId,
								generation: generation as number,
								room: roomIO,
								tts,
								voice: speaker.voice,
								beforeSpeak: async () => undefined,
							});
							const headphoneBridge = new HeadphoneBridgeVoiceClient({
								bridgeUrl: config.bridgeUrl,
								token: config.apiToken,
								record: (record) => evidence.appendBuffered(record),
							});
							return createEngineAHeadphoneSession({
								binding: {
									sessionId: context.sessionId,
									generation: generation as number,
									leaseToken: context.leaseToken,
								},
								founderUserId: context.projection.founderUserId,
								bridge: headphoneBridge,
								room: roomIO,
								mode: speaker.mode,
								transcriptSink,
								baseInstructions:
									"简单问题由前台直接回答；需要查询、执行或判断时先说我问下 Lead，再使用 client delegation。不要主动播报进度或状态，要她拍板的事由 Lead 自己跟她说。",
								createEngine: ({
									registerHandoff,
									submitHandoff,
									agendaTurns,
								}) =>
									new LiveLeadAdapter({
										sessionId: context.sessionId,
										generation: generation as number,
										projectName: context.projection.projectName,
										founderUserId: context.projection.founderUserId,
										targetLeadId: context.projection.leadId,
										room: roomIO,
										createConversation: (initialSessionContext) =>
											liveBackend.createConversation({
												brain: {
													async *respond() {
														yield await Promise.reject(
															new Error(
																"openai_live_does_not_use_brain_adapter",
															),
														);
													},
												},
												systemPreamble: initialSessionContext,
												voice: speaker.voice,
											}),
										transcriptSink,
										speech,
										classifyIntent: classifyLeadIntent,
										submitHandoff,
										registerHandoff,
										agendaTurns,
										record: (record) => evidence.appendBuffered(record),
										onUnavailable: (cause) => control.fail(cause),
									}),
								captionSink: {
									caption: (caption) => {
										void roomIO.status(caption.renderedText).catch((error) =>
											evidence.appendBuffered({
												kind: "live_caption_status_failed",
												message:
													error instanceof Error
														? error.message
														: String(error),
											}),
										);
									},
								},
								record: (record) => evidence.appendBuffered(record),
								textStatus: (text) => {
									void roomIO.status(text).catch(() => undefined);
								},
							});
						},
					}
				: {}),
			lifecycle: (state, reason) => {
				const ts = new Date().toISOString();
				const prefix =
					context.projection.mode === "meeting"
						? "meeting_container"
						: "session";
				const record = {
					ts,
					kind: `${prefix}_${state === "ready" ? "starting" : state}`,
					meetingId: context.projection.meetingId,
					bootId: daemonBootId,
					...(reason ? { reason } : {}),
				};
				if (state === "ended" || state === "interrupted")
					evidence.append(record);
				else evidence.appendBuffered(record);
				if (
					context.projection.mode === "meeting" &&
					context.projection.evidenceDir &&
					context.projection.meetingId
				) {
					writeMeetingVoiceSignal(context.projection.evidenceDir, {
						schemaVersion: 1,
						meetingId: context.projection.meetingId,
						state,
						at: ts,
						bootId: daemonBootId,
						...(reason ? { reason } : {}),
					});
				}
			},
			evidence: (record) => evidence.appendBuffered(record),
			confirmationMs: config.confirmationMs,
			assertLease: () => context.lease.assert(),
			postStatus: async (text) => {
				await mirror.post(context.projection.threadId, text, discordNonce());
			},
			cleanup: () => rmSync(scratch, { recursive: true, force: true }),
		});
		return session;
	};

	const daemon = new VoiceDaemon({
		bridge,
		stateStore,
		bootId: daemonBootId,
		legacyOutboundPolling: !engineA,
		health,
		recordSessionEvidence: (context, record) =>
			new EvidenceLog(
				evidencePath(config.voiceRoot, context.sessionId, context.projection),
			).append({ ts: new Date().toISOString(), ...record }),
		createSession,
		recoverSession: async (saved, authority) => {
			try {
				return await recoverPinnedVoiceSession({
					saved,
					authority,
					projects,
					env: process.env,
					journal: new SessionJournal(
						join(
							config.voiceRoot,
							"sessions",
							saved.sessionId,
							"journal.jsonl",
						),
					),
					replay: async (validated, token, lease) => {
						const mirror = new DiscordMirrorClient({
							token,
							timeoutMs: config.discordTimeoutMs,
						});
						return buildDelivery(
							validated,
							token,
							() => lease.assert(),
							async (text) => {
								await mirror.post(
									validated.projection.threadId,
									text,
									discordNonce(),
								);
							},
						).recover();
					},
				});
			} finally {
				rmSync(join(config.voiceRoot, "scratch", saved.sessionId), {
					recursive: true,
					force: true,
				});
			}
		},
		sleep: pause,
		timing: {
			idlePollMs: config.idlePollMs,
			idleExitMs: config.idleExitMs,
			leaseRenewMs: config.leaseRenewMs,
			leaseMissMax: config.leaseMissMax,
			presenceGraceMs: config.presenceGraceMs,
			speechChunkTokens: config.speechChunkTokens,
		},
	});
	const shutdown = () => daemon.shutdown();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await daemon.run();
	} finally {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		health.stop();
		await health.whenSettled();
		await lock.handle.close();
	}
}

main().catch((error) => {
	reportFatalStartupFailure(error);
	process.exitCode = 1;
});
