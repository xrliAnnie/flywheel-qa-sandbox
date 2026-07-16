/**
 * FLY-1160 §4.1-3 — TextTurnMouth: the /glaw resident mouth. Sentence-buffers
 * the brain's text delta stream, drives a serial text speaker per sentence,
 * gates late deltas, flushes the tail on endTurn, and barge-in stop() drops
 * the un-synthesized buffer + stops the speaker synchronously.
 */
import { describe, expect, it } from "vitest";
import {
	splitSentences,
	TextTurnMouth,
	type TextTurnSpeaker,
} from "../audio/TextTurnMouth.js";

function fakeSpeaker(): { speaker: TextTurnSpeaker; spoken: string[] } {
	const spoken: string[] = [];
	const speaker: TextTurnSpeaker = {
		async speak(text: string) {
			spoken.push(text);
			return { cancelled: false };
		},
		stop() {},
	};
	return { speaker, spoken };
}

describe("splitSentences (FLY-1160 §4.1-3)", () => {
	it("cuts on CJK + ASCII terminators and newlines; keeps the tail", () => {
		const { sentences, tail } = splitSentences(
			"先修耳朵。再上脑！那第三点",
			80,
		);
		expect(sentences).toEqual(["先修耳朵。", "再上脑！"]);
		expect(tail).toBe("那第三点");
	});

	it("run-on without punctuation still cuts at maxChars", () => {
		const { sentences, tail } = splitSentences("abcdefghij", 4);
		expect(sentences).toEqual(["abcd", "efgh"]);
		expect(tail).toBe("ij");
	});

	it("whitespace-only fragments are dropped", () => {
		const { sentences } = splitSentences("  。\n。x。", 80);
		expect(sentences).toEqual(["x。"]);
	});
});

describe("TextTurnMouth", () => {
	it("buffers deltas into sentences and speaks each in order", () => {
		const f = fakeSpeaker();
		const mouth = new TextTurnMouth({ speaker: f.speaker });
		mouth.beginTurn();
		mouth.feed("先修");
		mouth.feed("耳朵。再"); // "先修耳朵。" completes; "再" buffered
		mouth.feed("上脑！");
		expect(f.spoken).toEqual(["先修耳朵。", "再上脑！"]);
	});

	it("endTurn flushes the trailing partial sentence", () => {
		const f = fakeSpeaker();
		const mouth = new TextTurnMouth({ speaker: f.speaker });
		mouth.beginTurn();
		mouth.feed("没有标点的结尾");
		expect(f.spoken).toEqual([]); // nothing terminated yet
		mouth.endTurn();
		expect(f.spoken).toEqual(["没有标点的结尾"]);
	});

	it("a delta OUTSIDE an open turn is dropped and counted (turn gate)", () => {
		const f = fakeSpeaker();
		const mouth = new TextTurnMouth({ speaker: f.speaker });
		mouth.feed("late chunk of a dead turn。"); // no beginTurn
		expect(f.spoken).toEqual([]);
		expect(mouth.droppedDeltas).toBe(1);
	});

	it("flush() = barge-in: drops the un-synthesized buffer + stops the speaker", () => {
		let stops = 0;
		const spoken: string[] = [];
		const speaker: TextTurnSpeaker = {
			async speak(t) {
				spoken.push(t);
				return { cancelled: false };
			},
			stop() {
				stops++;
			},
		};
		const mouth = new TextTurnMouth({ speaker });
		mouth.beginTurn();
		mouth.feed("半句还没说完"); // buffered, not yet spoken
		mouth.flush();
		expect(stops).toBe(1);
		// the buffered partial was dropped, never synthesized
		expect(spoken).toEqual([]);
		// and the mouth no longer accepts feed until the next beginTurn
		mouth.feed("这句在打断后。");
		expect(spoken).toEqual([]);
	});

	it("a synth failure is fail-loud to onError (not swallowed) and the queue moves on", async () => {
		const spoken: string[] = [];
		const errors: string[] = [];
		let failOnce = true;
		const speaker: TextTurnSpeaker = {
			async speak(t) {
				if (failOnce) {
					failOnce = false;
					throw new Error(`tts down for ${t}`);
				}
				spoken.push(t);
				return { cancelled: false };
			},
			stop() {},
		};
		const mouth = new TextTurnMouth({
			speaker,
			onError: (e) => errors.push(e.message),
		});
		mouth.beginTurn();
		mouth.feed("第一句失败。第二句成功。");
		await Promise.resolve();
		await Promise.resolve();
		expect(errors[0]).toContain("tts down for 第一句失败。");
		expect(spoken).toEqual(["第二句成功。"]); // queue moved on
	});
});
