/**
 * FLY-2796 review R1/R2: who could be speaking in the voice channel, read at
 * the moment sole-speaker attribution asks.
 *
 * Attribution may trust "she is the one human here" only while that is
 * actually known, and every existing count answers a different question:
 * RoomIO re-reads the channel only on the founder's own voice-state changes,
 * the deps' voice-state stream waits for a REST member lookup before it
 * reports a join (and drops the change if the lookup fails), and
 * `voiceChannelHumanCount` leaves out occupants it cannot classify. Each is
 * fail-closed for "is anyone still here", and fail-open for "is she alone".
 *
 * This reads the gateway voice-state cache directly, synchronously, each time
 * it is asked — the cache is what the voice-state stream mutates before any
 * listener runs. Every occupant counts unless it is this bot or a member the
 * cache already knows is a bot; an occupant it cannot classify counts as a
 * possible human. When the cache cannot be read, the answer is unknown. The
 * client handle comes from the room's own deps subscription, so the room
 * layer is untouched.
 */

type MemberLike = { user?: { bot?: boolean } | null } | null | undefined;

interface GuildCacheLike {
	voiceStates?: {
		cache?: Iterable<
			[string, { channelId?: string | null; member?: MemberLike }]
		>;
	};
	members?: { cache?: { get(userId: string): MemberLike } };
}

interface ClientLike {
	user?: { id?: string } | null;
	guilds?: { cache?: { get(guildId: string): GuildCacheLike | undefined } };
}

export interface HeadcountDeps {
	onVoiceStateUpdate(client: unknown, cb: never): () => void;
}

export class ChannelHeadcount {
	private client?: ClientLike;

	constructor(
		private readonly options: { guildId: string; voiceChannelId: string },
	) {}

	wrap<T extends HeadcountDeps>(deps: T): T {
		const subscribe = deps.onVoiceStateUpdate.bind(deps) as (
			client: unknown,
			cb: unknown,
		) => () => void;
		return {
			...deps,
			onVoiceStateUpdate: (client: unknown, cb: unknown) => {
				this.client = client as ClientLike;
				return subscribe(client, cb);
			},
		};
	}

	/** Possible humans in the channel now, or null when that cannot be read. */
	current(): number | null {
		try {
			const client = this.client;
			const guild = client?.guilds?.cache?.get(this.options.guildId);
			const states = guild?.voiceStates?.cache;
			if (!states) return null;
			let occupants = 0;
			for (const [userId, state] of states) {
				if ((state?.channelId ?? null) !== this.options.voiceChannelId)
					continue;
				if (userId === client?.user?.id) continue;
				const member = state?.member ?? guild?.members?.cache?.get(userId);
				if (member?.user?.bot === true) continue;
				occupants += 1;
			}
			return occupants;
		} catch {
			return null;
		}
	}
}
