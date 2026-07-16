/**
 * FLY-545 PR-2 — ConversationSession.injectContext (silent context feed).
 *
 * The huddle's gated multi-session orchestration feeds meeting context to the
 * NON-addressed sessions. The feed must be SILENT: FLY-968 measured that
 * sendRealtimeInput({ text }) breaks silence on gemini-3.1 (the model answers
 * it), while sendClientContent(turnComplete: false) injects 0 bytes of speech
 * and the facts stay quotable. So injectContext is a SEPARATE channel from
 * sendText (the speech-triggering control prompt) — the two must never be
 * conflated. Nothing is written to the transcript sink for injected context:
 * these are minutes the session is being caught up on, not new conversation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GeminiLiveBackend,
	type GeminiModelProfile,
} from "../backends/gemini/GeminiLiveBackend.js";
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
	LiveServerEvent,
} from "../backends/gemini/transport.js";
import { TalkSessionRotator } from "../TalkSessionRotator.js";
import type { AudioFormat, ConversationSession } from "../types.js";
import { FakeBrain } from "./fakes.js";

// ---------- connector level: real genaiConnector against mocked @google/genai

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	session: {
		sendRealtimeInput: vi.fn(),
		sendClientContent: vi.fn(),
		sendToolResponse: vi.fn(),
		close: vi.fn(),
	},
}));

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		live = { connect: mocks.connect };
	},
	Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
}));

import { createGenaiTransport } from "../backends/gemini/genaiConnector.js";

const baseParams: LiveConnectParams = {
	model: "gemini-live-test",
	tools: [],
	asyncFunctionCalling: false,
};

beforeEach(() => {
	mocks.connect.mockReset();
	mocks.session.sendRealtimeInput.mockReset();
	mocks.session.sendClientContent.mockReset();
	mocks.connect.mockResolvedValue(mocks.session);
});

describe("genaiConnector.injectContext — silent client-content frame", () => {
	it("sends sendClientContent with turnComplete:false (the FLY-968 silent path)", async () => {
		const transport = createGenaiTransport({ apiKey: "test-key" });
		const conn = await transport.connect(baseParams);
		conn.injectContext("[会议记录] Annie: 发布时间定在周五下午三点。");
		expect(mocks.session.sendClientContent).toHaveBeenCalledWith({
			turns: [
				{
					role: "user",
					parts: [{ text: "[会议记录] Annie: 发布时间定在周五下午三点。" }],
				},
			],
			turnComplete: false,
		});
	});

	it("never routes through sendRealtimeInput (that path breaks silence)", async () => {
		const transport = createGenaiTransport({ apiKey: "test-key" });
		const conn = await transport.connect(baseParams);
		conn.injectContext("上下文");
		expect(mocks.session.sendRealtimeInput).not.toHaveBeenCalled();
	});

	it("sendText keeps its realtime frame (the channels stay distinct)", async () => {
		const transport = createGenaiTransport({ apiKey: "test-key" });
		const conn = await transport.connect(baseParams);
		conn.sendText("请做 recap");
		expect(mocks.session.sendRealtimeInput).toHaveBeenCalledWith({
			text: "请做 recap",
		});
		expect(mocks.session.sendClientContent).not.toHaveBeenCalled();
	});
});

// ---------- backend level: session forwards + transcript sink stays untouched

class FakeConnection implements LiveConnection {
	injected: string[] = [];
	texts: string[] = [];
	private cb?: (e: LiveServerEvent) => void;
	constructor(readonly params: LiveConnectParams) {}
	sendAudio(): void {}
	sendText(text: string): void {
		this.texts.push(text);
	}
	injectContext(text: string): void {
		this.injected.push(text);
	}
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
	lastConnection?: FakeConnection;
	async connect(params: LiveConnectParams): Promise<LiveConnection> {
		this.lastConnection = new FakeConnection(params);
		return this.lastConnection;
	}
}

const profile: GeminiModelProfile = {
	model: "gemini-3.1-flash-live-preview",
	asyncFunctionCalling: true,
};

describe("GeminiLiveSession.injectContext", () => {
	it("forwards to the connection and never writes the transcript sink", async () => {
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({ transport, profile });
		const sink = { write: vi.fn(), close: vi.fn() };
		const session = await backend.createConversation({
			brain: new FakeBrain(["hi"]),
			transcriptSink: sink,
		});
		session.injectContext("[会议记录] Tadashi: 底盘已经 merge。");
		const conn = transport.lastConnection;
		expect(conn?.injected).toEqual(["[会议记录] Tadashi: 底盘已经 merge。"]);
		expect(conn?.texts).toEqual([]);
		expect(sink.write).not.toHaveBeenCalled();
	});
});

// ---------- rotator level: forward to the current session, drop mid-rotation

class FakeSession implements ConversationSession {
	readonly sessionId: string;
	injected: string[] = [];
	constructor(id: string) {
		this.sessionId = id;
	}
	sendAudio(_f: Buffer, _fmt: AudioFormat): void {}
	sendText(): void {}
	injectContext(text: string): void {
		this.injected.push(text);
	}
	interrupt(): void {}
	injectToolResult(): void {}
	on(): () => void {
		return () => {};
	}
	async close(): Promise<undefined> {
		return undefined;
	}
}

describe("TalkSessionRotator.injectContext forwarding", () => {
	it("reaches the current session; a no-session drop returns FALSE (the caller's cursor must hold — Codex R1 HIGH)", async () => {
		const s1 = new FakeSession("s1");
		const rotator = new TalkSessionRotator({
			create: async () => s1,
			attach: () => {},
		});
		expect(rotator.injectContext("尚未 start — 丢弃但必须报告")).toBe(false);
		await rotator.start();
		expect(rotator.injectContext("给 s1 的会议记录")).toBe(true);
		expect(s1.injected).toEqual(["给 s1 的会议记录"]);
	});
});
