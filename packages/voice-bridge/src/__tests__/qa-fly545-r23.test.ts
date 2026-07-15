/**
 * Codex R23 regressions (QA R3 fix set):
 *  ① NO_INTERRUPTION + manual interrupt: cancellation persists until the OLD
 *    server turn truly closes — a new user fragment must not reopen the gate
 *    and let the interrupted answer's late audio replay.
 *  ② the e2e reply classifier is not fooled by cue/filler audio (cue-only
 *    turns FAIL).
 *  ③ a graceful (goAway) rotation never fires onReconnected — the hard
 *    mouth-flush/turn-reset recovery is bound to connection death only.
 *  ④ FLYWHEEL_HUDDLE_BARGE_MIN_RMS=0 (gate off) is a legal config.
 */
import type {
	ConversationSession,
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
	LiveServerEvent,
	ResumeHandle,
} from "flywheel-voice-core";
import { GeminiLiveBackend, TalkSessionRotator } from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain .mjs module shared with the e2e injector
import {
	CUE_BUDGET_BYTES,
	classifyReplyBytes,
	MIN_REPLY_BYTES,
} from "../../e2e/reply-classifier.mjs";
import { resolveHuddleBridgeConfig } from "../config.js";

class FakeConnection implements LiveConnection {
	lastParams?: LiveConnectParams;
	toolResponses: [string, string][] = [];
	private cb?: (e: LiveServerEvent) => void;
	sendAudio(): void {}
	sendText(): void {}
	endAudioStream(): void {}
	sendToolResponse(callId: string, output: string): void {
		this.toolResponses.push([callId, output]);
	}
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
	async connect(p: LiveConnectParams): Promise<LiveConnection> {
		this.last = new FakeConnection();
		this.last.lastParams = p;
		return this.last;
	}
}

async function session(bargeIn: boolean) {
	const transport = new FakeTransport();
	const backend = new GeminiLiveBackend({
		transport,
		profile: { model: "gemini-live-test", asyncFunctionCalling: false },
	});
	const s = await backend.createConversation({
		brain: { async *respond() {} },
		bargeIn,
	});
	const audio: Buffer[] = [];
	s.on("response-audio", (chunk) => audio.push(chunk));
	return { s, conn: transport.last as FakeConnection, audio };
}

const fmt = { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 } as const;
const chunk = () => ({
	type: "audio" as const,
	chunk: Buffer.alloc(4),
	format: fmt,
});

describe("① NO_INTERRUPTION: interrupt survives a new user fragment", () => {
	it("late audio of the interrupted answer stays muted; the NEXT turn plays", async () => {
		const { conn, s, audio } = await session(false);
		expect(conn.lastParams?.bargeIn).toBe(false);
		// turn 1 streams …
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "旧",
			final: false,
		});
		conn.emit(chunk());
		expect(audio).toHaveLength(1);
		// … she barges in (our ears gate) → manual interrupt
		s.interrupt();
		// her new words arrive while the server (NO_INTERRUPTION) keeps talking
		conn.emit({
			type: "transcript",
			role: "user",
			text: "新问题",
			final: false,
		});
		conn.emit(chunk()); // late audio of the interrupted answer
		expect(audio).toHaveLength(1); // ← the R23 replay bug: this leaked
		// the old server turn finally closes → next turn is clean and audible
		conn.emit({ type: "generation-complete" });
		conn.emit({ type: "turn-complete" });
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "答",
			final: false,
		});
		conn.emit(chunk());
		expect(audio).toHaveLength(2);
	});

	it("interrupts-ON keeps the legacy contract (user turn reopens the window)", async () => {
		const { conn, s, audio } = await session(true);
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "旧",
			final: false,
		});
		conn.emit(chunk());
		s.interrupt();
		conn.emit({ type: "transcript", role: "user", text: "新", final: false });
		conn.emit(chunk());
		expect(audio).toHaveLength(2); // server killed the old answer itself
	});
});

describe("① NO_INTERRUPTION: cancelled tool calls still get responses (R24)", () => {
	it("in-flight + late tool calls are answered so the old turn can close; the next answer plays", async () => {
		let releaseBrain: (() => void) | undefined;
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({
			transport,
			profile: { model: "gemini-live-test", asyncFunctionCalling: false },
		});
		const s = await backend.createConversation({
			brain: {
				async *respond(_t, opts) {
					await new Promise<void>((res) => {
						releaseBrain = res;
						opts.signal.addEventListener("abort", () => res());
					});
					yield "late";
				},
			},
			bargeIn: false,
		});
		const conn = transport.last as FakeConnection;
		const audio: Buffer[] = [];
		s.on("response-audio", (c) => audio.push(c));
		// model calls ask_lead (in-flight, brain hanging) …
		conn.emit({ type: "tool-call", callId: "c1", name: "ask_lead", args: {} });
		// … she barges in → manual interrupt while the tool is pending
		s.interrupt();
		expect(conn.toolResponses).toEqual([
			["c1", expect.stringContaining("cancelled")],
		]);
		releaseBrain?.();
		// a LATE tool call of the cancelled generation is answered too
		conn.emit({ type: "tool-call", callId: "c2", name: "ask_lead", args: {} });
		expect(conn.toolResponses).toHaveLength(2);
		expect(conn.toolResponses[1]?.[0]).toBe("c2");
		// the old turn can now close server-side → the next answer is audible
		conn.emit({ type: "generation-complete" });
		conn.emit({ type: "turn-complete" });
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "答",
			final: false,
		});
		conn.emit({ type: "audio", chunk: Buffer.alloc(4), format: fmt });
		expect(audio).toHaveLength(1);
	});

	it("interrupts-ON keeps the no-response cancellation contract", async () => {
		const { conn, s } = await session(true);
		conn.emit({ type: "tool-call", callId: "c1", name: "ask_lead", args: {} });
		s.interrupt();
		conn.emit({ type: "tool-call", callId: "c2", name: "ask_lead", args: {} });
		expect(conn.toolResponses).toEqual([]);
	});
});

describe("② reply classifier vs cues", () => {
	it("cue-sized audio is cue-only (the earcon alone used to score REPLIED)", () => {
		expect(classifyReplyBytes(26_880)).toBe("cue-only"); // 140ms earcon
		expect(classifyReplyBytes(CUE_BUDGET_BYTES)).toBe("cue-only");
		expect(classifyReplyBytes(0)).toBe("silent");
		expect(classifyReplyBytes(MIN_REPLY_BYTES)).toBe("replied");
	});
});

describe("③ graceful rotation ≠ reconnect", () => {
	it("a goAway-style rotation never fires onReconnected", async () => {
		const sessions: ConversationSession[] = [];
		const make = (): ConversationSession => ({
			sendAudio() {},
			sendText() {},
			injectContext() {},
			endUserTurn() {},
			interrupt() {},
			injectToolResult() {},
			on: () => () => {},
			async close(): Promise<ResumeHandle | undefined> {
				return undefined;
			},
		});
		const onReconnected = vi.fn();
		const rot = new TalkSessionRotator({
			create: async () => {
				const s = make();
				sessions.push(s);
				return s;
			},
			attach: () => {},
			onReconnected,
		});
		await rot.start();
		await rot.rotate(sessions[0] as ConversationSession); // graceful (no reconnect flag)
		expect(sessions).toHaveLength(2);
		expect(onReconnected).not.toHaveBeenCalled();
	});
});

describe("④ noise-gate config accepts 0", () => {
	const env = {
		HUDDLE_ORCH_BOT_TOKEN: "t",
		HUDDLE_EARS_BOT_TOKEN: "t",
		TADASHI_BOT_TOKEN: "t",
		FLYWHEEL_API_TOKEN: "t",
		DISCORD_OWNER_USER_ID: "u",
		GEMINI_API_KEY: "g",
	};
	const project = () => ({
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "eng",
				chatChannel: "chan-1",
				match: { labels: ["Flywheel"] },
				botTokenEnv: "TADASHI_BOT_TOKEN",
			},
		],
		huddle: {
			guildId: "g-1",
			voiceChannelId: "vc-1",
			orchestratorBotTokenEnv: "HUDDLE_ORCH_BOT_TOKEN",
			earsBotTokenEnv: "HUDDLE_EARS_BOT_TOKEN",
		},
	});
	it("0 disables the floor instead of crashing the daemon", () => {
		const cfg = resolveHuddleBridgeConfig([project()], {
			...env,
			FLYWHEEL_HUDDLE_BARGE_MIN_RMS: "0",
		});
		expect(cfg.bargeInMinRms).toBe(0);
	});
	it("negative still refuses", () => {
		expect(() =>
			resolveHuddleBridgeConfig([project()], {
				...env,
				FLYWHEEL_HUDDLE_BARGE_MIN_RMS: "-5",
			}),
		).toThrow(/non-negative/);
	});
});

describe("R28 — close() drains the sink and late events stay silent", () => {
	it("a late server event during the close drain never appends past the snapshot", async () => {
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({
			transport,
			profile: { model: "gemini-live-test", asyncFunctionCalling: false },
		});
		const entries: string[] = [];
		let release: (() => void) | undefined;
		const slowSink = {
			append: (e: { text: string }) => void entries.push(e.text),
			flush: () =>
				new Promise<void>((res) => {
					release = res;
				}),
		};
		const s = await backend.createConversation({
			brain: { async *respond() {} },
			transcriptSink: slowSink as never,
		});
		const conn = transport.last as FakeConnection;
		conn.emit({
			type: "transcript",
			role: "user",
			text: "before",
			final: false,
		});
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "答",
			final: false,
		});
		const closing = s.close(); // flushes finals, then awaits the slow drain
		const atSnapshot = entries.length;
		// LATE events arrive while close is awaiting the drain
		conn.emit({ type: "transcript", role: "user", text: "late", final: false });
		conn.emit({ type: "generation-complete" });
		conn.emit({ type: "turn-complete" });
		// … but a late resumption handle is GOLD (Codex R29): docs don't
		// guarantee one precedes GoAway — close() must still return it.
		conn.emit({ type: "resumption-update", handle: "late-handle" });
		release?.();
		const handle = await closing;
		expect(entries.length).toBe(atSnapshot); // nothing appended past the snapshot
		expect(entries.join("|")).not.toContain("late");
		expect(handle).toEqual({
			backendId: "gemini-live",
			payload: "late-handle",
		});
	});
});
