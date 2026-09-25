import { describe, expect, it, vi } from "vitest";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";
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
	const executionIntents = vi.fn();
	const backgroundTurns = vi.fn();
	const closed = vi.fn();
	const errors = vi.fn();
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
		onExecutionIntent: executionIntents,
		onBackgroundTurn: backgroundTurns,
		onClosed: closed,
		onError: errors,
	});
	return {
		rpc,
		transport,
		audio,
		transcript,
		gaps,
		violations,
		executionIntents,
		backgroundTurns,
		closed,
		errors,
	};
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

	it("rejects opening with the original realtime server error", async () => {
		const h = harness();
		const opening = h.transport.start();
		const upstream = {
			threadId: "thread-a",
			type: "invalid_request_error",
			message: "voice prompt was rejected",
		};

		h.rpc.emit("thread/realtime/error", upstream);

		await expect(opening).rejects.toMatchObject({
			name: "CodexRealtimeServerError",
			message: "realtime_server_error: voice prompt was rejected",
			upstreamEvent: {
				method: "thread/realtime/error",
				params: upstream,
			},
		});
		expect(h.errors).toHaveBeenCalledOnce();
	});

	it("preserves the realtime server error type, message, and upstream event", async () => {
		const h = harness();
		await start(h);
		const upstream = {
			threadId: "thread-a",
			type: "invalid_request_error",
			message: "voice prompt was rejected",
		};

		h.rpc.emit("thread/realtime/error", upstream);

		expect(h.errors).toHaveBeenCalledOnce();
		expect(h.errors.mock.calls[0]?.[0]).toMatchObject({
			name: "CodexRealtimeServerError",
			message: "realtime_server_error: voice prompt was rejected",
			upstreamEvent: {
				method: "thread/realtime/error",
				params: upstream,
			},
		});
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

	it("keeps itemless final user transcripts unattributed despite completed input order", async () => {
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
		expect(h.transcript.mock.calls.at(-1)?.[0]).not.toHaveProperty("itemId");
		expect(h.transcript.mock.calls.at(-1)?.[0]).not.toHaveProperty(
			"inputOwner",
		);
		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			role: "user",
			text: "FOUNDER SENTENCE",
		});
		expect(h.transcript).toHaveBeenLastCalledWith(
			expect.objectContaining({
				association: "unattributed",
				text: "FOUNDER SENTENCE",
			}),
		);
		expect(h.transcript.mock.calls.at(-1)?.[0]).not.toHaveProperty("itemId");
		expect(h.transcript.mock.calls.at(-1)?.[0]).not.toHaveProperty(
			"inputOwner",
		);
	});

	it("interrupts a real background turn before reporting its execution intent", async () => {
		const h = harness();
		await start(h);
		const interrupted = h.rpc.defer("turn/interrupt");

		h.rpc.emit("turn/started", {
			threadId: "thread-a",
			turn: { id: "turn-a", status: "inProgress" },
		});
		expect(h.violations).not.toHaveBeenCalled();
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "founder-request",
				ownerUserId: "founder",
			}),
		).toMatch(/^sent/u);

		h.rpc.emit("item/started", {
			threadId: "thread-a",
			turnId: "turn-a",
			item: {
				id: "exec-a",
				type: "commandExecution",
				command: "gh issue view FLY-2799",
				status: "inProgress",
			},
		});
		expect(h.rpc.requests).toContainEqual({
			method: "turn/interrupt",
			params: { threadId: "thread-a", turnId: "turn-a" },
		});
		expect(h.executionIntents).not.toHaveBeenCalled();
		interrupted.resolve({ result: {} });
		await vi.waitFor(() => expect(h.executionIntents).toHaveBeenCalledTimes(1));
		expect(h.executionIntents).toHaveBeenCalledWith({
			generation: 7,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-a",
			params: expect.any(Object),
		});
		expect(h.violations).not.toHaveBeenCalled();
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "after-handoff",
				ownerUserId: "founder",
			}),
		).toMatch(/^sent/u);
	});

	it("fails closed without delegating when a background turn cannot be interrupted", async () => {
		const h = harness();
		await start(h);
		const interrupted = h.rpc.defer("turn/interrupt");

		h.rpc.emit("item/started", {
			threadId: "thread-a",
			turnId: "turn-a",
			item: {
				id: "exec-a",
				type: "commandExecution",
				command: "gh issue view FLY-2799",
				status: "inProgress",
			},
		});
		interrupted.resolve({
			error: { code: -32_000, message: "turn already completed" },
		});

		await vi.waitFor(() => expect(h.violations).toHaveBeenCalledTimes(1));
		expect(h.executionIntents).not.toHaveBeenCalled();
		expect(h.violations).toHaveBeenCalledWith({
			generation: 7,
			method: "item/started:execution_interrupt_failed",
			params: expect.any(Object),
		});
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "after-failed-interrupt",
				ownerUserId: "founder",
			}),
		).toBe("dropped:closed");
	});

	it("reports a provider handoff_request once and interrupts its background turn once", async () => {
		const h = harness();
		await start(h);
		const interrupted = h.rpc.defer("turn/interrupt");
		// Shape recorded from codex-standalone 0.156.1 with clientManagedHandoffs.
		const handoffRequest = {
			threadId: "thread-a",
			item: {
				type: "handoff_request",
				handoff_id: "call_Rw5sqBJh4CgdDbt3",
				item_id: "item_ERo5QDh2q5KPmqu0F4lim",
				input_transcript: "你帮我去看一下 2799 现在是什么状态",
				active_transcript: [
					{
						role: "user",
						text: "你帮我去看一下两千七百九十九现在是什么状态。",
					},
				],
			},
		};

		h.rpc.emit("thread/realtime/itemAdded", handoffRequest);
		h.rpc.emit("thread/realtime/itemAdded", handoffRequest);
		expect(h.executionIntents).toHaveBeenCalledOnce();
		expect(h.executionIntents).toHaveBeenCalledWith({
			generation: 7,
			kind: "handoffRequest",
			method: "thread/realtime/itemAdded",
			itemId: "call_Rw5sqBJh4CgdDbt3",
			params: handoffRequest,
		});

		h.rpc.emit("turn/started", {
			threadId: "thread-a",
			turn: { id: "turn-bg", status: "inProgress" },
		});
		h.rpc.emit("item/started", {
			threadId: "thread-a",
			turnId: "turn-bg",
			item: { id: "exec-bg", type: "commandExecution", status: "inProgress" },
		});
		expect(
			h.rpc.requests.filter((request) => request.method === "turn/interrupt"),
		).toEqual([
			{
				method: "turn/interrupt",
				params: { threadId: "thread-a", turnId: "turn-bg" },
			},
		]);
		interrupted.resolve({ result: {} });

		await vi.waitFor(() =>
			expect(h.backgroundTurns).toHaveBeenCalledWith({
				generation: 7,
				turnId: "turn-bg",
				outcome: "interrupted",
			}),
		);
		await vi.waitFor(() => expect(h.executionIntents).toHaveBeenCalledTimes(2));
		expect(h.executionIntents).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "commandExecution", itemId: "exec-bg" }),
		);
		expect(h.violations).not.toHaveBeenCalled();
		expect(h.errors).not.toHaveBeenCalled();
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "after-handoff-request",
				ownerUserId: "founder",
			}),
		).toMatch(/^sent/u);
	});

	it("keeps the conversation when a bare background turn cannot be interrupted", async () => {
		const h = harness();
		await start(h);
		const interrupted = h.rpc.defer("turn/interrupt");

		h.rpc.emit("turn/started", {
			threadId: "thread-a",
			turn: { id: "turn-bg", status: "inProgress" },
		});
		interrupted.resolve({
			error: { code: -32_000, message: "turn already completed" },
		});

		await vi.waitFor(() =>
			expect(h.backgroundTurns).toHaveBeenCalledWith({
				generation: 7,
				turnId: "turn-bg",
				outcome: "interrupt_failed",
				reason: "turn/interrupt: turn already completed",
			}),
		);
		expect(h.violations).not.toHaveBeenCalled();
		expect(h.errors).not.toHaveBeenCalled();
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "after-bare-turn",
				ownerUserId: "founder",
			}),
		).toMatch(/^sent/u);
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

/**
 * Replays the notification order recorded by FLY-2799 QA against the real
 * codex-standalone 0.156.1 binary (qa4-real-codex-bench/run2): a sole-user
 * request, the model's spoken acknowledgement, the provider handoff_request,
 * then the background delegation turn that can only fail with 401.
 */
function emitRecordedHandoffTrace(rpc: FakeRpc): void {
	const threadId = "thread-real";
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: { type: "input_audio_buffer.speech_started", item_id: "item_user_1" },
	});
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: {
			type: "message",
			id: "item_user_1",
			role: "user",
			status: "completed",
		},
	});
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: {
			type: "message",
			id: "item_bot_1",
			role: "assistant",
			status: "in_progress",
		},
	});
	rpc.emit("thread/realtime/transcript/done", {
		threadId,
		role: "user",
		text: "你帮我去看一下两千七百九十九现在是什么状态。",
	});
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: { type: "function_call", status: "in_progress" },
	});
	rpc.emit("thread/realtime/transcript/done", {
		threadId,
		role: "assistant",
		text: "好的，我来把你的这个请求转给后台代理，请它去查状态。",
	});
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: {
			type: "handoff_request",
			handoff_id: "call_Rw5sqBJh4CgdDbt3",
			item_id: "item_ERo5QDh2q5KPmqu0F4lim",
			input_transcript: "你帮我去看一下 2799 现在是什么状态",
			active_transcript: [
				{ role: "user", text: "你帮我去看一下两千七百九十九现在是什么状态。" },
			],
		},
	});
	rpc.emit("turn/started", {
		threadId,
		turn: { id: "turn-delegation", items: [], status: "inProgress" },
	});
	rpc.emit("item/started", {
		threadId,
		turnId: "turn-delegation",
		item: { type: "userMessage", id: "delegation-input", content: [] },
	});
	rpc.emit("error", {
		threadId,
		turnId: "turn-delegation",
		willRetry: true,
		error: { message: "Reconnecting... 2/5" },
	});
}

async function realHandoffSession(
	soleRoomUser: { userId: string; name: string | null } | null,
) {
	const rpc = new FakeRpc();
	const evidence = vi.fn();
	const handoffToLead = vi.fn(async () => ({
		handoffId: "handoff-real",
		state: "dispatched" as const,
		idempotencyKey: "codex-delegate:real",
		requestDigest: "d".repeat(64),
	}));
	const backend = new CodexVoiceBackend({
		sessionId: "session-real",
		voice: "marin",
		container: {
			open: async (input) => {
				const transport = new CodexRealtimeTransport({
					rpc,
					sessionId: input.sessionId,
					threadId: "thread-real",
					generation: 1,
					start: { outputModality: "audio", clientManagedHandoffs: true },
					...input.realtime,
				});
				const opening = transport.start();
				rpc.emit("thread/realtime/started", {
					threadId: "thread-real",
					realtimeSessionId: "realtime-real",
					version: "v2",
				});
				await opening;
				return { generation: 1, transport, close: async () => undefined };
			},
		},
		loadContext: vi.fn(),
		persistUtterance: vi.fn(async () => undefined),
		handoffToLead,
		resolveSoleRoomUser: () => soleRoomUser,
		onEvidence: evidence,
	});
	const session = await backend.createConversation({
		brain: { async *respond() {} },
	});
	const errors = vi.fn();
	session.on("error", errors);
	const sendFounderAudio = (utteranceId: string) =>
		(
			session as typeof session & {
				sendOwnedAudio(
					frame: Buffer,
					owner: {
						utteranceId: string;
						ownerUserId: string;
						ownerName: string;
					},
				): void;
			}
		).sendOwnedAudio(Buffer.alloc(960), {
			utteranceId,
			ownerUserId: "founder",
			ownerName: "Annie",
		});
	return { rpc, evidence, handoffToLead, session, errors, sendFounderAudio };
}

describe("Codex 0.156.1 handoff_request end to end", () => {
	it("delivers the sole room user's request to the Lead and keeps the call alive", async () => {
		const real = await realHandoffSession({ userId: "founder", name: "Annie" });
		real.sendFounderAudio("discord-founder-request");

		emitRecordedHandoffTrace(real.rpc);

		await vi.waitFor(() => expect(real.handoffToLead).toHaveBeenCalledOnce());
		expect(real.handoffToLead).toHaveBeenCalledWith({
			utterance: expect.objectContaining({
				role: "user",
				text: "你帮我去看一下两千七百九十九现在是什么状态。",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
			intent: expect.objectContaining({
				kind: "handoffRequest",
				itemId: "call_Rw5sqBJh4CgdDbt3",
			}),
		});
		expect(real.rpc.requests).toContainEqual({
			method: "turn/interrupt",
			params: { threadId: "thread-real", turnId: "turn-delegation" },
		});
		await vi.waitFor(() =>
			expect(real.evidence).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "codex_execution_handoff",
					backendIntentKind: "handoffRequest",
					handoffId: "handoff-real",
				}),
			),
		);
		expect(real.evidence).toHaveBeenCalledWith({
			kind: "codex_background_turn",
			generation: 1,
			turnId: "turn-delegation",
			outcome: "interrupted",
		});
		expect(real.errors).not.toHaveBeenCalled();

		const appendsBefore = real.rpc.requests.filter(
			(request) => request.method === "thread/realtime/appendAudio",
		).length;
		real.sendFounderAudio("discord-founder-next-turn");
		await vi.waitFor(() =>
			expect(
				real.rpc.requests.filter(
					(request) => request.method === "thread/realtime/appendAudio",
				),
			).toHaveLength(appendsBefore + 1),
		);
		await real.session.close();
	});

	it("does not hand off when no single room user can be bound to the request", async () => {
		const real = await realHandoffSession(null);
		real.sendFounderAudio("discord-ambiguous-request");

		emitRecordedHandoffTrace(real.rpc);

		await vi.waitFor(() =>
			expect(real.evidence).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "codex_execution_handoff_skipped",
					backendIntentKind: "handoffRequest",
					reason: "known_user_missing",
				}),
			),
		);
		expect(real.handoffToLead).not.toHaveBeenCalled();
		expect(real.rpc.requests).toContainEqual({
			method: "turn/interrupt",
			params: { threadId: "thread-real", turnId: "turn-delegation" },
		});
		expect(real.errors).not.toHaveBeenCalled();
		await real.session.close();
	});
});
