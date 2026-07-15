/**
 * Codex R17 (FLY-545 × FLY-1065 merge) — cross-package regression: the REAL
 * GeminiLiveBackend (post-1065 turn aggregation: fragments pass through as
 * final:false, final:true is the ONE turn-level aggregate) feeding the REAL
 * HuddleSession, wired exactly the way wireMeeting's attach does.
 *
 * The doubling bug this pins down: HuddleSession appended BOTH the fragments
 * and the aggregate — founder「结束」became「结束结束」, assistant「答」「案」+
 * aggregate「答案」became「答案答案」, and an aggregate landing after the 700ms
 * founder debounce re-committed the whole utterance a second time (double
 * caption + double journal + double routing).
 *
 * Contract asserted here:
 *  - final:false fragments → final:true aggregate = exactly ONE caption /
 *    journal / routing, for BOTH roles;
 *  - founder: covered in BOTH orders — aggregate arriving BEFORE the
 *    speaking-end debounce fires, and AFTER it already committed (including
 *    an STT tail that only exists in the aggregate).
 */
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
	LiveServerEvent,
} from "flywheel-voice-core";
import { GeminiLiveBackend } from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import { type HuddleLine, HuddleSession } from "../huddle/HuddleSession.js";

class FakeConnection implements LiveConnection {
	private cb?: (e: LiveServerEvent) => void;
	sendAudio(): void {}
	sendText(): void {}
	endAudioStream(): void {}
	sendToolResponse(): void {}
	onEvent(cb: (e: LiveServerEvent) => void): void {
		this.cb = cb;
	}
	emit(e: LiveServerEvent): void {
		this.cb?.(e);
	}
	async close(): Promise<void> {}
}
class FakeTransport implements GeminiLiveTransport {
	last?: FakeConnection;
	async connect(_p: LiveConnectParams): Promise<LiveConnection> {
		this.last = new FakeConnection();
		return this.last;
	}
}

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

const issue = { id: "u1", identifier: "FLY-1234", url: "https://l/1234" };

async function assemble() {
	const transport = new FakeTransport();
	const backend = new GeminiLiveBackend({
		transport,
		profile: { model: "gemini-live-test", asyncFunctionCalling: false },
	});
	const session = await backend.createConversation({
		brain: { async *respond() {} },
	});

	const eng = new FakeLine("eng", "Tadashi");
	const captions: [string, string][] = [];
	const feed = new FeedPipeline();
	const journal: string[] = [];
	// second party so founder/eng entries fan out somewhere observable
	feed.register("observer", { inject: (text) => void journal.push(text) });
	const ladder = { notifyFounderUtterance: vi.fn() };
	const huddle = new HuddleSession({
		issue,
		hostLeadId: "eng",
		lines: [eng],
		router: new AddressRouter([{ leadId: "eng", aliases: ["Tadashi"] }], "eng"),
		feed,
		ladder,
		tiv: {
			presence: () => {},
			caption: (sp, t) => void captions.push([sp, t]),
			warn: vi.fn(),
		},
		conclusion: {
			land: vi.fn(async () => "landed" as const),
			abortNoShow: vi.fn(async () => {}),
		},
		onTeardown: vi.fn(),
		assembleTimeoutMs: 600_000,
	});

	// exactly wireMeeting's attach wiring for one line
	session.on("transcript", (t) => huddle.handleLineTranscript("eng", t));
	session.on("response-started", () => huddle.handleLineResponseStarted("eng"));
	session.on("response-done", () => huddle.handleLineResponseDone("eng"));

	huddle.start();
	huddle.handleFounderVoiceState(true);
	const conn = transport.last as FakeConnection;
	return { conn, huddle, captions, journal, ladder, eng };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("R17 — real backend aggregation × huddle consumption (one commit per turn)", () => {
	it("order A: aggregate lands BEFORE the debounce — fragments + aggregate = ONE founder caption, ONE journal entry", async () => {
		const { conn, captions, journal } = await assemble();
		conn.emit({
			type: "transcript",
			role: "user",
			text: "内存这块",
			final: false,
		});
		conn.emit({
			type: "transcript",
			role: "user",
			text: "怎么弄",
			final: false,
		});
		// first model output opens the turn → backend flushes HER aggregate
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "好的",
			final: false,
		});
		const founderCaptions = captions.filter(([s]) => s === "Annie");
		expect(founderCaptions).toHaveLength(1);
		expect(founderCaptions[0]?.[1]).toBe("内存这块怎么弄");
		expect(journal.filter((l) => l.includes("Annie"))).toHaveLength(1);
		// the debounce firing later must not double it either
		await vi.advanceTimersByTimeAsync(2_000);
		expect(captions.filter(([s]) => s === "Annie")).toHaveLength(1);
	});

	it("order B: debounce committed FIRST — the identical aggregate is deduped, an STT tail is journal-only (NO second semantic commit)", async () => {
		const { conn, huddle, captions, journal, ladder, eng } = await assemble();
		conn.emit({ type: "transcript", role: "user", text: "结束", final: false });
		huddle.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900); // debounce commits 「结束」
		expect(captions.filter(([s]) => s === "Annie")).toEqual([
			["Annie", "结束"],
		]);
		const semanticCommits = ladder.notifyFounderUtterance.mock.calls.length;
		const hostPrompts = eng.session.texts.length;
		const stateAfterCommit = huddle.currentState;
		// a late STT tail only the aggregate carries
		conn.emit({ type: "transcript", role: "user", text: "了", final: false });
		// model answers → backend flushes the user aggregate 「结束了」
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "好",
			final: false,
		});
		const founderCaptions = captions.filter(([s]) => s === "Annie");
		expect(founderCaptions.map(([, t]) => t)).toEqual(["结束", "了"]); // never 「结束了」 re-committed whole
		// the tail reached the RECORD (caption above + journal)…
		expect(journal.filter((l) => l.includes("Annie: 了"))).toHaveLength(1);
		// …but NEVER the semantic pipeline: no second ladder notify, no bogus
		// "correction:「了」" host prompt, no state change (Codex R18).
		expect(ladder.notifyFounderUtterance.mock.calls.length).toBe(
			semanticCommits,
		);
		expect(eng.session.texts.length).toBe(hostPrompts);
		expect(huddle.currentState).toBe(stateAfterCommit);
	});

	it("assistant turn: fragments + aggregate caption ONCE with the full text", async () => {
		const { conn, captions } = await assemble();
		// founder asks (final aggregate via first model output) → grants eng
		conn.emit({
			type: "transcript",
			role: "user",
			text: "说说进展",
			final: false,
		});
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "答",
			final: false,
		});
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "案",
			final: false,
		});
		conn.emit({ type: "generation-complete" });
		conn.emit({ type: "turn-complete" });
		const leadCaptions = captions.filter(([s]) => s === "Tadashi");
		expect(leadCaptions).toHaveLength(1);
		expect(leadCaptions[0]?.[1]).toBe("答案"); // aggregate, not 「答案答案」
	});

	it("R19: a stale commit from the PREVIOUS addressed line must not eat the new line's turn", async () => {
		// two lines; routing switches eng → joy between the debounce commit and
		// the aggregates' arrival. Driven at the huddle seam directly (the
		// multi-line topology has one real session per line in production).
		const eng = new FakeLine("eng", "Tadashi");
		const joy = new FakeLine("joy", "Hiro");
		const captions: [string, string][] = [];
		const ladder = { notifyFounderUtterance: vi.fn() };
		const huddle = new HuddleSession({
			issue,
			hostLeadId: "eng",
			lines: [eng, joy],
			router: new AddressRouter(
				[
					{ leadId: "eng", aliases: ["Tadashi"] },
					{ leadId: "joy", aliases: ["Hiro"] },
				],
				"eng",
			),
			feed: new FeedPipeline(),
			ladder,
			tiv: {
				presence: () => {},
				caption: (sp, t) => void captions.push([sp, t]),
				warn: vi.fn(),
			},
			conclusion: {
				land: vi.fn(async () => "landed" as const),
				abortNoShow: vi.fn(async () => {}),
			},
			onTeardown: vi.fn(),
			assembleTimeoutMs: 600_000,
		});
		huddle.start();
		huddle.handleFounderVoiceState(true);
		// turn 1 on eng: debounce commits + the utterance re-routes to Hiro/joy
		huddle.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 你说说",
			final: false,
		});
		huddle.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900);
		expect(captions.filter(([s]) => s === "Annie")).toHaveLength(1);
		// eng's aggregate is LATE (won't arrive until after the ping-pong
		// below) — its commit record stays outstanding: the R19 trap.
		// turn 2, order A on joy (no debounce): the aggregate must commit WHOLE
		huddle.handleLineTranscript("joy", {
			role: "user",
			text: "第二个问题",
			final: false,
		});
		huddle.handleLineTranscript("joy", {
			role: "user",
			text: "第二个问题",
			final: true,
		});
		const founderCaptions = captions.filter(([s]) => s === "Annie");
		expect(founderCaptions.map(([, t]) => t)).toEqual([
			"Hiro 你说说",
			"第二个问题",
		]);
		// and it was a real SEMANTIC commit, not a journal-only tail
		expect(ladder.notifyFounderUtterance).toHaveBeenCalledTimes(2);
		expect(ladder.notifyFounderUtterance).toHaveBeenLastCalledWith(
			"第二个问题",
		);

		// ---- R20: routing ping-pong (eng→joy→eng) must not replay turn 1 ----
		// turn 3 routes back to eng
		huddle.handleLineTranscript("joy", {
			role: "user",
			text: "Tadashi 接着说",
			final: false,
		});
		huddle.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900);
		const captionsBefore = captions.filter(([s]) => s === "Annie").length;
		const ladderBefore = ladder.notifyFounderUtterance.mock.calls.length;
		const engPromptsBefore = eng.session.texts.length;
		const joyPromptsBefore = joy.session.texts.length;
		// turn 1's eng aggregate arrives ONLY NOW — eng is addressed again, but
		// this stale turn must reconcile silently, never replay (Codex R20)
		huddle.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 你说说",
			final: true,
		});
		expect(captions.filter(([s]) => s === "Annie")).toHaveLength(
			captionsBefore,
		);
		expect(ladder.notifyFounderUtterance.mock.calls.length).toBe(ladderBefore);
		expect(eng.session.texts.length).toBe(engPromptsBefore);
		expect(joy.session.texts.length).toBe(joyPromptsBefore);
		// and a FRESH order-A turn on eng afterwards still commits normally
		huddle.handleLineTranscript("eng", {
			role: "user",
			text: "新问题",
			final: true,
		});
		expect(captions.filter(([s]) => s === "Annie").at(-1)).toEqual([
			"Annie",
			"新问题",
		]);
		expect(ladder.notifyFounderUtterance).toHaveBeenLastCalledWith("新问题");

		// ---- R21: a NON-addressed line's aggregate still journals its STT
		// tail — exactly once, with zero semantic side effects and without
		// touching the NEW addressed line's in-flight debounce state ----
		// route back to joy (turn on eng)
		huddle.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 再想想",
			final: false,
		});
		huddle.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900); // commits + routes to joy
		// joy (now addressed) starts accumulating her NEXT utterance
		huddle.handleLineTranscript("joy", {
			role: "user",
			text: "第三个",
			final: false,
		});
		const ladder2 = ladder.notifyFounderUtterance.mock.calls.length;
		const state2 = huddle.currentState;
		// eng's aggregate arrives late, carrying a tail beyond the commit
		huddle.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro 再想想这个",
			final: true,
		});
		// tail journaled exactly once…
		expect(captions.filter(([s]) => s === "Annie").at(-1)).toEqual([
			"Annie",
			"这个",
		]);
		// …with no semantic side effects and no state drift
		expect(ladder.notifyFounderUtterance.mock.calls.length).toBe(ladder2);
		expect(huddle.currentState).toBe(state2);
		// and joy's in-flight accumulation survived intact: her utterance
		// still commits WHOLE on the debounce
		huddle.handleLineTranscript("joy", {
			role: "user",
			text: "问题",
			final: false,
		});
		huddle.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(900);
		expect(captions.filter(([s]) => s === "Annie").at(-1)).toEqual([
			"Annie",
			"第三个问题",
		]);
		expect(ladder.notifyFounderUtterance).toHaveBeenLastCalledWith(
			"第三个问题",
		);
	});
});
