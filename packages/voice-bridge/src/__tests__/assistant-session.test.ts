/**
 * FLY-967 P6b — AssistantSession state machine:
 * invoked → live → concluding → landing → teardown, all seams injected.
 * Covers: opening/recap control prompts, founder 10-min no-show abort,
 * both concluding entries (end-word / she leaves), ears-drop >60s
 * degradation, speaker wiring (turn gate / earcon / filler-resolve),
 * landing failure still tearing down, and slot release on every exit.
 */

import { TypedEmitter } from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantSession } from "../assistant/AssistantSession.js";
import { SessionSlot } from "../SessionSlot.js";

type ConvEvents = {
	transcript: [
		{
			role: "user" | "assistant";
			text: string;
			final: boolean;
			interrupted?: boolean;
		},
	];
	"response-started": [];
	"response-audio": [chunk: Buffer, format: unknown];
	"response-done": [];
	"response-cancelled": [];
	"tool-call": [{ callId: string; name: string; args: unknown }];
	error: [Error];
};

class FakeConversation {
	readonly emitter = new TypedEmitter<ConvEvents>();
	sentTexts: string[] = [];
	sentAudio: Buffer[] = [];
	closed = false;
	closeCount = 0;
	sendText(t: string): void {
		this.sentTexts.push(t);
	}
	sendAudio(frame: Buffer): void {
		this.sentAudio.push(frame);
	}
	userTurnEnds = 0;
	endUserTurn(): void {
		this.userTurnEnds++;
	}
	on<E extends keyof ConvEvents>(
		e: E,
		h: (...a: ConvEvents[E]) => void,
	): () => void {
		return this.emitter.on(e, h);
	}
	async close(): Promise<undefined> {
		this.closed = true;
		this.closeCount++;
		return undefined;
	}
	// test drivers
	user(text: string): void {
		this.emitter.emit("transcript", { role: "user", text, final: true });
	}
	assistant(text: string, interrupted?: boolean): void {
		this.emitter.emit("transcript", {
			role: "assistant",
			text,
			final: true,
			...(interrupted ? { interrupted: true } : {}),
		});
	}
}

class FakeSpeaker {
	calls: string[] = [];
	beginTurn(): void {
		this.calls.push("beginTurn");
	}
	feed(): void {
		this.calls.push("feed");
	}
	endTurn(): void {
		this.calls.push("endTurn");
	}
	flush(): void {
		this.calls.push("flush");
	}
	noteToolCall(): void {
		this.calls.push("noteToolCall");
	}
	noteToolResolved(): void {
		this.calls.push("noteToolResolved");
	}
}

function harness(over: Record<string, unknown> = {}) {
	const conv = new FakeConversation();
	const speaker = new FakeSpeaker();
	const slot = new SessionSlot();
	expect(slot.acquire("gemini", "sess-1").ok).toBe(true); // command layer did this
	let founderJoined: (() => void) | undefined;
	let founderLeft: (() => void) | undefined;
	let earsDown: (() => void) | undefined;
	let earsSpeakingEnd: (() => void) | undefined;
	let earsFrame: ((f: Buffer, fmt: unknown) => void) | undefined;
	let earsUp: (() => void) | undefined;
	const tiv = {
		status: vi.fn(),
		caption: vi.fn(),
		card: vi.fn(),
		error: vi.fn(),
	};
	const landing = { run: vi.fn(async () => ({ ok: true }) as const) };
	const linearAbort = {
		comment: vi.fn(async () => ({})),
		closeIssue: vi.fn(async () => {}),
	};
	const voice = {
		join: vi.fn(async () => {}),
		leave: vi.fn(),
		founderPresent: vi.fn(() => true),
		onFounderJoin: (cb: () => void) => {
			founderJoined = cb;
			return () => {};
		},
		onFounderLeave: (cb: () => void) => {
			founderLeft = cb;
			return () => {};
		},
	};
	const ears = {
		onFrame: (cb: (f: Buffer, fmt: unknown) => void) => {
			earsFrame = cb;
			return () => {};
		},
		onSpeakingEnd: (cb: () => void) => {
			earsSpeakingEnd = cb;
			return () => {};
		},
		onDown: (cb: () => void) => {
			earsDown = cb;
			return () => {};
		},
		onUp: (cb: () => void) => {
			earsUp = cb;
			return () => {};
		},
	};
	const session = new AssistantSession({
		issueId: "FLY-1234",
		sessionId: "sess-1",
		topic: "声线",
		slot,
		briefing: {
			compose: () => ({
				text: "[简报生成时间 15:00] board…",
				generatedAt: "2026-07-07T15:00:00.000Z",
				stale: false,
			}),
		},
		createConversation: vi.fn(async (_preamble: string) => conv),
		speaker,
		voice,
		ears,
		tiv,
		landing,
		linearAbort,
		...over,
	});
	return {
		session,
		conv,
		speaker,
		slot,
		tiv,
		landing,
		linearAbort,
		voice,
		founderJoin: () => founderJoined?.(),
		founderLeave: () => founderLeft?.(),
		earsDown: () => earsDown?.(),
		earsSpeakingEnd: () => earsSpeakingEnd?.(),
		earsFrame: (f: Buffer) => earsFrame?.(f, { sampleRateHz: 16000 }),
		earsUp: () => earsUp?.(),
	};
}

async function settle() {
	await vi.advanceTimersByTimeAsync(0);
}

describe("AssistantSession (FLY-967 P6b)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-07T15:00:00"));
	});
	afterEach(() => vi.useRealTimers());

	it("FLY-967 round-6: founder speaking-end commits her turn only after she actually sent audio (Discord silence-suppression)", async () => {
		const h = harness();
		await h.session.start();
		expect(h.session.state).toBe("live");
		// pure speaking-end with no frames this utterance = backchannel/noise: no commit
		h.earsSpeakingEnd();
		expect(h.conv.userTurnEnds).toBe(0);
		// she speaks (frames flow), then stops → the turn commits exactly once
		h.earsFrame(Buffer.alloc(640));
		h.earsFrame(Buffer.alloc(640));
		h.earsSpeakingEnd();
		expect(h.conv.userTurnEnds).toBe(1);
		// a second speaking-end with no new frames does NOT re-commit
		h.earsSpeakingEnd();
		expect(h.conv.userTurnEnds).toBe(1);
		// next utterance commits again
		h.earsFrame(Buffer.alloc(640));
		h.earsSpeakingEnd();
		expect(h.conv.userTurnEnds).toBe(2);
	});

	it("happy path: open → chat → 结束 → recap → 对 → landing(confirmed) → teardown", async () => {
		const h = harness();
		await h.session.start();
		// opening control prompt went out
		expect(h.conv.sentTexts[0]).toContain("开场");
		// a chat turn wires the speaker
		h.conv.emitter.emit("response-started");
		h.conv.emitter.emit("response-audio", Buffer.from("a"), {});
		h.conv.emitter.emit("response-done");
		h.conv.user("声线就用稳一点的");
		// she ends the meeting
		h.conv.user("就这样,结束吧");
		await settle();
		expect(h.conv.sentTexts.some((t) => t.includes("recap"))).toBe(true);
		expect(h.session.state).toBe("concluding");
		// model recaps, she confirms
		h.conv.assistant("好的,今天定了:声线用稳一点的。对吗?");
		h.conv.user("对,没问题");
		await settle();
		expect(h.landing.run).toHaveBeenCalledTimes(1);
		const input = h.landing.run.mock.calls[0][0] as {
			confirmed: boolean;
			recapText: string;
			quotes: { text: string }[];
		};
		expect(input.confirmed).toBe(true);
		expect(input.recapText).toContain("声线用稳一点的");
		expect(input.quotes.map((q) => q.text)).toContain("声线就用稳一点的");
		expect(h.tiv.card).toHaveBeenCalled();
		expect(h.conv.closed).toBe(true);
		expect(h.voice.leave).toHaveBeenCalled();
		expect(h.slot.acquire("meet", "x").ok).toBe(true); // released
		expect(h.session.state).toBe("idle");
	});

	it("10-min founder no-show aborts: 未开成 comment + close, no landing", async () => {
		const h = harness();
		h.voice.founderPresent.mockReturnValue(false);
		await h.session.start();
		expect(h.session.state).toBe("invoked");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(h.linearAbort.comment).toHaveBeenCalledWith(
			"FLY-1234",
			expect.stringContaining("没开成"),
		);
		expect(h.linearAbort.closeIssue).toHaveBeenCalledWith("FLY-1234");
		expect(h.landing.run).not.toHaveBeenCalled();
		expect(h.slot.acquire("meet", "x").ok).toBe(true);
		expect(h.session.state).toBe("idle");
	});

	it("founder joining within the window enters live and disarms the abort", async () => {
		const h = harness();
		h.voice.founderPresent.mockReturnValue(false);
		await h.session.start();
		await vi.advanceTimersByTimeAsync(60_000);
		h.founderJoin();
		await settle();
		expect(h.session.state).toBe("live");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(h.linearAbort.comment).not.toHaveBeenCalled();
	});

	it("she leaves mid-live → landing runs degraded (confirmed=false), no recap wait", async () => {
		const h = harness();
		await h.session.start();
		h.conv.user("先记一下这个");
		h.founderLeave();
		await settle();
		expect(h.landing.run).toHaveBeenCalledTimes(1);
		const input = h.landing.run.mock.calls[0][0] as { confirmed: boolean };
		expect(input.confirmed).toBe(false);
		expect(h.session.state).toBe("idle");
	});

	it("ears down >60s degrades to concluding; recovery within 60s does not", async () => {
		const h = harness();
		await h.session.start();
		h.earsDown();
		await vi.advanceTimersByTimeAsync(59_000);
		h.earsUp();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(h.session.state).toBe("live"); // recovered — still живой
		h.earsDown();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.session.state).toBe("concluding");
		expect(h.conv.sentTexts.some((t) => t.includes("收音"))).toBe(true);
	});

	it("speaker wiring: cancelled→flush, tool-call→earcon, next audio→resolved", async () => {
		const h = harness();
		await h.session.start();
		h.conv.emitter.emit("response-started");
		h.conv.emitter.emit("tool-call", {
			callId: "c1",
			name: "lookup_issue",
			args: {},
		});
		h.conv.emitter.emit("response-audio", Buffer.from("a"), {});
		h.conv.emitter.emit("response-cancelled");
		expect(h.speaker.calls).toEqual([
			"beginTurn",
			"noteToolCall",
			"noteToolResolved",
			"feed",
			"flush",
		]);
	});

	it("a failed landing still tears down and surfaces the error", async () => {
		const h = harness();
		h.landing.run.mockResolvedValue({
			ok: false,
			stage: "comment",
			message: "纪要没写进 issue",
		} as never);
		await h.session.start();
		h.conv.user("结束");
		await settle();
		h.conv.assistant("recap……对吗?");
		h.conv.user("对");
		await settle();
		expect(h.tiv.error).toHaveBeenCalledWith(
			expect.stringContaining("纪要没写进 issue"),
		);
		expect(h.session.state).toBe("idle");
		expect(h.slot.acquire("meet", "x").ok).toBe(true);
	});

	it("stale briefing is surfaced on open", async () => {
		const h = harness({
			briefing: {
				compose: () => ({
					text: "old",
					generatedAt: "2026-07-07T10:00:00.000Z",
					stale: true,
				}),
			},
		});
		await h.session.start();
		expect(h.tiv.status).toHaveBeenCalledWith(
			expect.stringContaining("简报可能滞后"),
		);
	});
});

/**
 * FLY-1065 P5 — interrupted plumb-through, the landing flush ordering (Codex
 * R1 #1 blocker: close BEFORE landing.run so the close-flush residuals are in
 * the JSONL the landing reads), the recap accumulation guard across the state
 * flip (Codex R2 guardrail #1), and the landing card wording.
 */
describe("AssistantSession (FLY-1065 P5)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-09T15:00:00"));
	});
	afterEach(() => vi.useRealTimers());

	it("an interrupted final renders its caption with the (被打断) tail note", async () => {
		const h = harness();
		await h.session.start();
		h.conv.assistant("说到一半", true);
		expect(h.tiv.caption).toHaveBeenCalledWith(
			"assistant",
			"说到一半 (被打断)",
		);
		h.conv.assistant("完整说完");
		expect(h.tiv.caption).toHaveBeenCalledWith("assistant", "完整说完");
	});

	it("an interrupted assistant final during concluding does NOT enter recapText (a half recap she cut off is not the record)", async () => {
		const h = harness();
		await h.session.start();
		h.conv.user("结束");
		await settle();
		expect(h.session.state).toBe("concluding");
		h.conv.assistant("recap 完整段。对吗?");
		h.conv.assistant("被她打断的半句", true);
		h.conv.user("对");
		await settle();
		const input = h.landing.run.mock.calls[0][0] as { recapText: string };
		expect(input.recapText).toContain("recap 完整段");
		expect(input.recapText).not.toContain("被她打断的半句");
	});

	it("landing flush ordering: conv.close() runs BEFORE landing.run; close-flush finals reach quotes AND recap; teardown never double-closes", async () => {
		const h = harness();
		let convClosedWhenLandingRan = false;
		h.landing.run.mockImplementation(async () => {
			convClosedWhenLandingRan = h.conv.closed;
			return { ok: true } as const;
		});
		// the conversation flushes its residual buffers on close (the voice-core
		// C1 behavior) — the fake emits its tails BEFORE resolving, like the real one.
		h.conv.close = async () => {
			h.conv.closed = true;
			h.conv.closeCount++;
			h.conv.user("关门前的最后一句");
			h.conv.assistant("recap 尾巴");
			return undefined;
		};
		await h.session.start();
		h.conv.user("正文引用");
		h.conv.user("结束");
		await settle();
		h.conv.assistant("recap 主体。对吗?");
		h.conv.user("对");
		await settle();
		expect(h.landing.run).toHaveBeenCalledTimes(1);
		expect(convClosedWhenLandingRan).toBe(true); // close preceded landing.run
		const input = h.landing.run.mock.calls[0][0] as {
			recapText: string;
			quotes: { text: string }[];
		};
		expect(input.quotes.map((q) => q.text)).toContain("关门前的最后一句");
		expect(input.recapText).toContain("recap 主体");
		// Codex R2 guardrail: the close-flush assistant final lands in recap even
		// though the state already flipped to landing (closingFromConcluding).
		expect(input.recapText).toContain("recap 尾巴");
		expect(h.conv.closeCount).toBe(1); // teardown saw conv=null, no second close
		expect(h.session.state).toBe("idle");
	});

	it("a close-flush assistant final on a NON-concluding landing (she left mid-live) does NOT invent a recap", async () => {
		const h = harness();
		h.conv.close = async () => {
			h.conv.closed = true;
			h.conv.closeCount++;
			h.conv.assistant("离场时漏出的半截话");
			return undefined;
		};
		await h.session.start();
		h.conv.user("先记一下");
		h.founderLeave();
		await settle();
		const input = h.landing.run.mock.calls[0][0] as { recapText: string };
		expect(input.recapText).not.toContain("离场时漏出的半截话");
	});

	it("the success card names the verbatim record when transcript chunks landed", async () => {
		const h = harness();
		h.landing.run.mockResolvedValue({
			ok: true,
			commentUrl: "https://l/c/9",
			transcriptChunks: 2,
		} as never);
		await h.session.start();
		h.conv.user("结束");
		await settle();
		h.conv.assistant("recap。对吗?");
		h.conv.user("对");
		await settle();
		const card = h.tiv.card.mock.calls[0][0] as string;
		expect(card).toContain("📝 逐字对话记录");
		expect(card).toContain("FLY-1234");
		expect(card).toContain("https://l/c/9");
	});

	it("the success card falls back to the summary-only wording when zero transcript chunks landed (never lies)", async () => {
		const h = harness();
		h.landing.run.mockResolvedValue({
			ok: true,
			transcriptChunks: 0,
		} as never);
		await h.session.start();
		h.conv.user("结束");
		await settle();
		h.conv.user("对");
		await settle();
		const card = h.tiv.card.mock.calls[0][0] as string;
		expect(card).not.toContain("逐字对话记录");
		expect(card).toContain("会议纪要已落");
	});

	it("a stop() during an IN-FLIGHT landing JOINS it, and the shutdown budget signal aborts that same landing (Codex #550 R3)", async () => {
		let resolveLanding!: () => void;
		let captured: { signal?: AbortSignal } | undefined;
		const landing = {
			run: vi.fn((_input: unknown, runOpts?: { signal?: AbortSignal }) => {
				captured = runOpts;
				return new Promise<{ ok: true }>((r) => {
					resolveLanding = () => r({ ok: true });
				});
			}),
		};
		const h = harness({ landing });
		await h.session.start();
		const first = h.session.stop(); // landing begins and HANGS in landing.run
		await settle();
		expect(landing.run).toHaveBeenCalledTimes(1);

		const ctrl = new AbortController();
		const second = h.session.stop({ signal: ctrl.signal }); // daemon shutdown
		await settle();
		// joined the SAME landing — no second landing, no teardown racing it
		expect(landing.run).toHaveBeenCalledTimes(1);
		ctrl.abort();
		expect(captured?.signal?.aborted).toBe(true); // reached the in-flight landing
		resolveLanding();
		await settle();
		await first;
		await second;
	});
});
