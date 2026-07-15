/**
 * FLY-545 PR-2 P10′ — FeedPipeline first-class silent feed.
 *
 * FLY-968's negative control: a session that misses feed entries fabricates
 * facts, so delivery is cursor-tracked, ordered (never skip past an
 * undelivered entry), retried, and lag is fail-VISIBLE via onLag. Exclusion
 * skips sessions that heard the fact first-hand.
 */
import { describe, expect, it, vi } from "vitest";
import { FeedPipeline, type FeedTarget } from "../huddle/FeedPipeline.js";

class Sink implements FeedTarget {
	lines: string[] = [];
	failNext = 0;
	inject(text: string): void {
		if (this.failNext > 0) {
			this.failNext--;
			throw new Error("socket hiccup");
		}
		this.lines.push(text);
	}
}

const fixedNow = () => new Date("2026-07-07T15:00:00.000Z");

describe("fan-out with exclusion", () => {
	it("delivers to everyone except first-hand listeners", () => {
		const p = new FeedPipeline({ now: fixedNow });
		const tadashi = new Sink();
		const hiro = new Sink();
		p.register("tadashi", tadashi);
		p.register("hiro", hiro);
		// founder utterance — the addressed session (tadashi) heard the audio
		p.append({ speaker: "Annie", text: "发布定周五", exclude: ["tadashi"] });
		// tadashi's own answer — he heard himself
		p.append({ speaker: "Tadashi", text: "可以,我来排", exclude: ["tadashi"] });
		expect(tadashi.lines).toEqual([]);
		expect(hiro.lines).toEqual([
			"[会议记录] Annie: 发布定周五",
			"[会议记录] Tadashi: 可以,我来排",
		]);
	});
});

describe("cursor + retry (ordered, lossless)", () => {
	it("a failed delivery holds the cursor and re-delivers in order", () => {
		const p = new FeedPipeline({ now: fixedNow });
		const hiro = new Sink();
		p.register("hiro", hiro);
		hiro.failNext = 1;
		p.append({ speaker: "Annie", text: "第一条" });
		expect(hiro.lines).toEqual([]); // delivery failed, cursor held
		expect(p.backlog("hiro")).toBe(1);
		p.append({ speaker: "Annie", text: "第二条" }); // triggers drain
		expect(hiro.lines).toEqual([
			"[会议记录] Annie: 第一条",
			"[会议记录] Annie: 第二条",
		]);
		expect(p.backlog("hiro")).toBe(0);
	});

	it("retry() drains without a new append", () => {
		const p = new FeedPipeline({ now: fixedNow });
		const hiro = new Sink();
		p.register("hiro", hiro);
		hiro.failNext = 1;
		p.append({ speaker: "Annie", text: "只有这条" });
		expect(hiro.lines).toEqual([]);
		p.retry();
		expect(hiro.lines).toEqual(["[会议记录] Annie: 只有这条"]);
	});

	it("onLag fires once per episode after maxFailures, recovery re-arms it", () => {
		const onLag = vi.fn();
		const p = new FeedPipeline({ now: fixedNow, maxFailures: 2, onLag });
		const hiro = new Sink();
		p.register("hiro", hiro);
		hiro.failNext = 3;
		p.append({ speaker: "Annie", text: "a" }); // fail 1
		p.retry(); // fail 2 → lag
		p.retry(); // fail 3 → still same episode, no second call
		expect(onLag).toHaveBeenCalledTimes(1);
		expect(onLag).toHaveBeenCalledWith("hiro", 2);
		p.retry(); // succeeds → episode over
		expect(hiro.lines).toEqual(["[会议记录] Annie: a"]);
		hiro.failNext = 2;
		p.append({ speaker: "Annie", text: "b" }); // fail 1
		p.retry(); // fail 2 → NEW lag episode
		expect(onLag).toHaveBeenCalledTimes(2);
	});
});

describe("replay + snapshot", () => {
	it("replay() re-delivers the whole journal to a rebuilt session", () => {
		const p = new FeedPipeline({ now: fixedNow });
		const hiro = new Sink();
		p.register("hiro", hiro);
		p.append({ speaker: "Annie", text: "一" });
		p.append({ speaker: "Tadashi", text: "二" });
		const rebuilt = new Sink();
		p.register("hiro", rebuilt); // fresh session object, same lead
		p.replay("hiro");
		expect(rebuilt.lines).toEqual([
			"[会议记录] Annie: 一",
			"[会议记录] Tadashi: 二",
		]);
	});

	it("a late registrant starts at the head (no surprise backfill)", () => {
		const p = new FeedPipeline({ now: fixedNow });
		p.append({ speaker: "Annie", text: "早于注册" });
		const late = new Sink();
		p.register("late", late);
		p.append({ speaker: "Annie", text: "注册之后" });
		expect(late.lines).toEqual(["[会议记录] Annie: 注册之后"]);
	});

	it("transcriptSnapshot carries ts + speaker + text (summary source)", () => {
		const p = new FeedPipeline({ now: fixedNow });
		p.append({ speaker: "Annie", text: "发布定周五" });
		expect(p.transcriptSnapshot()).toBe(
			"[2026-07-07T15:00:00.000Z] Annie: 发布定周五",
		);
	});
});
