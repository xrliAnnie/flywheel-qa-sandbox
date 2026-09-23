import { describe, expect, it, vi } from "vitest";
import { GenerationFence } from "../backends/openai-live/generationFence.js";
import {
	LiveSession,
	type OpenAiLiveSocket,
} from "../backends/openai-live/LiveSession.js";
import type {
	OpenAiLiveClientEvent,
	OpenAiLiveSessionConfig,
} from "../backends/openai-live/liveProtocol.js";
import type { VoiceError } from "../types.js";

class FakeSocket implements OpenAiLiveSocket {
	readonly sent: OpenAiLiveClientEvent[] = [];
	closed = 0;
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

	close(): void {
		this.closed += 1;
	}

	receive(event: Record<string, unknown>): void {
		this.messageHandler(JSON.stringify(event));
	}
}

const config: OpenAiLiveSessionConfig = {
	model: "gpt-live-1",
	instructions: "Answer simple questions and delegate work.",
	voice: "marin",
	delegation: "client",
	audio: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
};

function makeSession(generation = 1): {
	session: LiveSession;
	socket: FakeSocket;
	fence: GenerationFence;
} {
	const socket = new FakeSocket();
	const fence = new GenerationFence();
	fence.activate(generation);
	let id = 0;
	const session = new LiveSession({
		generation,
		config,
		fence,
		socket,
		nextEventId: () => `client-${++id}`,
	});
	return { session, socket, fence };
}

function started(socket: FakeSocket): void {
	socket.receive({
		type: "session.started",
		session: {
			id: "live_123",
			model: "gpt-live-1",
			status: "active",
			audio: { format: { type: "audio/pcm", rate: 24_000 } },
			delegation: { type: "client" },
		},
	});
}

describe("GenerationFence", () => {
	it("never reactivates a tombstoned generation", () => {
		const fence = new GenerationFence();
		fence.activate(7);
		expect(fence.isCurrent(7)).toBe(true);
		fence.tombstone(7);
		expect(fence.isCurrent(7)).toBe(false);
		expect(() => fence.assertCurrent(7)).toThrow(/generation 7 is fenced/);
		expect(() => fence.activate(7)).toThrow(/must advance/);
		fence.activate(8);
		expect(fence.isCurrent(8)).toBe(true);
	});

	it("rechecks the generation after an awaited operation", async () => {
		const fence = new GenerationFence();
		fence.activate(1);
		let resolve!: (value: string) => void;
		const pending = new Promise<string>((done) => {
			resolve = done;
		});
		const guarded = fence.after(1, pending);
		fence.tombstone(1);
		resolve("late");
		await expect(guarded).rejects.toThrow(/generation 1 is fenced/);
	});
});

describe("LiveSession", () => {
	it("refuses input until the matching session.started handshake", async () => {
		const { session, socket } = makeSession();
		const opening = session.start();
		expect(socket.sent[0]?.type).toBe("session.start");
		expect(() => session.appendInputAudio(Buffer.from([0, 0]))).toThrow(
			/session is not active/,
		);

		started(socket);
		await opening;
		session.appendInputAudio(Buffer.from([1, 2]));
		expect(socket.sent[1]).toMatchObject({
			type: "session.input_audio.append",
			audio: "AQI=",
		});
	});

	it("rejects admission when session.started does not match config", async () => {
		const { session, socket, fence } = makeSession();
		const opening = session.start();
		socket.receive({
			type: "session.started",
			session: {
				id: "live_wrong",
				model: "unexpected-model",
				status: "active",
				audio: { format: { type: "audio/pcm", rate: 24_000 } },
				delegation: { type: "client" },
			},
		});

		await expect(opening).rejects.toThrow(/model mismatch/);
		expect(fence.isCurrent(1)).toBe(false);
		expect(socket.closed).toBe(1);
	});

	it("delivers each audio delta without waiting for a done event", async () => {
		const { session, socket } = makeSession();
		const audio = vi.fn();
		session.on("audio", audio);
		const opening = session.start();
		started(socket);
		await opening;

		socket.receive({
			type: "session.output_audio.delta",
			delta: Buffer.from([9, 8, 7]).toString("base64"),
		});
		expect(audio).toHaveBeenCalledOnce();
		expect(audio.mock.calls[0]?.[0]).toMatchObject({
			generation: 1,
			chunk: Buffer.from([9, 8, 7]),
		});
	});

	it("fences every late effect as soon as retirement starts", async () => {
		const { session, socket, fence } = makeSession();
		const audio = vi.fn();
		const transcript = vi.fn();
		const delegation = vi.fn();
		session.on("audio", audio);
		session.on("transcript", transcript);
		session.on("delegation", delegation);
		const opening = session.start();
		started(socket);
		await opening;

		const retiring = session.retire({ deadlineMs: 100 });
		expect(fence.isCurrent(1)).toBe(false);
		socket.receive({
			type: "session.output_audio.delta",
			delta: Buffer.from([1, 1]).toString("base64"),
		});
		socket.receive({
			type: "session.output_transcript.delta",
			start_ms: 0,
			end_ms: 200,
			delta: "late words",
		});
		socket.receive({
			type: "session.delegation.created",
			delegation: {
				id: "late-delegation",
				type: "delegation",
				target: "client",
			},
		});
		expect(audio).not.toHaveBeenCalled();
		expect(transcript).not.toHaveBeenCalled();
		expect(delegation).not.toHaveBeenCalled();

		socket.receive({ type: "session.closed" });
		await expect(retiring).resolves.toEqual({
			generation: 1,
			finalization: "provider_connection_closed",
		});
		expect(socket.closed).toBe(1);
	});

	it("reports provider finalization incomplete on a close deadline", async () => {
		const { session, socket } = makeSession();
		const opening = session.start();
		started(socket);
		await opening;

		await expect(session.retire({ deadlineMs: 1 })).resolves.toEqual({
			generation: 1,
			finalization: "provider_finalization_incomplete",
		});
		expect(socket.closed).toBe(1);
	});

	it("surfaces invalid server input as a typed error", async () => {
		const { session, socket } = makeSession();
		const errors: VoiceError[] = [];
		session.on("error", (error) => errors.push(error));
		const opening = session.start();
		socket.receive({
			type: "session.output_audio.delta",
			delta: "not base64!",
		});
		await expect(opening).rejects.toMatchObject({ code: "backend-protocol" });
		expect(errors).toHaveLength(1);
		expect(errors[0]?.code).toBe("backend-protocol");
	});
});
