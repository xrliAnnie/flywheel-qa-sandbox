import { describe, expect, it, vi } from "vitest";
import {
	CODEX_REALTIME_INPUT_QUEUE_BYTES,
	type CodexRealtimeRpc,
	CodexRealtimeTransport,
} from "../codex/RealtimeTransport.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

class FakeRpc implements CodexRealtimeRpc {
	readonly notifications: Array<(method: string, params: unknown) => void> = [];
	readonly exits: Array<
		(code: number | null, signal: NodeJS.Signals | null) => void
	> = [];
	readonly requests: Array<{ method: string; params: unknown }> = [];
	readonly replies = new Map<
		string,
		Array<
			ReturnType<
				typeof deferred<{
					result?: unknown;
					error?: { code: number; message: string };
				}>
			>
		>
	>();

	on(
		event: "notification" | "exit",
		callback:
			| ((method: string, params: unknown) => void)
			| ((code: number | null, signal: NodeJS.Signals | null) => void),
	): void {
		if (event === "notification") {
			this.notifications.push(
				callback as (method: string, params: unknown) => void,
			);
		} else {
			this.exits.push(
				callback as (
					code: number | null,
					signal: NodeJS.Signals | null,
				) => void,
			);
		}
	}

	request(method: string, params?: unknown) {
		this.requests.push({ method, params });
		const reply = this.replies.get(method)?.shift();
		return reply?.promise ?? Promise.resolve({ result: {} });
	}

	defer(method: string) {
		const reply = deferred<{
			result?: unknown;
			error?: { code: number; message: string };
		}>();
		const queue = this.replies.get(method) ?? [];
		queue.push(reply);
		this.replies.set(method, queue);
		return reply;
	}

	emit(method: string, params: unknown): void {
		for (const callback of this.notifications) callback(method, params);
	}

	exit(code: number | null = 0): void {
		for (const callback of this.exits) callback(code, null);
	}
}

function harness(generation = 7) {
	const rpc = new FakeRpc();
	const audio = vi.fn();
	const transcript = vi.fn();
	const gaps = vi.fn();
	const violations = vi.fn();
	const closed = vi.fn();
	const transport = new CodexRealtimeTransport({
		rpc,
		sessionId: "session-a",
		threadId: "thread-a",
		generation,
		start: {
			outputModality: "audio",
			clientManagedHandoffs: true,
			includeStartupContext: false,
			prompt: "identity and state snapshot",
			transport: { type: "websocket" },
			model: "gpt-realtime-2.1",
			voice: "marin",
		},
		onAudio: audio,
		onTranscript: transcript,
		onInputGap: gaps,
		onCapabilityViolation: violations,
		onClosed: closed,
	});
	return { rpc, transport, audio, transcript, gaps, violations, closed };
}

async function start(h: ReturnType<typeof harness>): Promise<void> {
	const opening = h.transport.start();
	h.rpc.emit("thread/realtime/started", {
		threadId: "thread-a",
		realtimeSessionId: "realtime-a",
		version: "v2",
	});
	await opening;
}

describe("Codex V2 realtime transport", () => {
	it("becomes ready only after both the start RPC and matching started receipt", async () => {
		const h = harness();
		const reply = h.rpc.defer("thread/realtime/start");
		let ready = false;
		const opening = h.transport.start().then(() => {
			ready = true;
		});

		h.rpc.emit("thread/realtime/started", {
			threadId: "other-thread",
			realtimeSessionId: "wrong",
			version: "v2",
		});
		h.rpc.emit("thread/realtime/started", {
			threadId: "thread-a",
			realtimeSessionId: "realtime-a",
			version: "v2",
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		reply.resolve({ result: {} });
		await opening;

		expect(h.rpc.requests[0]).toEqual({
			method: "thread/realtime/start",
			params: expect.objectContaining({
				threadId: "thread-a",
				version: "v2",
				model: "gpt-realtime-2.1",
			}),
		});
	});

	it("rejects a matching started receipt for any version other than V2", async () => {
		const h = harness();
		const opening = h.transport.start();
		h.rpc.emit("thread/realtime/started", {
			threadId: "thread-a",
			realtimeSessionId: "realtime-a",
			version: "v3",
		});
		await expect(opening).rejects.toThrow("realtime_version_mismatch");
	});

	it("sends only bounded 24 kHz mono PCM16 frames with owner metadata", async () => {
		const h = harness();
		await start(h);
		const frame = Buffer.alloc(4_800, 3);
		expect(
			h.transport.appendAudio(frame, 7, {
				utteranceId: "utterance-a",
				ownerUserId: "founder",
			}),
		).toBe("sent");
		await h.transport.drain();
		expect(h.rpc.requests.at(-1)).toEqual({
			method: "thread/realtime/appendAudio",
			params: {
				threadId: "thread-a",
				audio: {
					data: frame.toString("base64"),
					sampleRate: 24_000,
					numChannels: 1,
					samplesPerChannel: 2_400,
				},
			},
		});
		expect(() =>
			h.transport.appendAudio(Buffer.alloc(4_802), 7, {
				utteranceId: "too-long",
				ownerUserId: "founder",
			}),
		).toThrow("realtime_audio_frame_invalid");
		expect(() =>
			h.transport.appendAudio(Buffer.alloc(959), 7, {
				utteranceId: "odd",
				ownerUserId: "founder",
			}),
		).toThrow("realtime_audio_frame_invalid");
	});

	it("requires the current generation for audio, appendText, and appendSpeech", async () => {
		const h = harness();
		await start(h);
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 6, {
				utteranceId: "old",
				ownerUserId: "founder",
			}),
		).toBe("dropped:stale-generation");
		await expect(
			h.transport.appendText("context", "developer", 6),
		).rejects.toThrow("realtime_stale_generation");
		await expect(h.transport.appendSpeech("hello", 6)).rejects.toThrow(
			"realtime_stale_generation",
		);
		await h.transport.appendText("context", "developer", 7);
		await h.transport.appendSpeech("hello", 7);
		expect(h.rpc.requests.slice(-2)).toEqual([
			{
				method: "thread/realtime/appendText",
				params: {
					threadId: "thread-a",
					text: "context",
					role: "developer",
				},
			},
			{
				method: "thread/realtime/appendSpeech",
				params: { threadId: "thread-a", text: "hello" },
			},
		]);
	});

	it("marks a whole input frame as a gap when the one-second queue is full", async () => {
		const h = harness();
		await start(h);
		const held = h.rpc.defer("thread/realtime/appendAudio");
		const frame = Buffer.alloc(4_800);
		for (
			let bytes = 0;
			bytes < CODEX_REALTIME_INPUT_QUEUE_BYTES;
			bytes += frame.length
		) {
			h.transport.appendAudio(frame, 7, {
				utteranceId: "utterance-full",
				ownerUserId: "founder",
			});
		}
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "utterance-overflow",
				ownerUserId: "founder",
			}),
		).toBe("dropped:backpressure");
		expect(h.gaps).toHaveBeenCalledWith({
			generation: 7,
			utteranceId: "utterance-overflow",
			ownerUserId: "founder",
			droppedBytes: 960,
			reason: "backpressure",
		});
		held.resolve({ result: {} });
		await h.transport.drain();
	});

	it("preserves raw item correlation on audio and transcript callbacks", async () => {
		const h = harness();
		await start(h);
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				id: "item-assistant",
				type: "message",
				status: "in_progress",
				role: "assistant",
				content: [],
			},
		});
		h.rpc.emit("thread/realtime/outputAudio/delta", {
			threadId: "thread-a",
			audio: {
				data: Buffer.from([1, 2, 3, 4]).toString("base64"),
				sampleRate: 24_000,
				numChannels: 1,
				samplesPerChannel: null,
				itemId: "item-assistant",
			},
		});
		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			role: "assistant",
			text: "hello",
		});

		expect(h.audio).toHaveBeenCalledWith(
			expect.objectContaining({
				generation: 7,
				itemId: "item-assistant",
				pcm24Mono: Buffer.from([1, 2, 3, 4]),
			}),
		);
		expect(h.transcript).toHaveBeenCalledWith(
			expect.objectContaining({
				generation: 7,
				itemId: "item-assistant",
				association: "preceding_item",
				role: "assistant",
				text: "hello",
				final: true,
			}),
		);
	});

	it("binds a final user transcript only when the provider carries its item id", async () => {
		const h = harness();
		await start(h);
		const owner = {
			utteranceId: "utterance-founder",
			ownerUserId: "founder",
			ownerName: "Annie",
		};
		h.transport.appendAudio(Buffer.alloc(960), 7, owner);
		h.transport.appendAudio(Buffer.alloc(960), 7, owner);
		await h.transport.drain();
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				type: "input_audio_buffer.speech_started",
				item_id: "item-founder",
			},
		});
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				id: "item-founder",
				type: "message",
				status: "completed",
				role: "user",
				content: [],
			},
		});
		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			itemId: "item-founder",
			role: "user",
			text: "请把这件事交给本体",
		});

		expect(h.transcript).toHaveBeenLastCalledWith(
			expect.objectContaining({
				itemId: "item-founder",
				association: "provider_item",
				inputOwner: owner,
			}),
		);
	});

	it("keeps an itemless delayed user transcript unknown after speakers alternate", async () => {
		const h = harness();
		await start(h);
		h.transport.appendAudio(Buffer.alloc(960), 7, {
			utteranceId: "utterance-guest",
			ownerUserId: "guest",
			ownerName: "Guest",
		});
		await h.transport.drain();
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				type: "input_audio_buffer.speech_started",
				item_id: "item-guest",
			},
		});
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				id: "item-guest",
				type: "message",
				status: "completed",
				role: "user",
				content: [],
			},
		});
		h.transport.appendAudio(Buffer.alloc(960), 7, {
			utteranceId: "utterance-founder",
			ownerUserId: "founder",
			ownerName: "Annie",
		});
		await h.transport.drain();
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				type: "input_audio_buffer.speech_started",
				item_id: "item-founder",
			},
		});
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				id: "item-founder",
				type: "message",
				status: "completed",
				role: "user",
				content: [],
			},
		});

		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			role: "user",
			text: "GUEST SENTENCE",
		});

		expect(h.transcript).toHaveBeenLastCalledWith(
			expect.objectContaining({
				association: "unattributed",
				role: "user",
				text: "GUEST SENTENCE",
			}),
		);
		expect(h.transcript).toHaveBeenLastCalledWith(
			expect.not.objectContaining({
				itemId: expect.anything(),
				inputOwner: expect.anything(),
			}),
		);
	});

	it("fails attribution closed after mixed ownership or an input gap", async () => {
		const h = harness();
		await start(h);
		h.transport.appendAudio(Buffer.alloc(960), 7, {
			utteranceId: "utterance-a",
			ownerUserId: "founder",
			ownerName: "Annie",
		});
		h.transport.appendAudio(Buffer.alloc(960), 7, {
			utteranceId: "utterance-b",
			ownerUserId: "guest",
			ownerName: "Guest",
		});
		await h.transport.drain();
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				type: "input_audio_buffer.speech_started",
				item_id: "item-mixed",
			},
		});
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: { id: "item-mixed", role: "user", status: "completed" },
		});
		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			itemId: "item-mixed",
			role: "user",
			text: "mixed",
		});
		expect(h.transcript).toHaveBeenLastCalledWith(
			expect.not.objectContaining({ inputOwner: expect.anything() }),
		);

		const held = h.rpc.defer("thread/realtime/appendAudio");
		for (
			let bytes = 0;
			bytes < CODEX_REALTIME_INPUT_QUEUE_BYTES;
			bytes += 4_800
		) {
			h.transport.appendAudio(Buffer.alloc(4_800), 7, {
				utteranceId: "utterance-gap",
				ownerUserId: "founder",
				ownerName: "Annie",
			});
		}
		h.transport.appendAudio(Buffer.alloc(960), 7, {
			utteranceId: "utterance-gap",
			ownerUserId: "founder",
			ownerName: "Annie",
		});
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: {
				type: "input_audio_buffer.speech_started",
				item_id: "item-gap",
			},
		});
		h.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-a",
			item: { id: "item-gap", role: "user", status: "completed" },
		});
		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			itemId: "item-gap",
			role: "user",
			text: "gap",
		});
		expect(h.transcript).toHaveBeenLastCalledWith(
			expect.not.objectContaining({ inputOwner: expect.anything() }),
		);
		held.resolve({ result: {} });
		await h.transport.drain();
	});

	it("fences audio, transcript, and capability effects before cancellation awaits close", async () => {
		const h = harness();
		await start(h);
		const stop = h.rpc.defer("thread/realtime/stop");
		const cancelling = h.transport.cancel();

		h.rpc.emit("thread/realtime/outputAudio/delta", {
			threadId: "thread-a",
			audio: {
				data: Buffer.from([1, 2]).toString("base64"),
				sampleRate: 24_000,
				numChannels: 1,
				itemId: "late-item",
			},
		});
		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			role: "assistant",
			text: "late words",
		});
		h.rpc.emit("turn/started", { threadId: "thread-a" });
		expect(h.audio).not.toHaveBeenCalled();
		expect(h.transcript).not.toHaveBeenCalled();
		expect(h.violations).not.toHaveBeenCalled();
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "late",
				ownerUserId: "founder",
			}),
		).toBe("dropped:closed");

		stop.resolve({ result: {} });
		h.rpc.emit("thread/realtime/closed", {
			threadId: "thread-a",
			reason: "requested",
		});
		await cancelling;
		expect(h.closed).toHaveBeenCalledWith({
			generation: 7,
			reason: "requested",
		});
	});
});
