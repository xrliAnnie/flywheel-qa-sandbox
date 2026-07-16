/**
 * FLY-545 QA kickback R2 (Annie's real-machine run) — F1: the meeting aborts
 * mid-assembly and never comes back.
 *
 * Two reproducible defects share the fix surface (voice-core, shared with
 * /gemini FLY-1065):
 *  1. `client.live.connect()` has NO retry — the assembly burst (N Discord
 *     voice joins + N Gemini connects in one window) starves the WS and a
 *     single transient abort kills the whole meeting.
 *  2. An UNEXPECTED ws close only emits an error event — TalkSessionRotator
 *     rotates on server goAway (session-expiring) but never on connection
 *     death, so the line stays dead for the rest of the meeting even though
 *     the resume handle is still in memory (QA proved resume recovers it).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveConnectParams } from "../backends/gemini/transport.js";
import { TalkSessionRotator } from "../TalkSessionRotator.js";
import type {
	AudioFormat,
	ConversationEventMap,
	ConversationSession,
	ResumeHandle,
	ScheduleHint,
	ToolResult,
} from "../types.js";
import { VoiceError } from "../types.js";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	session: {
		sendRealtimeInput: vi.fn(),
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

const base: LiveConnectParams = {
	model: "gemini-live-test",
	tools: [],
	asyncFunctionCalling: false,
};

beforeEach(() => {
	vi.useRealTimers();
	mocks.connect.mockReset();
	mocks.session.sendRealtimeInput.mockReset();
});

describe("F1a — connect retries transient aborts with backoff", () => {
	it("a transient abort on first connect is retried and succeeds", async () => {
		mocks.connect
			.mockRejectedValueOnce(new Error("Request aborted"))
			.mockRejectedValueOnce(new Error("socket hang up"))
			.mockResolvedValueOnce(mocks.session);
		const transport = createGenaiTransport({
			apiKey: "k",
			retry: { attempts: 3, baseMs: 1 },
		});
		const conn = await transport.connect(base);
		expect(conn).toBeTruthy();
		expect(mocks.connect).toHaveBeenCalledTimes(3);
	});

	it("exhausted retries surface the last error (no silent hang)", async () => {
		mocks.connect.mockRejectedValue(new Error("Request aborted"));
		const transport = createGenaiTransport({
			apiKey: "k",
			retry: { attempts: 2, baseMs: 1 },
		});
		await expect(transport.connect(base)).rejects.toThrow(/aborted/i);
		expect(mocks.connect).toHaveBeenCalledTimes(2);
	});

	it("a PENDING (never-settling) connect is timed out and retried — the SDK does not reject on ws handshake death (Codex R13)", async () => {
		const orphanClose = vi.fn();
		mocks.connect
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						// settle long after abandonment — the orphan must be closed
						setTimeout(
							() => resolve({ ...mocks.session, close: orphanClose }),
							50,
						);
					}),
			)
			.mockResolvedValueOnce(mocks.session);
		const transport = createGenaiTransport({
			apiKey: "k",
			retry: { attempts: 2, baseMs: 1, attemptTimeoutMs: 10 },
		});
		const conn = await transport.connect(base);
		expect(conn).toBeTruthy();
		expect(mocks.connect).toHaveBeenCalledTimes(2);
		// the abandoned attempt's late session gets closed, never leaked
		await vi.waitFor(() => {
			if (orphanClose.mock.calls.length === 0) throw new Error("not yet");
		});
	});

	it("a REJECTED attempt's late onclose is muted — never a fake connectionClosed into the winner's stream (Codex R15)", async () => {
		let firstCallbacks: any;
		mocks.connect
			.mockImplementationOnce((args: any) => {
				firstCallbacks = args.callbacks;
				return Promise.reject(new Error("Request aborted"));
			})
			.mockResolvedValueOnce(mocks.session);
		const transport = createGenaiTransport({
			apiKey: "k",
			retry: { attempts: 2, baseMs: 1 },
		});
		const conn = await transport.connect(base);
		const events: any[] = [];
		conn.onEvent((e) => events.push(e));
		// the dead first attempt's socket fires a late close
		firstCallbacks.onclose({ reason: "late close from rejected attempt" });
		expect(events.filter((e) => e.connectionClosed)).toHaveLength(0);
	});

	it("default retry is ON (no opts needed) — assembly burst safety net", async () => {
		mocks.connect
			.mockRejectedValueOnce(new Error("Request aborted"))
			.mockResolvedValueOnce(mocks.session);
		const transport = createGenaiTransport({ apiKey: "k" });
		const conn = await transport.connect(base);
		expect(conn).toBeTruthy();
		expect(mocks.connect).toHaveBeenCalledTimes(2);
	});
});

// ---- F1b: rotator auto-reconnects on connection death ----

class FakeSession implements ConversationSession {
	readonly sessionId: string;
	private handlers = new Map<string, ((...a: never[]) => void)[]>();
	closed = false;
	constructor(
		readonly id: string,
		readonly handle?: string,
	) {
		this.sessionId = id;
	}
	sendAudio(_f: Buffer, _fmt: AudioFormat): void {}
	sendText(): void {}
	injectContext(): void {}
	endUserTurn(): void {}
	interrupt(): void {}
	injectToolResult(_r: ToolResult, _s?: ScheduleHint): void {}
	on<E extends keyof ConversationEventMap>(
		e: E,
		h: (...a: ConversationEventMap[E]) => void,
	): () => void {
		const list = this.handlers.get(e as string) ?? [];
		list.push(h as (...a: never[]) => void);
		this.handlers.set(e as string, list);
		return () => {};
	}
	emit<E extends keyof ConversationEventMap>(
		e: E,
		...a: ConversationEventMap[E]
	): void {
		for (const h of this.handlers.get(e as string) ?? [])
			(h as (...x: unknown[]) => void)(...a);
	}
	async close(): Promise<ResumeHandle | undefined> {
		this.closed = true;
		return this.handle
			? { backendId: "gemini-live", payload: this.handle }
			: undefined;
	}
}

describe("F1b — rotator rotates (resumes) on connection-closed errors", () => {
	it("connection-closed error → close old (handle) → create resumed successor", async () => {
		const s1 = new FakeSession("s1", "resume-1");
		const s2 = new FakeSession("s2");
		const create = vi
			.fn<(h?: ResumeHandle) => Promise<ConversationSession>>()
			.mockResolvedValueOnce(s1)
			.mockResolvedValueOnce(s2);
		const reconnected: boolean[] = [];
		const rot = new TalkSessionRotator({
			create,
			attach: () => {},
			onReconnected: (resumed) => reconnected.push(resumed),
		});
		await rot.start();
		s1.emit(
			"error",
			new VoiceError("connection-closed", "ws closed unexpectedly"),
		);
		await vi.waitFor(() => {
			if (create.mock.calls.length < 2) throw new Error("not yet");
		});
		expect(create.mock.calls[1]?.[0]).toEqual({
			backendId: "gemini-live",
			payload: "resume-1",
		});
		expect(s1.closed).toBe(true);
		await vi.waitFor(() => {
			if (reconnected.length === 0) throw new Error("not yet");
		});
		expect(reconnected).toEqual([true]);
	});

	it("non-connection errors do NOT rotate (tool failures etc. stay put)", async () => {
		const s1 = new FakeSession("s1");
		const create = vi.fn().mockResolvedValue(s1);
		const rot = new TalkSessionRotator({ create, attach: () => {} });
		await rot.start();
		s1.emit("error", new VoiceError("subprocess-failed", "brain died"));
		await new Promise((r) => setTimeout(r, 10));
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("closed rotator ignores late connection-closed (no zombie reconnect)", async () => {
		const s1 = new FakeSession("s1", "h");
		const create = vi.fn().mockResolvedValue(s1);
		const rot = new TalkSessionRotator({ create, attach: () => {} });
		await rot.start();
		await rot.close();
		s1.emit("error", new VoiceError("connection-closed", "late"));
		await new Promise((r) => setTimeout(r, 10));
		expect(create).toHaveBeenCalledTimes(1);
	});
});

describe("F1c (QA R5) — onDown fires when a death-reconnect starts", () => {
	it("connection-closed → onDown fires BEFORE the successor exists (the truthful 'down' moment)", async () => {
		const s1 = new FakeSession("s1", "h1");
		const s2 = new FakeSession("s2");
		const events: string[] = [];
		const create = vi
			.fn<(h?: ResumeHandle) => Promise<ConversationSession>>()
			.mockImplementationOnce(async () => s1)
			.mockImplementationOnce(async () => {
				events.push("create-successor");
				return s2;
			});
		const rot = new TalkSessionRotator({
			create,
			attach: () => {},
			onDown: () => events.push("down"),
			onReconnected: () => events.push("reconnected"),
		});
		await rot.start();
		s1.emit("error", new VoiceError("connection-closed", "ws aborted"));
		await vi.waitFor(() => {
			if (!events.includes("reconnected")) throw new Error("not yet");
		});
		expect(events).toEqual(["down", "create-successor", "reconnected"]);
	});

	it("a graceful goAway rotation does NOT fire onDown (planned, sub-second — no scare cue)", async () => {
		const s1 = new FakeSession("s1", "h1");
		const s2 = new FakeSession("s2");
		const create = vi
			.fn<(h?: ResumeHandle) => Promise<ConversationSession>>()
			.mockResolvedValueOnce(s1)
			.mockResolvedValueOnce(s2);
		const downs: number[] = [];
		const rot = new TalkSessionRotator({
			create,
			attach: () => {},
			onDown: () => downs.push(1),
		});
		await rot.start();
		s1.emit("session-expiring", { inSec: 50 });
		await vi.waitFor(() => {
			if (create.mock.calls.length < 2) throw new Error("not yet");
		});
		expect(downs).toHaveLength(0);
	});

	it("a late error from an already-rotated-out session does not fire onDown again", async () => {
		const s1 = new FakeSession("s1", "h1");
		const s2 = new FakeSession("s2");
		const create = vi
			.fn<(h?: ResumeHandle) => Promise<ConversationSession>>()
			.mockResolvedValueOnce(s1)
			.mockResolvedValueOnce(s2);
		const downs: number[] = [];
		const rot = new TalkSessionRotator({
			create,
			attach: () => {},
			onDown: () => downs.push(1),
		});
		await rot.start();
		s1.emit("error", new VoiceError("connection-closed", "ws aborted"));
		await vi.waitFor(() => {
			if (create.mock.calls.length < 2) throw new Error("not yet");
		});
		s1.emit("error", new VoiceError("connection-closed", "late duplicate"));
		await new Promise((r) => setTimeout(r, 10));
		expect(downs).toHaveLength(1);
	});
});
