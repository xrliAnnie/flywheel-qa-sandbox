import {
	BackendRegistry,
	type BrainAdapter,
	type ConversationSession,
	type VoiceBackend,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import {
	CodexRoomFrontend,
	registerCodexVoiceBackend,
} from "../codex/CodexRoomFrontend.js";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";
import { CodexVoiceContainerError } from "../codex/CodexVoiceContainer.js";
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
	it("maps the V2 transport into the shared session without claiming attribution", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const appendAudio = vi.fn(() => "sent" as const);
		const close = vi.fn(async () => undefined);
		const container = {
			open: vi.fn(async (input: { realtime: typeof callbacks }) => {
				callbacks = input.realtime;
				return {
					transport: {
						appendAudio,
						appendSpeech: vi.fn(async () => undefined),
						appendText: vi.fn(async () => undefined),
						cancel: vi.fn(async () => undefined),
					},
					close,
				};
			}),
		};
		const played = vi.fn(async () => undefined);
		const persisted = vi.fn(async () => undefined);
		const actual = new CodexVoiceBackend({
			sessionId: "session-v2",
			voice: "marin",
			container,
			loadContext: vi.fn(),
			playAudio: played,
			persistUtterance: persisted,
		});
		expect(actual.capabilities).toMatchObject({
			converse: true,
			bargeIn: false,
			verbatim: false,
			attribution: false,
		});
		const session = await actual.createConversation({ brain });
		const utterances: unknown[] = [];
		session.on("utterance", (value) => utterances.push(value));
		session.sendAudio(Buffer.alloc(480), {
			encoding: "pcm16",
			sampleRateHz: 24_000,
			channels: 1,
		});
		expect(appendAudio).toHaveBeenCalledWith(expect.any(Buffer), 1, {
			ownerUserId: null,
			utteranceId: null,
		});

		callbacks.onItem({
			generation: 1,
			itemId: "assistant-1",
			role: "assistant",
			raw: {},
		} as never);
		callbacks.onAudio({
			generation: 1,
			itemId: "assistant-1",
			pcm24Mono: Buffer.alloc(960),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		callbacks.onTranscript({
			generation: 1,
			itemId: "assistant-1",
			association: "preceding_item",
			role: "assistant",
			text: "你好",
			final: true,
			raw: {},
		} as never);
		await vi.waitFor(() => expect(played).toHaveBeenCalledOnce());
		expect(played).toHaveBeenCalledWith(
			expect.objectContaining({ itemId: "assistant-1" }),
		);
		expect(utterances).toEqual([
			expect.objectContaining({
				role: "assistant",
				text: "你好",
				attribution: { kind: "unknown", reason: "engine_output" },
			}),
		]);
		await session.close();
		expect(persisted).toHaveBeenCalledWith(
			expect.objectContaining({
				attribution: { kind: "unknown", reason: "engine_output" },
			}),
			expect.stringMatching(/^[a-f0-9]{64}$/),
		);
		expect(close).toHaveBeenCalledOnce();
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
