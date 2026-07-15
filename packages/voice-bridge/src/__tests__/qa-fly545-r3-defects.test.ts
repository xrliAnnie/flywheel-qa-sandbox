/**
 * FLY-545 QA R3 (Annie's second real-machine run) — the five /glaw defects:
 * ① defensive brain timeout ② truthful presence + stall watchdog ③ default
 * audio cues ④ noise-gated barge-in + Gemini VAD pinned off ⑤ post-reconnect
 * conversation recovery (zombie mouth + huddle turn reset).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDefaultCues, renderToneWav } from "../audio/defaultCues.js";
import { EarsReceiver } from "../audio/EarsReceiver.js";
import { GeminiTurnMouth } from "../audio/GeminiTurnMouth.js";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import { type HuddleLine, HuddleSession } from "../huddle/HuddleSession.js";
import {
	createReadOnlyLeadBrain,
	DEFAULT_HUDDLE_BRAIN_TIMEOUT_MS,
} from "../huddle/ReadOnlyLeadBrain.js";

class FakeLine implements HuddleLine {
	session = {
		sendAudio: () => {},
		sendText: () => {},
		injectContext: () => {},
		interrupt: () => {},
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

function huddle(overrides?: { thinkingWatchdogMs?: number }) {
	const eng = new FakeLine("eng", "Tadashi");
	const presences: [string, string | undefined][] = [];
	const warns: string[] = [];
	const h = new HuddleSession({
		issue: { id: "u1", identifier: "FLY-1", url: "https://l/1" },
		hostLeadId: "eng",
		lines: [eng],
		router: new AddressRouter([{ leadId: "eng", aliases: [] }], "eng"),
		feed: new FeedPipeline(),
		ladder: { notifyFounderUtterance: vi.fn() },
		tiv: {
			presence: (s, d) => void presences.push([s, d]),
			caption: () => {},
			warn: (t) => void warns.push(t),
		},
		conclusion: {
			land: vi.fn(async () => "landed" as const),
			abortNoShow: vi.fn(async () => {}),
		},
		onTeardown: vi.fn(),
		assembleTimeoutMs: 600_000,
		...overrides,
	});
	h.start();
	h.handleFounderVoiceState(true);
	return { h, eng, presences, warns };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("⑤ post-reconnect recovery", () => {
	it("beginTurn destroys a zombie stream from a dead turn — next turn plays FRESH", () => {
		const plays: unknown[] = [];
		const stop = vi.fn();
		const mouth = new GeminiTurnMouth({
			player: { play: (r) => void plays.push(r), stop, on: () => {} },
			createResource: (s) => s,
			upsample: (b) => b,
		});
		mouth.beginTurn();
		mouth.feed(Buffer.alloc(4)); // turn 1 stream created
		// connection dies mid-turn: NO endTurn. Next turn begins.
		mouth.beginTurn();
		mouth.feed(Buffer.alloc(4));
		expect(plays).toHaveLength(2); // fresh stream + fresh play, not the zombie
		expect(stop).toHaveBeenCalled();
	});

	it("handleLineReconnected clears the dead speaker/turn and shows listening", () => {
		const { h, presences } = huddle();
		h.handleLineTranscript("eng", { role: "user", text: "说说", final: true });
		h.handleLineResponseStarted("eng"); // eng is streaming
		h.handleLineReconnected("eng");
		expect(presences.at(-1)?.[0]).toBe("listening");
		// a NEW turn is fully audible: response events flow again
		h.handleLineTranscript("eng", { role: "user", text: "再说", final: true });
		h.handleLineResponseStarted("eng");
		expect(presences.at(-1)?.[0]).toBe("speaking");
	});
});

describe("② truthful presence + stall watchdog", () => {
	it("live fragments show 识别中 (the 说完→字出现 gap is visible)", () => {
		const { h, presences } = huddle();
		h.handleLineTranscript("eng", { role: "user", text: "内存", final: false });
		expect(presences.at(-1)).toEqual(["listening", "识别中…"]);
	});

	it("a stalled wait past the watchdog says so; model progress silences it", async () => {
		const { h, warns } = huddle({ thinkingWatchdogMs: 5_000 });
		h.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(5_100);
		expect(warns.some((w) => w.includes("等得比平时久"))).toBe(true);
		// next round: real progress before the window → no second warning
		const warnCount = warns.length;
		h.handleFounderSpeechStopped();
		h.handleLineTranscript("eng", { role: "user", text: "好", final: true });
		h.handleLineResponseStarted("eng");
		await vi.advanceTimersByTimeAsync(6_000);
		expect(warns.length).toBe(warnCount);
	});
});

describe("① defensive brain timeout (the 7-min freeze bound)", () => {
	it("the huddle brain always has a bounded per-turn timeout", () => {
		const brain = createReadOnlyLeadBrain({
			claudeBin: "claude",
			identityFile: "/tmp/id.md",
			projectRoot: "/tmp",
		});
		expect(
			(brain as unknown as { opts: { timeoutMs?: number } }).opts.timeoutMs,
		).toBe(DEFAULT_HUDDLE_BRAIN_TIMEOUT_MS);
	});
});

describe("④ noise-gated barge-in", () => {
	function ears(minRms: number) {
		const handlers = new Map<string, (id: string) => void>();
		const bargeIns: string[] = [];
		const receiver = new EarsReceiver({
			speaking: { on: (e, cb) => void handlers.set(e, cb) },
			subscribe: () =>
				({
					pipe: (d: unknown) => d,
					on: () => {},
					destroy: () => {},
				}) as never,
			createDecoder: () => {
				const listeners: ((b: Buffer) => void)[] = [];
				return {
					pipe: (d: unknown) => d,
					on: (ev: string, cb: (b: Buffer) => void) => {
						if (ev === "data") listeners.push(cb);
					},
					emitPcm: (b: Buffer) => {
						for (const l of listeners) l(b);
					},
					destroy: () => {},
				} as never;
			},
			isHuman: () => true,
			backchannelMs: 100,
			bargeInMinRms: minRms,
			onFrame: () => {},
			onBargeIn: (id) => void bargeIns.push(id),
		});
		receiver.attach();
		return { handlers, bargeIns, receiver };
	}
	function frame(amplitude: number): Buffer {
		// 48k stereo s16le input; downmix passes energy through
		const b = Buffer.alloc(1920 * 4);
		for (let i = 0; i < b.length; i += 2) b.writeInt16LE(amplitude, i);
		return b;
	}

	it("sustained QUIET sound (footsteps) never barges in; sustained SPEECH does", async () => {
		const { handlers, bargeIns, receiver } = ears(700);
		const caps = (
			receiver as unknown as {
				captures: Map<string, { decoder: { emitPcm: (b: Buffer) => void } }>;
			}
		).captures;
		handlers.get("start")?.("u1");
		caps.get("u1")?.decoder.emitPcm(frame(80)); // room tone
		await vi.advanceTimersByTimeAsync(150);
		expect(bargeIns).toEqual([]); // quiet burst re-armed, no interrupt
		caps.get("u1")?.decoder.emitPcm(frame(8000)); // real voice energy
		await vi.advanceTimersByTimeAsync(150);
		expect(bargeIns).toEqual(["u1"]);
	});

	it("floor=0 keeps the legacy duration-only gate", async () => {
		const { handlers, bargeIns } = ears(0);
		handlers.get("start")?.("u1");
		await vi.advanceTimersByTimeAsync(150);
		expect(bargeIns).toEqual(["u1"]);
	});
});

describe("③ default cues", () => {
	it("renders valid single-header WAVs and is idempotent", async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "cues-"));
		try {
			const a = ensureDefaultCues(dir);
			const b = ensureDefaultCues(dir);
			expect(a.earconPath).toBe(b.earconPath);
			for (const p of [a.earconPath, a.fillerPath]) {
				const wav = readFileSync(p);
				expect(wav.subarray(0, 4).toString()).toBe("RIFF");
				expect(wav.subarray(8, 12).toString()).toBe("WAVE");
				// exactly ONE data chunk (no concatenated headers)
				expect(wav.indexOf("RIFF", 4)).toBe(-1);
				expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tone renderer honors multi-segment sequences in one file", () => {
		const wav = renderToneWav(
			{ freqHz: 587, ms: 50 },
			{ freqHz: 0, ms: 20 },
			{ freqHz: 784, ms: 50 },
		);
		expect(wav.readUInt32LE(40)).toBe(48 * 120 * 4); // 120ms of 48k stereo s16
	});
});
