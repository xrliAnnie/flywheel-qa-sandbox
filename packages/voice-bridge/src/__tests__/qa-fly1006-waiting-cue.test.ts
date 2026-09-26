/**
 * QA · FLY-1006 — the waiting cue (Annie 反馈② 的 M2 原生实现) contract.
 *
 * plan §4 追加要求②: 用户说完 → 立即响「处理中」音效 → 真答案 onset 停。
 * ElevenSession carries the seam (`cue.start()` on speaking-end, `cue.stop()`
 * on the first audio chunk), but BOTH halves are wired wrong. These two tests
 * are RED against the current implementation and describe the intended shape.
 *
 * D1 — the cue can never start. EarsReceiver's backchannel gate fires
 * `onBargeIn` 350ms into ANY sustained burst, i.e. BEFORE `onSpeakingEnd` of
 * the founder's own turn — never mind whether the agent is speaking. That sets
 * ElevenSession.suppressed, and `suppressed` is only cleared by the platform's
 * `user_transcript`, which lands ~9s LATER. So the `!suppressed` guard on the
 * speaking-end cue start is always false in production.
 *   Real-machine corroboration (independent QA re-run of the S8 audio leg,
 *   session dc290a0f jsonl): every single `speech_end` is preceded by an
 *   `interruption source=local` — including the first utterance at +5.8s, when
 *   no agent audio had ever played (first_audio only at +18.5s).
 *
 * D2 — if the cue ever DID start, it would silence the agent. The wiring hands
 * `cue.stop` and AssistantSpeaker the SAME player (eleven/wiring.ts: cue.stop =
 * deferredPlayer.player.stop; speaker = new AssistantSpeaker({player})). But
 * ElevenSession.onAudio calls `cue?.stop()` on EVERY chunk, not just the first
 * — so from the second chunk on, `player.stop()` tears down the very turn
 * stream AssistantSpeaker just started playing.
 *
 * Both defects are latent today ONLY because no config sets
 * `huddle.eleven.waitingCuePath` (cue === undefined ⇒ `cue?.stop()` is a
 * no-op). Turning the founder-requested feature on is what breaks audio.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantSpeaker } from "../assistant/AssistantSpeaker.js";
import { EarsReceiver } from "../audio/EarsReceiver.js";
import type { PlayerLike, ResourceSource } from "../audio/LeadSpeaker.js";
import { ELEVEN_SLOT_MODE } from "../eleven/config.js";
import {
	ElevenSession,
	type ElevenWsHandlers,
} from "../eleven/ElevenSession.js";
import { VoiceRoomRuntime } from "../VoiceRoomRuntime.js";

type SpeakingCb = (userId: string) => void;

/** the @discordjs/voice receiver.speaking surface EarsReceiver binds. */
class FakeSpeaking {
	private handlers: Record<"start" | "end", SpeakingCb[]> = {
		start: [],
		end: [],
	};
	on(event: "start" | "end", cb: SpeakingCb): void {
		this.handlers[event].push(cb);
	}
	fire(event: "start" | "end", userId: string): void {
		for (const cb of this.handlers[event]) cb(userId);
	}
}

/** the daemon's real composition: ONE player shared by the cue and the mouth
 * (eleven/wiring.ts startSession). */
function makeSharedPlayer() {
	const events: string[] = [];
	const player: PlayerLike = {
		play: (resource) => {
			const src = resource as ResourceSource;
			events.push(`play:${src.kind}`);
		},
		stop: () => {
			events.push("stop");
		},
		on: () => {},
	};
	return { player, events };
}

function makeSession(
	over: Partial<ConstructorParameters<typeof ElevenSession>[0]> = {},
) {
	const room = new VoiceRoomRuntime();
	expect(room.slot.acquire(ELEVEN_SLOT_MODE, "qa-1").ok).toBe(true);
	let handlers: ElevenWsHandlers | undefined;
	const session = new ElevenSession({
		sessionId: "qa-1",
		slot: room.slot,
		slotMode: ELEVEN_SLOT_MODE,
		ears: room,
		connect: async (h) => {
			handlers = h;
			return { sendAudio: () => {}, flushAudio: () => {}, close: () => {} };
		},
		speaker: {
			beginTurn: () => {},
			feed: () => {},
			endTurn: () => {},
			flush: () => {},
		},
		voice: { join: async () => {}, leave: () => {} },
		log: () => {},
		...over,
	});
	return { room, session, handlers: () => handlers as ElevenWsHandlers };
}

describe("QA FLY-1006 — waiting cue (Annie 反馈②)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("D1: a normal founder utterance still starts the waiting cue on speaking-end", async () => {
		const cue = { starts: 0, stops: 0 };
		const { room, session } = makeSession({
			cue: {
				start: () => {
					cue.starts++;
				},
				stop: () => {
					cue.stops++;
				},
			},
		});
		await session.start();

		// the REAL ears pipeline, routed exactly as wireRoomEars does.
		const speaking = new FakeSpeaking();
		const ears = new EarsReceiver({
			speaking,
			subscribe: () => new PassThrough(),
			createDecoder: () => new PassThrough(),
			isHuman: () => true,
			backchannelMs: 350,
			onFrame: (frame) => room.routeFrame(frame, {}),
			onSpeakingEnd: () => room.routeSpeakingEnd(),
			onBargeIn: () => room.routeBargeIn(),
			onError: () => {},
		});
		ears.attach();

		// Annie says one ordinary sentence (~2s — every real utterance is > the
		// 350ms backchannel gate, so onBargeIn fires mid-sentence).
		speaking.fire("start", "human-annie");
		await vi.advanceTimersByTimeAsync(2_000);
		speaking.fire("end", "human-annie");

		// she has stopped talking and the brain is thinking (the platform's
		// user_transcript is still ~9s away) — this is exactly the window the
		// cue exists to fill.
		expect(cue.starts).toBe(1);
	});

	it("D2: cue.stop() must not tear down the live turn stream on later chunks", async () => {
		const { player, events } = makeSharedPlayer();
		const speaker = new AssistantSpeaker({
			player,
			createResource: (src) => src,
			upsample: (chunk) => chunk,
			log: () => {},
		});
		const { session, handlers } = makeSession({
			speaker,
			// the production cue: same player as the mouth (eleven/wiring.ts).
			cue: {
				start: () => player.play({ kind: "file", path: "/cue.opus" }),
				stop: () => player.stop(),
			},
		});
		await session.start();

		handlers().onAudio(Buffer.alloc(480)); // first chunk: cue off, turn opens
		const turnStreamPlaying = events.lastIndexOf("play:stream");
		expect(turnStreamPlaying).toBeGreaterThanOrEqual(0);

		handlers().onAudio(Buffer.alloc(480)); // mid-turn chunks
		handlers().onAudio(Buffer.alloc(480));

		// nothing may stop the player between the turn stream starting and the
		// turn ending — a stop() here silences the agent mid-sentence.
		expect(events.slice(turnStreamPlaying + 1)).not.toContain("stop");
	});
});
