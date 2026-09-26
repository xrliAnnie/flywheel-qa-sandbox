import {
	BackendRegistry,
	type BrainAdapter,
	type ConversationSession,
	type VoiceBackend,
	VoiceError,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import {
	CodexRoomFrontend,
	registerCodexVoiceBackend,
} from "../codex/CodexRoomFrontend.js";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";
import { CodexVoiceContainerError } from "../codex/CodexVoiceContainer.js";
import { CodexTranscriptPublisher } from "../codex/CodexVoiceHandoff.js";
import { GenericVoiceSession } from "../session.js";

const brain: BrainAdapter = {
	async *respond() {
		yield "unused";
	},
};

function conversation(
	close = vi.fn(async () => undefined),
): ConversationSession {
	return {
		sessionId: "codex-session",
		sendAudio: vi.fn(),
		sendText: vi.fn(),
		injectContext: vi.fn(),
		endUserTurn: vi.fn(),
		interrupt: vi.fn(),
		injectToolResult: vi.fn(),
		on: vi.fn(() => () => undefined),
		close,
		speak: vi.fn(async (_text, _kind, opts) => ({
			outcome: "completed" as const,
			transport: "submitted" as const,
			contentProof: "transcript_equivalent" as const,
			pendingKey: opts.pendingKey,
			requestDigest: "d".repeat(64),
		})),
	};
}

function backend(
	createConversation: VoiceBackend["createConversation"],
): VoiceBackend {
	return {
		id: "codex-realtime",
		capabilities: {
			announce: false,
			converse: true,
			bargeIn: false,
			verbatim: true,
			attribution: false,
			toolCallScheduling: "none",
			transcriptGranularity: "final-only",
			supportsResume: false,
			voiceCloning: false,
			audioIn: [{ encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }],
			audioOut: [{ encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }],
		},
		createConversation,
	};
}

describe("Codex room composition", () => {
	it("forwards the original backend failure instead of collapsing it to its code", async () => {
		let onError!: (error: VoiceError) => void;
		const onClosed = vi.fn();
		const session = {
			...conversation(),
			on: vi.fn((event: string, handler: (...args: never[]) => void) => {
				if (event === "error") onError = handler as (error: VoiceError) => void;
				return () => undefined;
			}),
		};
		const frontend = new CodexRoomFrontend({
			backend: backend(async () => session),
			conversationOptions: { brain },
			handlers: {
				onResponseState: vi.fn(),
				onTranscript: vi.fn(),
				onSpeechAudioReady: vi.fn(),
				onSpeechResult: vi.fn(),
				onClosed,
			},
			onUnavailable: vi.fn(),
		});
		await frontend.start();
		const upstream = new Error(
			"realtime_server_error: voice prompt was rejected",
		);
		upstream.name = "CodexRealtimeServerError";

		onError(
			new VoiceError("backend-protocol", "Codex realtime failed", upstream),
		);

		expect(onClosed).toHaveBeenCalledWith({
			kind: "failed",
			reason:
				"backend-protocol:Codex realtime failed:CodexRealtimeServerError:realtime_server_error: voice prompt was rejected",
		});
	});

	it("hands real execution intent to the Lead without closing", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const close = vi.fn(async () => undefined);
		const persisted = vi.fn(async () => undefined);
		const published = vi.fn(async () => undefined);
		const handoffToLead = vi.fn(async () => ({
			handoffId: "handoff-a",
			state: "dispatched" as const,
			idempotencyKey: "codex-delegate:a",
			requestDigest: "d".repeat(64),
		}));
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-handoff",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						generation: 1,
						transport: {
							appendAudio: vi.fn(() => "sent" as const),
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						restart: vi.fn(async () => 2),
						close,
					};
				}),
			},
			loadContext: vi.fn(),
			persistUtterance: persisted,
			publishUtterance: published,
			handoffToLead,
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const errors: Error[] = [];
		session.on("error", (error) => errors.push(error));

		callbacks.onTranscript({
			generation: 1,
			itemId: "user-a",
			association: "preceding_item",
			role: "user",
			text: "你帮我去看一下2799现在是什么状态。",
			final: true,
			inputOwner: {
				utteranceId: "founder-request",
				ownerUserId: "founder",
				ownerName: "Annie",
			},
			raw: {},
		} as never);
		await vi.waitFor(() => expect(persisted).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(published).toHaveBeenCalledOnce());

		callbacks.onExecutionIntent({
			generation: 1,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-a",
			params: { item: { type: "commandExecution" } },
		} as never);
		await vi.waitFor(() => expect(handoffToLead).toHaveBeenCalledOnce());
		expect(handoffToLead).toHaveBeenCalledWith({
			utterance: expect.objectContaining({
				transcriptId: "session-handoff:1:user-a:1",
				text: "你帮我去看一下2799现在是什么状态。",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
			intent: expect.objectContaining({
				kind: "commandExecution",
				itemId: "exec-a",
			}),
		});
		expect(close).not.toHaveBeenCalled();
		expect(errors).toEqual([]);

		expect(evidence).toHaveBeenCalledWith({
			kind: "codex_execution_handoff",
			generation: 1,
			backendIntentKind: "commandExecution",
			backendMethod: "item/started",
			backendItemId: "exec-a",
			transcriptId: "session-handoff:1:user-a:1",
			handoffId: "handoff-a",
			state: "dispatched",
		});

		await session.close();
	});

	it("records backpressure as a gap without ending the room session", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const appendAudio = vi
			.fn()
			.mockReturnValueOnce("dropped:backpressure" as const)
			.mockReturnValue("sent" as const);
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-backpressure",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						generation: 1,
						transport: {
							appendAudio,
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						restart: vi.fn(async () => 2),
						close: vi.fn(async () => undefined),
					};
				}),
			},
			loadContext: vi.fn(),
			resolveSoleRoomUser: () => ({ userId: "founder", name: "Annie" }),
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const errors: Error[] = [];
		const utterances: Array<{ attribution: unknown; text: string }> = [];
		session.on("error", (error) => errors.push(error));
		session.on("utterance", (utterance) => utterances.push(utterance));

		session.sendAudio(Buffer.alloc(960), {
			encoding: "pcm16",
			sampleRateHz: 24_000,
			channels: 1,
		});
		session.sendAudio(Buffer.alloc(960), {
			encoding: "pcm16",
			sampleRateHz: 24_000,
			channels: 1,
		});

		expect(appendAudio).toHaveBeenCalledTimes(2);
		expect(errors).toEqual([]);

		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "背压缺口后的句子",
			final: true,
			raw: {},
		} as never);
		expect(utterances.at(-1)).toMatchObject({
			text: "背压缺口后的句子",
			attribution: { kind: "unknown", reason: "input_gap" },
		});

		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "无缺口的重说",
			final: true,
			raw: {},
		} as never);
		expect(utterances.at(-1)).toMatchObject({
			text: "无缺口的重说",
			attribution: { kind: "known", speakerUserId: "founder" },
		});

		callbacks.onInputGap({ reason: "rpc_error", droppedBytes: 960 });
		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "RPC 缺口后的句子",
			final: true,
			raw: {},
		} as never);
		expect(utterances.at(-1)).toMatchObject({
			text: "RPC 缺口后的句子",
			attribution: { kind: "unknown", reason: "input_gap" },
		});
	});

	it("turns a continuously owned user item into known attribution", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const actual = new CodexVoiceBackend({
			sessionId: "session-owner",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						generation: 1,
						transport: {
							appendAudio: vi.fn(() => "sent" as const),
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						restart: vi.fn(async () => 2),
						close: vi.fn(async () => undefined),
					};
				}),
			},
			loadContext: vi.fn(),
		});
		const session = await actual.createConversation({ brain });
		const utterances: unknown[] = [];
		session.on("utterance", (utterance) => utterances.push(utterance));
		callbacks.onTranscript({
			generation: 1,
			itemId: "user-1",
			association: "preceding_item",
			role: "user",
			text: "请交给本体",
			final: true,
			inputOwner: {
				utteranceId: "room-utterance-1",
				ownerUserId: "founder",
				ownerName: "Annie",
			},
			raw: {},
		} as never);

		expect(utterances).toEqual([
			expect.objectContaining({
				utteranceId: "room-utterance-1",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
		]);
	});

	it("attributes an itemless transcript only to the sole present room user and publishes it", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const mirror = vi.fn(async () => ({ messageId: "discord-user" }));
		const evidence = vi.fn();
		const publisher = new CodexTranscriptPublisher({
			sessionId: "session-sole-user",
			founderUserId: "founder",
			displayName: "Raya",
			mirror,
			evidence,
		});
		const handoffToLead = vi.fn(async () => ({
			handoffId: "handoff-sole-user",
			state: "dispatched" as const,
			idempotencyKey: "codex-delegate:sole-user",
			requestDigest: "d".repeat(64),
		}));
		let soleRoomUser: { userId: string; name: string | null } | null = {
			userId: "founder",
			name: "Annie",
		};
		const actual = new CodexVoiceBackend({
			sessionId: "session-sole-user",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						generation: 1,
						transport: {
							appendAudio: vi.fn(() => "sent" as const),
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						restart: vi.fn(async () => 2),
						close: vi.fn(async () => undefined),
					};
				}),
			},
			loadContext: vi.fn(),
			persistUtterance: vi.fn(async () => undefined),
			publishUtterance: (utterance) => publisher.publish(utterance),
			handoffToLead,
			resolveSoleRoomUser: () => soleRoomUser,
			onEvidence: evidence,
		});
		const onTranscript = vi.fn();
		const onUnattributedTranscript = vi.fn();
		const frontend = new CodexRoomFrontend({
			backend: actual,
			conversationOptions: { brain },
			handlers: {
				onResponseState: vi.fn(),
				onTranscript,
				onUnattributedTranscript,
				onSpeechAudioReady: vi.fn(),
				onSpeechResult: vi.fn(),
				onClosed: vi.fn(),
			},
			onUnavailable: vi.fn(),
		});
		await frontend.start();
		frontend.appendAudio(Buffer.alloc(960), {
			utteranceId: "discord-founder-turn",
			ownerUserId: "founder",
			ownerName: "Annie",
		});

		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "你帮我去看一下 2799",
			final: true,
			raw: {},
		} as never);

		await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledOnce());
		expect(onTranscript).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "你帮我去看一下 2799",
				ownerUserId: "founder",
			}),
		);
		await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce());
		expect(mirror).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "🎙️ **你（语音）**：你帮我去看一下 2799",
			}),
		);

		callbacks.onExecutionIntent({
			generation: 1,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-sole-user",
			params: { item: { type: "commandExecution" } },
		} as never);
		await vi.waitFor(() => expect(handoffToLead).toHaveBeenCalledOnce());
		expect(handoffToLead).toHaveBeenCalledWith({
			utterance: expect.objectContaining({
				text: "你帮我去看一下 2799",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
			intent: expect.objectContaining({ itemId: "exec-sole-user" }),
		});

		soleRoomUser = null;
		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "多人房里这句不能授权",
			final: true,
			raw: {},
		} as never);
		callbacks.onExecutionIntent({
			generation: 1,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-ambiguous-user",
			params: { item: { type: "commandExecution" } },
		} as never);
		await vi.waitFor(() =>
			expect(onUnattributedTranscript).toHaveBeenCalledWith(
				expect.objectContaining({ text: "多人房里这句不能授权" }),
			),
		);
		await vi.waitFor(() => expect(mirror).toHaveBeenCalledTimes(2));
		expect(mirror.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				text: "🎙️ **语音输入**：多人房里这句不能授权",
			}),
		);
		expect(handoffToLead).toHaveBeenCalledOnce();
		await frontend.stop();
	});

	it("asks for a repeat when a user transcript remains unattributed", async () => {
		let onUtterance!: (utterance: unknown) => void;
		const session = {
			...conversation(),
			on: vi.fn((event: string, handler: (...args: never[]) => void) => {
				if (event === "utterance")
					onUtterance = handler as (utterance: unknown) => void;
				return () => undefined;
			}),
		};
		const onTranscript = vi.fn();
		const onUnattributedTranscript = vi.fn();
		const frontend = new CodexRoomFrontend({
			backend: backend(async () => session),
			conversationOptions: { brain },
			handlers: {
				onResponseState: vi.fn(),
				onTranscript,
				onUnattributedTranscript,
				onSpeechAudioReady: vi.fn(),
				onSpeechResult: vi.fn(),
				onClosed: vi.fn(),
			} as never,
			onUnavailable: vi.fn(),
		});
		await frontend.start();

		onUtterance({
			transcriptId: "session:1:unattributed:1",
			utteranceId: "session:1:unattributed",
			sequence: 1,
			role: "user",
			text: "请再听一次",
			final: true,
			attribution: { kind: "unknown", reason: "provider_item_unattributed" },
		});

		expect(onTranscript).not.toHaveBeenCalled();
		expect(onUnattributedTranscript).toHaveBeenCalledWith({
			itemId: "session:1:unattributed:1",
			text: "请再听一次",
			reason: "provider_item_unattributed",
		});
		await frontend.stop();
	});

	it("registers Codex only at the composition root", async () => {
		const registry = new BackendRegistry();
		expect(registry.has("codex-realtime")).toBe(false);
		registerCodexVoiceBackend(registry, () =>
			backend(async () => conversation()),
		);
		expect(registry.ids()).toEqual(["codex-realtime"]);
		expect((await registry.create("codex-realtime")).id).toBe("codex-realtime");
	});

	it("still closes the ephemeral container when Bridge transcript durability fails", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const close = vi.fn(async () => undefined);
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-durability",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						transport: {
							appendAudio: vi.fn(() => "sent" as const),
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						close,
					};
				}),
			},
			loadContext: vi.fn(),
			persistUtterance: vi.fn(async () => {
				throw new Error("bridge_down");
			}),
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const errors: Error[] = [];
		session.on("error", (error) => errors.push(error));
		callbacks.onTranscript({
			generation: 1,
			itemId: "user-1",
			association: "preceding_item",
			role: "user",
			text: "需要交给本体",
			final: true,
			raw: {},
		} as never);

		await session.close();
		expect(close).toHaveBeenCalledOnce();
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "codex_bridge_utterance_write_failed",
				reason: "bridge_down",
			}),
		);
		expect(errors).toHaveLength(1);
	});

	it("closes the ephemeral conversation before a room leave finishes", async () => {
		const close = vi.fn(async () => undefined);
		const roomStop = vi.fn(async () => undefined);
		let roomHandlers!: {
			onFounderPresence(present: boolean): void;
		};
		const frontend = new CodexRoomFrontend({
			backend: backend(async () => conversation(close)),
			conversationOptions: { brain },
			onUnavailable: vi.fn(),
		});
		const session = new GenericVoiceSession({
			projection: {
				sessionId: "session-a",
				mode: "meeting",
				projectName: "flywheel",
				leadId: "raya",
				displayName: "Raya",
				realtimeVoice: "marin",
				guildId: "1",
				voiceChannelId: "2",
				voiceBotUserId: "3",
				threadId: "4",
				boundChannelIds: [],
				founderUserId: "founder",
				qaAllowUserIds: [],
			},
			delivery: { capture: vi.fn(async () => false) },
			createFrontend: () => frontend,
			createRoom: (handlers) => {
				roomHandlers = handlers;
				return {
					start: async () => ({ founderPresent: true }),
					playSpeech: async () => undefined,
					status: async () => undefined,
					stop: roomStop,
				};
			},
			lifecycle: vi.fn(),
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		await session.start();
		await session.markLive();
		roomHandlers.onFounderPresence(false);
		expect(await session.waitForEnd()).toEqual({
			kind: "ended",
			reason: "she-left",
		});
		await session.stop({ kind: "ended", reason: "she-left" });
		expect(close).toHaveBeenCalledOnce();
		expect(roomStop).toHaveBeenCalledOnce();
		expect(close.mock.invocationCallOrder[0]).toBeLessThan(
			roomStop.mock.invocationCallOrder[0]!,
		);
	});

	it.each([
		["codex_quota_exhausted", "额度"],
		["codex_auth_rejected", "认证"],
	] as const)(
		"surfaces %s as unavailable without fallback",
		async (reason, copy) => {
			const unavailable = vi.fn();
			const create = vi.fn(async () => {
				throw new CodexVoiceContainerError(reason);
			});
			const frontend = new CodexRoomFrontend({
				backend: backend(create),
				conversationOptions: { brain },
				onUnavailable: unavailable,
			});
			await expect(frontend.start()).rejects.toThrow("voice_unavailable");
			expect(create).toHaveBeenCalledOnce();
			expect(unavailable).toHaveBeenCalledWith(
				expect.stringContaining("语音不可用"),
			);
			expect(unavailable).toHaveBeenCalledWith(expect.stringContaining(copy));
		},
	);
});
