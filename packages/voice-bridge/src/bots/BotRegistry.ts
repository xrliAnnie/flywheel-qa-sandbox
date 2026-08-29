/**
 * BotRegistry — N lightweight gateway clients in one voice-bridge process
 * (FLY-545 P5): the orchestrator bot, the Note-taker (ears) bot, and one bot
 * per participating Lead. One discord.js Client per token; the Lead tokens
 * are shared with the Lead daemons (Discord allows multiple gateway sessions
 * per token; ONLY voice-bridge holds voice connections — research §9).
 *
 * The FIRST PITFALL from the FLY-960 spike is codified here: calling
 * joinVoiceChannel before clientReady silently wedges in signalling — so
 * start() gates on clientReady for EVERY bot before returning, and join() is
 * only reachable afterwards.
 *
 * discord.js / @discordjs/voice specifics are injected (createClient /
 * joinVoice) so the registry is unit-testable; the real wiring lives in
 * discordWiring.ts and is exercised by the PR-1 real-machine loop.
 */

export interface RegistryClientLike {
	login(token: string): Promise<unknown>;
	isReady(): boolean;
	once(event: "clientReady", cb: () => void): void;
	destroy(): Promise<void> | void;
}

export interface BotSpec {
	id: string;
	token: string;
}

export interface VoiceJoinOpts {
	guildId: string;
	channelId: string;
	selfMute: boolean;
	selfDeaf: boolean;
}

export interface BotRegistryOptions<C extends RegistryClientLike, V> {
	createClient: () => C;
	/** real impl: guild fetch + joinVoiceChannel + entersState(Ready, 15s). */
	joinVoice: (client: C, opts: VoiceJoinOpts) => Promise<V>;
}

export class BotRegistry<C extends RegistryClientLike, V> {
	private readonly clients = new Map<string, C>();

	constructor(private readonly opts: BotRegistryOptions<C, V>) {}

	/** login every bot and wait for clientReady on each (join-before-ready
	 * silently wedges — FLY-960 first pitfall). */
	async start(bots: BotSpec[]): Promise<void> {
		const seen = new Set<string>();
		for (const bot of bots) {
			if (seen.has(bot.id)) {
				throw new Error(`BotRegistry: duplicate bot id "${bot.id}"`);
			}
			seen.add(bot.id);
		}
		await Promise.all(
			bots.map(async (bot) => {
				const client = this.opts.createClient();
				this.clients.set(bot.id, client);
				try {
					await client.login(bot.token);
				} catch (err) {
					throw new Error(
						`BotRegistry: bot "${bot.id}" failed to login: ${String(
							err instanceof Error ? err.message : err,
						)}`,
						{ cause: err },
					);
				}
				await new Promise<void>((resolve) => {
					if (client.isReady()) resolve();
					else client.once("clientReady", resolve);
				});
			}),
		);
	}

	client(id: string): C {
		const client = this.clients.get(id);
		if (!client) {
			throw new Error(`BotRegistry: unknown bot id "${id}" (not started)`);
		}
		return client;
	}

	async join(id: string, opts: VoiceJoinOpts): Promise<V> {
		return this.opts.joinVoice(this.client(id), opts);
	}

	async destroyAll(): Promise<void> {
		await Promise.all(
			[...this.clients.values()].map((client) => client.destroy()),
		);
		this.clients.clear();
	}
}
