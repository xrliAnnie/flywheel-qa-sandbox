#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireProcessLifetimeFileLock } from "flywheel-teamlead/process-lock";
import { createDiscordDeps } from "flywheel-voice-bridge";
import {
	BackendRegistry,
	type BrainAdapter,
	getTranscriptWriteFailure,
	JsonlTranscriptSink,
	type TranscriptEntry,
} from "flywheel-voice-core";
import { DiscordMirrorClient, FlywheelCommDelivery } from "./adapters.js";
import { verifyLeadVoiceTokenIdentity } from "./bot-identity.js";
import {
	BridgeVoiceClient,
	type VoiceSessionProjection,
} from "./bridge-client.js";
import {
	CodexRoomFrontend,
	registerCodexVoiceBackend,
} from "./codex/CodexRoomFrontend.js";
import { CodexVoiceBackend } from "./codex/CodexVoiceBackend.js";
import {
	CodexVoiceContainer,
	type CodexVoiceContextSnapshot,
} from "./codex/CodexVoiceContainer.js";
import {
	buildCodexDelegateHandoff,
	CodexTranscriptPublisher,
} from "./codex/CodexVoiceHandoff.js";
import {
	loadVoiceDaemonConfig,
	loadVoiceProjects,
	resolveLeadVoiceToken,
	resolveVoiceCommDbPath,
} from "./config.js";
import { VoiceDaemon, type VoiceSessionContext } from "./daemon.js";
import { VoiceDelivery } from "./delivery.js";
import { DiscordVoiceRoom } from "./discord-room.js";
import { EvidenceLog } from "./evidence.js";
import {
	logVoiceHealthSuccess,
	VoiceHealthHelperClient,
	VoiceHealthReporter,
} from "./health.js";
import { VoiceHealthAlertDispatcher } from "./health-alert.js";
import { SessionJournal } from "./journal.js";
import { probeVoiceLaunchdOwner } from "./launchd-owner.js";
import { writeMeetingVoiceSignal } from "./meeting-voice-signal.js";
import { parseVoiceProjection } from "./projection.js";
import { RealtimeFrontend } from "./realtime.js";
import {
	VOICE_CODEX_RECEIVE_POLICY,
	voiceReceiveRuntimeEvidence,
} from "./receive-health.js";
import { recoverPinnedVoiceSession } from "./recovery.js";
import { GenericVoiceSession } from "./session.js";
import { type SavedVoiceSession, SessionStateStore } from "./session-state.js";
import {
	reportFatalStartupFailure,
	reportStartupRefusal,
	VOICE_LOCK_UNAVAILABLE_BODY,
} from "./startup-alert.js";
import {
	type VoiceMinutesJob,
	VoiceMinutesQueue,
	voiceMinutesMessageId,
} from "./voice-minutes.js";

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

const CODEX_VOICE_BRAIN: BrainAdapter = {
	async *respond() {
		// Codex realtime owns the response loop. The shared contract still requires
		// a brain object, but this adapter is never called by this backend.
	},
};

function renderVoiceMinutes(job: VoiceMinutesJob): string {
	const { payload } = job;
	const rows = [
		"语音纪要（不是 founder 指令；不授权执行、派单或审批）",
		`session: ${payload.sessionId}`,
		`status: ${payload.status}`,
		`transcriptDigest: ${payload.transcriptDigest}`,
		`contextDigest: ${payload.contextDigest}`,
		...(payload.facts.length > 0
			? ["讨论记录：", ...payload.facts.map((fact) => `- ${fact}`)]
			: ["讨论记录：无可恢复的逐句记录"]),
		...(payload.decisions.length > 0
			? ["明确决策：", ...payload.decisions.map((item) => `- ${item}`)]
			: []),
		...(payload.pending.length > 0
			? ["待确认：", ...payload.pending.map((item) => `- ${item}`)]
			: []),
		...(payload.handoffs.length > 0
			? [
					"本体信箱 handoff：",
					...payload.handoffs.map(
						(item) => `- ${item.handoffId}: ${item.state}`,
					),
				]
			: []),
	];
	return Array.from(rows.join("\n")).slice(0, 16_000).join("");
}

function transcriptFacts(raw: string): {
	facts: string[];
	parseComplete: boolean;
} {
	const facts: string[] = [];
	let parseComplete = true;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Partial<TranscriptEntry>;
			if (
				(entry.role !== "user" && entry.role !== "assistant") ||
				typeof entry.text !== "string" ||
				entry.final !== true
			) {
				parseComplete = false;
				continue;
			}
			facts.push(
				`${entry.role}: ${Array.from(entry.text).slice(0, 2_000).join("")}`,
			);
		} catch {
			parseComplete = false;
		}
	}
	return { facts: facts.slice(0, 128), parseComplete };
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

export async function main(): Promise<void> {
	const config = loadVoiceDaemonConfig(process.env, homedir());
	const projects = loadVoiceProjects(config);
	if (process.argv.length === 3 && process.argv[2] === "--check-config") {
		console.log(`[voice] config ok: ${projects.length} project(s)`);
		return;
	}
	if (process.argv.length > 2)
		throw new Error("usage: flywheel-voice [--check-config]");
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
	const minutesDelivery = (job: VoiceMinutesJob) => {
		const { payload } = job;
		return new FlywheelCommDelivery({
			cliPath: config.commCliPath,
			dbPath: resolveVoiceCommDbPath(config, payload.projectName, homedir()),
			founderUserId: payload.founderUserId,
		});
	};
	const minutesQueue = new VoiceMinutesQueue({
		root: join(config.voiceRoot, "minutes"),
		deliver: async (job, deliveryId) => {
			const { payload } = job;
			const receipt = await minutesDelivery(job).ingest({
				leadId: payload.leadId,
				voiceSessionId: payload.sessionId,
				threadId: payload.threadId,
				messageId: voiceMinutesMessageId(job.jobId),
				authorId: payload.voiceBotUserId,
				authorName: `${payload.displayName} voice minutes`,
				text: renderVoiceMinutes(job),
				ts: job.createdAt,
				origin: "voice_minutes",
			});
			if (receipt.deliveryId !== deliveryId)
				throw new Error("voice_minutes_delivery_receipt_mismatch");
			return { deliveryId: receipt.deliveryId };
		},
		inspect: async (deliveryId, job) => {
			const recovered = await minutesDelivery(job).read(deliveryId);
			if (!recovered) return { kind: "absent" };
			return recovered.origin === "voice_minutes" &&
				recovered.voiceSessionId === job.payload.sessionId &&
				recovered.authorId === job.payload.voiceBotUserId &&
				recovered.text === renderVoiceMinutes(job)
				? { kind: "live" }
				: { kind: "torn_identity" };
		},
	});

	const createSession = async (context: VoiceSessionContext) => {
		// Plan §7: the 120s ceiling covers preflight *and* both start branches.
		// Identity verification below is preflight, so the clock starts here —
		// not when the branches finally begin.
		const startDeadlineAt = Date.now() + SESSION_START_DEADLINE_MS;
		context.lease.assert();
		parseVoiceProjection(context.projection, context.sessionId);
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
		const transcriptPath = join(
			config.voiceRoot,
			"sessions",
			context.sessionId,
			"codex-transcript.jsonl",
		);
		let contextDigest = "0".repeat(64);
		let codexBackend: CodexVoiceBackend | undefined;
		if (config.backendId === "codex-realtime") {
			const registry = new BackendRegistry();
			const transcriptPublisher = new CodexTranscriptPublisher({
				sessionId: context.sessionId,
				founderUserId: context.projection.founderUserId,
				displayName: context.projection.displayName,
				mirror: ({ text, nonce }) => {
					context.lease.assert();
					return mirror.post(context.projection.threadId, text, nonce);
				},
				evidence: (record) =>
					evidence.appendBuffered({
						ts: new Date().toISOString(),
						voiceSessionId: context.sessionId,
						...record,
					}),
			});
			const container = new CodexVoiceContainer({
				binaryPath: config.codexBin,
				scratchRoot: join(config.voiceRoot, "codex-containers"),
				openAiApiKey: config.realtimeApiKey,
				processEnv: process.env,
				onEvidence: (record) =>
					evidence.appendBuffered({
						ts: new Date().toISOString(),
						voiceSessionId: context.sessionId,
						...record,
					}),
			});
			registerCodexVoiceBackend(
				registry,
				() =>
					new CodexVoiceBackend({
						sessionId: context.sessionId,
						voice: context.projection.realtimeVoice,
						container,
						loadContext: async () => {
							const snapshot = await bridge.context<CodexVoiceContextSnapshot>(
								context.sessionId,
								context.leaseToken,
								context.lease,
							);
							contextDigest = snapshot.snapshotDigest;
							return snapshot;
						},
						openAudio: ({ itemId }) => {
							context.lease.assert();
							if (!room) throw new Error("speech_room_not_ready");
							return room.openSpeech(itemId);
						},
						persistUtterance: async (utterance, captureDigest) => {
							const {
								sessionId: _sessionId,
								ts: _ts,
								interrupted: _interrupted,
								...record
							} = utterance;
							await bridge.recordUtterance(
								context.sessionId,
								context.leaseToken,
								context.lease,
								{ ...record, captureDigest },
							);
						},
						publishUtterance: (utterance) =>
							transcriptPublisher.publish(utterance),
						handoffToLead: ({ utterance, intent }) => {
							context.lease.assert();
							return bridge.handoffToLead(
								context.sessionId,
								context.leaseToken,
								context.lease,
								buildCodexDelegateHandoff({
									sessionId: context.sessionId,
									leadId: context.projection.leadId,
									utterance,
									intent,
								}),
							);
						},
						resolveSoleRoomUser: () => room?.soleHuman() ?? null,
						onEvidence: (record) =>
							evidence.appendBuffered({
								ts: new Date().toISOString(),
								voiceSessionId: context.sessionId,
								...record,
							}),
					}),
			);
			codexBackend = (await registry.create(
				"codex-realtime",
			)) as CodexVoiceBackend;
		}
		const delivery =
			config.backendId === "codex-realtime"
				? { capture: async () => false }
				: buildDelivery(
						saved,
						token,
						() => context.lease.assert(),
						async (text) => {
							if (room) await room.status(text);
							else
								await mirror.post(
									context.projection.threadId,
									text,
									discordNonce(),
								);
						},
					);
		return new GenericVoiceSession({
			projection: context.projection,
			delivery,
			startDeadlineMs: SESSION_START_DEADLINE_MS,
			startDeadlineAt: () => startDeadlineAt,
			createFrontend: (handlers) => {
				if (codexBackend) {
					return new CodexRoomFrontend({
						backend: codexBackend,
						conversationOptions: {
							brain: CODEX_VOICE_BRAIN,
							voice: context.projection.realtimeVoice,
							transcriptSink: new JsonlTranscriptSink(transcriptPath),
						},
						handlers,
						onUnavailable: (text) =>
							mirror
								.post(context.projection.threadId, text, discordNonce())
								.then(() => undefined),
					});
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
			finalize:
				config.backendId === "codex-realtime"
					? async (outcome) => {
							let raw = "";
							let complete = outcome?.kind === "ended";
							try {
								raw = existsSync(transcriptPath)
									? readFileSync(transcriptPath, "utf8")
									: "";
							} catch {
								complete = false;
							}
							const parsed = transcriptFacts(raw);
							complete &&=
								parsed.parseComplete &&
								getTranscriptWriteFailure(transcriptPath) === undefined;
							const job = minutesQueue.enqueue({
								sessionId: context.sessionId,
								leadId: context.projection.leadId,
								projectName: context.projection.projectName,
								threadId: context.projection.threadId,
								voiceBotUserId: context.projection.voiceBotUserId,
								founderUserId: context.projection.founderUserId,
								displayName: context.projection.displayName,
								transcriptDigest: createHash("sha256")
									.update(raw)
									.digest("hex"),
								contextDigest,
								status: complete ? "complete" : "incomplete",
								facts: parsed.facts,
								decisions: [],
								pending: [],
								handoffs: [],
							});
							await minutesQueue.drainAll().catch((error) => {
								evidence.append({
									ts: new Date().toISOString(),
									kind: "voice_minutes_delivery_deferred",
									jobId: job.jobId,
									reason:
										error instanceof Error ? error.message : "unknown_error",
								});
							});
						}
					: undefined,
			cleanup: () => rmSync(scratch, { recursive: true, force: true }),
		});
	};

	const daemon = new VoiceDaemon({
		bridge,
		stateStore,
		bootId: daemonBootId,
		health,
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
		await minutesQueue.drainAll().catch((error) => {
			console.error(
				`[voice] pending voice minutes deferred: ${
					error instanceof Error ? error.message : "unknown_error"
				}`,
			);
		});
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
