import type { RoomIO } from "flywheel-voice-core";
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
	roomIO?: RoomIO;
	replyWaitMs?: number;
	capture?: () => Promise<boolean>;
	createHeadphoneSession?: () => {
		start(): Promise<void>;
		close(): Promise<void>;
	};
}) {
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
		...(options?.roomIO ? { roomIO: options.roomIO } : {}),
		start: vi.fn(async () => ({
			founderPresent: options?.founderPresent ?? true,
		})),
		playSpeech: vi.fn(options?.playSpeech ?? (async () => {})),
		cancelSpeech: vi.fn(),
		status: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		setWaiting: vi.fn(),
		setBedEnabled: vi.fn(),
	};
	const delivery = { capture: vi.fn(options?.capture ?? (async () => true)) };
	const lifecycle = vi.fn(async () => {});
	const evidence = vi.fn();
	const session = new GenericVoiceSession({
		projection,
		delivery,
		...(options?.replyWaitMs === undefined
			? {}
			: { replyWaitMs: options.replyWaitMs }),
		createFrontend: (handlers) => {
			frontendHandlers = handlers;
			return frontend;
		},
		createRoom: (handlers) => {
			roomHandlers = handlers;
			return room;
		},
		...(options?.createHeadphoneSession
			? {
					createHeadphoneSession: (_room: RoomIO) =>
						options.createHeadphoneSession!(),
				}
			: {}),
		lifecycle,
		evidence,
		confirmationMs: 100,
	});
	return {
		session,
		frontend,
		room,
		delivery,
		lifecycle,
		evidence,
		getFrontendHandlers: () => frontendHandlers,
		getRoomHandlers: () => roomHandlers,
	};
}

describe("GenericVoiceSession", () => {
	it("starts and closes an injected headphone V1 session on the canonical RoomIO", async () => {
		const roomIO = {} as RoomIO;
		const headphone = {
			start: vi.fn(async () => undefined),
			close: vi.fn(async () => undefined),
		};
		const test = fixture({
			roomIO,
			createHeadphoneSession: () => headphone,
		});

		await test.session.start();
		expect(headphone.start).toHaveBeenCalledOnce();
		await test.session.stop();
		expect(headphone.close).toHaveBeenCalledOnce();
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
		expect(test.room.setWaiting).toHaveBeenCalledWith(true);
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

/**
 * FLY-2796 founder bounce (2026-09-24): in two real rooms a delivered sentence
 * got no answer, the waiting sound ran for about four minutes, and talking
 * over it changed nothing. Every assertion here is about state and order —
 * which sound is on, what she hears next — never about wall-clock latency.
 */
describe("GenericVoiceSession reply wait (FLY-2796)", () => {
	/** What the voice is asked to read: the reply projection (NFKC, no emoji). */
	const said = (text: string) => prepareReplySpeech(text)[0]!.spokenText;
	const UNAVAILABLE = said("回话暂时不通，你可以再说一遍");

	function spokenTexts(test: ReturnType<typeof fixture>): string[] {
		return test.frontend.appendSpeech.mock.calls.map(
			(call) => (call as unknown as [{ spokenText: string }])[0].spokenText,
		);
	}

	function lastWaiting(test: ReturnType<typeof fixture>): boolean | undefined {
		return test.room.setWaiting.mock.calls.at(-1)?.[0] as boolean | undefined;
	}

	function barge(phase: "start" | "sustained" | "end") {
		return {
			sessionId: "legacy:thread",
			generation: 1,
			utteranceId: "utterance-2",
			owner: {
				kind: "known" as const,
				speakerUserId: "founder",
				speakerName: "Annie",
			},
			startedAt: 0,
			observedAt: 0,
			durationMs: 0,
			phase,
		};
	}

	async function liveFixture(options?: Parameters<typeof fixture>[0]) {
		const test = fixture({ replyWaitMs: 1_000, ...options });
		await test.session.start();
		await test.session.markLive();
		return test;
	}

	it("stops the waiting sound at the ceiling and says the reply is unavailable", async () => {
		vi.useFakeTimers();
		try {
			const test = await liveFixture();
			test.getFrontendHandlers().onTranscript(userTranscript("帮我看一下"));
			await vi.advanceTimersByTimeAsync(0);
			expect(lastWaiting(test)).toBe(true);

			await vi.advanceTimersByTimeAsync(999);
			expect(lastWaiting(test)).toBe(true);
			expect(spokenTexts(test)).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			expect(lastWaiting(test)).toBe(false);
			expect(spokenTexts(test)).toEqual([UNAVAILABLE]);
			expect(test.room.status).toHaveBeenCalledWith(
				"📻 回话暂时不通，你可以再说一遍",
			);
			// The waiting sound stopped before the prompt was handed to the voice.
			const stoppedAt = test.room.setWaiting.mock.invocationCallOrder.at(-1)!;
			const promptAt = test.frontend.appendSpeech.mock.invocationCallOrder[0]!;
			expect(stoppedAt).toBeLessThan(promptAt);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses a 15 second ceiling when none is configured", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture();
			await test.session.start();
			await test.session.markLive();
			test.getFrontendHandlers().onTranscript(userTranscript("在吗"));
			await vi.advanceTimersByTimeAsync(14_999);
			expect(lastWaiting(test)).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(lastWaiting(test)).toBe(false);
			expect(spokenTexts(test)).toEqual([UNAVAILABLE]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("ends the wait when the Lead answers, with no unavailable prompt afterwards", async () => {
		vi.useFakeTimers();
		try {
			const test = await liveFixture();
			test.getFrontendHandlers().onTranscript(userTranscript("帮我看一下"));
			await vi.advanceTimersByTimeAsync(500);
			const reply = prepareReplySpeech("看过了。", 80)[0]!;
			void test.session.speak(reply);
			expect(lastWaiting(test)).toBe(false);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(spokenTexts(test)).toEqual([reply.spokenText]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the waiting sound at once and says so when the sentence could not be delivered", async () => {
		vi.useFakeTimers();
		try {
			const test = await liveFixture({ capture: async () => false });
			test.getFrontendHandlers().onTranscript(userTranscript("帮我看一下"));
			await vi.advanceTimersByTimeAsync(0);
			expect(lastWaiting(test)).toBe(false);
			expect(spokenTexts(test)).toEqual([said("有一句可能没送到，请再说一遍")]);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(spokenTexts(test)).not.toContain(UNAVAILABLE);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the waiting sound at once and answers aloud when the Lead reply has nothing to read", async () => {
		vi.useFakeTimers();
		try {
			const test = await liveFixture();
			test.getFrontendHandlers().onTranscript(userTranscript("帮我看一下"));
			await vi.advanceTimersByTimeAsync(100);
			test.session.notify("📻 没有可朗读内容，请看文字");
			expect(lastWaiting(test)).toBe(false);
			expect(spokenTexts(test)).toEqual([said("没有可朗读内容，请看文字")]);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(spokenTexts(test)).not.toContain(UNAVAILABLE);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the waiting sound when she starts talking, and still delivers what she says", async () => {
		vi.useFakeTimers();
		try {
			const test = await liveFixture();
			test.getFrontendHandlers().onTranscript(userTranscript("帮我看一下"));
			await vi.advanceTimersByTimeAsync(0);
			expect(lastWaiting(test)).toBe(true);

			test.getRoomHandlers().onBargeIn(barge("start"));
			expect(lastWaiting(test)).toBe(false);
			test.getRoomHandlers().onBargeIn(barge("sustained"));
			expect(lastWaiting(test)).toBe(false);

			test.getFrontendHandlers().onTranscript({
				...userTranscript("算了，先看另一个"),
				itemId: "item-2",
				utteranceId: "utterance-2",
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(test.delivery.capture).toHaveBeenCalledTimes(2);
			expect(test.delivery.capture).toHaveBeenLastCalledWith(
				expect.objectContaining({ rawText: "算了，先看另一个" }),
			);
			// Still talking: the new sentence does not bring the sound back over her.
			expect(lastWaiting(test)).toBe(false);

			test.getRoomHandlers().onBargeIn(barge("end"));
			expect(lastWaiting(test)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the ceiling running while she talks without a new sentence", async () => {
		vi.useFakeTimers();
		try {
			const test = await liveFixture();
			test.getFrontendHandlers().onTranscript(userTranscript("帮我看一下"));
			await vi.advanceTimersByTimeAsync(0);
			test.getRoomHandlers().onBargeIn(barge("start"));
			test.getRoomHandlers().onBargeIn(barge("end"));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(lastWaiting(test)).toBe(false);
			expect(spokenTexts(test)).toEqual([UNAVAILABLE]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("queues a Lead reply behind a prompt that is still being spoken instead of dropping it", async () => {
		vi.useFakeTimers();
		try {
			const test = await liveFixture();
			test.getFrontendHandlers().onTranscript(userTranscript("帮我看一下"));
			await vi.advanceTimersByTimeAsync(1_000);
			const prompt = test.frontend.appendSpeech.mock.calls[0]![0] as {
				speechId: string;
			};
			const reply = prepareReplySpeech("刚看完。", 80)[0]!;
			let settled: string | undefined;
			void test.session.speak(reply).then((value) => {
				settled = value;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBeUndefined();
			expect(spokenTexts(test)).toEqual([UNAVAILABLE]);

			test.getFrontendHandlers().onSpeechAudioReady({
				speechId: prompt.speechId,
				pcm24Mono: Buffer.alloc(960, 1),
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(spokenTexts(test)).toEqual([UNAVAILABLE, reply.spokenText]);
			// A local prompt is not a Lead reply: no "已念完" receipt for it.
			expect(test.room.status).not.toHaveBeenCalledWith("📻 已念完");
		} finally {
			vi.useRealTimers();
		}
	});

	it("says a frontend please-repeat status aloud as well as posting it", async () => {
		const test = await liveFixture();
		test
			.getFrontendHandlers()
			.onStatus("📻 有一句话没能确认说话人，请再说一遍");
		expect(test.room.status).toHaveBeenCalledWith(
			"📻 有一句话没能确认说话人，请再说一遍",
		);
		expect(spokenTexts(test)).toEqual([
			said("有一句话没能确认说话人，请再说一遍"),
		]);
	});

	it("names her as the sole speaker only while she is the one human in the room", async () => {
		const test = await liveFixture();
		const handlers = test.getFrontendHandlers();
		test.getRoomHandlers().onPresence({ founderPresent: true, humanCount: 1 });
		expect(handlers.soleSpeaker()).toEqual({
			ownerUserId: "founder",
			ownerName: null,
		});
		test.getRoomHandlers().onPresence({ founderPresent: true, humanCount: 2 });
		expect(handlers.soleSpeaker()).toBeNull();
		test.getRoomHandlers().onPresence({ founderPresent: false, humanCount: 1 });
		expect(handlers.soleSpeaker()).toBeNull();
	});

	it("does not name a sole speaker before the room has reported who is there", async () => {
		const test = await liveFixture();
		expect(test.getFrontendHandlers().soleSpeaker()).toBeNull();
	});
});
