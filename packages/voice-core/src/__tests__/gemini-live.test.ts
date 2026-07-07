import { describe, expect, it } from "vitest";
import {
	deriveCapabilities,
	GeminiLiveBackend,
	type GeminiModelProfile,
} from "../backends/gemini/GeminiLiveBackend.js";
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
	LiveServerEvent,
} from "../backends/gemini/transport.js";
import { MemoryTranscriptSink } from "../transcript.js";
import type { AudioFormat, ConversationEventMap } from "../types.js";
import { FakeBrain } from "./fakes.js";

const PCM: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 16_000,
	channels: 1,
};

class FakeConnection implements LiveConnection {
	sentAudio: Buffer[] = [];
	toolResponses: { callId: string; output: string }[] = [];
	closed = false;
	private cb?: (e: LiveServerEvent) => void;
	constructor(readonly params: LiveConnectParams) {}
	sendAudio(frame: Buffer): void {
		this.sentAudio.push(frame);
	}
	sendToolResponse(callId: string, output: string): void {
		this.toolResponses.push({ callId, output });
	}
	onEvent(cb: (e: LiveServerEvent) => void): void {
		this.cb = cb;
	}
	emit(e: LiveServerEvent): void {
		this.cb?.(e);
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeTransport implements GeminiLiveTransport {
	lastConnection?: FakeConnection;
	async connect(params: LiveConnectParams): Promise<LiveConnection> {
		this.lastConnection = new FakeConnection(params);
		return this.lastConnection;
	}
}

const profile = (
	over: Partial<GeminiModelProfile> = {},
): GeminiModelProfile => ({
	model: "gemini-live-2.5-flash-preview",
	asyncFunctionCalling: false,
	connectionSec: 600,
	audioSec: 900,
	...over,
});

function counter(session: {
	on: (e: keyof ConversationEventMap, h: () => void) => () => void;
}) {
	const counts: Partial<Record<keyof ConversationEventMap, number>> = {};
	for (const e of [
		"response-audio",
		"response-done",
		"response-cancelled",
		"response-started",
		"session-expiring",
		"tool-call",
		"error",
	] as (keyof ConversationEventMap)[]) {
		session.on(e, () => {
			counts[e] = (counts[e] ?? 0) + 1;
		});
	}
	return counts;
}

describe("deriveCapabilities (model-derived, not hardcoded)", () => {
	it("converse-only, streaming, barge-in, resumable", () => {
		const c = deriveCapabilities(profile());
		expect(c.announce).toBe(false);
		expect(c.converse).toBe(true);
		expect(c.bargeIn).toBe(true);
		expect(c.supportsResume).toBe(true);
		expect(c.sessionLimits).toEqual({ connectionSec: 600, audioSec: 900 });
	});
	it("scheduled tool calls only when the model supports async fn calling", () => {
		expect(
			deriveCapabilities(profile({ asyncFunctionCalling: true }))
				.toolCallScheduling,
		).toBe("scheduled");
		expect(
			deriveCapabilities(profile({ asyncFunctionCalling: false }))
				.toolCallScheduling,
		).toBe("basic");
	});
});

describe("GeminiLiveBackend converse face", () => {
	async function makeSession(
		brain = new FakeBrain([]),
		sink?: MemoryTranscriptSink,
		resumeHandle?: string,
	) {
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({ transport, profile: profile() });
		const session = await (
			backend.createConversation as NonNullable<
				typeof backend.createConversation
			>
		)({
			brain,
			transcriptSink: sink,
			resumeHandle: resumeHandle
				? { backendId: "gemini-live", payload: resumeHandle }
				: undefined,
		});
		return { session, conn: transport.lastConnection as FakeConnection };
	}

	it("maps server events onto the unified vocabulary + writes final transcripts", async () => {
		const sink = new MemoryTranscriptSink();
		const { session, conn } = await makeSession(new FakeBrain([]), sink);
		const counts = counter(session);
		conn.emit({ type: "transcript", role: "user", text: "hi", final: true });
		conn.emit({ type: "audio", chunk: Buffer.from("PCM"), format: PCM });
		conn.emit({ type: "go-away", timeLeftSec: 30 });
		conn.emit({ type: "turn-complete" });
		expect(counts["response-started"]).toBe(1); // user turn opened a response window
		expect(counts["response-audio"]).toBe(1);
		expect(counts["session-expiring"]).toBe(1);
		expect(counts["response-done"]).toBe(1);
		expect(sink.entries).toHaveLength(1);
		expect(sink.entries[0]).toMatchObject({
			face: "converse",
			role: "user",
			backendId: "gemini-live",
		});
	});

	it("surfaces the brain via ask_lead and sends the answer back", async () => {
		const { session, conn } = await makeSession(
			new FakeBrain(["The answer ", "is 42."]),
		);
		void session;
		conn.emit({
			type: "tool-call",
			callId: "c1",
			name: "ask_lead",
			args: { question: "?" },
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(conn.toolResponses).toEqual([
			{ callId: "c1", output: "The answer is 42." },
		]);
	});

	it("server barge-in (interrupted) cancels the turn and suppresses later assistant output", async () => {
		const { session, conn } = await makeSession();
		const counts = counter(session);
		const assistantTs: string[] = [];
		session.on("transcript", (t) => {
			if (t.role === "assistant") assistantTs.push(t.text);
		});
		conn.emit({ type: "transcript", role: "user", text: "hey", final: true });
		conn.emit({ type: "audio", chunk: Buffer.from("A"), format: PCM });
		conn.emit({ type: "interrupted" });
		conn.emit({ type: "audio", chunk: Buffer.from("B"), format: PCM }); // dropped
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "late",
			final: true,
		}); // dropped
		expect(counts["response-cancelled"]).toBe(1);
		expect(counts["response-audio"]).toBe(1); // only the pre-cancel chunk
		expect(assistantTs).toEqual([]); // no assistant transcript after cancel
	});

	it("manual interrupt() is local suppression (emits response-cancelled)", async () => {
		const { session, conn } = await makeSession();
		const counts = counter(session);
		conn.emit({ type: "transcript", role: "user", text: "hey", final: true });
		session.interrupt();
		conn.emit({ type: "audio", chunk: Buffer.from("B"), format: PCM }); // dropped
		expect(counts["response-cancelled"]).toBe(1);
		expect(counts["response-audio"]).toBe(undefined);
	});

	it("drops a late tool-call arriving after manual interrupt (no run, no response)", async () => {
		const brain = new FakeBrain(["should never run"]);
		const { session, conn } = await makeSession(brain);
		const toolCalls: string[] = [];
		session.on("tool-call", (t) => toolCalls.push(t.callId));
		conn.emit({ type: "transcript", role: "user", text: "hey", final: true });
		session.interrupt();
		conn.emit({
			type: "tool-call",
			callId: "late-1",
			name: "ask_lead",
			args: { question: "?" },
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(toolCalls).toEqual([]); // not even emitted
		expect(conn.toolResponses).toHaveLength(0); // no function-response for a dead turn
	});

	it("drops a late tool-call arriving after server barge-in; next user turn flows again", async () => {
		const { session, conn } = await makeSession(new FakeBrain(["answer"]));
		void session;
		conn.emit({ type: "transcript", role: "user", text: "hey", final: true });
		conn.emit({ type: "interrupted" });
		conn.emit({
			type: "tool-call",
			callId: "late-2",
			name: "ask_lead",
			args: { question: "?" },
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(conn.toolResponses).toHaveLength(0);
		// a new user turn resets the cancel window — tool calls run again
		conn.emit({ type: "transcript", role: "user", text: "again", final: true });
		conn.emit({
			type: "tool-call",
			callId: "fresh",
			name: "ask_lead",
			args: { question: "?" },
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(conn.toolResponses).toEqual([{ callId: "fresh", output: "answer" }]);
	});

	it("tool-call-cancellation aborts an in-flight ask_lead (no response sent)", async () => {
		const { session, conn } = await makeSession(
			new FakeBrain([], { hangUntilAbort: true }),
		);
		void session;
		conn.emit({
			type: "tool-call",
			callId: "c9",
			name: "ask_lead",
			args: { question: "?" },
		});
		await new Promise((r) => setTimeout(r, 5));
		conn.emit({ type: "tool-call-cancellation", callIds: ["c9"] });
		await new Promise((r) => setTimeout(r, 10));
		expect(conn.toolResponses).toHaveLength(0); // aborted → no function-response
	});

	it("passes resume handle at connect and returns the latest on close", async () => {
		const { session, conn } = await makeSession(
			new FakeBrain([]),
			undefined,
			"handle-abc",
		);
		expect(conn.params.resumeHandle).toBe("handle-abc");
		expect(conn.params.toolNames).toContain("ask_lead");
		conn.emit({ type: "resumption-update", handle: "handle-def" });
		const handle = await session.close();
		expect(conn.closed).toBe(true);
		expect(handle).toEqual({ backendId: "gemini-live", payload: "handle-def" });
	});

	it("rejects a resume handle from a different backend", async () => {
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({ transport, profile: profile() });
		await expect(
			(
				backend.createConversation as NonNullable<
					typeof backend.createConversation
				>
			)({
				brain: new FakeBrain([]),
				resumeHandle: { backendId: "edge-tts", payload: "x" },
			}),
		).rejects.toMatchObject({ code: "unsupported" });
	});
});
