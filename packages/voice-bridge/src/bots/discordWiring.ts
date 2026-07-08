/**
 * discordWiring — the ONLY module that touches real discord.js /
 * @discordjs/voice / prism-media APIs (genaiConnector pattern: dynamic
 * imports keep every other module unit-testable without the SDKs, and the
 * real glue is exercised by the PR-1 real-machine loop, not unit tests).
 */
import type { Readable } from "node:stream";
import type { PlayerLike, ResourceSource } from "../audio/LeadSpeaker.js";
import type { VoiceJoinOpts } from "./BotRegistry.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DiscordDeps {
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
	// ---- FLY-967 /gemini assistant-mode surface ----
	/** register a guild slash command with one optional STRING "topic" option. */
	registerGuildCommand: (
		client: any,
		guildId: string,
		spec: { name: string; description: string },
	) => Promise<void>;
	/** dispatch chat-input invocations of `name` to the handler. */
	onChatCommand: (
		client: any,
		name: string,
		cb: (inv: {
			topic?: string;
			userId: string;
			reply: (text: string, opts?: { joinUrl?: string }) => Promise<void>;
		}) => void,
	) => void;
	sendMessage: (client: any, channelId: string, text: string) => Promise<void>;
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
	/** MOVE_MEMBERS; false on missing permission / member not in voice. */
	moveMember: (
		client: any,
		guildId: string,
		userId: string,
		channelId: string,
	) => Promise<boolean>;
	/** tear down a voice connection (orchestrator leaves after the meeting). */
	leaveVoice: (conn: any) => void;
	/** connection liveness (ears down/up degradation signals). */
	connectionEvents: (conn: any) => {
		onDown: (cb: () => void) => () => void;
		onUp: (cb: () => void) => () => void;
	};
}

export async function createDiscordDeps(): Promise<DiscordDeps> {
	const { Client, GatewayIntentBits } = await import("discord.js");
	const voice = await import("@discordjs/voice");
	const prismModule = await import("prism-media");
	const prism: any = (prismModule as any).default ?? prismModule;

	return {
		createClient: () =>
			new Client({
				intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
			}),

		// FLY-960 first pitfall: caller (BotRegistry.start) has already gated on
		// clientReady before this runs.
		joinVoice: async (client: any, opts: VoiceJoinOpts) => {
			const guild = await client.guilds.fetch(opts.guildId);
			const conn = voice.joinVoiceChannel({
				guildId: opts.guildId,
				channelId: opts.channelId,
				adapterCreator: guild.voiceAdapterCreator,
				selfMute: opts.selfMute,
				selfDeaf: opts.selfDeaf,
				// @discordjs/voice keys its connection registry by (group, guildId)
				// with group defaulting to "default" — N bots in ONE process joining
				// the SAME guild would clobber each other's connection (found on the
				// PR-1 real-machine loop: ears went silent the moment the speaker
				// joined). Group by bot user id = the multi-client-per-process form.
				group: client.user?.id ?? "default",
			});
			await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
			return conn;
		},

		subscribeManual: (conn: any) => (userId: string) =>
			conn.receiver.subscribe(userId, {
				end: { behavior: voice.EndBehaviorType.Manual },
			}),

		createDecoder: () =>
			new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 }),

		createPlayer: (conn: any): PlayerLike => {
			const player = voice.createAudioPlayer();
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

		createResource: (src: ResourceSource) =>
			src.kind === "file"
				? voice.createAudioResource(src.path)
				: voice.createAudioResource(src.stream as Readable),

		speakingEvents: (conn: any) => conn.receiver.speaking,

		isHumanFactory: (client: any, guildId: string) => (userId: string) => {
			const member = client.guilds.cache
				.get(guildId)
				?.members.cache.get(userId);
			// unknown member → NOT admitted (fail-closed; allowUserIds is the
			// explicit override for QA rigs).
			return member ? member.user.bot === false : false;
		},

		// ---- FLY-967 /gemini assistant-mode surface (real SDK glue; exercised
		// by the staged E2E, not unit tests — discordWiring discipline) ----

		registerGuildCommand: async (client: any, guildId: string, spec) => {
			const guild = await client.guilds.fetch(guildId);
			await guild.commands.create({
				name: spec.name,
				description: spec.description,
				options: [
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
				cb({
					topic: interaction.options.getString("topic") ?? undefined,
					userId: interaction.user.id,
					reply: async (text: string, opts?: { joinUrl?: string }) => {
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
						if (interaction.replied || interaction.deferred) {
							await interaction.followUp(payload);
						} else {
							await interaction.reply(payload);
						}
					},
				});
			});
		},

		sendMessage: async (client: any, channelId: string, text: string) => {
			const channel = await client.channels.fetch(channelId);
			await channel.send(text);
		},

		onVoiceStateUpdate: (client: any, cb) => {
			const handler = (oldState: any, newState: any) => {
				cb({
					userId: newState.id,
					isBot: newState.member?.user?.bot ?? true,
					fromChannelId: oldState.channelId ?? null,
					toChannelId: newState.channelId ?? null,
				});
			};
			client.on("voiceStateUpdate", handler);
			return () => client.off("voiceStateUpdate", handler);
		},

		voiceChannelHumanCount: async (
			client: any,
			guildId: string,
			channelId: string,
		) => {
			const guild = await client.guilds.fetch(guildId);
			const channel = await guild.channels.fetch(channelId);
			let humans = 0;
			for (const [, member] of channel?.members ?? []) {
				if (member.user?.bot === false) humans++;
			}
			return humans;
		},

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
