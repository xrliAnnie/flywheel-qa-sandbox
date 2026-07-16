/**
 * FLY-1160 §4.1 — HuddleSession in RESIDENT mode: a line whose `resident`
 * control is set thinks via a resident Claude brain, not Gemini. HuddleSession
 * drives brain.respond for greetings / founder turns / handoff (never
 * session.sendText), and the driver's speaking/answer events flow back into
 * handleResident*. Barge-in cuts the resident. The Gemini-path tests
 * (huddle-session.test.ts) prove the `resident`-absent path is byte-identical.
 */
import { describe, expect, it, vi } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import {
	type HuddleLine,
	HuddleSession,
	type ResidentLineControl,
} from "../huddle/HuddleSession.js";

const issue = { id: "u1", identifier: "FLY-1234", url: "https://l/1234" };

/** a resident line: the `resident` control records respond/bargeIn; session is
 * the Gemini STT stub (audio + user-transcript only); mouth is inert (the real
 * text mouth lives inside the driver, off-session here). */
class FakeResidentLine implements HuddleLine {
	responded: string[] = [];
	bargeIns = 0;
	session = {
		audio: [] as Buffer[],
		texts: [] as string[],
		injected: [] as string[],
		interrupts: 0,
		sendAudio: (f: Buffer) => void this.session.audio.push(f),
		sendText: (t: string) => void this.session.texts.push(t), // MUST stay empty in resident mode
		injectContext: (t: string) => void this.session.injected.push(t),
		interrupt: () => void this.session.interrupts++,
	};
	mouth = {
		flushes: 0,
		beginTurn: () => {},
		feed: () => {},
		endTurn: () => {},
		flush: () => void this.mouth.flushes++,
		noteToolCall: () => {},
		noteToolResolved: () => {},
	};
	resident: ResidentLineControl = {
		respond: (t) => void this.responded.push(t),
		bargeIn: () => void this.bargeIns++,
	};
	constructor(
		readonly leadId: string,
		readonly displayName: string,
	) {}
}

function setup(over: Record<string, unknown> = {}) {
	const tadashi = new FakeResidentLine("eng", "Tadashi");
	const hiro = new FakeResidentLine("joy", "Hiro");
	const feed = new FeedPipeline({
		now: () => new Date("2026-07-11T00:00:00Z"),
	});
	feed.register("eng", { inject: (t) => tadashi.session.injectContext(t) });
	feed.register("joy", { inject: (t) => hiro.session.injectContext(t) });
	const tiv = { presence: vi.fn(), caption: vi.fn(), warn: vi.fn() };
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
		ladder: { notifyFounderUtterance: vi.fn() },
		tiv,
		conclusion: {
			land: vi.fn(async () => "landed" as const),
			abortNoShow: vi.fn(async () => {}),
		},
		onTeardown: vi.fn(),
		assembleTimeoutMs: 600_000,
		...over,
	});
	return { session, tadashi, hiro, feed, tiv };
}

const utter = (session: HuddleSession, leadId: string, text: string) =>
	session.handleLineTranscript(leadId, { role: "user", text, final: true });

describe("HuddleSession resident mode (FLY-1160 §4.1)", () => {
	it("host greeting drives the resident brain, NOT session.sendText", () => {
		const { session, tadashi, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		expect(tadashi.responded[0]).toContain("招呼");
		expect(tadashi.session.texts).toHaveLength(0); // never a Gemini text turn
		expect(hiro.responded).toHaveLength(0);
	});

	it("a founder turn kicks off the addressed line's resident.respond; the answer captions + fans out", () => {
		const { session, tadashi, hiro, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		tadashi.responded.length = 0; // drop the greeting

		utter(session, "eng", "发布定周五");
		// a resident line never heard audio — it must be given the transcript
		expect(tadashi.responded).toEqual(["发布定周五"]);
		// the OTHER line hears her words through the feed (exclude the addressed)
		expect(hiro.session.injected).toEqual(["[会议记录] Annie: 发布定周五"]);

		// driver reports the turn back: speaking → answer
		session.handleResidentSpeaking("eng");
		expect(tiv.presence).toHaveBeenLastCalledWith("speaking", "Tadashi");
		session.handleResidentAnswer("eng", "好的，那就周五发布。");
		expect(tiv.caption).toHaveBeenCalledWith("Tadashi", "好的，那就周五发布。");
		// the answer fans out to the other line
		expect(hiro.session.injected).toContain(
			"[会议记录] Tadashi: 好的，那就周五发布。",
		);
	});

	it("barge-in cuts the resident that is currently speaking (no Gemini interrupt)", () => {
		const { session, tadashi } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		utter(session, "eng", "讲讲进度");
		session.handleResidentSpeaking("eng");
		const before = tadashi.bargeIns;
		session.handleBargeIn();
		expect(tadashi.bargeIns).toBe(before + 1);
		expect(tadashi.session.interrupts).toBe(0); // resident path, not Gemini
	});

	it("barge-in BEFORE the first delta (currentSpeaker unset) still cuts the addressed resident (Codex R1 HIGH-1)", () => {
		const { session, tadashi } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		utter(session, "eng", "讲讲进度"); // respond kicked off; no delta → no currentSpeaker
		const before = tadashi.bargeIns;
		session.handleBargeIn();
		expect(tadashi.bargeIns).toBe(before + 1);
	});

	it("barge-in DURING mouth drain (brain stream ended, audio may still play) cuts the resident (Codex R1 HIGH-1)", () => {
		const { session, tadashi } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		utter(session, "eng", "讲讲进度");
		session.handleResidentSpeaking("eng");
		session.handleResidentAnswer("eng", "在做了。"); // brain done → currentSpeaker cleared
		const before = tadashi.bargeIns;
		session.handleBargeIn(); // currentSpeaker unset, but the edge-tts mouth may still play
		expect(tadashi.bargeIns).toBe(before + 1);
	});

	it("handoff: the old line is barge-in cut and the new line gets an addressing respond", () => {
		const { session, tadashi, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		// address the host first so it holds the floor, then hand off to Hiro
		utter(session, "eng", "先问你");
		session.handleResidentSpeaking("eng");
		const engBarges = tadashi.bargeIns;
		hiro.responded.length = 0;
		utter(session, "eng", "Hiro 你觉得呢");
		expect(tadashi.bargeIns).toBe(engBarges + 1); // old line cut
		expect(hiro.responded).toEqual(["[Annie 在点名你] Hiro 你觉得呢"]);
	});

	it("barge-in cuts the resident that HOLDS THE FLOOR (a host recap), not the router's addressed line (Codex R2 HIGH-2)", () => {
		const { session, tadashi, hiro } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		// hand off to Hiro so the router now addresses joy…
		utter(session, "eng", "Hiro 你觉得呢");
		expect(hiro.responded.at(-1)).toContain("[Annie 在点名你]");
		// …but the HOST (eng) is the one actually speaking now (a recap/control turn)
		session.promptHost("所以结论是周五发布,对吗?");
		const engBefore = tadashi.bargeIns;
		const joyBefore = hiro.bargeIns;
		session.handleBargeIn();
		expect(tadashi.bargeIns).toBe(engBefore + 1); // the recap host is cut
		expect(hiro.bargeIns).toBe(joyBefore); // NOT the router-addressed line
	});

	it("barge-in is a NO-OP once the meeting is landing — it must not interrupt the host's final-turn minutes (Codex R2 HIGH-3)", () => {
		const { session, tadashi } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		utter(session, "eng", "就这样"); // → concluding (host recap sets the floor)
		expect(session.currentState).toBe("concluding");
		utter(session, "eng", "对"); // clean affirm → landNow → state "landing"
		expect(session.currentState).toBe("landing");
		const before = tadashi.bargeIns;
		session.handleBargeIn(); // must NOT cut the host (its summary turn is running)
		expect(tadashi.bargeIns).toBe(before);
	});

	it("a resident turn failure is fail-loud to the TIV, not silent dead air", () => {
		const { session, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		utter(session, "eng", "查一下状态");
		session.handleResidentSpeaking("eng");
		session.handleResidentError("eng", "subprocess-failed");
		expect(tiv.warn).toHaveBeenCalledWith(
			expect.stringContaining("Tadashi 这轮没答上来"),
		);
	});

	it("FLY-1190: an STT flap mid-resident-answer does NOT drop the answer — the resident turn lives on the brain, not the STT session", () => {
		const { session, tadashi, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		tadashi.responded.length = 0; // drop the greeting
		utter(session, "eng", "讲讲进度");
		session.handleResidentSpeaking("eng"); // resident is now answering (currentSpeaker=eng)
		// her Gemini STT session (ears) flaps mid-answer — this is INDEPENDENT of the
		// resident's in-flight answer (which streams from the brain, not this session).
		session.handleLineDown("eng");
		session.handleLineReconnected("eng");
		// the resident finishes its answer — it MUST still caption + fan out. Before the
		// resident-aware guard, handleLineReconnected cleared currentSpeaker → this answer
		// was silently dropped (leadId !== currentSpeaker).
		session.handleResidentAnswer("eng", "在做了,底盘 merge 了。");
		expect(tiv.caption).toHaveBeenCalledWith(
			"Tadashi",
			"在做了,底盘 merge 了。",
		);
	});

	it("FLY-1190: an STT abort while she is TALKING to a resident line replays her buffered audio into the successor STT session (её words are not lost)", () => {
		const { session, tadashi } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		// she is addressing the resident host and speaking; frames buffer as she talks
		const FMT = {
			encoding: "pcm16",
			sampleRateHz: 16_000,
			channels: 1,
		} as const;
		session.handleFounderFrame(Buffer.from("f1"), FMT);
		session.handleFounderFrame(Buffer.from("f2"), FMT);
		const before = tadashi.session.audio.length;
		// STT dies mid-utterance, then reconnects
		session.handleLineDown("eng");
		session.handleFounderSpeechStopped(); // she finished during the down window
		const res = session.handleLineReconnected("eng");
		// the buffered frames are re-sent into the successor STT session so it can
		// transcribe what she actually said → the resident brain then gets her words.
		expect(res.replayed).toBe(true);
		expect(tadashi.session.audio.length).toBe(before + 2);
	});

	it("FLY-1190: an ears-only STT flap DURING a resident answer keeps presence 'speaking' — never connecting/listening (Codex MEDIUM-2)", () => {
		const { session, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		utter(session, "eng", "讲讲进度");
		session.handleResidentSpeaking("eng"); // currentSpeaker=eng → presence "speaking"
		expect(tiv.presence).toHaveBeenLastCalledWith("speaking", "Tadashi");
		const base = tiv.presence.mock.calls.length;
		// her Gemini STT ears flap while the resident answer streams FROM THE BRAIN —
		// the answer's status belongs to the answer, not this ears-only reconnect.
		session.handleLineDown("eng");
		session.handleLineReconnected("eng");
		// no presence stomp: before the guard this went speaking → connecting → listening.
		const states = tiv.presence.mock.calls.slice(base).map((c) => c[0]);
		expect(states).not.toContain("connecting");
		expect(states).not.toContain("listening");
	});

	it("FLY-1190: an ears-only STT flap BEFORE the first delta (resident still thinking) keeps 'thinking' — the flap must not flip to connecting/listening (Codex MEDIUM-2)", () => {
		const { session, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		// a founder turn kicks off resident.respond → residentFloor=eng (pre-first-delta:
		// no handleResidentSpeaking yet, so currentSpeaker is still unset).
		utter(session, "eng", "查一下状态");
		session.handleFounderSpeechStopped(); // waiting for the answer → presence "thinking" + watchdog armed
		const base = tiv.presence.mock.calls.length;
		session.handleLineDown("eng");
		session.handleLineReconnected("eng");
		// residentFloor keeps residentTurnInFlight true even before the first delta, so
		// the still-thinking turn's status + stall watchdog are left alone.
		const states = tiv.presence.mock.calls.slice(base).map((c) => c[0]);
		expect(states).not.toContain("connecting");
		expect(states).not.toContain("listening");
	});

	it("FLY-1190: after a resident answer COMPLETES, an idle ears flap DOES show connecting/listening — a finished turn must not stickily suppress the truthful reconnect status (Codex R12: residentFloor is sticky)", () => {
		const { session, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		session.handleResidentSpeaking("eng");
		session.handleResidentAnswer("eng", "hi"); // drain the greeting turn → count 0
		utter(session, "eng", "讲讲进度");
		session.handleResidentSpeaking("eng");
		session.handleResidentAnswer("eng", "在做了。"); // founder turn DONE → count settles to 0
		const base = tiv.presence.mock.calls.length;
		// her ears flap while IDLE (no answer in flight) — she must SEE the truth. With
		// the sticky residentFloor predicate this line was still "in flight" and both
		// statuses were wrongly swallowed.
		session.handleLineDown("eng");
		session.handleLineReconnected("eng");
		const states = tiv.presence.mock.calls.slice(base).map((c) => c[0]);
		expect(states).toContain("connecting"); // handleLineDown told the truth
		expect(states).toContain("listening"); // handleLineReconnected restored listening
	});

	it("FLY-1190: two turns queued on ONE resident line — turn A settling must NOT clear turn B's in-flight status (Codex R14: needs a per-line count, not a single marker)", () => {
		const { session, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true); // turn A: greeting on the host (eng)
		session.promptHost("控制:再确认一下"); // turn B queued behind A (serial driver)
		session.handleResidentSpeaking("eng"); // A streams
		session.handleResidentAnswer("eng", "A done"); // A settles — but B is still in flight
		session.handleResidentSpeaking("eng"); // B streams
		const base = tiv.presence.mock.calls.length;
		// an STT flap now: B is genuinely in flight, so its status/watchdog must be left
		// alone. With a single marker (cleared by A) this went connecting/listening.
		session.handleLineDown("eng");
		session.handleLineReconnected("eng");
		const states = tiv.presence.mock.calls.slice(base).map((c) => c[0]);
		expect(states).not.toContain("connecting");
		expect(states).not.toContain("listening");
	});

	it("FLY-1190: a barge-in that CANCELS resident answer(s) clears the in-flight count — a later idle ears flap still shows connecting/listening (Codex R13: interruptLine must cancel all)", () => {
		const { session, tiv } = setup();
		session.start();
		session.handleFounderVoiceState(true);
		utter(session, "eng", "讲讲进度");
		session.handleResidentSpeaking("eng"); // answering
		session.handleBargeIn(); // she cuts him off — the cancel path fires NO answer/error cb
		const base = tiv.presence.mock.calls.length;
		// ears flap while idle — the CANCELLED turn must not still count as in flight, or
		// both statuses get swallowed (Codex's minimal repro: empty [] state sequence).
		session.handleLineDown("eng");
		session.handleLineReconnected("eng");
		const states = tiv.presence.mock.calls.slice(base).map((c) => c[0]);
		expect(states).toContain("connecting");
		expect(states).toContain("listening");
	});

	it("resident real progress re-arms the stall warning: a LATER wait warns AGAIN (545-fold MEDIUM — handleResidentSpeaking must mirror the Gemini thinkingWarned reset)", () => {
		const timers: { ms: number; run: () => void }[] = [];
		const setTimeoutFn = ((run: () => void, ms?: number) => {
			const h = setTimeout(() => {}, 60_000);
			h.unref?.();
			timers.push({ ms: ms ?? 0, run });
			return h;
		}) as unknown as typeof setTimeout;
		const fireLatestWatchdog = () => {
			const w = [...timers].reverse().find((t) => t.ms === 20);
			if (!w) throw new Error("watchdog not scheduled");
			w.run();
		};
		const warns = () =>
			tiv.warn.mock.calls.filter((c) => String(c[0]).includes("等得比平时久"))
				.length;
		const { session, tiv } = setup({ thinkingWatchdogMs: 20, setTimeoutFn });
		session.start();
		session.handleFounderVoiceState(true); // grant = host (eng), greeting turn
		session.handleResidentSpeaking("eng");
		session.handleResidentAnswer("eng", "greeting done");

		// wait #1 stalls → warns exactly once
		session.handleFounderSpeechStopped();
		fireLatestWatchdog();
		expect(warns()).toBe(1);

		// resident makes REAL progress then finishes the turn — this is the entry
		// that must reset thinkingWarned (final-545 reset it on the Gemini path only)
		session.handleResidentSpeaking("eng");
		session.handleResidentAnswer("eng", "first answer done");

		// wait #2 stalls → must warn AGAIN (before the fix it stayed silent at 1)
		session.handleFounderSpeechStopped();
		fireLatestWatchdog();
		expect(warns()).toBe(2);
	});
});
