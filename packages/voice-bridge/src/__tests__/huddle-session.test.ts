/**
 * FLY-545 PR-2 P11′ — HuddleSession lifecycle + multi-session conducting:
 * gated audio (addressed line only), one-mouth-at-a-time grant, sticky
 * handoff, feed fan-out, conclude/recap/landing, no-show abort, degraded
 * landing on founder exit.
 */

import type { AudioFormat } from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import { type HuddleLine, HuddleSession } from "../huddle/HuddleSession.js";

const FMT: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 16_000,
	channels: 1,
};
const issue = { id: "u1", identifier: "FLY-1234", url: "https://l/1234" };

class FakeLine implements HuddleLine {
	session = {
		audio: [] as Buffer[],
		texts: [] as string[],
		injected: [] as string[],
		interrupts: 0,
		sendAudio: (f: Buffer) => void this.session.audio.push(f),
		sendText: (t: string) => void this.session.texts.push(t),
		injectContext: (t: string) => void this.session.injected.push(t),
		interrupt: () => void this.session.interrupts++,
	};
	mouth = {
		begins: 0,
		fed: [] as Buffer[],
		ends: 0,
		flushes: 0,
		toolCalls: 0,
		beginTurn: () => void this.mouth.begins++,
		feed: (c: Buffer) => void this.mouth.fed.push(c),
		endTurn: () => void this.mouth.ends++,
		flush: () => void this.mouth.flushes++,
		noteToolCall: () => void this.mouth.toolCalls++,
		noteToolResolved: () => {},
	};
	constructor(
		readonly leadId: string,
		readonly displayName: string,
	) {}
}

function setup(over: { assembleTimeoutMs?: number } = {}) {
	const tadashi = new FakeLine("eng", "Tadashi");
	const hiro = new FakeLine("joy", "Hiro");
	const feed = new FeedPipeline({
		now: () => new Date("2026-07-07T15:00:00Z"),
	});
	feed.register("eng", { inject: (t) => tadashi.session.injectContext(t) });
	feed.register("joy", { inject: (t) => hiro.session.injectContext(t) });
	const land = vi.fn(async () => "landed" as const);
	const abortNoShow = vi.fn(async () => {});
	const onTeardown = vi.fn();
	const ladder = { notifyFounderUtterance: vi.fn() };
	const session = new HuddleSession({
		issue,
		hostLeadId: "eng",
		lines: [tadashi, hiro],
		router: new AddressRouter(
			[
				{ leadId: "eng", aliases: ["Tadashi"] },
				{ leadId: "joy", aliases: ["Hiro"] },
			],
			"eng",
		),
		feed,
		ladder,
		tiv: { presence: vi.fn(), caption: vi.fn(), warn: vi.fn() },
		conclusion: { land, abortNoShow },
		onTeardown,
		assembleTimeoutMs: over.assembleTimeoutMs ?? 600_000,
	});
	return {
		session,
		tadashi,
		hiro,
		feed,
		land,
		abortNoShow,
		onTeardown,
		ladder,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("assembling", () => {
	it("no-show times out into abortNoShow + teardown", async () => {
		const { session, abortNoShow, onTeardown } = setup({
			assembleTimeoutMs: 1000,
		});
		session.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(abortNoShow).toHaveBeenCalledWith(issue);
		expect(onTeardown).toHaveBeenCalled();
	});

	it("founder joining goes live and the HOST greets her", () => {
		const { session, tadashi, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		expect(session.currentState).toBe("live");
		expect(tadashi.session.texts[0]).toContain("招呼");
		expect(hiro.session.texts).toHaveLength(0);
	});
});

describe("gated audio + turns", () => {
	it("founder frames reach ONLY the addressed line", () => {
		const { session, tadashi, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleFounderFrame(Buffer.from("f1"), FMT);
		expect(tadashi.session.audio).toHaveLength(1);
		expect(hiro.session.audio).toHaveLength(0);
	});

	it("a granted turn streams through its mouth; its words feed the others", () => {
		const { session, tadashi, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true); // grant = host
		session.handleLineResponseStarted("eng");
		expect(tadashi.mouth.begins).toBe(1);
		session.handleLineResponseAudio("eng", Buffer.from("a"));
		expect(tadashi.mouth.fed).toHaveLength(1);
		session.handleLineTranscript("eng", {
			role: "assistant",
			text: "底盘已经 merge 了",
			final: true,
		});
		session.handleLineResponseDone("eng");
		expect(tadashi.mouth.ends).toBe(1);
		// journal fan-out: hiro got fed, tadashi (own words) did not.
		expect(hiro.session.injected).toEqual([
			"[会议记录] Tadashi: 底盘已经 merge 了",
		]);
		expect(tadashi.session.injected).toHaveLength(0);
	});

	it("an UN-granted turn is interrupted and counted, mouth never opens", () => {
		const { session, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true); // grant = host (eng)
		session.handleLineResponseStarted("joy");
		expect(hiro.session.interrupts).toBe(1);
		expect(hiro.mouth.begins).toBe(0);
		expect(session.ungrantedTurns).toBe(1);
	});

	it("barge-in flushes the current speaker synchronously", () => {
		const { session, tadashi } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleLineResponseStarted("eng");
		session.handleBargeIn();
		expect(tadashi.session.interrupts).toBe(1);
		expect(tadashi.mouth.flushes).toBeGreaterThan(0);
	});

	it("byte-compat (Codex R4): a Gemini line still interrupts+flushes on a barge-in during landing (founder left mid-response)", () => {
		const { session, tadashi } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleLineResponseStarted("eng"); // currentSpeaker=eng, mid-response
		session.handleFounderVoiceState(false); // founder leaves → degraded landing
		expect(session.currentState).toBe("landing");
		const interruptsBefore = tadashi.session.interrupts;
		const flushesBefore = tadashi.mouth.flushes;
		session.handleBargeIn();
		// the resident-summary no-op must NOT swallow the gemini interrupt/flush.
		expect(tadashi.session.interrupts).toBe(interruptsBefore + 1);
		expect(tadashi.mouth.flushes).toBeGreaterThan(flushesBefore);
	});
});

describe("founder utterances: feed, sticky handoff", () => {
	function founderSays(session: HuddleSession, from: string, text: string) {
		session.handleLineTranscript(from, { role: "user", text, final: true });
	}

	it("a normal utterance feeds everyone but the addressed line", () => {
		const { session, tadashi, hiro, ladder } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		founderSays(session, "eng", "发布定周五");
		expect(hiro.session.injected).toEqual(["[会议记录] Annie: 发布定周五"]);
		expect(tadashi.session.injected).toHaveLength(0);
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledWith("发布定周五");
	});

	it("naming another Lead hands off: old cut, new gets the text turn, frames follow", () => {
		const { session, tadashi, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		founderSays(session, "eng", "Hiro,内存这块你怎么看?");
		expect(tadashi.session.interrupts).toBe(1);
		expect(hiro.session.texts[0]).toBe(
			"[Annie 在点名你] Hiro,内存这块你怎么看?",
		);
		// the OLD line heard the audio → excluded from the feed of that entry
		expect(tadashi.session.injected).toHaveLength(0);
		expect(hiro.session.injected).toHaveLength(0); // it got the text TURN instead
		// frames now stream to hiro
		session.handleFounderFrame(Buffer.from("f"), FMT);
		expect(hiro.session.audio).toHaveLength(1);
		// and hiro's answer is now granted
		session.handleLineResponseStarted("joy");
		expect(hiro.mouth.begins).toBe(1);
	});

	it("transcripts from a non-addressed line are ignored (single source)", () => {
		const { session, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		founderSays(session, "joy", "幽灵转写");
		expect(hiro.session.texts).toHaveLength(0);
		expect(session.currentState).toBe("live");
	});
});

describe("concluding + landing", () => {
	function founderSays(session: HuddleSession, text: string) {
		session.handleLineTranscript("eng", { role: "user", text, final: true });
	}

	it("「就这样」→ host recaps; 「对」→ confirmed landing + teardown", async () => {
		const { session, tadashi, land, onTeardown } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		founderSays(session, "好,就这样吧");
		expect(session.currentState).toBe("concluding");
		expect(tadashi.session.texts.at(-1)).toContain("recap");
		founderSays(session, "对,没问题");
		await vi.runAllTimersAsync();
		expect(land).toHaveBeenCalledWith(
			expect.objectContaining({ issue, confirmed: true }),
		);
		expect(onTeardown).toHaveBeenCalled();
	});

	it("a correction during concluding re-prompts the host, no landing", () => {
		const { session, tadashi, land } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		founderSays(session, "结束吧");
		founderSays(session, "第二条不对,是下周三");
		expect(land).not.toHaveBeenCalled();
		expect(tadashi.session.texts.at(-1)).toContain("更正");
		expect(session.currentState).toBe("concluding");
	});

	it("founder leaving mid-meeting lands DEGRADED (confirmed:false)", async () => {
		const { session, land } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleFounderVoiceState(false);
		await vi.runAllTimersAsync();
		expect(land).toHaveBeenCalledWith(
			expect.objectContaining({ confirmed: false }),
		);
	});

	it("landing happens exactly once even with racing signals", async () => {
		const { session, land } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		founderSays(session, "就这样");
		founderSays(session, "对");
		session.handleFounderVoiceState(false); // she hangs up right after
		await vi.runAllTimersAsync();
		expect(land).toHaveBeenCalledTimes(1);
	});
});
