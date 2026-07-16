/**
 * FLY-545 QA kickback R2 (Annie's real-machine run) — F2 + F3.
 *
 * F2: NO feedback during any wait — she cannot tell "broken" from "thinking".
 *     (a) assembly window: the daemon must show a "connecting — don't talk
 *         yet" state, then flip to "ready" (this is exactly the F1 abort
 *         window where her speech was swallowed);
 *     (b) after she finishes a question: a thinking cue must appear — but the
 *         speech-stopped path was NEVER WIRED (EarsReceiver.onSpeakingEnd
 *         existed and nobody connected it).
 * F3: the transcript panel shows only assistant lines. Root cause: the
 *     user-transcript `final` flag is bound to Gemini's turnComplete, which
 *     is false while HER words stream in — so the founder caption (and the
 *     whole conclude/confirm path riding handleFounderUtterance) never fired
 *     off transcripts alone. Fix: accumulate user fragments and flush them on
 *     the speaking-stopped signal (with a short STT-tail debounce).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import { type HuddleLine, HuddleSession } from "../huddle/HuddleSession.js";

const issue = { id: "u1", identifier: "FLY-1234", url: "https://l/1234" };

class FakeLine implements HuddleLine {
	session = {
		texts: [] as string[],
		sendAudio: () => {},
		sendText: (t: string) => void this.session.texts.push(t),
		injectContext: () => {},
		interrupt: () => {},
	};
	mouth = {
		beginTurn: () => {},
		feed: () => {},
		endTurn: () => {},
		flush: () => {},
		noteToolCall: () => {},
		noteToolResolved: () => {},
	};
	constructor(
		readonly leadId: string,
		readonly displayName: string,
	) {}
}

function setup() {
	const eng = new FakeLine("eng", "Tadashi");
	const captions: [string, string][] = [];
	const presences: [string, string | undefined][] = [];
	const land = vi.fn(async () => "landed" as const);
	const session = new HuddleSession({
		issue,
		hostLeadId: "eng",
		lines: [eng],
		router: new AddressRouter([{ leadId: "eng", aliases: ["Tadashi"] }], "eng"),
		feed: new FeedPipeline(),
		ladder: { notifyFounderUtterance: vi.fn() },
		tiv: {
			presence: (s, d) => void presences.push([s, d]),
			caption: (sp, t) => void captions.push([sp, t]),
			warn: vi.fn(),
		},
		conclusion: { land, abortNoShow: vi.fn(async () => {}) },
		onTeardown: vi.fn(),
		assembleTimeoutMs: 600_000,
	});
	return { session, captions, presences, land };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("F3 — founder's own words reach the caption panel via speech-stop flush", () => {
	it("user fragments (final=false) + speaking stop → ONE founder caption after the STT tail", async () => {
		const { session, captions } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		// Gemini streams her words as non-final fragments (turnComplete=false)
		session.handleLineTranscript("eng", {
			role: "user",
			text: "内存这块",
			final: false,
		});
		session.handleLineTranscript("eng", {
			role: "user",
			text: "怎么弄",
			final: false,
		});
		expect(captions.filter(([s]) => s === "Annie")).toHaveLength(0);
		session.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900); // > STT-tail debounce
		const founderCaptions = captions.filter(([s]) => s === "Annie");
		expect(founderCaptions).toHaveLength(1);
		expect(founderCaptions[0]?.[1]).toBe("内存这块怎么弄");
	});

	it("a fragment arriving DURING the debounce is included (STT tail)", async () => {
		const { session, captions } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleLineTranscript("eng", {
			role: "user",
			text: "第二条",
			final: false,
		});
		session.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(300);
		session.handleLineTranscript("eng", {
			role: "user",
			text: "改成下周三",
			final: false,
		});
		await vi.advanceTimersByTimeAsync(900);
		const founderCaptions = captions.filter(([s]) => s === "Annie");
		expect(founderCaptions).toHaveLength(1);
		expect(founderCaptions[0]?.[1]).toBe("第二条改成下周三");
	});

	it("the flushed utterance drives the conclude flow (not just the caption)", async () => {
		const { session, land } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleLineTranscript("eng", {
			role: "user",
			text: "就这样",
			final: false,
		});
		session.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900);
		expect(session.currentState).toBe("concluding");
		// clean confirm, also via fragments + stop
		session.handleLineTranscript("eng", {
			role: "user",
			text: "对,没问题",
			final: false,
		});
		session.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900);
		await vi.runAllTimersAsync();
		expect(land).toHaveBeenCalledWith(
			expect.objectContaining({ confirmed: true }),
		);
	});

	it("a final=true transcript still flushes immediately (legacy path kept)", () => {
		const { session, captions } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleLineTranscript("eng", {
			role: "user",
			text: "Tadashi 你说说",
			final: true,
		});
		expect(captions.filter(([s]) => s === "Annie")).toHaveLength(1);
	});
});

describe("R13 — debounce vs landing/teardown coordination", () => {
	it("she leaves inside the debounce window → her last words still reach the journal snapshot", async () => {
		const { session, land } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleLineTranscript("eng", {
			role: "user",
			text: "worktree 先别建",
			final: false,
		});
		session.handleFounderSpeechStopped();
		// she leaves BEFORE the 700ms tail elapses → degraded landing
		session.handleFounderVoiceState(false);
		await vi.runAllTimersAsync();
		expect(land).toHaveBeenCalledTimes(1);
		const snapshot = land.mock.calls[0]?.[0]?.journalSnapshot as string;
		expect(snapshot).toContain("worktree 先别建");
	});

	it("the flush timer does not survive teardown (no idle-state ghost flush)", async () => {
		const { session, captions, land } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleLineTranscript("eng", {
			role: "user",
			text: "尾巴碎片",
			final: false,
		});
		session.handleFounderSpeechStopped();
		session.handleFounderVoiceState(false); // → landing → teardown
		await vi.runAllTimersAsync();
		const captionsAfterLanding = captions.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(captions.length).toBe(captionsAfterLanding); // no ghost flush
		expect(land).toHaveBeenCalledTimes(1);
	});
});

describe("F2b — speech stop shows the thinking cue", () => {
	it("handleFounderSpeechStopped flips presence to thinking", () => {
		const { session, presences } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleFounderSpeechStopped();
		expect(presences.some(([s]) => s === "thinking")).toBe(true);
	});
});
