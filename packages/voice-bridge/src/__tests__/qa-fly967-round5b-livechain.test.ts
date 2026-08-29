/**
 * FLY-967 round-5 REVISED — post-enterLive live chain went dead both ways.
 *
 * QA's hard-artifact re-attribution: FLY-1019 landed (state reached
 * live/concluding — presence fix works), but 0 captions both directions,
 * "无 recap" summary, and Annie heard only a single "咕" fragment of the
 * opening. Mandate: instrument the whole live chain (out: OPENING sent /
 * response-audio chunks / speaker feeds / player non-null + play calls;
 * in: live-state ears→sendAudio counts) and pin why landing fired at
 * 22:54:31 with her still in the room (transition-source labels).
 *
 * Audit result on the named prime suspect (deferred realPlayer proxy):
 * AssistantSpeaker never calls player.on() and play() cannot run before
 * voice.join sets the real player — but the proxy DID silently drop on()
 * registrations and play() calls when real was missing. makeDeferredPlayer
 * now queues on() until the real player arrives and logs LOUDLY if play()
 * ever fires without one (runtime evidence instead of silence).
 */
import { describe, expect, it, vi } from "vitest";
import { AssistantSpeaker } from "../assistant/AssistantSpeaker.js";
import { makeDeferredPlayer } from "../assistant/wiring.js";

describe("FLY-967 round-5b ① makeDeferredPlayer — nothing silent about a missing player", () => {
	it("play() before the real player exists is dropped LOUDLY, not silently", () => {
		const lines: string[] = [];
		const { player } = makeDeferredPlayer((l) => lines.push(l));
		player.play({ res: 1 });
		expect(lines.join("\n")).toContain("no real player yet");
	});

	it("on() registrations made before join are queued and replayed once the real player arrives", () => {
		const { player, setReal } = makeDeferredPlayer(() => {});
		const seen: string[] = [];
		player.on("idle", () => seen.push("idle-cb"));
		const real = {
			play: vi.fn(),
			stop: vi.fn(),
			on: vi.fn((event: string, _cb: () => void) => {
				seen.push(`registered:${event}`);
			}),
		};
		setReal(real as never);
		expect(seen).toEqual(["registered:idle"]); // not lost
		player.play({ res: 2 });
		expect(real.play).toHaveBeenCalledWith({ res: 2 });
	});

	it("logs when the real player is attached (timing evidence for the venue log)", () => {
		const lines: string[] = [];
		const { setReal } = makeDeferredPlayer((l) => lines.push(l));
		setReal({ play: vi.fn(), stop: vi.fn(), on: vi.fn() } as never);
		expect(lines.join("\n")).toContain("real player attached");
	});
});

describe("FLY-967 round-5b ② AssistantSpeaker — every out-leg step observable", () => {
	function speakerHarness() {
		const lines: string[] = [];
		const played: unknown[] = [];
		const speaker = new AssistantSpeaker({
			player: {
				play: (r: unknown) => {
					played.push(r);
				},
				stop: () => {},
				on: () => {},
			},
			createResource: (src: unknown) => ({ src }),
			upsample: (c: Buffer) => c,
			log: (l: string) => lines.push(l),
		});
		return { speaker, lines, played };
	}

	it("logs turn begin, first feed (bytes), play() start, and end-of-turn totals", () => {
		const { speaker, lines, played } = speakerHarness();
		speaker.beginTurn();
		speaker.feed(Buffer.alloc(480));
		speaker.feed(Buffer.alloc(480));
		speaker.endTurn();
		const all = lines.join("\n");
		expect(all).toContain("turn begin");
		expect(all).toContain("first audio chunk");
		expect(all).toContain("playing turn stream");
		expect(all).toMatch(/turn end .*chunks=2/);
		expect(played).toHaveLength(1);
	});

	it("reports gate-dropped chunks at end of turn (the counter must reach the log)", () => {
		const { speaker, lines } = speakerHarness();
		speaker.feed(Buffer.alloc(480)); // before beginTurn — gated
		speaker.beginTurn();
		speaker.feed(Buffer.alloc(480));
		speaker.endTurn();
		expect(lines.join("\n")).toMatch(/dropped=1/);
	});
});
