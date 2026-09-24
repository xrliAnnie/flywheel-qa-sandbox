/**
 * FLY-2796 review R1: a live count of the humans in the voice channel.
 *
 * Sole-speaker attribution may only trust "she is the one human here" while
 * that is actually known. RoomIO re-reads the channel only on the founder's
 * own voice-state changes, so after anyone else joins, its count is stale.
 * This watches every voice-state change through the same deps RoomIO
 * subscribes with — the room layer itself is untouched. Any change touching
 * the channel makes the count unknown at once, before the room hears the
 * event, and a fresh read settles it. A failed or superseded read stays
 * unknown, so attribution fails closed until the channel is read again.
 */

type VoiceStateEvent = {
	userId: string;
	isBot: boolean;
	fromChannelId: string | null;
	toChannelId: string | null;
};

export interface HeadcountDeps {
	onVoiceStateUpdate(
		client: unknown,
		cb: (event: VoiceStateEvent) => void,
	): () => void;
	voiceChannelHumanCount?(
		client: unknown,
		guildId: string,
		channelId: string,
	): Promise<number>;
}

export class ChannelHeadcount {
	private humans: number | null = null;
	private epoch = 0;

	constructor(
		private readonly options: {
			guildId: string;
			voiceChannelId: string;
			onError?(error: Error): void;
		},
	) {}

	/** Humans in the channel now, or null while that is not known. */
	current(): number | null {
		return this.humans;
	}

	wrap<T extends HeadcountDeps>(deps: T): T {
		return {
			...deps,
			onVoiceStateUpdate: (
				client: unknown,
				cb: (event: VoiceStateEvent) => void,
			) => {
				const unsubscribe = deps.onVoiceStateUpdate(client, (event) => {
					if (
						!event.isBot &&
						(event.fromChannelId === this.options.voiceChannelId ||
							event.toChannelId === this.options.voiceChannelId)
					)
						this.recount(client, deps);
					cb(event);
				});
				this.recount(client, deps);
				return unsubscribe;
			},
		};
	}

	private recount(client: unknown, deps: HeadcountDeps): void {
		const epoch = ++this.epoch;
		this.humans = null;
		if (!deps.voiceChannelHumanCount) return;
		let read: Promise<number>;
		try {
			read = deps.voiceChannelHumanCount(
				client,
				this.options.guildId,
				this.options.voiceChannelId,
			);
		} catch (error) {
			this.options.onError?.(error as Error);
			return;
		}
		void Promise.resolve(read).then(
			(humans) => {
				if (epoch !== this.epoch) return;
				this.humans =
					Number.isSafeInteger(humans) && humans >= 0 ? humans : null;
			},
			(error) => {
				if (epoch === this.epoch) this.options.onError?.(error as Error);
			},
		);
	}
}
