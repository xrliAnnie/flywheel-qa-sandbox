/**
 * FLY-1006 S6 — ElevenWs contract tests (TDD: written before the client).
 * Fully offline via the voice-core transport-injection convention: fetch and
 * the WS constructor are injected seams. Pins the FLY-980 real-machine
 * findings: mandatory unique custom_llm_extra_body.conversation_id (the
 * platform sends NO session identity by default — shim keying collapses
 * without it), platform ping→pong (long sessions flake without it), and the
 * pcm_24000/pcm_16000 metadata runtime gate (fail-loud, never garble).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ElevenWs, type WsLike } from "../eleven/ElevenWs.js";

class FakeWs extends EventEmitter implements WsLike {
	sent: string[] = [];
	closed = 0;
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed++;
	}
	open(): void {
		this.emit("open");
	}
	message(obj: unknown): void {
		this.emit("message", Buffer.from(JSON.stringify(obj)));
	}
	frames(): Record<string, unknown>[] {
		return this.sent.map((s) => JSON.parse(s));
	}
}

function makeClient(over: Record<string, unknown> = {}) {
	const ws = new FakeWs();
	const fetchCalls: { url: string; headers: Record<string, string> }[] = [];
	const events = {
		audio: [] as Buffer[],
		interruptions: 0,
		userTx: [] as string[],
		agentTx: [] as string[],
		meta: [] as unknown[],
		errors: [] as string[],
		closes: [] as number[],
	};
	const client = new ElevenWs({
		agentId: "agent_test",
		apiKey: "xi-key-test",
		conversationId: "vc-conv-1",
		overrides: { voiceId: "voice-1", prompt: "persona text" },
		aggregateMs: 150,
		fetchImpl: (async (url: unknown, init?: RequestInit) => {
			fetchCalls.push({
				url: String(url),
				headers: (init?.headers ?? {}) as Record<string, string>,
			});
			return Response.json({ signed_url: "wss://fake/ws" });
		}) as typeof fetch,
		wsFactory: () => ws,
		onAudio: (b) => events.audio.push(b),
		onInterruption: () => events.interruptions++,
		onUserTranscript: (t) => events.userTx.push(t),
		onAgentResponse: (t) => events.agentTx.push(t),
		onMetadata: (m) => events.meta.push(m),
		onError: (e) => events.errors.push(e.message),
		onClose: (code) => events.closes.push(code),
		...over,
	});
	return { client, ws, fetchCalls, events };
}

describe("ElevenWs (FLY-1006 S6)", () => {
	it("connect: signed-url via key header; init frame carries override + NON-EMPTY conversation_id", async () => {
		const { client, ws, fetchCalls } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.open();
		await connected;

		expect(fetchCalls[0].url).toContain("agent_id=agent_test");
		expect(fetchCalls[0].headers["xi-api-key"]).toBe("xi-key-test");

		const init = ws.frames()[0];
		expect(init.type).toBe("conversation_initiation_client_data");
		expect(init.conversation_config_override).toMatchObject({
			tts: { voice_id: "voice-1" },
			agent: { prompt: { prompt: "persona text" } },
		});
		const extra = init.custom_llm_extra_body as { conversation_id: string };
		expect(extra.conversation_id).toBe("vc-conv-1");
		expect(extra.conversation_id.length).toBeGreaterThan(0);
	});

	it("empty conversation_id is a construction error (shim keying collapses without it)", () => {
		expect(() => makeClient({ conversationId: "" })).toThrow(/conversation/i);
	});

	it("platform ping → pong with the echoed event_id", async () => {
		const { client, ws } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.open();
		await connected;
		ws.message({ type: "ping", ping_event: { event_id: 42 } });
		const pong = ws.frames().find((f) => f.type === "pong");
		expect(pong).toMatchObject({ type: "pong", event_id: 42 });
	});

	it("sendAudio aggregates ~aggregateMs of 16k s16le before one user_audio_chunk; flushAudio sends the remainder", async () => {
		const { client, ws } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.open();
		await connected;

		// 150ms @16k s16le = 4800 bytes; 20ms frames are 640 bytes each
		const frame = Buffer.alloc(640, 7);
		for (let i = 0; i < 7; i++) client.sendAudio(frame); // 4480 < 4800 — buffered
		expect(ws.frames().filter((f) => f.user_audio_chunk)).toHaveLength(0);
		client.sendAudio(frame); // 5120 ≥ 4800 → flush
		const chunks = ws.frames().filter((f) => f.user_audio_chunk);
		expect(chunks).toHaveLength(1);
		expect(
			Buffer.from(chunks[0].user_audio_chunk as string, "base64").length,
		).toBe(5120);

		client.sendAudio(Buffer.alloc(100, 3));
		client.flushAudio();
		const after = ws.frames().filter((f) => f.user_audio_chunk);
		expect(after).toHaveLength(2);
		expect(
			Buffer.from(after[1].user_audio_chunk as string, "base64").length,
		).toBe(100);
		client.flushAudio(); // empty — no extra frame
		expect(ws.frames().filter((f) => f.user_audio_chunk)).toHaveLength(2);
	});

	it("audio_event decodes base64 → onAudio; transcripts and interruption route", async () => {
		const { client, ws, events } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.open();
		await connected;

		const pcm = Buffer.from([1, 2, 3, 4]);
		ws.message({
			type: "audio",
			audio_event: { audio_base_64: pcm.toString("base64") },
		});
		expect(events.audio[0].equals(pcm)).toBe(true);

		ws.message({
			type: "user_transcript",
			user_transcription_event: { user_transcript: "你好" },
		});
		ws.message({
			type: "agent_response",
			agent_response_event: { agent_response: "嗨" },
		});
		ws.message({ type: "interruption", interruption_event: { event_id: 9 } });
		expect(events.userTx).toEqual(["你好"]);
		expect(events.agentTx).toEqual(["嗨"]);
		expect(events.interruptions).toBe(1);
	});

	it("metadata gate: pcm_24000/pcm_16000 → onMetadata; anything else = fail-loud error + close", async () => {
		const ok = makeClient();
		const c1 = ok.client.connect();
		await new Promise((r) => setImmediate(r));
		ok.ws.open();
		await c1;
		ok.ws.message({
			type: "conversation_initiation_metadata",
			conversation_initiation_metadata_event: {
				conversation_id: "conv_x",
				agent_output_audio_format: "pcm_24000",
				user_input_audio_format: "pcm_16000",
			},
		});
		expect(ok.events.meta).toHaveLength(1);
		expect(ok.events.errors).toHaveLength(0);

		const bad = makeClient();
		const c2 = bad.client.connect();
		await new Promise((r) => setImmediate(r));
		bad.ws.open();
		await c2;
		bad.ws.message({
			type: "conversation_initiation_metadata",
			conversation_initiation_metadata_event: {
				conversation_id: "conv_y",
				agent_output_audio_format: "ulaw_8000",
				user_input_audio_format: "pcm_16000",
			},
		});
		expect(bad.events.errors[0]).toMatch(/ulaw_8000/);
		expect(bad.ws.closed).toBeGreaterThan(0);
	});

	it("close is idempotent and post-close traffic is ignored", async () => {
		const { client, ws, events } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.open();
		await connected;
		client.close();
		client.close();
		expect(ws.closed).toBe(1);
		ws.message({
			type: "audio",
			audio_event: { audio_base_64: Buffer.from([1]).toString("base64") },
		});
		expect(events.audio).toHaveLength(0);
		expect(() => client.sendAudio(Buffer.alloc(640))).not.toThrow();
	});

	it("signed-url failure rejects connect with a key-free error", async () => {
		const { client } = makeClient({
			fetchImpl: (async () =>
				Response.json({ detail: "nope" }, { status: 500 })) as typeof fetch,
		});
		await expect(client.connect()).rejects.toThrow(/signed-url/i);
		await expect(client.connect()).rejects.not.toThrow(/xi-key-test/);
	});

	// Codex code review R1 HIGH: connect() only awaited "open" — a pre-open
	// error/close fired the callbacks but left the promise pending forever,
	// wedging the shared VC slot (the command acquires it before startSession
	// awaits connect). Both pre-open failure paths must REJECT.
	it("pre-open ws error rejects connect (slot-wedge guard)", async () => {
		const { client, ws, events } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.emit("error", new Error("boom"));
		await expect(connected).rejects.toThrow(/before open|boom/i);
		expect(events.errors.length).toBeGreaterThan(0);
	});

	it("pre-open ws close rejects connect (slot-wedge guard)", async () => {
		const { client, ws } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.emit("close", 1008);
		await expect(connected).rejects.toThrow(/closed before open/i);
	});

	it("post-open error/close do NOT disturb an already-resolved connect", async () => {
		const { client, ws, events } = makeClient();
		const connected = client.connect();
		await new Promise((r) => setImmediate(r));
		ws.open();
		await connected;
		ws.emit("close", 1000);
		expect(events.closes).toEqual([1000]);
	});
});
