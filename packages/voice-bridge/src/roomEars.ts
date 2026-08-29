/**
 * wireRoomEars (FLY-1006 S5b) — the ONE resident EarsReceiver for the daemon
 * lifetime, routed into the shared VoiceRoomRuntime. Extracted verbatim from
 * the FLY-967 /gemini wiring (which owned it privately) so every voice mode
 * consumes the same physical receiver instead of double-subscribing.
 *
 * onBargeIn now routes into the room (FLY-967 wired it to a no-op): /gemini
 * registers no barge-in consumer so its behavior is unchanged; /eleven uses
 * it as the local flush fast path.
 */
import { EarsReceiver } from "./audio/EarsReceiver.js";
import { superviseVoiceConnection } from "./audio/VoiceConnSupervisor.js";
import type { DiscordDeps } from "./bots/discordWiring.js";
import type { VoiceRoomRuntime } from "./VoiceRoomRuntime.js";

export interface WireRoomEarsOptions {
	room: VoiceRoomRuntime;
	deps: Pick<
		DiscordDeps,
		| "speakingEvents"
		| "subscribeManual"
		| "createDecoder"
		| "isHumanFactory"
		| "connectionEvents"
	> &
		Partial<Pick<DiscordDeps, "voiceConnHandle">>;
	/** the resident Note-taker voice connection. */
	earsConnection: unknown;
	/** the Note-taker client (isHuman member lookups). */
	earsClient: unknown;
	guildId: string;
	allowUserIds?: string[];
	backchannelMs?: number;
	bargeInHoldoffMs?: number;
	log?: (msg: string) => void;
}

export interface RoomEarsRuntime {
	dispose(): void;
}

export function wireRoomEars(opts: WireRoomEarsOptions): RoomEarsRuntime {
	const log = opts.log ?? (() => {});
	const { room, deps } = opts;
	const ears = new EarsReceiver({
		speaking: deps.speakingEvents(opts.earsConnection),
		subscribe: deps.subscribeManual(opts.earsConnection),
		createDecoder: deps.createDecoder,
		isHuman: deps.isHumanFactory(opts.earsClient, opts.guildId),
		allowUserIds: opts.allowUserIds,
		backchannelMs: opts.backchannelMs,
		bargeInHoldoffMs: opts.bargeInHoldoffMs,
		onFrame: (frame) =>
			room.routeFrame(frame, {
				encoding: "pcm16",
				sampleRateHz: 16_000,
				channels: 1,
			}),
		onSpeakingStart: () => room.routeSpeakingStart(),
		onSpeakingEnd: () => room.routeSpeakingEnd(),
		onBargeIn: () => room.routeBargeIn(),
		onError: (err, userId) =>
			log(`ears pipeline error (user ${userId}): ${err.message}`),
	});
	ears.attach();
	const conn = deps.connectionEvents(opts.earsConnection);
	const unsubDown = conn.onDown(() => room.fireDown());
	const unsubUp = conn.onUp(() => room.fireUp());
	// diagnostics only (FLY-967 round-3): the ears connection has its own
	// EARS_LOST degradation flow; this just puts every transition in the log.
	const earsHandle = deps.voiceConnHandle?.(opts.earsConnection);
	const disposeWatch = earsHandle
		? superviseVoiceConnection(earsHandle, {
				label: "ears",
				log,
				mode: "observe",
			})
		: undefined;
	return {
		dispose: () => {
			unsubDown();
			unsubUp();
			disposeWatch?.();
			ears.detach();
		},
	};
}
