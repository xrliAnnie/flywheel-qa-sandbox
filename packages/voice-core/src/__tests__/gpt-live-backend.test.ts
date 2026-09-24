import { describe, expect, it, vi } from "vitest";
import type { OpenAiLiveConversationSession } from "../backends/openai-live/GptLiveBackend.js";
import { GptLiveBackend } from "../backends/openai-live/GptLiveBackend.js";
import type { OpenAiLiveSocket } from "../backends/openai-live/LiveSession.js";
import type { OpenAiLiveClientEvent } from "../backends/openai-live/liveProtocol.js";
import {
	type BrainAdapter,
	type ConversationOptions,
	VoiceError,
} from "../types.js";

class FakeSocket implements OpenAiLiveSocket {
	readonly sent: OpenAiLiveClientEvent[] = [];
	private messageHandler: (raw: string | Buffer) => void = () => {};

	send(event: OpenAiLiveClientEvent): void {
		this.sent.push(event);
	}

	onMessage(handler: (raw: string | Buffer) => void): () => void {
		this.messageHandler = handler;
		return () => {
			this.messageHandler = () => {};
		};
	}

	onClose(_handler: (error?: Error) => void): () => void {
		return () => {};
	}

	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}

	close(): void {}

	receive(event: Record<string, unknown>): void {
		this.messageHandler(JSON.stringify(event));
	}

	started(generation = 1): void {
		this.receive({
			type: "session.started",
			session: {
				id: `live-${generation}`,
				model: "gpt-live-1",
				status: "active",
				audio: { format: { type: "audio/pcm", rate: 24_000 } },
				delegation: { type: "client" },
			},
		});
	}
}

const brain: BrainAdapter = {
	async *respond() {
		yield "unused";
	},
};

const conversationOptions: ConversationOptions = {
	brain,
	systemPreamble: "You are the foreground voice for Lead Tadashi.",
	systemHint: "Keep answers concise.",
};

describe("GptLiveBackend", () => {
	it("opens a configured session that answers simply and delegates complex work", async () => {
		const sockets: FakeSocket[] = [];
		const backend = new GptLiveBackend({
			model: "gpt-live-1",
			voice: "marin",
			transport: {
				connect: async () => {
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
			},
		});

		const opening = backend.createConversation(conversationOptions);
		const observedOpening = opening.catch((error) => error);
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const start = sockets[0]?.sent[0];
		expect(start).toMatchObject({
			type: "session.start",
			session: {
				model: "gpt-live-1",
				audio: { output: { voice: "marin" } },
				delegation: { type: "client" },
			},
		});
		if (start?.type !== "session.start")
			throw new Error("missing session.start");
		expect(start.session.instructions).toContain("answer simple questions");
		expect(start.session.instructions).toContain("我问下 Lead");
		expect(start.session.instructions).toContain(
			conversationOptions.systemPreamble,
		);

		sockets[0]?.started();
		const session = await observedOpening;
		expect(session).toMatchObject({ sessionId: expect.any(String) });
	});

	it("rejects input audio outside the negotiated PCM16 mono 24 kHz format", async () => {
		const socket = new FakeSocket();
		const backend = new GptLiveBackend({
			model: "gpt-live-1",
			voice: "marin",
			transport: { connect: async () => socket },
		});
		const opening = backend.createConversation(conversationOptions);
		await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
		socket.started();
		const session = await opening;

		expect(() =>
			session.sendAudio(Buffer.from([1, 2]), {
				encoding: "pcm16",
				sampleRateHz: 16_000,
				channels: 1,
			}),
		).toThrow(/PCM16 mono 24 kHz/);
	});

	it("streams frontend audio, retains partial transcripts, and exposes client delegation", async () => {
		const socket = new FakeSocket();
		const backend = new GptLiveBackend({
			model: "gpt-live-1",
			voice: "marin",
			transport: { connect: async () => socket },
		});
		const opening = backend.createConversation(conversationOptions);
		await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
		socket.started();
		const session = (await opening) as OpenAiLiveConversationSession;
		const responseStarted = vi.fn();
		const responseAudio = vi.fn();
		const transcripts = vi.fn();
		const delegations = vi.fn();
		const liveTranscripts = vi.fn();
		session.on("response-started", responseStarted);
		session.on("response-audio", responseAudio);
		session.on("transcript", transcripts);
		session.on("delegation-created", delegations);
		session.onLiveTranscript(liveTranscripts);

		for (const text of ["first", "second"]) {
			socket.receive({
				type: "session.output_audio.delta",
				delta: Buffer.from(text).toString("base64"),
			});
		}
		socket.receive({
			type: "session.input_transcript.delta",
			event_id: "transcript-1",
			start_ms: 10,
			end_ms: 20,
			delta: "请查一下",
		});
		socket.receive({
			type: "session.delegation.created",
			offset_ms: 20,
			delegation: { id: "delegation-1", type: "delegation", target: "client" },
		});

		expect(responseStarted).toHaveBeenCalledOnce();
		expect(responseAudio.mock.calls.map(([chunk]) => chunk.toString())).toEqual(
			["first", "second"],
		);
		expect(transcripts).toHaveBeenCalledWith({
			role: "user",
			text: "请查一下",
			final: false,
		});
		expect(delegations).toHaveBeenCalledWith({
			delegationId: "delegation-1",
			generation: 1,
			offsetMs: 20,
			target: "client",
		});
		expect(liveTranscripts).toHaveBeenCalledWith({
			type: "transcript-delta",
			direction: "input",
			eventId: "transcript-1",
			startMs: 10,
			endMs: 20,
			delta: "请查一下",
			generation: 1,
		});
	});

	it("can suspend without reconnecting, then resume a fresh provider generation", async () => {
		const sockets: FakeSocket[] = [];
		const backend = new GptLiveBackend({
			model: "gpt-live-1",
			voice: "marin",
			transport: {
				connect: async () => {
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
			},
		});
		const opening = backend.createConversation(conversationOptions);
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0]?.started(1);
		const session = await opening;

		const suspended = session.suspend("announcer-takeover");
		sockets[0]?.receive({ type: "session.closed" });
		await expect(suspended).resolves.toMatchObject({
			generation: 1,
			finalization: "provider_connection_closed",
		});
		expect(sockets).toHaveLength(1);

		const resumed = session.resume();
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		sockets[1]?.started(2);
		await expect(resumed).resolves.toBe(2);
	});

	it("reports effective suppression while fencing late audio across interrupt", async () => {
		const sockets: FakeSocket[] = [];
		const backend = new GptLiveBackend({
			model: "gpt-live-1",
			voice: "marin",
			transport: {
				connect: async () => {
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
			},
		});
		const opening = backend.createConversation(conversationOptions);
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0]?.started(1);
		const session = await opening;
		const effective = session as unknown as {
			readonly effectiveCapabilities: {
				turnCancelOrSuppress: boolean;
			};
		};
		const audio = vi.fn();
		const cancelled = vi.fn();
		session.on("response-audio", audio);
		session.on("response-cancelled", cancelled);
		expect(effective.effectiveCapabilities.turnCancelOrSuppress).toBe(true);

		const replacing = session.replaceAfterBargeIn();
		expect(effective.effectiveCapabilities.turnCancelOrSuppress).toBe(false);
		expect(cancelled).toHaveBeenCalledOnce();
		sockets[0]?.receive({
			type: "session.output_audio.delta",
			delta: Buffer.from("late").toString("base64"),
		});
		expect(audio).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(sockets[0]?.sent.at(-1)?.type).toBe("session.close"),
		);
		sockets[0]?.receive({ type: "session.closed" });
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		sockets[1]?.started(2);
		await expect(replacing).resolves.toBe(2);
		expect(effective.effectiveCapabilities.turnCancelOrSuppress).toBe(true);
	});

	it("rejects silent context above the configured per-event token ceiling", async () => {
		const socket = new FakeSocket();
		const backend = new GptLiveBackend({
			model: "gpt-live-1",
			voice: "marin",
			contextMaxTokens: 5,
			transport: { connect: async () => socket },
		});
		const opening = backend.createConversation(conversationOptions);
		await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
		socket.started();
		const session = await opening;

		expect(() => session.injectContext("123456")).toThrow(
			/context exceeds.*5-token/i,
		);
		expect(socket.sent).toHaveLength(1);
	});

	it("reports a failed replacement connection instead of dropping its rejection", async () => {
		const socket = new FakeSocket();
		let attempts = 0;
		const backend = new GptLiveBackend({
			model: "gpt-live-1",
			voice: "marin",
			transport: {
				connect: async () => {
					attempts += 1;
					if (attempts === 1) return socket;
					throw new VoiceError(
						"connection-closed",
						"语音不可用: replacement connection failed",
					);
				},
			},
		});
		const opening = backend.createConversation(conversationOptions);
		await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
		socket.started();
		const session = await opening;
		const errors = vi.fn();
		session.on("error", errors);

		session.interrupt();
		await vi.waitFor(() =>
			expect(socket.sent.at(-1)?.type).toBe("session.close"),
		);
		socket.receive({ type: "session.closed" });
		await vi.waitFor(() => expect(attempts).toBe(2));
		await vi.waitFor(() =>
			expect(errors).toHaveBeenCalledWith(
				expect.objectContaining({
					code: "connection-closed",
					message: expect.stringContaining("语音不可用"),
				}),
			),
		);
	});
});
