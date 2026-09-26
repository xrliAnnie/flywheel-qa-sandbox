import { describe, expect, it, vi } from "vitest";
import {
	CODEX_HANDOFF_FAILED_PROMPT,
	CODEX_HANDOFF_UNCONFIRMED_PROMPT,
	CodexVoiceBackend,
} from "../codex/CodexVoiceBackend.js";
import {
	type CodexRealtimeRpc,
	CodexRealtimeTransport,
} from "../codex/RealtimeTransport.js";
import type { RealtimeMediaLeg } from "../codex/WebRtcLeg.js";

/** Stands in for the WebRTC leg: records what the transport hands it. */
class FakeLeg implements RealtimeMediaLeg {
	writable = true;
	readonly frames: Buffer[] = [];
	readonly answers: string[] = [];
	answerError?: Error;
	closeCount = 0;

	async prepareOffer(): Promise<string> {
		return "v=0\r\no=fake-offer";
	}

	async acceptAnswer(sdp: string): Promise<void> {
		this.answers.push(sdp);
		if (this.answerError) throw this.answerError;
	}

	writePcm24(frame: Buffer): boolean {
		if (!this.writable) return false;
		this.frames.push(Buffer.from(frame));
		return true;
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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
	const leg = new FakeLeg();
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
		leg,
		start: {
			outputModality: "audio",
			clientManagedHandoffs: true,
			includeStartupContext: false,
			prompt: "identity and state snapshot",
			model: "gpt-live-1-codex",
			voice: "cove",
		},
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
		leg,
		transport,
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
	await flush();
	h.rpc.emit("thread/realtime/started", {
		threadId: "thread-a",
		realtimeSessionId: "realtime-a",
		version: "v3",
	});
	h.rpc.emit("thread/realtime/sdp", {
		threadId: "thread-a",
		sdp: "v=0\r\no=fake-answer",
	});
	await opening;
}

describe("Codex V3 realtime transport over WebRTC", () => {
	it("becomes ready only after the start RPC, started (v3) and the answer SDP, then connects the leg", async () => {
		const h = harness();
		const reply = h.rpc.defer("thread/realtime/start");
		let ready = false;
		const opening = h.transport.start().then(() => {
			ready = true;
		});
		await flush();
		expect(h.rpc.requests[0]).toEqual({
			method: "thread/realtime/start",
			params: {
				outputModality: "audio",
				clientManagedHandoffs: true,
				includeStartupContext: false,
				prompt: "identity and state snapshot",
				model: "gpt-live-1-codex",
				voice: "cove",
				threadId: "thread-a",
				version: "v3",
				transport: { type: "webrtc", sdp: "v=0\r\no=fake-offer" },
			},
		});
		expect(h.transport.startRequested).toBe(true);

		h.rpc.emit("thread/realtime/started", {
			threadId: "other-thread",
			realtimeSessionId: "wrong",
			version: "v3",
		});
		// Pinned 0.156.1 order: started first, sdp right after.
		h.rpc.emit("thread/realtime/started", {
			threadId: "thread-a",
			realtimeSessionId: "realtime-a",
			version: "v3",
		});
		reply.resolve({ result: {} });
		await flush();
		expect(ready).toBe(false);
		expect(h.leg.answers).toEqual([]);
		h.rpc.emit("thread/realtime/sdp", {
			threadId: "other-thread",
			sdp: "v=0\r\no=wrong",
		});
		h.rpc.emit("thread/realtime/sdp", {
			threadId: "thread-a",
			sdp: "v=0\r\no=fake-answer",
		});
		await opening;
		expect(h.leg.answers).toEqual(["v=0\r\no=fake-answer"]);
		expect(ready).toBe(true);
	});

	it("rejects a started receipt for any version other than V3 without waiting for the SDP", async () => {
		const h = harness();
		const opening = h.transport.start();
		await flush();
		h.rpc.emit("thread/realtime/started", {
			threadId: "thread-a",
			realtimeSessionId: "realtime-a",
			version: "v2",
		});
		await expect(opening).rejects.toThrow("realtime_version_mismatch");
		expect(h.leg.answers).toEqual([]);
	});

	it("fails the open on an asynchronous server error after the start RPC succeeded", async () => {
		// research R2: an unsupported v3 voice is accepted by the RPC and only
		// then rejected by thread/realtime/error.
		const h = harness();
		const opening = h.transport.start();
		await flush();
		h.rpc.emit("thread/realtime/started", {
			threadId: "thread-a",
			realtimeSessionId: "realtime-a",
			version: "v3",
		});
		h.rpc.emit("thread/realtime/error", {
			threadId: "thread-a",
			message:
				"realtime voice 'marin' is not supported for v3; supported voices: juniper, maple, spruce, ember, vale, breeze, arbor, sol, cove",
		});
		await expect(opening).rejects.toMatchObject({
			name: "CodexRealtimeServerError",
		});
		expect(h.leg.answers).toEqual([]);
	});

	it.each([
		["closed", { reason: "error" }, "error"],
		["an empty sdp", { sdp: "" }, "realtime_sdp_invalid"],
	] as const)("fails the open on %s", async (_name, params, message) => {
		const h = harness();
		const opening = h.transport.start();
		await flush();
		h.rpc.emit("thread/realtime/started", {
			threadId: "thread-a",
			realtimeSessionId: "realtime-a",
			version: "v3",
		});
		h.rpc.emit(
			"sdp" in params ? "thread/realtime/sdp" : "thread/realtime/closed",
			{ threadId: "thread-a", ...params },
		);
		await expect(opening).rejects.toThrow(message);
	});

	it("fails the open when the leg cannot connect with the answer", async () => {
		const h = harness();
		h.leg.answerError = new Error("webrtc_connect_timeout");
		const opening = h.transport.start();
		await flush();
		h.rpc.emit("thread/realtime/started", {
			threadId: "thread-a",
			realtimeSessionId: "realtime-a",
			version: "v3",
		});
		h.rpc.emit("thread/realtime/sdp", {
			threadId: "thread-a",
			sdp: "v=0\r\no=fake-answer",
		});
		await expect(opening).rejects.toThrow("webrtc_connect_timeout");
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "late",
				ownerUserId: "founder",
			}),
		).toBe("dropped:closed");
	});

	it("stops waiting as soon as the attempt is aborted", async () => {
		const h = harness();
		const controller = new AbortController();
		const opening = h.transport.start(controller.signal);
		await flush();
		controller.abort(new Error("reconnect_attempt_timeout"));
		await expect(opening).rejects.toThrow("reconnect_attempt_timeout");
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

	it("writes whole 20 ms 24 kHz mono frames straight to the WebRTC leg", async () => {
		const h = harness();
		await start(h);
		const frame = Buffer.alloc(4_800, 3);
		expect(
			h.transport.appendAudio(frame, 7, {
				utteranceId: "utterance-a",
				ownerUserId: "founder",
			}),
		).toBe("sent");
		expect(h.leg.frames).toHaveLength(5);
		expect(Buffer.concat(h.leg.frames)).toEqual(frame);
		expect(
			h.rpc.requests.some(
				(request) => request.method === "thread/realtime/appendAudio",
			),
		).toBe(false);
		expect(() =>
			h.transport.appendAudio(Buffer.alloc(1_000), 7, {
				utteranceId: "partial",
				ownerUserId: "founder",
			}),
		).toThrow("realtime_audio_frame_invalid");
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

	it("marks a whole input frame as a gap when the leg cannot take it", async () => {
		const h = harness();
		await start(h);
		h.leg.writable = false;
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
	});

	it("fences JSON-RPC output audio: under WebRTC it can only be a duplicate of the RTP audio", async () => {
		const h = harness();
		await start(h);
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
		expect(h.violations).toHaveBeenCalledWith({
			generation: 7,
			method: "thread/realtime/outputAudio/delta:webrtc_duplicate_audio",
			params: { threadId: "thread-a", bytes: 4 },
		});
		expect(
			h.transport.appendAudio(Buffer.alloc(960), 7, {
				utteranceId: "after",
				ownerUserId: "founder",
			}),
		).toBe("dropped:closed");
	});

	it("keeps the preceding assistant item association on transcripts", async () => {
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
		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			role: "assistant",
			text: "hello",
		});
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

		h.transport.appendAudio(Buffer.alloc(960), 7, {
			utteranceId: "utterance-gap",
			ownerUserId: "founder",
			ownerName: "Annie",
		});
		h.leg.writable = false;
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
	});

	it("fences audio, transcript, and capability effects before cancellation awaits close", async () => {
		const h = harness();
		await start(h);
		const stop = h.rpc.defer("thread/realtime/stop");
		const cancelling = h.transport.cancel();

		h.rpc.emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			role: "assistant",
			text: "late words",
		});
		h.rpc.emit("turn/started", { threadId: "thread-a" });
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
type DataEvent = (event: {
	type: "turn.created" | "turn.done";
	turnId: string;
	role: "user" | "assistant";
	transcript: string | null;
}) => void;

function emitRecordedHandoffTrace(rpc: FakeRpc, data: DataEvent): void {
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
	// v3 reports the spoken acknowledgement as a data-channel turn.
	data({ type: "turn.created", turnId: "turn-ack", role: "assistant", transcript: null });
	rpc.emit("thread/realtime/transcript/done", {
		threadId,
		role: "assistant",
		text: "好的，我来把你的这个请求转给后台代理，请它去查状态。",
	});
	data({
		type: "turn.done",
		turnId: "turn-ack",
		role: "assistant",
		transcript: "好的，我来把你的这个请求转给后台代理，请它去查状态。",
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

/** One recorded 0.156.1 spoken user turn: VAD start, audio commit, final. */
function emitSpokenUserTurn(rpc: FakeRpc, itemId: string, text: string): void {
	const threadId = "thread-real";
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: { type: "input_audio_buffer.speech_started", item_id: itemId },
	});
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: {
			type: "message",
			id: itemId,
			role: "user",
			status: "completed",
			content: [{ type: "input_audio", transcript: null }],
		},
	});
	rpc.emit("thread/realtime/transcript/done", { threadId, role: "user", text });
}

/** The recorded delegation tail: spoken acknowledgement, handoff, 401 turn. */
function emitHandoffRequest(
	rpc: FakeRpc,
	data: DataEvent,
	handoffId: string,
	turnId: string,
): void {
	const threadId = "thread-real";
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: { type: "function_call", status: "in_progress" },
	});
	data({ type: "turn.created", turnId: `ack-${handoffId}`, role: "assistant", transcript: null });
	rpc.emit("thread/realtime/transcript/done", {
		threadId,
		role: "assistant",
		text: "好的，我先把这个请求交给后台代理，让它按你的原话去处理。",
	});
	data({
		type: "turn.done",
		turnId: `ack-${handoffId}`,
		role: "assistant",
		transcript: "好的，我先把这个请求交给后台代理，让它按你的原话去处理。",
	});
	rpc.emit("thread/realtime/itemAdded", {
		threadId,
		item: {
			type: "handoff_request",
			handoff_id: handoffId,
			item_id: `item-${handoffId}`,
			input_transcript: "你帮我去看一下2799现在是什么状态。",
			active_transcript: [],
		},
	});
	rpc.emit("turn/started", {
		threadId,
		turn: { id: turnId, items: [], status: "inProgress" },
	});
}

async function realHandoffSession(
	soleRoomUser: { userId: string; name: string | null } | null,
	options: { handoffError?: Error } = {},
) {
	const rpc = new FakeRpc();
	const legs: FakeLeg[] = [];
	let realtime!: { onDataEvent?: (input: unknown) => void };
	const evidence = vi.fn();
	const handoffToLead = vi.fn(async () => {
		if (options.handoffError) throw options.handoffError;
		return {
			handoffId: "handoff-real",
			state: "dispatched" as const,
			idempotencyKey: "codex-delegate:real",
			requestDigest: "d".repeat(64),
		};
	});
	const realtimeStarts = () =>
		rpc.requests.filter((request) => request.method === "thread/realtime/start")
			.length;
	const backend = new CodexVoiceBackend({
		sessionId: "session-real",
		voice: "marin",
		container: {
			open: async (input) => {
				realtime = input.realtime as typeof realtime;
				const createTransport = async (generation: number) => {
					const leg = new FakeLeg();
					legs.push(leg);
					const transport = new CodexRealtimeTransport({
						rpc,
						sessionId: input.sessionId,
						threadId: "thread-real",
						generation,
						leg,
						start: { outputModality: "audio", clientManagedHandoffs: true },
						...input.realtime,
					});
					const opening = transport.start();
					await flush();
					rpc.emit("thread/realtime/started", {
						threadId: "thread-real",
						realtimeSessionId: `realtime-real-${generation}`,
						version: "v3",
					});
					rpc.emit("thread/realtime/sdp", {
						threadId: "thread-real",
						sdp: "v=0\r\no=fake-answer",
					});
					await opening;
					return transport;
				};
				// Same shape as CodexVoiceConversation.restart(): confirm the old
				// realtime connection closed, then open the next generation.
				const conversation = {
					generation: 1,
					transport: await createTransport(1),
					async restart() {
						const cancelling = conversation.transport.cancel();
						rpc.emit("thread/realtime/closed", {
							threadId: "thread-real",
							reason: "requested",
						});
						await cancelling;
						const generation = conversation.generation + 1;
						conversation.transport = await createTransport(generation);
						conversation.generation = generation;
						return generation;
					},
					close: async () => undefined,
				};
				return conversation;
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
	const sendFounderAudio = (utteranceId: string, speech = false) =>
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
		).sendOwnedAudio(Buffer.alloc(960, speech ? 1 : 0), {
			utteranceId,
			ownerUserId: "founder",
			ownerName: "Annie",
		});
	/** The uplink's next tick after she stops: an unowned silence frame. */
	const sendSilence = () =>
		session.sendAudio(Buffer.alloc(960), {
			encoding: "pcm16",
			sampleRateHz: 24_000,
			channels: 1,
		});
	const data: DataEvent = (event) =>
		realtime.onDataEvent?.({
			generation: 1,
			event: { ...event, startMs: null, endMs: null },
		});
	const spokenPrompts = () =>
		rpc.requests
			.filter((request) => request.method === "thread/realtime/appendSpeech")
			.map((request) => (request.params as { text: string }).text);
	const uplinkFrames = () =>
		legs.reduce((total, leg) => total + leg.frames.length, 0);
	return {
		rpc,
		data,
		sendSilence,
		uplinkFrames,
		evidence,
		handoffToLead,
		session,
		errors,
		sendFounderAudio,
		realtimeStarts,
		spokenPrompts,
	};
}

describe("Codex 0.156.1 handoff_request end to end", () => {
	it("delivers the sole room user's request to the Lead and keeps the call alive", async () => {
		const real = await realHandoffSession({ userId: "founder", name: "Annie" });
		real.sendFounderAudio("discord-founder-request");

		real.sendSilence();
		emitRecordedHandoffTrace(real.rpc, real.data);

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

		const appendsBefore = real.uplinkFrames();
		real.sendFounderAudio("discord-founder-next-turn");
		expect(real.uplinkFrames()).toBe(appendsBefore + 1);
		await real.session.close();
	});

	it("asks aloud for a repeat instead of handing off when no single room user can be bound", async () => {
		const real = await realHandoffSession(null);
		real.sendFounderAudio("discord-ambiguous-request");

		real.sendSilence();
		emitRecordedHandoffTrace(real.rpc, real.data);

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
		await vi.waitFor(() =>
			expect(real.spokenPrompts()).toEqual([CODEX_HANDOFF_UNCONFIRMED_PROMPT]),
		);
		expect(real.rpc.requests).toContainEqual({
			method: "turn/interrupt",
			params: { threadId: "thread-real", turnId: "turn-delegation" },
		});
		expect(real.errors).not.toHaveBeenCalled();
		await real.session.close();
	});

	it("asks aloud for a repeat when the Lead handoff itself fails", async () => {
		const real = await realHandoffSession(
			{ userId: "founder", name: "Annie" },
			{ handoffError: new Error("voice_handoff_rejected") },
		);
		real.sendFounderAudio("discord-founder-request", true);

		real.sendSilence();
		emitRecordedHandoffTrace(real.rpc, real.data);

		await vi.waitFor(() => expect(real.handoffToLead).toHaveBeenCalledOnce());
		await vi.waitFor(() =>
			expect(real.spokenPrompts()).toEqual([CODEX_HANDOFF_FAILED_PROMPT]),
		);
		expect(real.errors).not.toHaveBeenCalled();
		await real.session.close();
	});

	it("stays silent for a later execution item of a request already handed off", async () => {
		const real = await realHandoffSession({ userId: "founder", name: "Annie" });
		real.sendFounderAudio("discord-founder-request", true);

		real.sendSilence();
		emitRecordedHandoffTrace(real.rpc, real.data);
		await vi.waitFor(() => expect(real.handoffToLead).toHaveBeenCalledOnce());
		real.rpc.emit("item/started", {
			threadId: "thread-real",
			turnId: "turn-delegation",
			item: { id: "exec-late", type: "commandExecution", status: "inProgress" },
		});

		await vi.waitFor(() =>
			expect(real.evidence).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "codex_execution_handoff_skipped",
					backendIntentKind: "commandExecution",
					reason: "already_handed_off",
				}),
			),
		);
		expect(real.handoffToLead).toHaveBeenCalledOnce();
		expect(real.spokenPrompts()).toEqual([]);
		await real.session.close();
	});
});

describe("Codex 0.156.1 local barge-in followed by a handoff (FLY-2885 T5)", () => {
	it("keeps the generation and sole-room attribution across a barge-in and hands off the next request", async () => {
		const real = await realHandoffSession({ userId: "founder", name: "Annie" });
		real.sendFounderAudio("discord-hello", true);
		emitSpokenUserTurn(
			real.rpc,
			"item_user_1",
			"你好,你是谁?你手上现在有什么事?",
		);
		real.sendSilence();
		real.data({
			type: "turn.created",
			turnId: "answer-1",
			role: "assistant",
			transcript: null,
		});

		real.session.interrupt();
		expect(real.realtimeStarts()).toBe(1);
		real.sendFounderAudio("discord-ask", true);
		emitSpokenUserTurn(
			real.rpc,
			"item_user_2",
			"你帮我去看一下2799现在是什么状态。",
		);
		real.sendSilence();
		emitHandoffRequest(real.rpc, real.data, "call_after_barge", "turn-after-barge");

		await vi.waitFor(() => expect(real.handoffToLead).toHaveBeenCalledOnce());
		expect(real.handoffToLead).toHaveBeenCalledWith({
			utterance: expect.objectContaining({
				sessionGeneration: 1,
				text: "你帮我去看一下2799现在是什么状态。",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
			intent: expect.objectContaining({
				kind: "handoffRequest",
				itemId: "call_after_barge",
			}),
		});
		expect(real.evidence).toHaveBeenCalledWith({
			kind: "codex_barge_in",
			generation: 1,
			local: true,
		});
		expect(real.evidence).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "codex_input_gap" }),
		);
		expect(real.spokenPrompts()).toEqual([]);
		expect(real.errors).not.toHaveBeenCalled();
		await real.session.close();
	});

	it("loses no founder speech: an utterance still being transcribed at the barge-in binds and hands off", async () => {
		const real = await realHandoffSession({ userId: "founder", name: "Annie" });
		real.sendFounderAudio("discord-unfinished", true);
		real.rpc.emit("thread/realtime/itemAdded", {
			threadId: "thread-real",
			item: {
				type: "input_audio_buffer.speech_started",
				item_id: "item_user_1",
			},
		});

		real.session.interrupt();
		expect(real.realtimeStarts()).toBe(1);
		emitSpokenUserTurn(real.rpc, "item_user_1", "那就 ship 2808。");
		real.sendSilence();
		emitHandoffRequest(real.rpc, real.data, "call_after_cut", "turn-after-cut");

		await vi.waitFor(() => expect(real.handoffToLead).toHaveBeenCalledOnce());
		expect(real.evidence).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "codex_input_gap" }),
		);
		expect(real.spokenPrompts()).toEqual([]);
		expect(real.errors).not.toHaveBeenCalled();
		await real.session.close();
	});
});
