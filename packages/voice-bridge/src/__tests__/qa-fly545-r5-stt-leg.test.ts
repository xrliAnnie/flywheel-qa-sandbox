/**
 * FLY-545 QA R5 (FLY-1186 founder test FAIL — resident-line STT abort):
 * the STT-leg abort window must never silently eat her words.
 *
 *   P0 — frames of the CURRENT founder utterance are buffered (rolling cap)
 *        and re-sent to the line after a connection-death reconnect; if she
 *        already finished speaking, the replay is closed with endUserTurn so
 *        the successor session processes the utterance.
 *   F2 — while a line is down the status tells the TRUTH (「恢复中」, not
 *        「在想」), and the reconnect messaging distinguishes "I recovered
 *        your words" from "please say that again".
 */

import type { AudioFormat } from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import {
	FOUNDER_AUDIO_BUFFER_MAX_BYTES,
	type HuddleLine,
	HuddleSession,
} from "../huddle/HuddleSession.js";

const FMT: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 16_000,
	channels: 1,
};

class FakeLine implements HuddleLine {
	audio: Buffer[] = [];
	texts: string[] = [];
	endedTurns = 0;
	session = {
		sendAudio: (f: Buffer) => void this.audio.push(f),
		sendText: (t: string) => void this.texts.push(t),
		injectContext: () => {},
		interrupt: () => {},
		endUserTurn: () => void this.endedTurns++,
	};
	mouth = {
		beginTurn: () => {},
		feed: () => {},
		endTurn: () => {},
		flush: vi.fn(),
		noteToolCall: () => {},
		noteToolResolved: () => {},
	};
	constructor(
		readonly leadId: string,
		readonly displayName: string,
	) {}
}

function huddle(lineIds: [string, string][] = [["eng", "Tadashi"]]) {
	const lines = lineIds.map(([id, name]) => new FakeLine(id, name));
	const presences: [string, string | undefined][] = [];
	const warns: string[] = [];
	const captions: [string, string][] = [];
	const ladder = { notifyFounderUtterance: vi.fn() };
	const feed = new FeedPipeline();
	const h = new HuddleSession({
		issue: { id: "u1", identifier: "FLY-1", url: "https://l/1" },
		hostLeadId: lineIds[0]?.[0] ?? "eng",
		lines,
		router: new AddressRouter(
			lineIds.map(([id, name]) => ({ leadId: id, aliases: [name] })),
			lineIds[0]?.[0] ?? "eng",
		),
		feed,
		ladder,
		tiv: {
			presence: (s, d) => void presences.push([s, d]),
			caption: (s, t) => void captions.push([s, t]),
			warn: (t) => void warns.push(t),
		},
		conclusion: {
			land: vi.fn(async () => "landed" as const),
			abortNoShow: vi.fn(async () => {}),
		},
		onTeardown: vi.fn(),
		assembleTimeoutMs: 600_000,
	});
	h.start();
	h.handleFounderVoiceState(true);
	return { h, lines, presences, warns, captions, ladder, feed };
}

function frame(fill: number, bytes = 320): Buffer {
	return Buffer.alloc(bytes, fill);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("P0 — abort-window utterance replay", () => {
	it("frames sent before AND during the down window are re-sent in order on reconnect; endUserTurn closes a finished utterance", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		const [f1, f2, f3] = [frame(1), frame(2), frame(3)];
		h.handleFounderFrame(f1, FMT);
		h.handleFounderFrame(f2, FMT);
		h.handleLineDown("eng");
		// she keeps talking into the dead window — the rotator drops these,
		// the huddle must not.
		h.handleFounderFrame(f3, FMT);
		h.handleFounderSpeechStopped();
		const sentBefore = eng.audio.length;
		const res = h.handleLineReconnected("eng");
		expect(res.replayed).toBe(true);
		expect(eng.audio.slice(sentBefore)).toEqual([f1, f2, f3]);
		expect(eng.endedTurns).toBe(1);
	});

	it("an utterance still in flight (she is mid-sentence) replays WITHOUT endUserTurn", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineDown("eng");
		const sentBefore = eng.audio.length;
		const res = h.handleLineReconnected("eng");
		expect(res.replayed).toBe(true);
		expect(eng.audio.length).toBe(sentBefore + 1);
		expect(eng.endedTurns).toBe(0);
	});

	it("a commit while the line was UP clears the buffer — reconnect does not duplicate her words", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		h.handleFounderFrame(frame(1), FMT);
		h.handleFounderSpeechStopped();
		// turn-level user aggregate = the utterance is safely transcribed.
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看那个 issue",
			final: true,
		});
		h.handleLineDown("eng");
		const sentBefore = eng.audio.length;
		const res = h.handleLineReconnected("eng");
		expect(res.replayed).toBe(false);
		expect(eng.audio.length).toBe(sentBefore);
		expect(eng.endedTurns).toBe(0);
	});

	it("a commit DURING the down window does NOT clear the buffer (partial pre-abort transcription) — the full utterance still replays", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		const [f1, f2] = [frame(1), frame(2)];
		h.handleFounderFrame(f1, FMT);
		h.handleLineDown("eng");
		h.handleFounderFrame(f2, FMT);
		h.handleFounderSpeechStopped();
		// the pre-abort fragments commit while the line is down — that
		// transcription is PARTIAL; her tail only exists in the buffer.
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看",
			final: true,
		});
		const sentBefore = eng.audio.length;
		const res = h.handleLineReconnected("eng");
		expect(res.replayed).toBe(true);
		expect(eng.audio.slice(sentBefore)).toEqual([f1, f2]);
	});

	it("a NEW utterance resets the buffer — only her latest words replay", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		h.handleFounderFrame(frame(1), FMT);
		h.handleFounderSpeechStopped();
		const f3 = frame(3);
		h.handleFounderFrame(f3, FMT); // new utterance
		h.handleLineDown("eng");
		const sentBefore = eng.audio.length;
		h.handleLineReconnected("eng");
		expect(eng.audio.slice(sentBefore)).toEqual([f3]);
	});

	it("the buffer is a ROLLING window — oldest frames drop beyond the cap", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		const big = Math.ceil(FOUNDER_AUDIO_BUFFER_MAX_BYTES / 4);
		const [f1, f2, f3, f4, f5] = [1, 2, 3, 4, 5].map((n) => frame(n, big));
		for (const f of [f1, f2, f3, f4, f5]) h.handleFounderFrame(f, FMT);
		h.handleLineDown("eng");
		const sentBefore = eng.audio.length;
		h.handleLineReconnected("eng");
		const replayed = eng.audio.slice(sentBefore);
		expect(replayed[0]).not.toEqual(f1); // oldest dropped
		expect(replayed[replayed.length - 1]).toEqual(f5);
		expect(replayed.reduce((n, f) => n + f.length, 0)).toBeLessThanOrEqual(
			FOUNDER_AUDIO_BUFFER_MAX_BYTES,
		);
	});

	it("replay targets ONLY the line the audio was sent to", () => {
		const { h, lines } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		const joy = lines[1] as FakeLine;
		h.handleFounderFrame(frame(1), FMT); // addressed = eng (host)
		h.handleLineDown("joy");
		const joyBefore = joy.audio.length;
		const res = h.handleLineReconnected("joy");
		expect(res.replayed).toBe(false);
		expect(joy.audio.length).toBe(joyBefore);
	});

	it("double abort before the commit lands replays again — her words survive repeated flaps", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		const f1 = frame(1);
		h.handleFounderFrame(f1, FMT);
		h.handleFounderSpeechStopped();
		h.handleLineDown("eng");
		h.handleLineReconnected("eng");
		h.handleLineDown("eng");
		const sentBefore = eng.audio.length;
		const res = h.handleLineReconnected("eng");
		expect(res.replayed).toBe(true);
		expect(eng.audio.slice(sentBefore)).toEqual([f1]);
	});
});

describe("F2 — the status tells the truth while a line is down", () => {
	it("line down → presence shows recovering, and the thinking-stall watchdog is disarmed (no「慢」lie)", () => {
		const { h, presences, warns } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleFounderSpeechStopped(); // arms the thinking watchdog
		h.handleLineDown("eng");
		const last = presences[presences.length - 1];
		expect(last?.[0]).toBe("connecting");
		expect(last?.[1]).toContain("恢复");
		vi.advanceTimersByTime(60_000);
		expect(warns.filter((w) => w.includes("慢"))).toHaveLength(0);
	});

	it("speech-stop DURING the down window shows the recovering cue, not「在想」", () => {
		const { h, presences } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		const last = presences[presences.length - 1];
		expect(last?.[0]).toBe("connecting");
		expect(
			presences.filter(
				([s], i) => s === "thinking" && i > presences.length - 3,
			),
		).toHaveLength(0);
	});

	it("reconnect reports replayed=false when there is nothing to recover (wiring picks the 请再说 message)", () => {
		const { h } = huddle();
		h.handleLineDown("eng");
		expect(h.handleLineReconnected("eng").replayed).toBe(false);
	});
});

describe("R35 HIGH-1 — the dying session's partial output never double-commits", () => {
	it("a partial user aggregate during the down window is suppressed; the replayed full utterance commits exactly once", () => {
		const { h, ladder } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		// close() of the dying session flushes its PARTIAL user aggregate
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看",
			final: true,
		});
		expect(ladder.notifyFounderUtterance).not.toHaveBeenCalled();
		h.handleLineReconnected("eng"); // replay into the successor
		// the successor re-transcribes the FULL utterance
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看这个 issue",
			final: true,
		});
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledTimes(1);
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledWith(
			"帮我看看这个 issue",
		);
	});

	it("the debounce flush during the down window is suppressed too, and pre-abort fragments never double the successor's", () => {
		const { h, ladder } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看",
			final: false, // pre-abort fragment
		});
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		vi.advanceTimersByTime(1_000); // debounce fires while down → suppressed
		expect(ladder.notifyFounderUtterance).not.toHaveBeenCalled();
		h.handleLineReconnected("eng");
		// the successor's fresh transcription of the SAME utterance
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看这个",
			final: false,
		});
		h.handleFounderSpeechStopped();
		vi.advanceTimersByTime(1_000);
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledTimes(1);
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledWith("帮我看看这个");
	});

	it("guard: an aggregate from a down line with NOTHING to replay still commits — her words are not thrown away", () => {
		const { h, ladder } = huddle();
		h.handleLineDown("eng"); // abort hit between utterances, no buffer
		h.handleLineTranscript("eng", {
			role: "user",
			text: "把这个排给他",
			final: true,
		});
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledWith("把这个排给他");
	});
});

describe("R35 HIGH-2 — a replay landing mid-sentence is closed by the NEXT speech-stop", () => {
	it("no close at reconnect while she talks; exactly one close at her real speech end; none for later normal turns", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		h.handleFounderFrame(frame(1), FMT); // speaking
		h.handleLineDown("eng");
		const res = h.handleLineReconnected("eng"); // she is mid-sentence
		expect(res.replayed).toBe(true);
		expect(eng.endedTurns).toBe(0);
		h.handleFounderSpeechStopped(); // the real end of the replayed+live turn
		expect(eng.endedTurns).toBe(1);
		// a later NORMAL utterance gets no extra explicit close
		h.handleFounderFrame(frame(2), FMT);
		h.handleFounderSpeechStopped();
		expect(eng.endedTurns).toBe(1);
	});
});

describe("R35 MEDIUM-4 — no wedged 'recovering' state, no presence stomps", () => {
	it("rotation exhaustion (handleLineFailed) ends the recovering state and drops the replay buffer", () => {
		const { h, lines, presences } = huddle();
		const eng = lines[0] as FakeLine;
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineDown("eng");
		h.handleLineFailed("eng");
		expect(presences[presences.length - 1]?.[0]).toBe("paused");
		// nothing left to replay — the buffer died with the line
		const before = eng.audio.length;
		expect(h.handleLineReconnected("eng").replayed).toBe(false);
		expect(eng.audio.length).toBe(before);
	});

	it("a background line's flap neither changes the status nor masks the addressed line still being down", () => {
		const { h, presences } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		h.handleLineDown("eng"); // addressed down → recovering shown
		const afterDown = presences.length;
		h.handleLineDown("joy"); // background flap: no presence change
		expect(presences.length).toBe(afterDown);
		h.handleLineReconnected("joy"); // background recovery must NOT say listening
		expect(presences.slice(afterDown).every(([s]) => s !== "listening")).toBe(
			true,
		);
		h.handleLineReconnected("eng"); // the addressed line is back → listening
		expect(presences[presences.length - 1]?.[0]).toBe("listening");
	});
});

describe("R36 HIGH-1 — the open replayed turn belongs to its OWNER line", () => {
	it("a routing switch before her speech-stop still closes the original successor's turn", () => {
		const { h, lines } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		const [eng, joy] = [lines[0] as FakeLine, lines[1] as FakeLine];
		h.handleFounderFrame(frame(1), FMT); // speaking, addressed = eng
		h.handleLineDown("eng");
		h.handleLineReconnected("eng"); // mid-sentence replay → open turn on eng
		expect(eng.endedTurns).toBe(0);
		// the replayed aggregate re-routes her to joy BEFORE she stops talking
		h.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 你来说说",
			final: true,
		});
		h.handleFounderSpeechStopped();
		expect(eng.endedTurns).toBe(1); // closed by owner, not by addressed
		expect(joy.endedTurns).toBe(0);
	});

	it("a double flap leaves no stale marker — no spurious close on later normal turns", () => {
		const { h, lines } = huddle();
		const eng = lines[0] as FakeLine;
		h.handleFounderFrame(frame(1), FMT); // speaking
		h.handleLineDown("eng");
		h.handleLineReconnected("eng"); // marker set (still speaking)
		h.handleLineDown("eng"); // second flap — the marker dies with its session
		h.handleFounderSpeechStopped(); // during down: nothing to close
		expect(eng.endedTurns).toBe(0);
		h.handleLineReconnected("eng"); // she已说完 → replay closes immediately
		expect(eng.endedTurns).toBe(1);
		h.handleFounderFrame(frame(2), FMT); // later NORMAL turn
		h.handleFounderSpeechStopped();
		expect(eng.endedTurns).toBe(1); // no spurious extra close
	});
});

describe("R36 HIGH-2 — a failed line is persistently dead", () => {
	it("stops eating her audio and never flips the status back to a 'thinking' lie", () => {
		const { h, lines, presences } = huddle();
		const eng = lines[0] as FakeLine;
		h.handleLineDown("eng");
		h.handleLineFailed("eng");
		const idx = presences.length;
		const before = eng.audio.length;
		h.handleFounderFrame(frame(1), FMT); // must NOT reach the dead line
		expect(eng.audio.length).toBe(before);
		h.handleFounderSpeechStopped();
		expect(presences.slice(idx).some(([s]) => s === "thinking")).toBe(false);
		expect(presences[presences.length - 1]?.[0]).toBe("paused");
	});

	it("auto-switches her audio to a healthy line when one exists", () => {
		const { h, lines, warns } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		const [eng, joy] = [lines[0] as FakeLine, lines[1] as FakeLine];
		h.handleLineDown("eng");
		h.handleLineFailed("eng");
		expect(warns.some((w) => w.includes("切给"))).toBe(true);
		const [e0, j0] = [eng.audio.length, joy.audio.length];
		h.handleFounderFrame(frame(1), FMT);
		expect(joy.audio.length).toBe(j0 + 1);
		expect(eng.audio.length).toBe(e0);
	});
});

describe("R36 MEDIUM-3 — the suppressed partial survives a terminal failure", () => {
	it("is journaled record-only (caption), never semantically committed", () => {
		const { h, ladder, captions } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		// the dying session's partial flush — suppressed but RECORDED
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看",
			final: true,
		});
		h.handleLineFailed("eng");
		expect(ladder.notifyFounderUtterance).not.toHaveBeenCalled();
		expect(
			captions.some(([s, t]) => s === "Annie" && t.includes("帮我看看")),
		).toBe(true);
	});
});

describe("R36 MEDIUM-4 — background reconnect never stomps the addressed line", () => {
	it("neither disarms the addressed watchdog nor announces listening", () => {
		const { h, presences, warns } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		h.handleFounderFrame(frame(1), FMT);
		h.handleFounderSpeechStopped(); // eng thinking + watchdog armed
		h.handleLineDown("joy");
		const idx = presences.length;
		h.handleLineReconnected("joy"); // background recovery
		expect(presences.slice(idx).some(([s]) => s === "listening")).toBe(false);
		vi.advanceTimersByTime(60_000); // the addressed watchdog must still fire
		expect(warns.some((w) => w.includes("久"))).toBe(true);
	});
});

describe("R37 HIGH-1 — name routing never hands the meeting to a failed line", () => {
	it("addressing a dead lead by name is refused: pointer stays, she is told", () => {
		const { h, lines, warns } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		const [eng, joy] = [lines[0] as FakeLine, lines[1] as FakeLine];
		h.handleLineDown("joy");
		h.handleLineFailed("joy"); // background line dies for good
		// she names the dead lead through the healthy addressed line
		h.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 你来说说",
			final: true,
		});
		expect(warns.some((w) => w.includes("接不进来"))).toBe(true);
		// audio keeps flowing to the healthy line, not the corpse
		const [e0, j0] = [eng.audio.length, joy.audio.length];
		h.handleFounderFrame(frame(1), FMT);
		expect(eng.audio.length).toBe(e0 + 1);
		expect(joy.audio.length).toBe(j0);
	});
});

describe("R37 HIGH-2 — the dead line's fragments never pollute the successor line", () => {
	it("terminal auto-switch clears the pending debounce state — the new line's utterance commits alone", () => {
		const { h, ladder } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		// un-flushed fragments on the addressed (soon dead) line
		h.handleLineTranscript("eng", {
			role: "user",
			text: "旧半句",
			final: false,
		});
		h.handleLineDown("eng");
		h.handleLineFailed("eng"); // auto-switch → joy
		// the NEW line transcribes her next utterance
		h.handleLineTranscript("joy", {
			role: "user",
			text: "新问题",
			final: false,
		});
		h.handleFounderSpeechStopped();
		vi.advanceTimersByTime(1_000);
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledTimes(1);
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledWith("新问题");
	});
});

describe("R37 MEDIUM-3 — the switch target prefers a line that is actually UP", () => {
	it("when only a recovering line remains the pointer moves but the status stays truthful", () => {
		const { h, lines, presences } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		const joy = lines[1] as FakeLine;
		h.handleLineDown("joy"); // the only alternative is mid-reconnect
		h.handleLineDown("eng");
		h.handleLineFailed("eng"); // addressed dies for good
		const last = presences[presences.length - 1];
		expect(last?.[0]).toBe("connecting"); // NOT a "listening" lie
		// the pointer did move — her frames head for joy (buffered + replayed
		// once joy's own reconnect lands)
		const j0 = joy.audio.length;
		h.handleFounderFrame(frame(1), FMT);
		expect(joy.audio.length).toBe(j0 + 1);
	});
});

describe("R37 MEDIUM-4 — the incompleteness marker reaches the DURABLE record", () => {
	it("the journaled partial carries the marker in the feed transcript, not just the caption", () => {
		const { h, feed } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看",
			final: true,
		});
		h.handleLineFailed("eng");
		const snapshot = feed.transcriptSnapshot();
		expect(snapshot).toContain("帮我看看");
		expect(snapshot).toContain("记录可能不完整");
	});
});

describe("R38 HIGH-1 — her unrecovered words reach the landing record when she leaves early", () => {
	it("down → debounce suppressed → she leaves: the partial lands with the provenance marker", () => {
		const { h, feed } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看这个",
			final: false,
		});
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		vi.advanceTimersByTime(1_000); // debounce fires while down → suppressed
		h.handleFounderVoiceState(false); // she leaves before the reconnect
		const snapshot = feed.transcriptSnapshot();
		expect(snapshot).toContain("帮我看看这个");
		expect(snapshot).toContain("记录可能不完整");
	});

	it("down → she leaves BEFORE the debounce: the pending fragment lands, marked incomplete", () => {
		const { h, feed } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineTranscript("eng", {
			role: "user",
			text: "把这个改一下",
			final: false,
		});
		h.handleLineDown("eng");
		h.handleFounderVoiceState(false); // gone before any flush
		const snapshot = feed.transcriptSnapshot();
		expect(snapshot).toContain("把这个改一下");
		expect(snapshot).toContain("记录可能不完整");
	});

	it("pending fragment and suppressed aggregate dedup by containment — the superset lands exactly once", () => {
		const { h, feed } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看",
			final: false, // pending fragment (subset)
		});
		h.handleLineDown("eng");
		// the dying session's aggregate (superset) — suppressed + recorded
		h.handleLineTranscript("eng", {
			role: "user",
			text: "帮我看看这个",
			final: true,
		});
		h.handleFounderVoiceState(false);
		const snapshot = feed.transcriptSnapshot();
		expect(snapshot).toContain("帮我看看这个");
		expect(snapshot.split("记录可能不完整").length - 1).toBe(1);
	});
});

describe("R38 MEDIUM-2 — a handoff onto a recovering line is queued, not dropped", () => {
	it("the speech-triggering handoff waits for the reconnect and then delivers", () => {
		const { h, lines, warns } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		const joy = lines[1] as FakeLine;
		h.handleLineDown("joy"); // joy is mid-death-rotation
		h.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 你来说说",
			final: true,
		});
		// nothing was sent into the rotation gap
		expect(joy.texts.some((t) => t.includes("在点名你"))).toBe(false);
		expect(warns.some((w) => w.includes("稍等"))).toBe(true);
		h.handleLineReconnected("joy");
		expect(
			joy.texts.some((t) => t.includes("[Annie 在点名你] Hiro 你来说说")),
		).toBe(true);
	});

	it("a queued handoff dies with the line — terminal failure never delivers it later", () => {
		const { h, lines } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		const joy = lines[1] as FakeLine;
		h.handleLineDown("joy");
		h.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 你来说说",
			final: true,
		});
		h.handleLineFailed("joy"); // the reconnect never comes
		h.handleLineReconnected("joy"); // defensive revival must not resurrect it
		expect(joy.texts.some((t) => t.includes("在点名你"))).toBe(false);
	});
});

describe("R39 HIGH-1 — the textual fallback outlives the replay", () => {
	it("she leaves after the replay but before the successor transcript — her words still land", () => {
		const { h, feed } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineTranscript("eng", {
			role: "user",
			text: "最后一句",
			final: false,
		});
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		vi.advanceTimersByTime(1_000); // debounce suppressed → partial recorded
		h.handleLineReconnected("eng"); // audio replay happens
		h.handleFounderVoiceState(false); // gone before the successor's STT returns
		const snapshot = feed.transcriptSnapshot();
		expect(snapshot).toContain("最后一句");
		expect(snapshot).toContain("记录可能不完整");
	});

	it("the fallback dies on the successor's REAL commit — no stale duplicate at landing", () => {
		const { h, feed, ladder } = huddle();
		h.handleFounderFrame(frame(1), FMT);
		h.handleLineTranscript("eng", {
			role: "user",
			text: "最后一句",
			final: false,
		});
		h.handleLineDown("eng");
		h.handleFounderSpeechStopped();
		vi.advanceTimersByTime(1_000);
		h.handleLineReconnected("eng");
		// the successor transcribes the replayed audio and commits for real
		h.handleLineTranscript("eng", {
			role: "user",
			text: "最后一句话",
			final: true,
		});
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledWith("最后一句话");
		h.handleFounderVoiceState(false);
		const snapshot = feed.transcriptSnapshot();
		expect(snapshot.split("记录可能不完整").length - 1).toBe(0);
	});
});

describe("R39 MEDIUM-2 — the wiring is told a handoff was delivered", () => {
	it("a queue-only reconnect reports handoffDelivered=true (and replayed=false)", () => {
		const { h } = huddle([
			["eng", "Tadashi"],
			["joy", "Hiro"],
		]);
		h.handleLineDown("joy");
		h.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 你来说说",
			final: true,
		});
		const res = h.handleLineReconnected("joy");
		expect(res.handoffDelivered).toBe(true);
		expect(res.replayed).toBe(false);
	});
});
