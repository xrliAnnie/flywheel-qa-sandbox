#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CodexLeadProcess,
	spawnCodexAppServer,
} from "flywheel-teamlead/codex-process";
import { acquireProcessLifetimeFileLock } from "flywheel-teamlead/process-lock";
import { createDiscordDeps } from "flywheel-voice-bridge";
import { DiscordMirrorClient, FlywheelCommDelivery } from "./adapters.js";
import {
	BridgeVoiceClient,
	type VoiceSessionProjection,
} from "./bridge-client.js";
import {
	loadVoiceDaemonConfig,
	loadVoiceProjects,
	resolveVoiceBotToken,
	voiceCodexEnv,
} from "./config.js";
import { VoiceDaemon, type VoiceSessionContext } from "./daemon.js";
import { VoiceDelivery } from "./delivery.js";
import { DiscordVoiceRoom } from "./discord-room.js";
import { EvidenceLog } from "./evidence.js";
import { SessionJournal } from "./journal.js";
import { writeMeetingVoiceSignal } from "./meeting-voice-signal.js";
import { RealtimeFrontend } from "./realtime.js";
import { GenericVoiceSession } from "./session.js";
import { type SavedVoiceSession, SessionStateStore } from "./session-state.js";
import { reportStartupRefusal } from "./startup-alert.js";

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
			body: `The standalone voice lock helper failed: ${lock.error}`,
		});
		return;
	}

	const discordDeps = await createDiscordDeps();
	const bridge = new BridgeVoiceClient({
		baseUrl: config.bridgeUrl,
		token: config.apiToken,
		httpTimeoutMs: config.leaseHttpTimeoutMs,
	});
	const stateStore = new SessionStateStore(config.voiceRoot);
	const daemonBootId = randomUUID();
	stateStore.saveBoot(daemonBootId);
	const tokenFor = (projection: VoiceSessionProjection) =>
		resolveVoiceBotToken(
			projection.projectName,
			projection.guildId,
			projection.voiceChannelId,
			projects,
			process.env,
		);
	const buildDelivery = (
		saved: SavedVoiceSession,
		assertLease: () => void,
		status: (text: string) => Promise<void>,
	) => {
		const mirror = new DiscordMirrorClient({
			token: tokenFor(saved.projection),
			timeoutMs: config.discordTimeoutMs,
		});
		const comm = new FlywheelCommDelivery({
			cliPath: config.commCliPath,
			dbPath: join(
				homedir(),
				".flywheel",
				"comm",
				saved.projection.projectName,
				"comm.db",
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

	const createSession = (context: VoiceSessionContext) => {
		const scratch = join(config.voiceRoot, "scratch", context.sessionId);
		mkdirSync(scratch, { recursive: true, mode: 0o700 });
		const evidence = new EvidenceLog(
			evidencePath(config.voiceRoot, context.sessionId, context.projection),
		);
		let room: DiscordVoiceRoom | undefined;
		const saved: SavedVoiceSession = {
			sessionId: context.sessionId,
			leaseToken: context.leaseToken,
			projection: context.projection,
		};
		const mirror = new DiscordMirrorClient({
			token: tokenFor(context.projection),
			timeoutMs: config.discordTimeoutMs,
		});
		const delivery = buildDelivery(
			saved,
			() => context.lease.assert(),
			async (text) => {
				if (room) await room.status(text);
				else
					await mirror.post(context.projection.threadId, text, discordNonce());
			},
		);
		return new GenericVoiceSession({
			projection: context.projection,
			delivery,
			createFrontend: (handlers) => {
				const codexProcess = new CodexLeadProcess({
					experimentalApi: true,
					spawnChild: () =>
						spawnCodexAppServer({
							codexBin: config.codexBin,
							mcpArgv: [],
							featureArgv: ["--enable", "realtime_conversation"],
							codexHome: config.codexHome,
							baseEnv: voiceCodexEnv(process.env),
						}),
					clientInfo: { name: "flywheel-voice", version: "0.1.0" },
				});
				codexProcess.on("exit", () => handlers.onClosed("codex_process_exit"));
				return new RealtimeFrontend({
					process: codexProcess,
					cwd: scratch,
					voice: context.projection.realtimeVoice,
					displayName: context.projection.displayName,
					...handlers,
				});
			},
			createRoom: (handlers) => {
				room = new DiscordVoiceRoom({
					onDiagnostic: (record) =>
						evidence.append({ ts: new Date().toISOString(), ...record }),
					deps: discordDeps,
					token: tokenFor(context.projection),
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
				evidence.append({
					ts,
					kind: `${prefix}_${state === "ready" ? "starting" : state}`,
					meetingId: context.projection.meetingId,
					bootId: daemonBootId,
					...(reason ? { reason } : {}),
				});
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
			evidence: (record) => evidence.append(record),
			confirmationMs: config.confirmationMs,
			assertLease: () => context.lease.assert(),
			postStatus: async (text) => {
				await mirror.post(context.projection.threadId, text, discordNonce());
			},
			cleanup: () => rmSync(scratch, { recursive: true, force: true }),
		});
	};

	const daemon = new VoiceDaemon({
		bridge,
		stateStore,
		bootId: daemonBootId,
		createSession,
		recoverSession: async (saved, authority) => {
			const mirror = new DiscordMirrorClient({
				token: tokenFor(saved.projection),
				timeoutMs: config.discordTimeoutMs,
			});
			try {
				return await buildDelivery(
					saved,
					() => {
						if (!authority) throw new Error("voice_lease_fenced");
						authority.assert();
					},
					async (text) => {
						await mirror.post(saved.projection.threadId, text, discordNonce());
					},
				).recover();
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
		await lock.handle.close();
	}
}

main().catch((error) => {
	console.error(`[voice] fatal: ${(error as Error).message}`);
	process.exitCode = 1;
});
