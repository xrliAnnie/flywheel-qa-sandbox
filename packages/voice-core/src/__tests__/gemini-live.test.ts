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
	audioStreamEnds = 0;
	sendAudio(frame: Buffer): void {
		this.sentAudio.push(frame);
	}
	sendText(): void {}
	endAudioStream(): void {
		this.audioStreamEnds++;
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

	it("endUserTurn commits the turn via audioStreamEnd (FLY-967 round-6: Discord silence-suppression gives no trailing silence)", async () => {
		const { session, conn } = await makeSession();
		session.endUserTurn();
		session.endUserTurn();
		expect(conn.audioStreamEnds).toBe(2);
	});

	it("threads bargeIn to the transport (default true; explicit false honored)", async () => {
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({ transport, profile: profile() });
		const create = (
			backend.createConversation as NonNullable<
				typeof backend.createConversation
			>
		).bind(backend);
		await create({ brain: new FakeBrain([]) });
		expect(transport.lastConnection?.params.bargeIn).toBe(true);
		await create({ brain: new FakeBrain([]), bargeIn: false });
		expect(transport.lastConnection?.params.bargeIn).toBe(false);
	});

	it("a sendText-initiated model turn fires response-started BEFORE its audio (FLY-967 round-4: the opening was gated dead in the speaker)", async () => {
		const { session, conn } = await makeSession();
		const order: string[] = [];
		session.on("response-started", () => order.push("started"));
		session.on("response-audio", () => order.push("audio"));
		// NO user transcript — the turn was initiated by a sendText control
		// prompt (the /gemini opening). The old mapping only opened a response
		// window on user transcripts, so the speaker never saw beginTurn and
		// dropped every opening chunk.
		conn.emit({ type: "audio", chunk: Buffer.from("PCM"), format: PCM });
		conn.emit({ type: "audio", chunk: Buffer.from("PCM"), format: PCM });
		conn.emit({ type: "turn-complete" });
		expect(order).toEqual(["started", "audio", "audio"]);
	});

	it("response-started fires exactly once per model turn and re-fires for the next turn", async () => {
		const { session, conn } = await makeSession();
		const counts = counter(session);
		conn.emit({ type: "audio", chunk: Buffer.from("A"), format: PCM });
		conn.emit({ type: "audio", chunk: Buffer.from("B"), format: PCM });
		conn.emit({ type: "turn-complete" });
		conn.emit({ type: "audio", chunk: Buffer.from("C"), format: PCM });
		conn.emit({ type: "turn-complete" });
		expect(counts["response-started"]).toBe(2);
		expect(counts["response-done"]).toBe(2);
	});

	it("an assistant transcript arriving before any audio also opens the response window", async () => {
		const { session, conn } = await makeSession();
		const counts = counter(session);
		conn.emit({
			type: "transcript",
			role: "assistant",
			text: "开场",
			final: false,
		});
		expect(counts["response-started"]).toBe(1);
	});

	it("a turn-complete with no model output emits no response-done (nothing began)", async () => {
		const { session, conn } = await makeSession();
		const counts = counter(session);
		conn.emit({ type: "turn-complete" });
		expect(counts["response-done"]).toBeUndefined();
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
		const askLead = conn.params.tools.find((t) => t.name === "ask_lead");
		expect(askLead).toBeDefined();
		conn.emit({ type: "resumption-update", handle: "handle-def" });
		const handle = await session.close();
		expect(conn.closed).toBe(true);
		expect(handle).toEqual({ backendId: "gemini-live", payload: "handle-def" });
	});

	it("declares ask_lead with description + parameters schema (FLY-959 bug 3)", async () => {
		const { conn } = await makeSession();
		const tool = conn.params.tools[0];
		expect(tool.name).toBe("ask_lead");
		expect(tool.description).toMatch(/project/i);
		expect(tool.parameters).toMatchObject({
			type: "OBJECT",
			required: ["question"],
		});
		expect(
			(tool.parameters as { properties: Record<string, unknown> }).properties,
		).toHaveProperty("question");
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

/**
 * FLY-1065 P2 — turn aggregation. Transport fragments are deltas; the session
 * aggregates per role and emits ONE final:true per turn side, flushed by a
 * priority chain proven on the real model (evidence/finished-flag-probe.md):
 * finished fast path (kept for model upgrades) → first assistant output
 * flushes the user turn → generation-complete flushes the assistant turn →
 * turn-complete is the last-resort flush. The empty-buffer gate makes any
 * signal combination emit at most one final per side.
 */
describe("GeminiLiveBackend turn aggregation (FLY-1065)", () => {
	async function makeAggSession() {
		const sink = new MemoryTranscriptSink();
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({ transport, profile: profile() });
		const session = await (
			backend.createConversation as NonNullable<
				typeof backend.createConversation
			>
		)({ brain: new FakeBrain([]), transcriptSink: sink });
		const finals: {
			role: string;
			text: string;
			final: boolean;
			interrupted?: boolean;
		}[] = [];
		const fragments: { role: string; text: string }[] = [];
		session.on("transcript", (t) => {
			if (t.final) finals.push(t);
			else fragments.push({ role: t.role, text: t.text });
		});
		return {
			session,
			conn: transport.lastConnection as FakeConnection,
			sink,
			finals,
			fragments,
		};
	}

	const frag = (
		role: "user" | "assistant",
		text: string,
		finished?: boolean,
	): LiveServerEvent => ({
		type: "transcript",
		role,
		text,
		final: false,
		...(finished === undefined ? {} : { finished }),
	});

	it("finished fast path: fragments aggregate into ONE final with the full text; sink gets one row", async () => {
		const { conn, finals, sink } = await makeAggSession();
		conn.emit(frag("user", "今天"));
		conn.emit(frag("user", "聊转写"));
		conn.emit(frag("user", "面板", true));
		expect(finals).toEqual([
			{ role: "user", text: "今天聊转写面板", final: true },
		]);
		expect(sink.entries).toHaveLength(1);
		expect(sink.entries[0]).toMatchObject({
			role: "user",
			text: "今天聊转写面板",
			final: true,
		});
	});

	it("fragments still pass through as final:false events (consumers unchanged)", async () => {
		const { conn, fragments } = await makeAggSession();
		conn.emit(frag("user", "第一"));
		conn.emit(frag("user", "第二"));
		expect(fragments).toEqual([
			{ role: "user", text: "第一" },
			{ role: "user", text: "第二" },
		]);
	});

	it("first assistant output (transcript fragment) flushes the user turn — captions must not wait ~10s for turn-complete", async () => {
		const { conn, finals } = await makeAggSession();
		conn.emit(frag("user", "她的整句话"));
		conn.emit(frag("assistant", "模型开始答"));
		expect(finals).toEqual([{ role: "user", text: "她的整句话", final: true }]);
	});

	it("first assistant AUDIO chunk also flushes the user turn", async () => {
		const { conn, finals } = await makeAggSession();
		conn.emit(frag("user", "audio 先到的场景"));
		conn.emit({ type: "audio", chunk: Buffer.from("A"), format: PCM });
		expect(finals).toEqual([
			{ role: "user", text: "audio 先到的场景", final: true },
		]);
	});

	it("generation-complete flushes the assistant turn; the later turn-complete adds NO second final", async () => {
		const { conn, finals } = await makeAggSession();
		conn.emit(frag("user", "问题"));
		conn.emit(frag("assistant", "答案 part 1,"));
		conn.emit(frag("assistant", "part 2"));
		conn.emit({ type: "generation-complete" });
		conn.emit({ type: "turn-complete" });
		expect(finals).toEqual([
			{ role: "user", text: "问题", final: true },
			{ role: "assistant", text: "答案 part 1,part 2", final: true },
		]);
	});

	it("turn-complete is the last-resort flush: no finished / generation-complete → one final per side, user first", async () => {
		const { conn, finals } = await makeAggSession();
		conn.emit(frag("user", "只有兜底"));
		conn.emit({ type: "turn-complete" });
		expect(finals).toEqual([{ role: "user", text: "只有兜底", final: true }]);
		conn.emit(frag("user", "第二轮"));
		conn.emit(frag("assistant", "回话"));
		conn.emit({ type: "turn-complete" });
		expect(finals.slice(1)).toEqual([
			{ role: "user", text: "第二轮", final: true },
			{ role: "assistant", text: "回话", final: true },
		]);
	});

	it("multi-signal arrival never double-emits: finished + generation-complete + turn-complete → at most one final per side", async () => {
		const { conn, finals } = await makeAggSession();
		conn.emit(frag("user", "全信号", true));
		conn.emit(frag("assistant", "答话", true));
		conn.emit({ type: "generation-complete" });
		conn.emit({ type: "turn-complete" });
		expect(finals).toEqual([
			{ role: "user", text: "全信号", final: true },
			{ role: "assistant", text: "答话", final: true },
		]);
	});

	it("interrupted flushes the half-said assistant turn WITH interrupted:true, before response-cancelled; sink row carries interrupted", async () => {
		const { conn, finals, sink, session } = await makeAggSession();
		const order: string[] = [];
		session.on("response-cancelled", () => order.push("cancelled"));
		session.on("transcript", (t) => {
			if (t.final) order.push(`final:${t.role}`);
		});
		conn.emit(frag("user", "她问"));
		conn.emit(frag("assistant", "说到一半"));
		conn.emit({ type: "interrupted" });
		const assistantFinal = finals.find((f) => f.role === "assistant");
		expect(assistantFinal).toMatchObject({
			text: "说到一半",
			final: true,
			interrupted: true,
		});
		expect(order.indexOf("final:assistant")).toBeLessThan(
			order.indexOf("cancelled"),
		);
		const row = sink.entries.find((e) => e.role === "assistant");
		expect(row).toMatchObject({ text: "说到一半", interrupted: true });
		// suppression still holds after the flush
		conn.emit(frag("assistant", "late"));
		expect(finals.filter((f) => f.role === "assistant")).toHaveLength(1);
	});

	it("manual interrupt() also flushes the half-said assistant turn with interrupted:true", async () => {
		const { conn, finals, session } = await makeAggSession();
		conn.emit(frag("user", "她问"));
		conn.emit(frag("assistant", "半句"));
		session.interrupt();
		expect(finals.find((f) => f.role === "assistant")).toMatchObject({
			text: "半句",
			interrupted: true,
		});
	});

	it("an interrupted flush after generation-complete already flushed is a no-op (she interrupted playback; text was complete)", async () => {
		const { conn, finals } = await makeAggSession();
		conn.emit(frag("user", "问"));
		conn.emit(frag("assistant", "完整答案"));
		conn.emit({ type: "generation-complete" });
		conn.emit({ type: "interrupted" });
		const assistantFinals = finals.filter((f) => f.role === "assistant");
		expect(assistantFinals).toHaveLength(1);
		expect(assistantFinals[0].interrupted).toBeUndefined();
	});

	it("same-frame interrupted + fragment: the fragment is appended BEFORE the flush (connector emits transcript first)", async () => {
		// session-level half of the Codex R1 #5 contract: given the connector's
		// transcript-before-interrupted order, the flush carries the last half-line.
		const { conn, finals } = await makeAggSession();
		conn.emit(frag("assistant", "同帧前半"));
		conn.emit(frag("assistant", "同帧后半"));
		conn.emit({ type: "interrupted" });
		expect(finals.find((f) => f.role === "assistant")).toMatchObject({
			text: "同帧前半同帧后半",
			interrupted: true,
		});
	});

	it("close() flushes both residual buffers (rotator rotation must not lose tails)", async () => {
		const { conn, finals, sink, session } = await makeAggSession();
		conn.emit(frag("user", "user 残余"));
		conn.emit(frag("assistant", "assistant 残余"));
		await session.close();
		expect(finals).toEqual([
			{ role: "user", text: "user 残余", final: true },
			{ role: "assistant", text: "assistant 残余", final: true },
		]);
		expect(sink.entries).toHaveLength(2);
		expect(conn.closed).toBe(true);
	});

	it("scrub applies at the final exit; fragment passthrough is NOT scrubbed (documented v1 boundary)", async () => {
		const { conn, finals, fragments, sink } = await makeAggSession();
		conn.emit(frag("user", "key 是 sk-AbCdEfGhIjKlMnOp1234 别外传", true));
		expect(fragments[0].text).toContain("sk-AbCdEfGhIjKlMnOp1234");
		expect(finals[0].text).not.toContain("sk-AbCdEfGhIjKlMnOp1234");
		expect(finals[0].text).toContain("[redacted]");
		expect(sink.entries[0].text).toContain("[redacted]");
	});

	it("sendText control prompts never enter the aggregation or the sink", async () => {
		const { session, conn, finals, sink } = await makeAggSession();
		session.sendText("控制提示(她听不到):请开场。");
		conn.emit({ type: "turn-complete" });
		await session.close();
		expect(finals).toEqual([]);
		expect(sink.entries).toEqual([]);
	});

	it("barge-in with her new words in the SAME frame as interrupted: the next model answer is NOT suppressed and both finals land (delta R1 blocker)", async () => {
		const { conn, finals } = await makeAggSession();
		// old assistant turn in flight
		conn.emit(frag("user", "第一问"));
		conn.emit(frag("assistant", "旧答案说到一半"));
		// she barges in — the connector delivers, in order: interrupted first,
		// THEN her new words (role-aware frame ordering), with NO turn-complete
		// in between (the cancelled generation never completes).
		conn.emit({ type: "interrupted" });
		conn.emit(frag("user", "等等,换个问题"));
		// the model answers her new utterance
		conn.emit(frag("assistant", "好,新答案"));
		conn.emit({ type: "generation-complete" });
		expect(finals).toEqual([
			{ role: "user", text: "第一问", final: true },
			{
				role: "assistant",
				text: "旧答案说到一半",
				final: true,
				interrupted: true,
			},
			{ role: "user", text: "等等,换个问题", final: true },
			{ role: "assistant", text: "好,新答案", final: true },
		]);
	});

	it("interrupted frame carrying OLD audio + her new words: the cancelled audio never plays and never opens the next window (delta R2)", async () => {
		const { session, conn, finals } = await makeAggSession();
		const events: string[] = [];
		session.on("response-audio", () => events.push("audio"));
		session.on("response-started", () => events.push("started"));
		// old turn in flight
		conn.emit(frag("user", "第一问"));
		conn.emit(frag("assistant", "旧半句"));
		events.length = 0; // only observe from the barge-in on
		// the barge-in frame, in connector order: interrupted → old audio → her new words
		conn.emit({ type: "interrupted" });
		conn.emit({ type: "audio", chunk: Buffer.from("OLD"), format: PCM });
		conn.emit(frag("user", "换个问题"));
		expect(events).toEqual([]); // old audio dropped; no window reopened on it
		// the REAL new answer opens the window, flushes her new turn, and lands
		conn.emit({ type: "audio", chunk: Buffer.from("NEW"), format: PCM });
		conn.emit(frag("assistant", "新答案"));
		conn.emit({ type: "generation-complete" });
		expect(events).toEqual(["started", "audio"]);
		expect(finals.slice(-2)).toEqual([
			{ role: "user", text: "换个问题", final: true },
			{ role: "assistant", text: "新答案", final: true },
		]);
	});

	it("an unexpected transport error does not flush by itself; the owner's close() is the contracted drain (connection-died sequence)", async () => {
		const { session, conn, finals, sink } = await makeAggSession();
		conn.emit(frag("user", "说到一半连接死了"));
		conn.emit({ type: "error", message: "ws dropped" });
		expect(finals).toEqual([]); // error alone never fabricates a final
		await session.close(); // AssistantSession teardown / rotator rotation path
		expect(finals).toEqual([
			{ role: "user", text: "说到一半连接死了", final: true },
		]);
		expect(sink.entries).toHaveLength(1);
	});
});
