import { describe, expect, it, vi } from "vitest";
import type { VoiceSessionProjection } from "../bridge-client.js";
import {
	type FrontendHandlers,
	GenericVoiceSession,
	type RoomHandlers,
} from "../session.js";
import { prepareReplySpeech } from "../speech.js";

const projection: VoiceSessionProjection = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	voiceBotUserId: "323456789012345678",
	mode: "meeting",
	projectName: "raya",
	leadId: "raya",
	displayName: "Raya",
	realtimeVoice: "marin",
	guildId: "guild",
	voiceChannelId: "voice",
	threadId: "thread",
	boundChannelIds: ["thread"],
	founderUserId: "founder",
	qaAllowUserIds: ["qa"],
};

function userTranscript(text: string) {
	return {
		itemId: "item-1",
		contentIndex: 0,
		text,
		ownerUserId: "founder",
		speakerName: "Annie",
		utteranceId: "utterance-1",
	};
}

function fixture(options?: {
	founderPresent?: boolean;
	playSpeech?: (speechId: string, pcm: Buffer) => Promise<void>;
	appendSpeech?: () => Promise<
		"confirmed" | "unconfirmed" | "failed" | undefined
	>;
	coordinatedSpeech?: boolean;
	/** FLY-2886 §14.2: false once the background degraded at open. */
	coordinationActive?: () => boolean;
	rewriteSpeech?: (input: {
		sourceText: string;
		rosterNames: readonly string[];
		recentFounderAsks?: readonly string[];
	}) => Promise<{
		spoken: string;
		threadText: string | null;
		protectedFieldEvidence: [];
		tell?: boolean;
		skipReason?: "ack_only" | "receipt_only" | "no_new_information" | null;
	}>;
}) {
	let frontendHandlers!: FrontendHandlers;
	let roomHandlers!: RoomHandlers;
	const frontend = {
		start: vi.fn(async () => {}),
		appendAudio: vi.fn(),
		rewriteSpeech: vi.fn(
			options?.rewriteSpeech ??
				(async () => ({
					spoken: "FLY-2886 已查到 PR #1326。",
					threadText: null,
					protectedFieldEvidence: [],
				})),
		),
		appendSpeech: vi.fn(options?.appendSpeech ?? (async () => {})),
		cancelSpeech: vi.fn(),
		stop: vi.fn(async () => {}),
	};
	const room = {
		start: vi.fn(async () => ({
			founderPresent: options?.founderPresent ?? true,
		})),
		playSpeech: vi.fn(options?.playSpeech ?? (async () => {})),
		cancelSpeech: vi.fn(),
		cancelAllSpeech: vi.fn(),
		status: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		setWaiting: vi.fn(),
		setBedEnabled: vi.fn(),
	};
	const delivery = { capture: vi.fn(async () => true) };
	const lifecycle = vi.fn(async () => {});
	const evidence = vi.fn();
	const postThread = vi.fn(async () => undefined);
	const persistCloseSnapshot = vi.fn((_snapshot?: unknown) => undefined);
	const finalize = vi.fn(
		async (_outcome?: unknown, _snapshot?: unknown) => undefined,
	);
	const session = new GenericVoiceSession({
		projection,
		delivery,
		createFrontend: (handlers) => {
			frontendHandlers = handlers;
			return frontend;
		},
		createRoom: (handlers) => {
			roomHandlers = handlers;
			return room;
		},
		lifecycle,
		evidence,
		confirmationMs: 100,
		finalize,
		persistCloseSnapshot,
		...(options?.coordinatedSpeech
			? {
					speechCoordination: {
						postThread,
						...(options.coordinationActive
							? { active: options.coordinationActive }
							: {}),
					},
				}
			: {}),
	});
	return {
		session,
		frontend,
		room,
		delivery,
		lifecycle,
		evidence,
		postThread,
		finalize,
		persistCloseSnapshot,
		getFrontendHandlers: () => frontendHandlers,
		getRoomHandlers: () => roomHandlers,
	};
}

describe("GenericVoiceSession", () => {
	it("rewrites original Lead text before queuing one tell and does not play before floor release", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture({
				coordinatedSpeech: true,
				appendSpeech: async () => "confirmed",
			});
			await test.session.start();
			await test.session.markLive();
			test.getRoomHandlers().onLocalUtteranceStarted?.("u1");
			const result = test.session.deliverTell({
				businessId: "tell:1",
				text: "**FLY-2886** 已经查到 PR #1326。",
			});
			await vi.advanceTimersByTimeAsync(1000);
			expect(test.frontend.rewriteSpeech).toHaveBeenCalledWith({
				sourceText: "**FLY-2886** 已经查到 PR #1326。",
				rosterNames: ["Raya"],
				recentFounderAsks: [],
			});
			expect(test.frontend.appendSpeech).not.toHaveBeenCalled();
			test.getRoomHandlers().onLocalUtteranceEnded?.("u1");
			await vi.advanceTimersByTimeAsync(800);
			await expect(result).resolves.toBe("spoken");
			expect(test.frontend.appendSpeech).toHaveBeenCalledTimes(1);
			expect(test.frontend.appendSpeech).toHaveBeenCalledWith(
				expect.objectContaining({ spokenText: "FLY-2886 已查到 PR #1326。" }),
			);
			await test.session.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([true, false])(
		"publishes original text before fallback pointer, post success=%s",
		async (postSuccess) => {
			vi.useFakeTimers();
			try {
				const test = fixture({
					coordinatedSpeech: true,
					appendSpeech: async () => "confirmed",
					rewriteSpeech: async () => {
						throw new Error("script_writer_output_invalid");
					},
				});
				let finishPost!: () => void;
				test.postThread.mockImplementationOnce(
					() =>
						new Promise<void>((resolve, reject) => {
							finishPost = () =>
								postSuccess ? resolve() : reject(new Error("offline"));
						}),
				);
				await test.session.start();
				await test.session.markLive();
				const result = test.session.deliverTell({
					businessId: "tell:1",
					text: "FLY-2886 PR #1326",
				});
				await vi.advanceTimersByTimeAsync(1000);
				expect(test.postThread).toHaveBeenCalledWith({
					businessId: "tell:1",
					text: "FLY-2886 PR #1326",
				});
				expect(test.frontend.appendSpeech).not.toHaveBeenCalled();
				finishPost();
				await vi.advanceTimersByTimeAsync(800);
				await expect(result).resolves.toBe(
					postSuccess ? "fallback_posted" : "failed",
				);
				expect(test.frontend.appendSpeech).toHaveBeenCalledWith(
					expect.objectContaining({
						spokenText: postSuccess
							? "这条我发到 thread 了，编号以文字为准。"
							: "编号我没核对上，等下再给你",
					}),
				);
				await test.session.stop();
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("holds enabled repeat fallback on the same local speech floor", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture({
				coordinatedSpeech: true,
				appendSpeech: async () => "confirmed",
			});
			await test.session.start();
			await test.session.markLive();
			test.getRoomHandlers().onLocalUtteranceStarted?.("u1");
			test.getFrontendHandlers().onCoordinatedSpeech?.({
				businessId: "repeat-1",
				text: "请再说一遍。",
			});
			await vi.advanceTimersByTimeAsync(1000);
			expect(test.frontend.appendSpeech).not.toHaveBeenCalled();
			test.getRoomHandlers().onLocalUtteranceEnded?.("u1");
			await vi.advanceTimersByTimeAsync(800);
			expect(test.frontend.appendSpeech).toHaveBeenCalledOnce();
			await test.session.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds coordinated speech until local VAD has been idle for 800ms", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const test = fixture({
				coordinatedSpeech: true,
				appendSpeech: async () => "confirmed",
			});
			await test.session.start();
			await test.session.markLive();
			const speech = prepareReplySpeech("FLY-2886 已查到。", 80)[0]!;

			test.getRoomHandlers().onLocalUtteranceStarted?.("founder-1");
			const result = test.session.speak(speech);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(test.frontend.appendSpeech).not.toHaveBeenCalled();

			test.getRoomHandlers().onLocalUtteranceEnded?.("founder-1");
			await vi.advanceTimersByTimeAsync(799);
			expect(test.frontend.appendSpeech).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(test.frontend.appendSpeech).toHaveBeenCalledWith(
				expect.objectContaining({
					speechId: `${speech.speechId}:attempt:0`,
					spokenText: speech.spokenText,
				}),
			);
			await expect(result).resolves.toBe("confirmed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles an enabled background obligation through the coordinated speech floor", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const test = fixture({
				coordinatedSpeech: true,
				appendSpeech: async () => "confirmed",
			});
			await test.session.start();
			await test.session.markLive();

			test.getFrontendHandlers().onBackgroundHandoff?.({
				handoffId: "handoff-a",
				inputTranscript: "查 FLY-2886",
			});
			test.getFrontendHandlers().onBackgroundTurnStarted?.("turn-a");
			test.getFrontendHandlers().onBackgroundTurnTerminal?.({
				turnId: "turn-a",
				outcome: "completed",
				spokenSegments: ["FLY-2886 在 PR #1324。"],
				sources: [{ itemId: "completed-tool", text: "FLY-2886 PR #1324" }],
			});

			await vi.advanceTimersByTimeAsync(800);
			await vi.waitFor(() =>
				expect(test.frontend.appendSpeech).toHaveBeenCalledWith(
					expect.objectContaining({
						spokenText: "FLY-2886 在 PR #1324。",
					}),
				),
			);
			expect(test.postThread).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// FLY-2886 QA@4 D2 (3/3 real sessions): the result arrived while the realtime
	// generation was being replaced, speak was rejected not_live, and the result
	// was dropped. It must be replayed once the new generation is live.
	it("replays a background result the frontend deferred while the generation was being replaced", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const outcomes: Array<"deferred" | "confirmed"> = [
				"deferred",
				"confirmed",
			];
			const test = fixture({
				coordinatedSpeech: true,
				appendSpeech: async () => outcomes.shift() as never,
			});
			await test.session.start();
			await test.session.markLive();
			test.getFrontendHandlers().onBackgroundHandoff?.({
				handoffId: "handoff-d2",
				inputTranscript: "查 FLY-2886 的 PR",
			});
			test.getFrontendHandlers().onBackgroundTurnStarted?.("turn-d2");
			test.getFrontendHandlers().onBackgroundTurnTerminal?.({
				turnId: "turn-d2",
				outcome: "completed",
				spokenSegments: ["FLY-2886 在 PR #1360。"],
				sources: [{ itemId: "tool", text: "FLY-2886 PR #1360" }],
			});
			await vi.advanceTimersByTimeAsync(800);
			await vi.waitFor(() =>
				expect(test.frontend.appendSpeech).toHaveBeenCalledTimes(1),
			);
			test.getFrontendHandlers().onGenerationChanged?.(2);
			await vi.advanceTimersByTimeAsync(800);
			await vi.waitFor(() =>
				expect(test.frontend.appendSpeech).toHaveBeenCalledTimes(2),
			);
			const keys = test.frontend.appendSpeech.mock.calls.map(
				(call) => (call as unknown as [{ speechId: string }])[0].speechId,
			);
			expect(keys[1]).not.toBe(keys[0]);
			for (const call of test.frontend.appendSpeech.mock.calls)
				expect(
					(call as unknown as [{ spokenText: string }])[0].spokenText,
				).toBe("FLY-2886 在 PR #1360。");
			expect(test.postThread).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("routes an audio-attributed final exactly once with a deterministic transcript id", async () => {
		const test = fixture();
		await test.session.start();
		await test.session.markLive();
		test.getFrontendHandlers().onTranscript(userTranscript("请检查 FLY-2655"));
		await vi.waitFor(() =>
			expect(test.delivery.capture).toHaveBeenCalledOnce(),
		);
		expect(test.delivery.capture).toHaveBeenCalledWith({
			transcriptId: `${projection.sessionId}:1:item-1:0`,
			speakerUserId: "founder",
			speakerName: "Annie",
			rawText: "请检查 FLY-2655",
			ts: expect.any(String),
		});
		// FLY-2799 qa6 / founder 9-24: no waiting music after she speaks; with no
		// update the room stays quiet.
		expect(test.room.setWaiting).not.toHaveBeenCalledWith(true);
	});

	it("uses founder audio to cancel active Codex output once before forwarding the frame", async () => {
		const test = fixture();
		await test.session.start();
		await test.session.markLive();
		const owner = {
			utteranceId: "founder-turn",
			ownerUserId: "founder",
			ownerName: "Annie",
		};
		const pcm = Buffer.alloc(960);

		test.getFrontendHandlers().onResponseState(true);
		test.getRoomHandlers().onAudio(pcm, owner);
		test.getRoomHandlers().onAudio(pcm, owner);

		expect(test.frontend.cancelSpeech).toHaveBeenCalledOnce();
		expect(test.frontend.cancelSpeech).toHaveBeenCalledWith("__conversation__");
		expect(test.room.cancelAllSpeech).toHaveBeenCalledOnce();
		expect(test.room.cancelSpeech).not.toHaveBeenCalled();
		expect(test.frontend.appendAudio).toHaveBeenCalledTimes(2);
	});

	it("confirms a reply only after validated audio finishes paced playback", async () => {
		let finishPlayback!: () => void;
		const playback = new Promise<void>((resolve) => {
			finishPlayback = resolve;
		});
		const test = fixture({ playSpeech: async () => playback });
		await test.session.start();
		await test.session.markLive();
		const speech = prepareReplySpeech("已经检查。", 80)[0]!;
		let settled = false;
		const result = test.session.speak(speech).then((value) => {
			settled = true;
			return value;
		});
		await vi.waitFor(() =>
			expect(test.frontend.appendSpeech).toHaveBeenCalledWith(speech),
		);
		const pcm = Buffer.alloc(1_920, 1);
		test.getFrontendHandlers().onSpeechAudioReady({
			speechId: speech.speechId,
			pcm24Mono: pcm,
		});
		await vi.waitFor(() =>
			expect(test.room.playSpeech).toHaveBeenCalledWith(speech.speechId, pcm),
		);
		expect(settled).toBe(false);
		finishPlayback();
		expect(await result).toBe("confirmed");
		await vi.waitFor(() =>
			expect(test.room.status).toHaveBeenCalledWith("📻 已念完"),
		);
	});

	it("maps output timeout to unconfirmed without playing any bytes", async () => {
		const test = fixture();
		await test.session.start();
		await test.session.markLive();
		const speech = prepareReplySpeech("稍等。", 80)[0]!;
		const result = test.session.speak(speech);
		test.getFrontendHandlers().onSpeechResult({
			speechId: speech.speechId,
			status: "timeout",
			reason: "speech_generation_timeout",
		});
		expect(await result).toBe("unconfirmed");
		expect(test.room.playSpeech).not.toHaveBeenCalled();
		expect(test.room.status).toHaveBeenCalledWith("📻 这段未朗读，请看文字");
	});

	it("fails the session when released audio cannot finish playback", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture({ playSpeech: () => new Promise(() => {}) });
			await test.session.start();
			await test.session.markLive();
			const speech = prepareReplySpeech("播放测试。", 80)[0]!;
			const spoken = test.session.speak(speech);
			test.getFrontendHandlers().onSpeechAudioReady({
				speechId: speech.speechId,
				pcm24Mono: Buffer.alloc(960),
			});
			await vi.advanceTimersByTimeAsync(5_021);
			expect(await spoken).toBe("failed");
			expect(await test.session.waitForEnd()).toEqual({
				kind: "failed",
				reason: "realtime_playback_stalled",
			});
			expect(test.room.cancelSpeech).toHaveBeenCalledWith(speech.speechId);
		} finally {
			vi.useRealTimers();
		}
	});

	it("turns a normal realtime end before live into a startup failure", async () => {
		const test = fixture();
		await test.session.start();
		test.getFrontendHandlers().onClosed({
			kind: "ended",
			reason: "realtime_session_expiring",
		});
		expect(await test.session.waitForEnd()).toEqual({
			kind: "failed",
			reason: "realtime_pre_live_end",
		});
	});

	it("preserves a normal realtime end after the session is live", async () => {
		const test = fixture();
		await test.session.start();
		await test.session.markLive();
		test.getFrontendHandlers().onClosed({
			kind: "ended",
			reason: "realtime_session_expiring",
		});
		expect(await test.session.waitForEnd()).toEqual({
			kind: "ended",
			reason: "realtime_session_expiring",
		});
	});

	it("exposes receive health and keeps a degraded receive path alive", async () => {
		const test = fixture();
		await test.session.start();
		test.getRoomHandlers().onReceiveHealth({
			version: 1,
			sequence: 2,
			state: "degraded",
			reason: "dave_decrypt",
			failures: 1,
			retries: 0,
			lastPcmAt: null,
		});
		expect(test.session.receiveHealth()).toMatchObject({
			sequence: 2,
			state: "degraded",
			reason: "dave_decrypt",
		});
	});

	it("handles founder-only local commands without mailbox delivery", async () => {
		const test = fixture();
		await test.session.start();
		await test.session.markLive();
		test.getFrontendHandlers().onTranscript(userTranscript("等待音关掉"));
		expect(test.room.setBedEnabled).toHaveBeenCalledWith(false);
		expect(test.delivery.capture).not.toHaveBeenCalled();
		test.getFrontendHandlers().onTranscript(userTranscript("退出语音模式"));
		expect(await test.session.waitForEnd()).toEqual({
			kind: "ended",
			reason: "voice-stop",
		});
	});

	it("ignores late transport callbacks once teardown begins", async () => {
		let finishStop!: () => void;
		const stopPending = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		const test = fixture();
		test.room.stop.mockImplementation(() => stopPending);
		await test.session.start();
		await test.session.markLive();
		const handlers = test.getFrontendHandlers();
		const stopped = test.session.stop({ kind: "ended", reason: "text-stop" });
		handlers.onTranscript(userTranscript("late"));
		handlers.onSpeechAudioReady({
			speechId: "late",
			pcm24Mono: Buffer.alloc(960),
		});
		expect(test.delivery.capture).not.toHaveBeenCalled();
		expect(test.room.playSpeech).not.toHaveBeenCalled();
		finishStop();
		await stopped;
	});
});

describe("GenericVoiceSession cancellation", () => {
	it.each(["frontend", "room"])(
		"does not resume late %s startup after stop",
		async (stage) => {
			let release!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const test = fixture();
			test.frontend.start.mockImplementation(() =>
				stage === "frontend" ? pending : Promise.resolve(),
			);
			test.room.start.mockImplementation(async () => {
				if (stage === "room") await pending;
				return { founderPresent: true };
			});
			const starting = test.session.start();
			await Promise.resolve();
			await test.session.stop({ kind: "failed", reason: "lease_lost" });
			release();
			await expect(starting).rejects.toThrow("voice_session_stopped");
			expect(test.lifecycle).not.toHaveBeenCalledWith("ready");
		},
	);
});

describe("GenericVoiceSession prewarm gate (FLY-2701)", () => {
	function prewarmed(founderPresent = true) {
		let frontendHandlers!: FrontendHandlers;
		let roomHandlers!: RoomHandlers;
		const frontend = {
			start: vi.fn(async () => {}),
			appendAudio: vi.fn(),
			appendSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const room = {
			start: vi.fn(async () => ({ founderPresent })),
			playSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			setWaiting: vi.fn(),
			setBedEnabled: vi.fn(),
		};
		const delivery = { capture: vi.fn(async () => true) };
		const session = new GenericVoiceSession({
			projection: {
				...projection,
				notBeforeLiveAt: "2026-09-22T09:00:00.000Z",
			},
			delivery,
			createFrontend: (handlers) => {
				frontendHandlers = handlers;
				return frontend;
			},
			createRoom: (handlers) => {
				roomHandlers = handlers;
				return room;
			},
			lifecycle: vi.fn(async () => {}),
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		return {
			session,
			frontend,
			delivery,
			getFrontendHandlers: () => frontendHandlers,
			getRoomHandlers: () => roomHandlers,
		};
	}

	const frame = () => Buffer.alloc(960);
	const owner = { ownerUserId: "founder", speakerName: "Annie" } as never;

	it("holds room audio out of the model while it waits for the meeting time", async () => {
		const test = prewarmed();
		await test.session.start();
		test.getRoomHandlers().onAudio(frame(), owner);
		test.getFrontendHandlers().onTranscript(userTranscript("开会前的闲聊"));
		expect(test.frontend.appendAudio).not.toHaveBeenCalled();
		expect(test.delivery.capture).not.toHaveBeenCalled();
		await test.session.stop();
	});

	it("opens the microphone once the meeting actually starts", async () => {
		const test = prewarmed();
		await test.session.start();
		await test.session.markLive();
		test.getRoomHandlers().onAudio(frame(), owner);
		expect(test.frontend.appendAudio).toHaveBeenCalledTimes(1);
		await test.session.stop();
	});

	it("leaves an instant session unchanged: audio flows as soon as the room is up", async () => {
		const test = fixture();
		await test.session.start();
		test.getRoomHandlers().onAudio(frame(), owner);
		expect(test.frontend.appendAudio).toHaveBeenCalledTimes(1);
		await test.session.stop();
	});

	it("forgets a founder who arrived early and then left before the meeting", async () => {
		const test = prewarmed();
		await test.session.start();
		expect(test.session.isFounderPresent()).toBe(true);
		test.getRoomHandlers().onFounderPresence(false);
		// She was here at prewarm time. That is not evidence she is here now, and
		// going live into an empty room would leave the bot talking to nobody.
		expect(test.session.isFounderPresent()).toBe(false);
		await expect(test.session.waitForFounderPresence(10)).resolves.toBe(false);
		await test.session.stop();
	});

	it("resolves as soon as she comes back", async () => {
		const test = prewarmed(false);
		await test.session.start();
		const waiting = test.session.waitForFounderPresence(5_000);
		test.getRoomHandlers().onFounderPresence(true);
		await expect(waiting).resolves.toBe(true);
		expect(test.session.isFounderPresent()).toBe(true);
		await test.session.stop();
	});

	it("still ends a live session the moment she leaves", async () => {
		const test = prewarmed();
		await test.session.start();
		await test.session.markLive();
		const ended = test.session.waitForEnd();
		test.getRoomHandlers().onFounderPresence(false);
		await expect(ended).resolves.toEqual({
			kind: "ended",
			reason: "she-left",
		});
		await test.session.stop();
	});
});

/**
 * FLY-2701 review R1 (HIGH): between "she is here" and the media actually
 * opening there is an await — the Bridge's setState("live") round trip. If she
 * leaves inside it, the leave event arrives while `live` is still false, so the
 * end path ignores it; then markLive opens everything anyway and no second
 * leave event is ever coming. The session sits live in an empty room.
 *
 * The founder's rule is "she leaves, it leaves". Presence is therefore asked
 * again at the last possible moment, and a leave in that window ends the call.
 */
describe("GenericVoiceSession live transition presence race", () => {
	it("does not open media when she left during the Bridge round trip", async () => {
		const test = fixture({ founderPresent: true });
		await test.session.start();
		expect(await test.session.waitForFounderPresence(0)).toBe(true);

		// The Bridge ACK is in flight; she leaves.
		test.getRoomHandlers().onFounderPresence(false);
		await test.session.markLive();

		await expect(test.session.waitForEnd()).resolves.toEqual({
			kind: "ended",
			reason: "she-left",
		});
		// No media may have been opened on the way out.
		expect(test.lifecycle).not.toHaveBeenCalledWith("live");
		test.getFrontendHandlers().onTranscript(userTranscript("还在吗"));
		expect(test.delivery.capture).not.toHaveBeenCalled();
	});

	it("still goes live normally when she stayed", async () => {
		const test = fixture({ founderPresent: true });
		await test.session.start();
		await test.session.markLive();

		expect(test.lifecycle).toHaveBeenCalledWith("live");
		test.getFrontendHandlers().onTranscript(userTranscript("开始吧"));
		await vi.waitFor(() =>
			expect(test.delivery.capture).toHaveBeenCalledOnce(),
		);
	});

	it("goes live for an instant session that never tracked presence", async () => {
		// An rg session with no founder in the room is a normal case today; the
		// new guard must not turn it into an end.
		const test = fixture({ founderPresent: false });
		await test.session.start();
		test.getRoomHandlers().onFounderPresence(true);
		await test.session.markLive();

		expect(test.lifecycle).toHaveBeenCalledWith("live");
	});
});

/**
 * FLY-2701 review R1 (MEDIUM) — plan §7 / slice D "预热并行": the two start
 * branches share one AbortController and one 120s session-start deadline.
 * Neither waits for the other; the first failure fences the other; and a branch
 * that lands late is stopped rather than left sitting in the room.
 */
describe("GenericVoiceSession parallel start", () => {
	function branches(options: {
		frontend?: (signal?: AbortSignal) => Promise<void>;
		room?: (signal?: AbortSignal) => Promise<{ founderPresent: boolean }>;
		startDeadlineMs?: number;
	}) {
		const frontend = {
			start: vi.fn(options.frontend ?? (async () => {})),
			appendAudio: vi.fn(),
			appendSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const room = {
			start: vi.fn(options.room ?? (async () => ({ founderPresent: true }))),
			playSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			setWaiting: vi.fn(),
			setBedEnabled: vi.fn(),
		};
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn(async () => true) },
			createFrontend: () => frontend,
			createRoom: () => room,
			lifecycle: vi.fn(async () => {}),
			evidence: vi.fn(),
			confirmationMs: 100,
			...(options.startDeadlineMs === undefined
				? {}
				: { startDeadlineMs: options.startDeadlineMs }),
		});
		return { session, frontend, room };
	}

	it("starts both branches without either waiting for the other", async () => {
		let releaseFrontend!: () => void;
		const test = branches({
			frontend: () =>
				new Promise<void>((resolve) => {
					releaseFrontend = resolve;
				}),
		});

		const started = test.session.start();
		// The room must already be on its way while the frontend is still hanging.
		await vi.waitFor(() => expect(test.room.start).toHaveBeenCalled());
		releaseFrontend();
		await expect(started).resolves.toEqual({ founderPresent: true });
	});

	it("fences the other branch when one fails, and stops it if it lands late", async () => {
		let landRoom!: (value: { founderPresent: boolean }) => void;
		let aborted = false;
		const test = branches({
			frontend: async () => {
				throw new Error("realtime refused");
			},
			room: (signal) =>
				new Promise((resolve) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
					});
					landRoom = resolve;
				}),
		});

		const started = test.session.start();

		// The caller learns about the failure while the room is *still pending* —
		// that is what fail-fast means, and awaiting it here, before the room is
		// ever landed, is what proves it: an implementation that waited for the
		// other branch would hang on this line forever. Awaiting it first also
		// keeps the rejection handled from the tick it is created, which is what
		// stops it surfacing as an unhandled rejection.
		await expect(started).rejects.toThrow("realtime refused");
		expect(aborted).toBe(true);

		// The room ignores the fence and finishes anyway: the bot is now in the
		// channel with nothing driving it, so the session must take it back out.
		landRoom({ founderPresent: true });
		await vi.waitFor(() => expect(test.room.stop).toHaveBeenCalled());
	});

	it("gives the whole start one deadline and cleans up what lands after it", async () => {
		let landRoom!: (value: { founderPresent: boolean }) => void;
		const test = branches({
			startDeadlineMs: 10,
			room: () =>
				new Promise((resolve) => {
					landRoom = resolve;
				}),
		});

		const started = test.session.start();
		await expect(started).rejects.toThrow("voice_session_start_timeout");
		landRoom({ founderPresent: true });

		await vi.waitFor(() => expect(test.room.stop).toHaveBeenCalled());
		expect(test.frontend.stop).toHaveBeenCalled();
	});
});

/**
 * FLY-2701 review R2 (HIGH): parallelising the start turned the room's
 * `founderPresent` into a snapshot that can go stale. The room subscribes to
 * presence *before* it reads the channel, so an event that arrives while the
 * other branch is still starting is strictly newer than the snapshot — but the
 * snapshot was applied afterwards and rolled it back. markLive's re-read then
 * saw the rolled-back value and opened the media anyway.
 */
describe("GenericVoiceSession presence ordering across a parallel start", () => {
	function orderedFixture() {
		let roomHandlers!: RoomHandlers;
		let releaseFrontend!: () => void;
		let landRoom!: (value: { founderPresent: boolean }) => void;
		const frontend = {
			start: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						releaseFrontend = resolve;
					}),
			),
			appendAudio: vi.fn(),
			appendSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const room = {
			start: vi.fn(
				() =>
					new Promise<{ founderPresent: boolean }>((resolve) => {
						landRoom = resolve;
					}),
			),
			playSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			setWaiting: vi.fn(),
			setBedEnabled: vi.fn(),
		};
		const lifecycle = vi.fn(async () => {});
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn(async () => true) },
			createFrontend: () => frontend,
			createRoom: (handlers) => {
				roomHandlers = handlers;
				return room;
			},
			lifecycle,
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		return {
			session,
			lifecycle,
			handlers: () => roomHandlers,
			landRoom: (present: boolean) => landRoom({ founderPresent: present }),
			releaseFrontend: () => releaseFrontend(),
		};
	}

	it("keeps a leave that happened after the room read the channel", async () => {
		const test = orderedFixture();
		const started = test.session.start();

		test.landRoom(true);
		// She leaves while the model connection is still coming up.
		test.handlers().onFounderPresence(false);
		test.releaseFrontend();
		// FLY-2701 review R3: the *returned* value matters too. The daemon's
		// instant path trusts `started.founderPresent` and commits `live` to the
		// Bridge on it, so a stale `true` here shows a durable live state for a
		// call nobody is in — permanently, if the process dies in that window.
		await expect(started).resolves.toEqual({ founderPresent: false });

		expect(test.session.isFounderPresent()).toBe(false);
		await test.session.markLive();
		expect(test.lifecycle).not.toHaveBeenCalledWith("live");
	});

	it("keeps a join that happened after the room read an empty channel", async () => {
		const test = orderedFixture();
		const started = test.session.start();

		test.landRoom(false);
		test.handlers().onFounderPresence(true);
		test.releaseFrontend();
		await expect(started).resolves.toEqual({ founderPresent: true });

		expect(test.session.isFounderPresent()).toBe(true);
		await test.session.markLive();
		expect(test.lifecycle).toHaveBeenCalledWith("live");
	});

	it("still uses the room snapshot when no event contradicted it", async () => {
		const test = orderedFixture();
		const started = test.session.start();

		test.landRoom(true);
		test.releaseFrontend();
		await started;

		expect(test.session.isFounderPresent()).toBe(true);
	});
});

/**
 * FLY-2701 review R2 (HIGH): cleanup was gated on `Promise.all` of both
 * branches, so the one case that actually leaks a joined bot — the room lands
 * and the model connection never settles at all — never cleaned up, because
 * that combined promise never resolved. Each branch now hands itself back the
 * moment it lands into an abandoned start, independently of the other.
 */
describe("GenericVoiceSession start cleanup is per-branch", () => {
	function hangingFrontend(startDeadlineMs: number) {
		let landRoom!: (value: { founderPresent: boolean }) => void;
		const frontend = {
			start: vi.fn(() => new Promise<void>(() => {})),
			appendAudio: vi.fn(),
			appendSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const room = {
			start: vi.fn(
				() =>
					new Promise<{ founderPresent: boolean }>((resolve) => {
						landRoom = resolve;
					}),
			),
			playSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			setWaiting: vi.fn(),
			setBedEnabled: vi.fn(),
		};
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn(async () => true) },
			createFrontend: () => frontend,
			createRoom: () => room,
			lifecycle: vi.fn(async () => {}),
			evidence: vi.fn(),
			confirmationMs: 100,
			startDeadlineMs,
		});
		return {
			session,
			frontend,
			room,
			landRoom: () => landRoom({ founderPresent: true }),
		};
	}

	it("stops a room that landed before the deadline while the model never settles", async () => {
		const test = hangingFrontend(10);
		const started = test.session.start();
		test.landRoom();

		await expect(started).rejects.toThrow("voice_session_start_timeout");
		await vi.waitFor(() => expect(test.room.stop).toHaveBeenCalled());
	});

	it("stops a room that lands long after the deadline already passed", async () => {
		const test = hangingFrontend(10);
		const started = test.session.start();

		await expect(started).rejects.toThrow("voice_session_start_timeout");
		expect(test.room.stop).not.toHaveBeenCalled();
		// The room ignored the fence and finally joins, minutes later.
		test.landRoom();

		await vi.waitFor(() => expect(test.room.stop).toHaveBeenCalled());
	});

	it("does not wait for the hung branch before releasing the one that landed", async () => {
		const test = hangingFrontend(10);
		const started = test.session.start();
		test.landRoom();
		await expect(started).rejects.toThrow("voice_session_start_timeout");

		// The frontend is still hanging and always will be; cleanup of the room
		// must not be behind it.
		await vi.waitFor(() => expect(test.room.stop).toHaveBeenCalled());
		expect(test.frontend.start).toHaveBeenCalled();
	});
});

/**
 * FLY-2701 review R2: plan §7's 120s is a ceiling over preflight AND both
 * branches. Starting the clock when the branches begin quietly grants the whole
 * budget again to a start that already spent most of it verifying identity.
 */
describe("GenericVoiceSession start budget includes preflight", () => {
	it("gives the branches only what the caller's deadline has left", async () => {
		const now = 1_000_000;
		const room = {
			start: vi.fn(() => new Promise<{ founderPresent: boolean }>(() => {})),
			playSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			setWaiting: vi.fn(),
			setBedEnabled: vi.fn(),
		};
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn(async () => true) },
			createFrontend: () => ({
				start: vi.fn(() => new Promise<void>(() => {})),
				appendAudio: vi.fn(),
				appendSpeech: vi.fn(async () => {}),
				cancelSpeech: vi.fn(),
				stop: vi.fn(async () => {}),
			}),
			createRoom: () => room,
			lifecycle: vi.fn(async () => {}),
			evidence: vi.fn(),
			confirmationMs: 100,
			now: () => new Date(now),
			startDeadlineMs: 120_000,
			// Preflight already burned nearly the whole budget: 15ms remain.
			startDeadlineAt: () => now + 15,
		});

		// The proof is the outcome, not a stopwatch: with only 15ms left the start
		// expires and this settles. An implementation that handed the branches a
		// fresh 120s would never settle here at all, and the test would fail on
		// its own timeout rather than on a host-duration threshold — which
		// required checks are not allowed to assert.
		await expect(session.start()).rejects.toThrow(
			"voice_session_start_timeout",
		);
		// The expired start gives back the branch that had come up, if any.
		expect(room.start).toHaveBeenCalledTimes(1);
	});

	it("uses the whole ceiling when the caller names no deadline", () => {
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn(async () => true) },
			createFrontend: () => ({
				start: vi.fn(async () => {}),
				appendAudio: vi.fn(),
				appendSpeech: vi.fn(async () => {}),
				cancelSpeech: vi.fn(),
				stop: vi.fn(async () => {}),
			}),
			createRoom: () => ({
				start: vi.fn(async () => ({ founderPresent: true })),
				playSpeech: vi.fn(async () => {}),
				cancelSpeech: vi.fn(),
				status: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
				setWaiting: vi.fn(),
				setBedEnabled: vi.fn(),
			}),
			lifecycle: vi.fn(async () => {}),
			evidence: vi.fn(),
			confirmationMs: 100,
			startDeadlineMs: 120_000,
		});

		// No `startDeadlineAt`, so the budget is the ceiling itself — the
		// remaining-budget arithmetic must not silently apply to a caller that
		// never claimed to have spent any of it.
		expect(
			(session as unknown as { startBudgetMs(): number }).startBudgetMs(),
		).toBe(120_000);
	});
});

/**
 * FLY-2701 review R3: with each branch now cleaning itself up on landing, there
 * is no longer any reason for the caller to sit through the other branch. The
 * first failure ends the wait; the survivor still hands itself back whenever it
 * eventually lands.
 */
describe("GenericVoiceSession start fails fast on the first failure", () => {
	it("does not wait for the other branch after one fails", async () => {
		let landRoom!: (value: { founderPresent: boolean }) => void;
		const room = {
			start: vi.fn(
				() =>
					new Promise<{ founderPresent: boolean }>((resolve) => {
						landRoom = resolve;
					}),
			),
			playSpeech: vi.fn(async () => {}),
			cancelSpeech: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			setWaiting: vi.fn(),
			setBedEnabled: vi.fn(),
		};
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn(async () => true) },
			createFrontend: () => ({
				start: vi.fn(async () => {
					throw new Error("realtime refused");
				}),
				appendAudio: vi.fn(),
				appendSpeech: vi.fn(async () => {}),
				cancelSpeech: vi.fn(),
				stop: vi.fn(async () => {}),
			}),
			createRoom: () => room,
			lifecycle: vi.fn(async () => {}),
			evidence: vi.fn(),
			confirmationMs: 100,
			startDeadlineMs: 60_000,
		});

		// The room has not settled and will not for a while; the failure must
		// surface long before the 60s ceiling.
		await expect(session.start()).rejects.toThrow("realtime refused");

		landRoom({ founderPresent: true });
		await vi.waitFor(() => expect(room.stop).toHaveBeenCalled());
	});
});

it("freezes rewriting tells, queued results and unfinished obligations before stop clears them", async () => {
	let finishRewrite!: (value: {
		spoken: string;
		threadText: null;
		protectedFieldEvidence: [];
	}) => void;
	const test = fixture({
		coordinatedSpeech: true,
		rewriteSpeech: () =>
			new Promise((resolve) => {
				finishRewrite = resolve;
			}),
	});
	await test.session.start();
	await test.session.markLive();
	test.getRoomHandlers().onLocalUtteranceStarted?.("speaker");
	const handlers = test.getFrontendHandlers();
	handlers.onBackgroundHandoff?.({
		handoffId: "h1",
		inputTranscript: "查 FLY-2886",
	});
	handlers.onBackgroundTurnStarted?.("turn-a");
	handlers.onBackgroundTurnTerminal?.({
		turnId: "turn-a",
		outcome: "completed",
		spokenSegments: ["FLY-2886 已查到"],
	});
	handlers.onBackgroundHandoff?.({
		handoffId: "h2",
		inputTranscript: "另一件还没完成",
	});
	const tell = test.session.deliverTell({
		businessId: "tell-pending",
		text: "FLY-2886 PR #1326",
	});
	await test.session.stop({ kind: "failed", reason: "session_failure" });
	const snapshot = test.finalize.mock.calls[0]?.[1] as {
		unplayed: readonly {
			businessId: string;
			kind: string;
			status: string;
			text: string;
		}[];
	};
	expect(snapshot.unplayed).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				businessId: "tell-pending",
				status: "rewriting",
				text: "FLY-2886 PR #1326",
			}),
			expect.objectContaining({
				kind: "result",
				status: "queued",
				text: "FLY-2886 已查到",
			}),
			expect.objectContaining({
				businessId: "h2",
				kind: "obligation",
				status: "unfinished",
			}),
		]),
	);
	expect(Object.isFrozen(snapshot.unplayed)).toBe(true);
	finishRewrite({
		spoken: "FLY-2886 PR #1326",
		threadText: null,
		protectedFieldEvidence: [],
	});
	expect(await tell).toBe("failed");
	expect(test.postThread).not.toHaveBeenCalled();
});

it("persists immutable close state before cancellation and retains it when finalization fails", async () => {
	const test = fixture({ coordinatedSpeech: true });
	await test.session.start();
	await test.session.markLive();
	test.getRoomHandlers().onLocalUtteranceStarted?.("speaker");
	const tell = test.session.deliverTell({
		businessId: "queued-tell",
		text: "FLY-2886 已完成",
	});
	await vi.waitFor(() =>
		expect(test.frontend.rewriteSpeech).toHaveBeenCalled(),
	);
	test.finalize.mockRejectedValueOnce(new Error("minutes_failed"));
	await expect(
		test.session.stop({ kind: "failed", reason: "disconnected" }),
	).rejects.toThrow("minutes_failed");
	const snapshot = test.persistCloseSnapshot.mock.calls[0]?.[0];
	expect(snapshot).toEqual(
		expect.objectContaining({
			unplayed: expect.arrayContaining([
				expect.objectContaining({ businessId: "queued-tell" }),
			]),
		}),
	);
	expect(Object.isFrozen(snapshot)).toBe(true);
	expect(test.persistCloseSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
		test.frontend.stop.mock.invocationCallOrder[0],
	);
	expect(test.finalize.mock.calls[0]?.[1]).toBe(snapshot);
	expect(await tell).toBe("failed");
});

it("keeps original tell material for minutes when fidelity fallback cannot publish", async () => {
	const test = fixture({
		coordinatedSpeech: true,
		rewriteSpeech: async () => {
			throw new Error("rewrite_failed");
		},
		appendSpeech: async () => "confirmed",
	});
	test.postThread.mockRejectedValue(new Error("offline"));
	await test.session.start();
	await test.session.markLive();
	const tell = test.session.deliverTell({
		businessId: "unpublished-tell",
		text: "FLY-2886 PR #1324",
	});
	await vi.waitFor(() => expect(test.postThread).toHaveBeenCalled());
	await test.session.stop({ kind: "failed", reason: "closed" });
	await tell;
	expect(test.finalize.mock.calls[0]?.[1]).toEqual(
		expect.objectContaining({
			unplayed: expect.arrayContaining([
				expect.objectContaining({
					businessId: "unpublished-tell",
					text: "FLY-2886 PR #1324",
					status: "unfinished",
				}),
			]),
		}),
	);
});

it("a degraded background runs the background-off speech path (FLY-2886 §14.2)", async () => {
	const test = fixture({
		coordinatedSpeech: true,
		coordinationActive: () => false,
		appendSpeech: async () => "confirmed",
	});
	await test.session.start();
	await test.session.markLive();
	expect(
		await test.session.deliverTell({ businessId: "tell:1", text: "FLY-2886" }),
	).toBe("disabled");
	expect(test.frontend.rewriteSpeech).not.toHaveBeenCalled();
	expect(test.postThread).not.toHaveBeenCalled();
	await test.session.stop?.();
});

// FLY-2886 Lead 1c8019f8 (founder 2026-09-26 12:19 PDT): the voice brain first
// decides whether a Lead message is worth saying. Answers to her are always
// told; a pure ack/receipt/no-news message may be skipped, and every skip is
// logged with its reason for QA — never dropped silently.
describe("tell relevance", () => {
	async function live(
		rewrite: NonNullable<Parameters<typeof fixture>[0]>["rewriteSpeech"],
	) {
		const test = fixture({
			coordinatedSpeech: true,
			appendSpeech: async () => "confirmed",
			rewriteSpeech: rewrite,
		});
		await test.session.start();
		await test.session.markLive();
		return test;
	}

	it("skips a pure receipt, logs the reason and the original text, and speaks nothing", async () => {
		// The real scribe's skip shape (QA@5 B1): empty spoken.
		const test = await live(async () => ({
			spoken: "",
			threadText: null,
			protectedFieldEvidence: [],
			tell: false,
			skipReason: "receipt_only",
		}));
		await expect(
			test.session.deliverTell({
				businessId: "tell:ack",
				text: "收到，已排队。",
			}),
		).resolves.toBe("skipped");
		expect(test.frontend.appendSpeech).not.toHaveBeenCalled();
		expect(test.evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "voice_tell_skipped",
				businessId: "tell:ack",
				reason: "receipt_only",
				originalText: "收到，已排队。",
			}),
		);
		await test.session.stop();
	});

	it("always tells a reply that answers what she asked, even if the writer wanted to skip it", async () => {
		vi.useFakeTimers();
		try {
			const test = await live(async () => ({
				spoken: "FLY-2886 的 PR #1360 已经合并了。",
				threadText: null,
				protectedFieldEvidence: [],
				tell: false,
				skipReason: "no_new_information",
			}));
			test
				.getFrontendHandlers()
				.onTranscript(userTranscript("2886 的 PR 怎么样了"));
			const result = test.session.deliverTell({
				businessId: "tell:answer",
				text: "FLY-2886 的 PR #1360 已合并。",
			});
			await vi.advanceTimersByTimeAsync(1_500);
			await expect(result).resolves.toBe("spoken");
			expect(test.frontend.rewriteSpeech).toHaveBeenCalledWith(
				expect.objectContaining({
					recentFounderAsks: ["2886 的 PR 怎么样了"],
				}),
			);
			expect(test.frontend.appendSpeech).toHaveBeenCalledWith(
				expect.objectContaining({
					spokenText: "FLY-2886 的 PR #1360 已经合并了。",
				}),
			);
			expect(test.evidence).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "voice_tell_skip_overridden",
					businessId: "tell:answer",
					reason: "no_new_information",
					override: "answers_her",
				}),
			);
			await test.session.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("always tells a message that asks her something", async () => {
		vi.useFakeTimers();
		try {
			const test = await live(async () => ({
				spoken: "要不要现在合并 PR #1360？",
				threadText: null,
				protectedFieldEvidence: [],
				tell: false,
				skipReason: "ack_only",
			}));
			const result = test.session.deliverTell({
				businessId: "tell:ask",
				text: "要不要现在合并 PR #1360？",
			});
			await vi.advanceTimersByTimeAsync(1_500);
			await expect(result).resolves.toBe("spoken");
			expect(test.evidence).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "voice_tell_skip_overridden",
					override: "asks_her",
				}),
			);
			await test.session.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

// Review b5bc5d89 advisory: a message that reports a result is always told,
// mechanically, not only because the prompt says so.
it("always tells a message that reports a pass/fail outcome, even if the writer wanted to skip it", async () => {
	vi.useFakeTimers();
	try {
		const test = fixture({
			coordinatedSpeech: true,
			appendSpeech: async () => "confirmed",
			rewriteSpeech: async () => ({
				spoken: "FLY-1234 失败了。",
				threadText: null,
				protectedFieldEvidence: [],
				tell: false,
				skipReason: "no_new_information",
			}),
		});
		await test.session.start();
		await test.session.markLive();
		const result = test.session.deliverTell({
			businessId: "tell:result",
			text: "FLY-1234 失败了。",
		});
		await vi.advanceTimersByTimeAsync(1_500);
		await expect(result).resolves.toBe("spoken");
		expect(test.evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "voice_tell_skip_overridden",
				override: "reports_result",
			}),
		);
		await test.session.stop();
	} finally {
		vi.useRealTimers();
	}
});

// QA@5 B1: when the floor overrides a skip there is no script to say; the
// exact text goes to the thread and the pointer is spoken — never silence.
it("falls back to thread + pointer when a skip with an empty script is overridden", async () => {
	vi.useFakeTimers();
	try {
		const test = fixture({
			coordinatedSpeech: true,
			appendSpeech: async () => "confirmed",
			rewriteSpeech: async () => ({
				spoken: "",
				threadText: null,
				protectedFieldEvidence: [],
				tell: false,
				skipReason: "no_new_information",
			}),
		});
		await test.session.start();
		await test.session.markLive();
		const result = test.session.deliverTell({
			businessId: "tell:empty",
			text: "FLY-1234 失败了。",
		});
		await vi.advanceTimersByTimeAsync(1_500);
		await expect(result).resolves.toBe("fallback_posted");
		expect(test.postThread).toHaveBeenCalledWith({
			businessId: "tell:empty",
			text: "FLY-1234 失败了。",
		});
		expect(test.frontend.appendSpeech).toHaveBeenCalledWith(
			expect.objectContaining({
				spokenText: "这条我发到 thread 了，编号以文字为准。",
			}),
		);
		await test.session.stop();
	} finally {
		vi.useRealTimers();
	}
});
