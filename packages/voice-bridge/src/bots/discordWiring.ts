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
	};
}
