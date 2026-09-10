import { describe, expect, it, vi } from "vitest";
import type { VoiceSessionProjection } from "../bridge-client.js";
import { GenericVoiceSession } from "../session.js";

const projection: VoiceSessionProjection = {
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

describe("GenericVoiceSession", () => {
	it("routes authorized transcripts, handles local commands, and confirms spoken replies", async () => {
		let frontendHandlers:
			| Parameters<
					ConstructorParameters<typeof GenericVoiceSession>[0]["createFrontend"]
			  >[0]
			| undefined;
		let roomHandlers:
			| Parameters<
					ConstructorParameters<typeof GenericVoiceSession>[0]["createRoom"]
			  >[0]
			| undefined;
		const appendSpeech = vi.fn(async () => {});
		const room = {
			start: vi.fn(async () => ({ founderPresent: false })),
			speaker: vi.fn(() => ({ userId: "founder", name: "Annie" })),
			feedOutputAudio: vi.fn(),
			finishOutputAudio: vi.fn(),
			flushOutputAudio: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
		};
		const delivery = { capture: vi.fn(async () => true) };
		const lifecycle = vi.fn();
		const session = new GenericVoiceSession({
			projection,
			delivery,
			createFrontend: (handlers) => {
				frontendHandlers = handlers;
				return {
					start: vi.fn(async () => {}),
					appendAudio: vi.fn(),
					appendSpeech,
					stop: vi.fn(async () => {}),
				};
			},
			createRoom: (handlers) => {
				roomHandlers = handlers;
				return room;
			},
			lifecycle,
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		expect(await session.start()).toEqual({ founderPresent: false });
		const founder = session.waitForFounder(100);
		roomHandlers?.onFounderPresence(true);
		expect(await founder).toBe(true);
		await session.markLive();
		frontendHandlers?.onTranscript({ role: "user", text: "请检查 FLY-2446" });
		await vi.waitFor(() =>
			expect(delivery.capture).toHaveBeenCalledWith(
				expect.objectContaining({
					rawText: "请检查 FLY-2446",
					speakerUserId: "founder",
				}),
			),
		);
		await vi.waitFor(() =>
			expect(room.status).toHaveBeenCalledWith("📻 已转达，Raya 在想"),
		);

		const spoken = session.speak("**已经检查。**");
		await vi.waitFor(() =>
			expect(appendSpeech).toHaveBeenCalledWith("**已经检查。**"),
		);
		frontendHandlers?.onTranscript({ role: "assistant", text: "已经检查。" });
		expect(await spoken).toBe("confirmed");
		await vi.waitFor(() =>
			expect(room.status).toHaveBeenCalledWith("📻 已念完"),
		);

		frontendHandlers?.onTranscript({ role: "user", text: " 退出 语音模式 " });
		expect(await session.waitForEnd()).toEqual({
			kind: "ended",
			reason: "voice-stop",
		});
		expect(delivery.capture).toHaveBeenCalledTimes(1);
		await session.stop({ kind: "ended", reason: "voice-stop" });
		expect(lifecycle).toHaveBeenCalledWith("ended", "voice-stop");
	});

	it("does not claim delivery when the journal delivery was abandoned", async () => {
		let handlers:
			| Parameters<
					ConstructorParameters<typeof GenericVoiceSession>[0]["createFrontend"]
			  >[0]
			| undefined;
		const status = vi.fn(async () => {});
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn(async () => false) },
			createFrontend: (value) => {
				handlers = value;
				return {
					start: vi.fn(async () => {}),
					appendAudio: vi.fn(),
					appendSpeech: vi.fn(async () => {}),
					stop: vi.fn(async () => {}),
				};
			},
			createRoom: () => ({
				start: vi.fn(async () => ({ founderPresent: true })),
				speaker: vi.fn(() => ({ userId: "founder", name: "Annie" })),
				feedOutputAudio: vi.fn(),
				finishOutputAudio: vi.fn(),
				flushOutputAudio: vi.fn(),
				status,
				stop: vi.fn(async () => {}),
			}),
			lifecycle: vi.fn(),
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		await session.start();
		await session.markLive();
		handlers?.onTranscript({ role: "user", text: "hello" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(status).not.toHaveBeenCalledWith("📻 已转达，Raya 在想");
	});

	it("records attempted realtime delegation without routing it to the mailbox", async () => {
		let handlers:
			| Parameters<
					ConstructorParameters<typeof GenericVoiceSession>[0]["createFrontend"]
			  >[0]
			| undefined;
		const evidence = vi.fn();
		const delivery = { capture: vi.fn() };
		const session = new GenericVoiceSession({
			projection,
			delivery,
			createFrontend: (value) => {
				handlers = value;
				return {
					start: vi.fn(async () => {}),
					appendAudio: vi.fn(),
					appendSpeech: vi.fn(async () => {}),
					stop: vi.fn(async () => {}),
				};
			},
			createRoom: () => ({
				start: vi.fn(async () => ({ founderPresent: true })),
				speaker: vi.fn(() => null),
				feedOutputAudio: vi.fn(),
				finishOutputAudio: vi.fn(),
				flushOutputAudio: vi.fn(),
				status: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			}),
			lifecycle: vi.fn(),
			evidence,
			confirmationMs: 100,
		});
		await session.start();
		handlers?.onFrontendDelegation({ itemId: "handoff-1" });
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "frontend_delegation",
				itemId: "handoff-1",
			}),
		);
		expect(delivery.capture).not.toHaveBeenCalled();
	});

	it("marks an unmatched frontend utterance and protocol closure without mailbox ingress", async () => {
		let handlers:
			| Parameters<
					ConstructorParameters<typeof GenericVoiceSession>[0]["createFrontend"]
			  >[0]
			| undefined;
		const evidence = vi.fn();
		const status = vi.fn(async () => {});
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn() },
			createFrontend: (value) => {
				handlers = value;
				return {
					start: vi.fn(async () => {}),
					appendAudio: vi.fn(),
					appendSpeech: vi.fn(async () => {}),
					stop: vi.fn(async () => {}),
				};
			},
			createRoom: () => ({
				start: vi.fn(async () => ({ founderPresent: true })),
				speaker: vi.fn(() => null),
				feedOutputAudio: vi.fn(),
				finishOutputAudio: vi.fn(),
				flushOutputAudio: vi.fn(),
				status,
				stop: vi.fn(async () => {}),
			}),
			lifecycle: vi.fn(),
			evidence,
			confirmationMs: 100,
		});
		await session.start();
		handlers?.onTranscript({ role: "assistant", text: "我来回答" });
		await vi.waitFor(() =>
			expect(status).toHaveBeenCalledWith("🤖(前台自言) 我来回答"),
		);
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "realtime_transcript",
				role: "assistant",
				generation: 1,
			}),
		);
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "frontend_utterance" }),
		);
		handlers?.onClosed("realtime_protocol");
		expect(await session.waitForEnd()).toEqual({
			kind: "failed",
			reason: "realtime_protocol",
		});
	});

	it("bounds scrubbed frontend utterances before evidence and status output", async () => {
		let handlers:
			| Parameters<
					ConstructorParameters<typeof GenericVoiceSession>[0]["createFrontend"]
			  >[0]
			| undefined;
		const evidence = vi.fn();
		const status = vi.fn(async () => {});
		const session = new GenericVoiceSession({
			projection,
			delivery: { capture: vi.fn() },
			createFrontend: (value) => {
				handlers = value;
				return {
					start: vi.fn(async () => {}),
					appendAudio: vi.fn(),
					appendSpeech: vi.fn(async () => {}),
					stop: vi.fn(async () => {}),
				};
			},
			createRoom: () => ({
				start: vi.fn(async () => ({ founderPresent: true })),
				speaker: vi.fn(() => null),
				feedOutputAudio: vi.fn(),
				finishOutputAudio: vi.fn(),
				flushOutputAudio: vi.fn(),
				status,
				stop: vi.fn(async () => {}),
			}),
			lifecycle: vi.fn(),
			evidence,
			confirmationMs: 100,
		});
		await session.start();
		handlers?.onTranscript({ role: "assistant", text: "语".repeat(3_000) });
		await vi.waitFor(() => expect(status).toHaveBeenCalled());
		const utterance = evidence.mock.calls.find(
			([record]) => record.kind === "frontend_utterance",
		)?.[0];
		expect(Array.from(utterance.text)).toHaveLength(1_800);
		expect(Array.from(status.mock.calls[0]?.[0] ?? "").length).toBeLessThan(
			2_000,
		);
	});
});

describe("GenericVoiceSession cancellation", () => {
	it.each(["frontend", "room"])(
		"does not resume late %s startup after stop",
		async (stage) => {
			let finish!: () => void;
			const pending = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const frontend = {
				start: vi.fn(() =>
					stage === "frontend" ? pending : Promise.resolve(),
				),
				appendAudio: vi.fn(),
				appendSpeech: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			};
			const room = {
				start: vi.fn(async () => {
					if (stage === "room") await pending;
					return { founderPresent: true };
				}),
				speaker: vi.fn(() => null),
				feedOutputAudio: vi.fn(),
				finishOutputAudio: vi.fn(),
				flushOutputAudio: vi.fn(),
				status: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			};
			const lifecycle = vi.fn();
			const session = new GenericVoiceSession({
				projection,
				delivery: { capture: vi.fn() },
				createFrontend: () => frontend,
				createRoom: () => room,
				lifecycle,
				evidence: vi.fn(),
				confirmationMs: 100,
			});
			const starting = session.start();
			await Promise.resolve();
			await session.stop({ kind: "failed", reason: "lease_lost" });
			finish();
			await expect(starting).rejects.toThrow("voice_session_stopped");
			expect(lifecycle).not.toHaveBeenCalledWith("ready");
			if (stage === "frontend") expect(room.start).not.toHaveBeenCalled();
			else expect(room.stop).toHaveBeenCalledTimes(2);
		},
	);
});

describe("GenericVoiceSession stopped callbacks", () => {
	it("ignores delayed audio and transcripts after teardown begins", async () => {
		let frontendHandlers!: import("../session.js").FrontendHandlers;
		let roomHandlers!: import("../session.js").RoomHandlers;
		let finishStop!: () => void;
		const pendingStop = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		const frontend = {
			start: vi.fn(async () => {}),
			appendAudio: vi.fn(),
			appendSpeech: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
		};
		const room = {
			start: vi.fn(async () => ({ founderPresent: true })),
			speaker: vi.fn(() => ({ userId: "founder", name: "Annie" })),
			feedOutputAudio: vi.fn(),
			finishOutputAudio: vi.fn(),
			flushOutputAudio: vi.fn(),
			status: vi.fn(async () => {}),
			stop: vi.fn(() => pendingStop),
		};
		const delivery = { capture: vi.fn() };
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
			lifecycle: vi.fn(),
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		await session.start();
		await session.markLive();
		const stopped = session.stop({ kind: "ended", reason: "text-stop" });
		frontendHandlers.onAudio(Buffer.alloc(960));
		roomHandlers.onAudio(Buffer.alloc(960));
		frontendHandlers.onTranscript({ role: "user", text: "late transcript" });
		expect(frontend.appendAudio).not.toHaveBeenCalled();
		expect(room.feedOutputAudio).not.toHaveBeenCalled();
		expect(delivery.capture).not.toHaveBeenCalled();
		finishStop();
		await stopped;
	});
});

it("preserves scrubbed evidence and requests repetition when user attribution is ambiguous", async () => {
	let handlers!: import("../session.js").FrontendHandlers;
	const evidence = vi.fn();
	const status = vi.fn(async () => {});
	const delivery = { capture: vi.fn() };
	const session = new GenericVoiceSession({
		projection,
		delivery,
		createFrontend: (value) => {
			handlers = value;
			return {
				start: vi.fn(async () => {}),
				appendAudio: vi.fn(),
				appendSpeech: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			};
		},
		createRoom: () => ({
			start: vi.fn(async () => ({ founderPresent: true })),
			speaker: vi.fn(() => null),
			feedOutputAudio: vi.fn(),
			finishOutputAudio: vi.fn(),
			flushOutputAudio: vi.fn(),
			status,
			stop: vi.fn(async () => {}),
		}),
		lifecycle: vi.fn(),
		evidence,
		confirmationMs: 100,
	});
	await session.start();
	await session.markLive();
	const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
	handlers.onTranscript({ role: "user", text: `请检查 ${secret}` });
	expect(evidence).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "realtime_transcript",
			role: "user",
			generation: 1,
			text: expect.stringContaining("请检查"),
		}),
	);
	expect(JSON.stringify(evidence.mock.calls)).not.toContain(secret);
	expect(evidence.mock.calls[0]?.[0]).not.toHaveProperty("speakerUserId");
	expect(status).toHaveBeenCalledWith(expect.stringContaining("请再说一遍"));
	expect(delivery.capture).not.toHaveBeenCalled();
	await session.stop();
});
