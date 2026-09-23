/**
 * discordWiring — the ONLY module that touches real discord.js /
 * @discordjs/voice / prism-media APIs (genaiConnector pattern: dynamic
 * imports keep every other module unit-testable without the SDKs, and the
 * real glue is exercised by the PR-1 real-machine loop, not unit tests).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { PlayerLike, ResourceSource } from "../audio/LeadSpeaker.js";
import type { VoiceConnHandle } from "../audio/VoiceConnSupervisor.js";
import type { VoiceJoinOpts } from "./BotRegistry.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DiscordDeps {
	/** Exact versions and receive policy loaded by this glue entrypoint. */
	receiveRuntime?: DiscordReceiveRuntimeDiagnostic;
	createClient: () => any;
	joinVoice: (client: any, opts: VoiceJoinOpts) => Promise<any>;
	/** bind an EarsReceiver subscribe fn (Manual end behavior) to a connection. */
	subscribeManual: (conn: any) => (userId: string) => NodeJS.ReadableStream;
	/** opus decoder factory: 48kHz stereo s16le out (FLY-960 pinned params). */
	createDecoder: () => NodeJS.ReadWriteStream;
	/** resident AudioPlayer on a connection, adapted to the PlayerLike seam. */
	createPlayer: (conn: any) => PlayerLike;
	createResource: (src: ResourceSource) => unknown;
	/** speaking-events surface of a connection's receiver. */
	speakingEvents: (conn: any) => {
		on(event: "start" | "end", cb: (userId: string) => void): void;
	};
	/** true when the guild member behind userId is a human (not a bot). */
	isHumanFactory: (client: any, guildId: string) => (userId: string) => boolean;
	// ---- FLY-967 /gemini assistant-mode surface (landed first) + FLY-545
	// /glaw additions. Merge reconciliation per the first-to-land ruling:
	// 967's landed seams keep their exact shapes; 545's clashing variants got
	// distinct names (onChatInteraction / moveMemberDetailed) and its
	// registerGuildCommand needs folded in as a strict superset (options?
	// absent = 967's hardcoded topic option, byte-identical registration).
	/** create/overwrite a guild slash command (instant, no global propagation).
	 * options absent → the /gemini topic STRING option (FLY-967 behavior). */
	registerGuildCommand: (
		client: any,
		guildId: string,
		spec: {
			name: string;
			description: string;
			options?: readonly unknown[];
		},
	) => Promise<void>;
	/** dispatch chat-input invocations of `name` to the handler (projected
	 * defer-first payload — the FLY-967 /gemini discipline). */
	onChatCommand: (
		client: any,
		name: string,
		cb: (inv: {
			topic?: string;
			userId: string;
			reply: (text: string, opts?: { joinUrl?: string }) => Promise<void>;
		}) => void,
	) => void;
	/** FLY-545 /glaw: dispatch chat-input invocations of `name` to the handler
	 * with the RAW interaction (GlawCommand does its own defer/options/
	 * components projection call-site-locally). */
	onChatInteraction: (
		client: any,
		name: string,
		cb: (interaction: any) => void,
	) => void;
	sendMessage: (client: any, channelId: string, text: string) => Promise<void>;
	/** FLY-1065: a channel message whose id we keep (the TIV status anchor). */
	sendMessageForId: (
		client: any,
		channelId: string,
		text: string,
	) => Promise<{ messageId: string }>;
	/** FLY-1065: edit an existing channel message in place (status updates). */
	editMessage: (
		client: any,
		channelId: string,
		messageId: string,
		text: string,
	) => Promise<void>;
	/** voice-state deltas (founder presence tracking). */
	onVoiceStateUpdate: (
		client: any,
		cb: (u: {
			userId: string;
			isBot: boolean;
			fromChannelId: string | null;
			toChannelId: string | null;
		}) => void,
	) => () => void;
	/** humans currently in a voice channel. */
	voiceChannelHumanCount: (
		client: any,
		guildId: string,
		channelId: string,
	) => Promise<number>;
	/** the voice channel THIS user is in right now (null = not in voice).
	 * Read from the gateway voiceStates cache — consistent with the
	 * voiceStateUpdate stream, so a leave processed before the probe can
	 * never come back as a stale "present" (Codex R14 HIGH-2). */
	userVoiceChannelId: (
		client: any,
		guildId: string,
		userId: string,
	) => Promise<string | null>;
	/** MOVE_MEMBERS; false on missing permission / member not in voice. */
	moveMember: (
		client: any,
		guildId: string,
		userId: string,
		channelId: string,
	) => Promise<boolean>;
	/** FLY-545 zero-tap MOVE_MEMBERS; distinguishes "she isn't in voice"
	 * (Join button is the path in) from a real failure. */
	moveMemberDetailed: (
		client: any,
		guildId: string,
		userId: string,
		channelId: string,
	) => Promise<"moved" | "not-in-voice" | "failed">;
	/** guild display name for a (bot) user id — AddressRouter aliases. */
	memberDisplayName: (
		client: any,
		guildId: string,
		userId: string,
	) => Promise<string | undefined>;
	/** TIV message port (post/edit) on a channel. */
	tivPort: (
		client: any,
		channelId: string,
	) => {
		post(content: string): Promise<{ id: string }>;
		edit(messageId: string, content: string): Promise<void>;
	};
	/** tear down a voice connection (orchestrator leaves after the meeting). */
	leaveVoice: (conn: any) => void;
	/** connection liveness (ears down/up degradation signals). */
	connectionEvents: (conn: any) => {
		onDown: (cb: () => void) => () => void;
		onUp: (cb: () => void) => () => void;
	};
	/** FLY-967 round-3: duck-typed lifecycle handle for VoiceConnSupervisor
	 * (state-transition log + error listener + rejoin). Optional so test
	 * fakes without it keep compiling; wiring guards with ?. */
	voiceConnHandle?: (conn: any) => VoiceConnHandle;
	/** DAVE/receiver diagnostics exposed without leaking raw SDK debug text. */
	receiveEvents?: (conn: any) => {
		onTransition(cb: (transitionId: number) => void): () => void;
		onDiagnostic(cb: (event: DiscordReceiveDiagnostic) => void): () => void;
		isSpeaking(userId: string): boolean;
	};
}

export interface DiscordReceivePolicy {
	daveEncryption: boolean;
	decryptionFailureTolerance: number;
	debug?: boolean;
}

export interface DiscordReceiveRuntimeDiagnostic {
	voiceVersion: string;
	daveyVersion: string;
	nodeVersion: string;
	arch: string;
	daveEncryption: boolean;
	decryptionFailureTolerance: number;
	debug: boolean;
}

function installedPackageVersion(packageName: string): string {
	const require = createRequire(import.meta.url);
	let current = dirname(require.resolve(packageName));
	for (;;) {
		try {
			const manifest = JSON.parse(
				readFileSync(join(current, "package.json"), "utf8"),
			) as { name?: unknown; version?: unknown };
			if (
				manifest.name === packageName &&
				typeof manifest.version === "string" &&
				manifest.version.length > 0
			) {
				return manifest.version;
			}
		} catch {
			// Continue toward the package root; fail closed if none is found.
		}
		const parent = dirname(current);
		if (parent === current)
			throw new Error(`package_version_unavailable:${packageName}`);
		current = parent;
	}
}

export function loadDiscordReceiveRuntimeDiagnostic(
	policy: DiscordReceivePolicy,
): DiscordReceiveRuntimeDiagnostic {
	if (
		!Number.isSafeInteger(policy.decryptionFailureTolerance) ||
		policy.decryptionFailureTolerance < 0
	) {
		throw new Error("invalid_decryption_failure_tolerance");
	}
	return {
		voiceVersion: installedPackageVersion("@discordjs/voice"),
		daveyVersion: installedPackageVersion("@snazzah/davey"),
		nodeVersion: process.version,
		arch: process.arch,
		daveEncryption: policy.daveEncryption,
		decryptionFailureTolerance: policy.decryptionFailureTolerance,
		debug: policy.debug === true,
	};
}

export type DiscordReceiveDiagnostic =
	| {
			kind: "transition_preparing";
			transitionId: number;
			protocolVersion: number;
	  }
	| {
			kind: "transition_executed";
			transitionId: number;
			fromVersion: number;
			toVersion: number;
	  }
	| { kind: "decrypt_failures"; consecutiveFailures: number }
	| { kind: "decrypt_reinitializing"; reinitializing: true }
	| { kind: "session_security"; encrypted: boolean }
	| { kind: "transition_invalidated"; transitionId: number }
	| { kind: "decrypt_pending_transitions"; pendingTransitions: number }
	| {
			kind: "session_protocol";
			protocolVersion: number;
			reinitialized: boolean;
	  }
	| { kind: "unknown" };

export function buildVoiceJoinOptions(
	opts: VoiceJoinOpts,
	adapterCreator: unknown,
	clientUserId: string | undefined,
	policy?: DiscordReceivePolicy,
): Record<string, unknown> {
	if (
		policy &&
		(!Number.isSafeInteger(policy.decryptionFailureTolerance) ||
			policy.decryptionFailureTolerance < 0)
	) {
		throw new Error("invalid_decryption_failure_tolerance");
	}
	return {
		guildId: opts.guildId,
		channelId: opts.channelId,
		adapterCreator,
		selfMute: opts.selfMute,
		selfDeaf: opts.selfDeaf,
		group: clientUserId ?? "default",
		...(policy
			? {
					daveEncryption: policy.daveEncryption,
					decryptionFailureTolerance: policy.decryptionFailureTolerance,
					debug: policy.debug,
				}
			: {}),
	};
}

export function parseDiscordReceiveDiagnostic(
	message: string,
): DiscordReceiveDiagnostic {
	let match = message.match(
		/^\[NW\] \[DAVE\] Preparing for transition \((\d+), v(\d+)\)$/u,
	);
	if (match) {
		return {
			kind: "transition_preparing",
			transitionId: Number(match[1]),
			protocolVersion: Number(match[2]),
		};
	}
	match = message.match(
		/^\[NW\] \[DAVE\] Transition executed \(v(\d+) -> v(\d+), id: (\d+)\)$/u,
	);
	if (match) {
		return {
			kind: "transition_executed",
			fromVersion: Number(match[1]),
			toVersion: Number(match[2]),
			transitionId: Number(match[3]),
		};
	}
	match = message.match(
		/^\[NW\] \[DAVE\] Failed to decrypt a packet \((\d+) consecutive fails\)$/u,
	);
	if (match) {
		return { kind: "decrypt_failures", consecutiveFailures: Number(match[1]) };
	}
	if (
		message ===
		"[NW] [DAVE] Failed to decrypt a packet (reinitializing session)"
	) {
		return { kind: "decrypt_reinitializing", reinitializing: true };
	}
	if (message === "[NW] [DAVE] Session downgraded") {
		return { kind: "session_security", encrypted: false };
	}
	if (message === "[NW] [DAVE] Session upgraded") {
		return { kind: "session_security", encrypted: true };
	}
	match = message.match(/^\[NW\] \[DAVE\] Invalidating transition (\d+)$/u);
	if (match) {
		return { kind: "transition_invalidated", transitionId: Number(match[1]) };
	}
	match = message.match(
		/^\[NW\] \[DAVE\] Failed to decrypt a packet \((\d+) pending transition\[s\]\)$/u,
	);
	if (match) {
		return {
			kind: "decrypt_pending_transitions",
			pendingTransitions: Number(match[1]),
		};
	}
	match = message.match(
		/^\[NW\] \[DAVE\] Session (re)?initialized for protocol version (\d+)$/u,
	);
	if (match) {
		return {
			kind: "session_protocol",
			protocolVersion: Number(match[2]),
			reinitialized: match[1] === "re",
		};
	}
	return { kind: "unknown" };
}

/**
 * FLY-2701 review R4: joining creates the connection and only then waits for it
 * to become Ready. Every path out of that wait that is not success must destroy
 * what was created — the caller never receives a handle on those paths, so
 * nothing upstream can take the bot back out of the channel. The same applies
 * to an abort arriving mid-join: the room's own cleanup can only reach fields
 * it already owns, and this connection is not one of them yet.
 */
export async function joinVoiceConnection(input: {
	// Structurally the two primitives this needs, so a test can hand it fakes
	// while production hands it the real `@discordjs/voice` module.
	voice: {
		joinVoiceChannel: (options: any) => { destroy: () => void };
		entersState: (
			connection: any,
			status: any,
			timeoutMs: number,
		) => Promise<unknown>;
		VoiceConnectionStatus: { Ready: any };
	};
	client: {
		user?: { id?: string };
		guilds: { fetch: (guildId: string) => Promise<any> };
	};
	opts: VoiceJoinOpts;
	receivePolicy?: DiscordReceivePolicy;
	signal?: AbortSignal;
}): Promise<unknown> {
	const { voice, client, opts, receivePolicy, signal } = input;
	const aborted = (): Error =>
		new Error("voice_join_aborted", { cause: signal?.reason });
	if (signal?.aborted) throw aborted();
	const guild = await client.guilds.fetch(opts.guildId);
	if (signal?.aborted) throw aborted();
	// @discordjs/voice keys its connection registry by (group, guildId).
	// Group by bot id so multiple bot clients in one process cannot clobber
	// each other's connections.
	const conn = voice.joinVoiceChannel(
		buildVoiceJoinOptions(
			opts,
			guild.voiceAdapterCreator,
			client.user?.id,
			receivePolicy,
		) as any,
	);
	try {
		await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
		if (signal?.aborted) throw aborted();
	} catch (error) {
		try {
			conn.destroy();
		} catch {
			// Already torn down by the failure itself; nothing left to give back.
		}
		throw error;
	}
	return conn;
}

export async function createDiscordDeps(
	receivePolicy?: DiscordReceivePolicy,
): Promise<DiscordDeps> {
	const { Client, GatewayIntentBits } = await import("discord.js");
	const voice = await import("@discordjs/voice");
	const prismModule = await import("prism-media");
	const prism: any = (prismModule as any).default ?? prismModule;

	return {
		...(receivePolicy
			? { receiveRuntime: loadDiscordReceiveRuntimeDiagnostic(receivePolicy) }
			: {}),
		createClient: () =>
			new Client({
				intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
			}),

		// FLY-960 first pitfall: caller (BotRegistry.start) has already gated on
		// clientReady before this runs.
		joinVoice: async (client: any, opts: VoiceJoinOpts, signal?: AbortSignal) =>
			joinVoiceConnection({
				voice,
				client,
				opts,
				...(receivePolicy ? { receivePolicy } : {}),
				...(signal ? { signal } : {}),
			}),

		subscribeManual: (conn: any) => (userId: string) =>
			conn.receiver.subscribe(userId, {
				end: { behavior: voice.EndBehaviorType.Manual },
			}),

		createDecoder: () =>
			new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 }),

		createPlayer: (conn: any): PlayerLike => {
			const player = voice.createAudioPlayer({
				behaviors: {
					// FLY-967 round-5b: the default (5 missed 20ms frames = 100ms of
					// underflow) KILLS a live Raw stream on the first network gap
					// between Gemini audio chunks — Annie heard one "咕" fragment and
					// then silence. Tolerate up to 5s of underflow before giving up.
					maxMissedFrames: 250,
				},
			});
			conn.subscribe(player);
			const handlers: Record<string, ((err?: Error) => void)[]> = {
				playing: [],
				idle: [],
				error: [],
			};
			player.on("stateChange", (oldState: any, newState: any) => {
				if (
					newState.status === voice.AudioPlayerStatus.Playing &&
					oldState.status !== voice.AudioPlayerStatus.Playing
				) {
					for (const cb of handlers.playing ?? []) cb();
				}
				if (
					newState.status === voice.AudioPlayerStatus.Idle &&
					oldState.status !== voice.AudioPlayerStatus.Idle
				) {
					for (const cb of handlers.idle ?? []) cb();
				}
			});
			player.on("error", (err: Error) => {
				for (const cb of handlers.error ?? []) cb(err);
			});
			return {
				play: (resource) => player.play(resource as any),
				stop: () => player.stop(true),
				on: (event, cb) => {
					handlers[event] = handlers[event] ?? [];
					handlers[event].push(cb);
				},
			};
		},

		createResource: makeCreateResource(voice),

		speakingEvents: (conn: any) => conn.receiver.speaking,

		isHumanFactory: (client: any, guildId: string) =>
			makeIsHuman(client, guildId),

		// ---- FLY-967 /gemini assistant-mode surface (real SDK glue; exercised
		// by the staged E2E, not unit tests — discordWiring discipline) ----

		registerGuildCommand: async (client: any, guildId: string, spec) => {
			// guild-scoped commands propagate instantly, unlike global ones.
			// options absent = 967's /gemini topic option, byte-identical to the
			// pre-merge registration; /glaw passes its own options explicitly.
			const guild = await client.guilds.fetch(guildId);
			await guild.commands.create({
				name: spec.name,
				description: spec.description,
				options: spec.options ?? [
					{
						type: 3, // STRING
						name: "topic",
						description: "想聊什么(可选,用于简报聚焦)",
						required: false,
					},
				],
			});
		},

		onChatCommand: (client: any, name: string, cb) => {
			client.on("interactionCreate", (interaction: any) => {
				if (!interaction.isChatInputCommand?.()) return;
				if (interaction.commandName !== name) return;
				void handleChatInteraction(interaction, cb, (line) =>
					console.error(line),
				);
			});
		},

		onChatInteraction: (client: any, name: string, cb) => {
			client.on("interactionCreate", (interaction: any) => {
				if (!interaction.isChatInputCommand?.()) return;
				if (interaction.commandName !== name) return;
				cb(interaction);
			});
		},

		moveMemberDetailed: async (
			client: any,
			guildId: string,
			userId: string,
			channelId: string,
		) => {
			try {
				const guild = await client.guilds.fetch(guildId);
				await guild.members.edit(userId, { channel: channelId });
				return "moved";
			} catch (err: any) {
				// 40032 = "Target user is not connected to voice." — the expected
				// she-is-not-in-a-VC case; everything else is a real failure.
				return err?.code === 40032 ? "not-in-voice" : "failed";
			}
		},

		memberDisplayName: async (client: any, guildId: string, userId: string) => {
			try {
				const guild = await client.guilds.fetch(guildId);
				const member = await guild.members.fetch(userId);
				return member?.displayName ?? member?.user?.username;
			} catch {
				return undefined;
			}
		},

		tivPort: (client: any, channelId: string) => ({
			post: async (content: string) => {
				const channel = await client.channels.fetch(channelId);
				const msg = await channel.send(content);
				return { id: msg.id };
			},
			edit: async (messageId: string, content: string) => {
				const channel = await client.channels.fetch(channelId);
				await channel.messages.edit(messageId, content);
			},
		}),

		sendMessage: async (client: any, channelId: string, text: string) => {
			const channel = await client.channels.fetch(channelId);
			await channel.send(text);
		},

		sendMessageForId: async (client: any, channelId: string, text: string) => {
			const channel = await client.channels.fetch(channelId);
			const msg = await channel.send(text);
			return { messageId: String(msg.id) };
		},

		editMessage: async (
			client: any,
			channelId: string,
			messageId: string,
			text: string,
		) => {
			const channel = await client.channels.fetch(channelId);
			await channel.messages.edit(messageId, text);
		},

		onVoiceStateUpdate: (client: any, cb) => {
			const handler = makeVoiceStateForwarder(cb, (line) =>
				console.error(line),
			);
			client.on("voiceStateUpdate", handler);
			return () => client.off("voiceStateUpdate", handler);
		},

		voiceChannelHumanCount: async (
			client: any,
			guildId: string,
			channelId: string,
		) => {
			const guild = await client.guilds.fetch(guildId);
			return countHumansInVoiceChannel(guild, channelId);
		},

		userVoiceChannelId: async (
			client: any,
			guildId: string,
			userId: string,
		) => {
			// gateway cache only — there is no per-user voice-state REST endpoint,
			// and the cache is exactly what voiceStateUpdate mutates, so this can
			// never race a leave the forwarder already processed.
			const guild = await client.guilds.fetch(guildId);
			return guild.voiceStates?.cache?.get(userId)?.channelId ?? null;
		},

		voiceConnHandle: (conn: any): VoiceConnHandle => ({
			status: () => String(conn.state?.status ?? "unknown"),
			rejoin: () => {
				try {
					return conn.rejoin() === true;
				} catch {
					return false;
				}
			},
			onStateChange: (cb) => {
				const h = (o: any, n: any) =>
					cb(String(o?.status ?? "unknown"), String(n?.status ?? "unknown"));
				conn.on("stateChange", h);
				return () => conn.off("stateChange", h);
			},
			onError: (cb) => {
				conn.on("error", cb);
				return () => conn.off("error", cb);
			},
		}),

		receiveEvents: (conn: any) => ({
			onTransition: (cb) => {
				conn.on("transitioned", cb);
				return () => conn.off("transitioned", cb);
			},
			onDiagnostic: (cb) => {
				const handler = (message: string) =>
					cb(parseDiscordReceiveDiagnostic(message));
				conn.on("debug", handler);
				return () => conn.off("debug", handler);
			},
			isSpeaking: (userId) =>
				conn.receiver?.speaking?.users?.has(userId) === true,
		}),

		moveMember: async (
			client: any,
			guildId: string,
			userId: string,
			channelId: string,
		) => {
			try {
				const guild = await client.guilds.fetch(guildId);
				const member = await guild.members.fetch(userId);
				if (!member.voice?.channelId) return false; // not in any VC
				await member.voice.setChannel(channelId);
				return true;
			} catch {
				return false; // missing permission etc. — Join button is the path in
			}
		},

		leaveVoice: (conn: any) => {
			conn.destroy();
		},

		connectionEvents: (conn: any) => ({
			onDown: (cb: () => void) => {
				const handler = (_old: any, newState: any) => {
					if (newState.status === voice.VoiceConnectionStatus.Disconnected)
						cb();
				};
				conn.on("stateChange", handler);
				return () => conn.off("stateChange", handler);
			},
			onUp: (cb: () => void) => {
				const handler = (oldState: any, newState: any) => {
					if (
						newState.status === voice.VoiceConnectionStatus.Ready &&
						oldState.status !== voice.VoiceConnectionStatus.Ready
					)
						cb();
				};
				conn.on("stateChange", handler);
				return () => conn.off("stateChange", handler);
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// FLY-967 round-2 helpers — extracted SDK-free so Annie's real-machine
// failures stay pinned by unit tests (classifyVoiceDelta precedent). Only
// this module may construct them against real SDK objects.
// ---------------------------------------------------------------------------

/** duck-typed slice of a ChatInputCommandInteraction (no SDK import). */
export interface ChatInteractionLike {
	deferReply(): Promise<unknown>;
	editReply(payload: unknown): Promise<unknown>;
	followUp(payload: unknown): Promise<unknown>;
	user: { id: string };
	options: { getString(name: string): string | null };
}

/**
 * Defer-first interaction handling. Discord voids the interaction token 3s
 * after delivery; every slow step of /gemini (slot, Linear kickoff issue,
 * briefing) runs AFTER the handler starts — so the ack must be the FIRST
 * await, unconditionally (Annie round-1: "The application did not respond").
 * The first reply resolves the deferred placeholder via editReply; later
 * replies are followUps. A dead token (defer threw) never blocks the command
 * — replies degrade to no-ops and the founder ping is the fallback channel.
 */
export async function handleChatInteraction(
	interaction: ChatInteractionLike,
	cb: (inv: {
		topic?: string;
		userId: string;
		reply: (text: string, opts?: { joinUrl?: string }) => Promise<void>;
	}) => void | Promise<void>,
	log?: (line: string) => void,
): Promise<void> {
	let acked = true;
	try {
		await interaction.deferReply();
	} catch (err) {
		acked = false;
		log?.(
			`[chat-command] deferReply failed (command continues; replies dropped): ${String(
				(err as Error).message ?? err,
			)}`,
		);
	}
	let repliedOnce = false;
	await cb({
		topic: interaction.options.getString("topic") ?? undefined,
		userId: interaction.user.id,
		reply: async (text, opts) => {
			if (!acked) return; // token dead — nothing to edit, don't throw
			const payload = {
				content: text,
				components: opts?.joinUrl
					? [
							{
								type: 1,
								components: [
									{
										type: 2,
										style: 5, // Link
										label: "Join",
										url: opts.joinUrl,
									},
								],
							},
						]
					: undefined,
			};
			if (repliedOnce) {
				await interaction.followUp(payload);
			} else {
				repliedOnce = true;
				await interaction.editReply(payload);
			}
		},
	});
}

/**
 * Resource factory. "raw-stream" sources are headerless 48kHz s16le stereo
 * PCM (AssistantSpeaker turn streams, GeminiTurnMouth) and MUST be declared
 * StreamType.Raw — the default (StreamType.Arbitrary) sends headerless PCM
 * through an ffmpeg probe that mis-decodes it (Annie round-2: garbled
 * assistant voice). Plain "stream" sources (LeadSpeaker's TTS synth output)
 * and file sources keep the ffmpeg probe path: they have probeable headers.
 * (545/967 merge reconciliation: 545's explicit "raw-stream" kind is the
 * disambiguation — 967's AssistantSpeaker moved onto it.)
 */
export function makeCreateResource(voiceLib: {
	// method syntax (bivariant) so the real @discordjs/voice module and the
	// unit-test stub both satisfy the seam
	createAudioResource(input: any, options?: any): unknown;
	StreamType: { Raw: unknown };
}): (src: ResourceSource) => unknown {
	return (src) =>
		src.kind === "file"
			? voiceLib.createAudioResource(src.path)
			: src.kind === "raw-stream"
				? voiceLib.createAudioResource(src.stream as Readable, {
						inputType: voiceLib.StreamType.Raw,
					})
				: voiceLib.createAudioResource(src.stream as Readable);
}

/**
 * Human filter that self-heals cache misses. members.cache alone is a trap:
 * GUILD_CREATE voice_states carry NO member objects, so a founder already
 * sitting in the VC before boot never appears in the cache and every speaking
 * burst is dropped fail-closed (Annie round-2/3: the assistant heard nothing;
 * both landed summaries had zero quotes). On a miss we stay fail-closed for
 * THIS burst but kick a single-member REST fetch (no privileged intent
 * needed); the next burst is admitted. Current VC occupants are prefetched at
 * construction so the founder's FIRST utterance is already audible.
 */
/** duck-typed slice of a discord.js VoiceState (no SDK import). */
export interface VoiceStateLike {
	id: string;
	channelId: string | null;
	member?: { user?: { bot?: boolean } };
	guild: {
		members: { fetch: (userId: string) => Promise<{ user: { bot: boolean } }> };
	};
}

/**
 * Voice-state forwarder that never defaults an unresolved member to bot.
 * Round-3 regression (Annie's third real-machine round): without the
 * GuildMembers intent her member object was unresolved on the join event, the
 * old `?? true` default classified her as a bot, wiring dropped the delta,
 * founderPresent stayed false and the session never entered live. Mirrors the
 * round-2 self-heal: resolve via a single-member REST fetch (VoiceState.guild
 * carries the handle; discord.js caches the result so later events are sync).
 * Resolution failure drops the delta fail-closed.
 */
export function makeVoiceStateForwarder(
	cb: (u: {
		userId: string;
		isBot: boolean;
		fromChannelId: string | null;
		toChannelId: string | null;
	}) => void,
	log?: (line: string) => void,
): (oldState: VoiceStateLike, newState: VoiceStateLike) => void {
	// per-user serialization (Codex R13): each user's deltas run through ONE
	// promise chain, so a slow REST resolution can never reorder gateway order
	// (unresolved join + quick leave used to emit leave-before-join and corrupt
	// humanCount). Different users stay independent.
	const chains = new Map<string, Promise<void>>();
	return (oldState, newState) => {
		const userId = newState.id;
		const known = newState.member?.user?.bot ?? oldState.member?.user?.bot;
		const fromChannelId = oldState.channelId ?? null;
		const toChannelId = newState.channelId ?? null;
		const step = async () => {
			let isBot: boolean;
			if (typeof known === "boolean") {
				isBot = known;
			} else {
				try {
					const m = await newState.guild.members.fetch(userId);
					isBot = m.user.bot === true;
					log?.(
						`[voice-state] member ${userId} resolved via REST: bot=${isBot}`,
					);
				} catch (err) {
					log?.(
						`[voice-state] member ${userId} unresolvable — delta dropped fail-closed: ${String(
							(err as Error).message ?? err,
						)}`,
					);
					return;
				}
			}
			cb({ userId, isBot, fromChannelId, toChannelId });
		};
		const tail = (chains.get(userId) ?? Promise.resolve()).then(step);
		chains.set(userId, tail);
		void tail.finally(() => {
			if (chains.get(userId) === tail) chains.delete(userId);
		});
	};
}

/** duck-typed slice of a discord.js Guild (no SDK import). */
export interface GuildLike {
	voiceStates?: { cache: Map<string, { channelId?: string | null }> };
	members: {
		cache?: Map<string, { user?: { bot?: boolean } }>;
		fetch: (userId: string) => Promise<{ user: { bot: boolean } }>;
	};
}

/**
 * Humans currently in a voice channel, counted from voice states (NOT
 * channel.members — that view silently omits unresolved members, which is
 * exactly the pre-sitting-founder shape: GUILD_CREATE voice_states carry no
 * member objects). Unresolved occupants are resolved via a single-member REST
 * fetch; unresolvable ones count as not-human (fail-closed).
 */
export async function countHumansInVoiceChannel(
	guild: GuildLike,
	channelId: string,
): Promise<number> {
	let humans = 0;
	for (const [userId, vs] of guild.voiceStates?.cache ?? []) {
		if ((vs?.channelId ?? null) !== channelId) continue;
		try {
			const member =
				guild.members.cache?.get(userId) ?? (await guild.members.fetch(userId));
			if (member.user?.bot === false) humans++;
		} catch {
			// unknown member — fail-closed, not counted
		}
	}
	return humans;
}

export function makeIsHuman(
	client: {
		guilds: {
			cache: Map<
				string,
				{
					members: {
						cache: Map<string, { user: { bot: boolean } }>;
						fetch?: (userId: string) => Promise<{ user: { bot: boolean } }>;
					};
					voiceStates?: { cache: Map<string, unknown> };
				}
			>;
			fetch: (guildId: string) => Promise<{
				members: {
					fetch: (userId: string) => Promise<{ user: { bot: boolean } }>;
				};
			}>;
		};
	},
	guildId: string,
): (userId: string) => boolean {
	const resolved = new Map<string, boolean>();
	const inflight = new Set<string>();
	const ensureResolve = (userId: string) => {
		if (inflight.has(userId) || resolved.has(userId)) return;
		inflight.add(userId);
		const cached = client.guilds.cache.get(guildId);
		const member = cached?.members.fetch
			? cached.members.fetch(userId)
			: client.guilds.fetch(guildId).then((g) => g.members.fetch(userId));
		member
			.then((m) => {
				resolved.set(userId, m.user.bot === false);
			})
			.catch(() => {
				// stay unknown — a later burst retries (transient REST outage)
			})
			.finally(() => {
				inflight.delete(userId);
			});
	};
	for (const [userId] of client.guilds.cache.get(guildId)?.voiceStates?.cache ??
		[]) {
		ensureResolve(userId);
	}
	return (userId: string) => {
		const member = client.guilds.cache.get(guildId)?.members.cache.get(userId);
		if (member) return member.user.bot === false;
		const known = resolved.get(userId);
		if (known !== undefined) return known;
		ensureResolve(userId);
		return false;
	};
}
