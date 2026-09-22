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
	const delivery = { capture: vi.fn(async () => true) };
	const lifecycle = vi.fn(async () => {});
	const evidence = vi.fn();
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
