import type { Readable } from "node:stream";
import type { BrainAdapter, ConversationSession } from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpusDownlink } from "../audio/OpusDownlink.js";
import { SPEECH_TRUNCATED_NOTE } from "../codex/CodexProofSpeaker.js";
import { CodexRoomFrontend } from "../codex/CodexRoomFrontend.js";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";
import { GenericVoiceSession, type RoomHandlers } from "../session.js";
import { prepareReplySpeech } from "../speech.js";

const brain: BrainAdapter = {
	async *respond() {
		yield "unused";
	},
};

afterEach(() => {
	vi.useRealTimers();
});

/** A room player: one packet per 20 ms cycle, like @discordjs/voice. */
function roomPlayer() {
	type Resource = { stream: Readable };
	let current: Resource | undefined;
	const heard: Array<number | null> = [];
	const player = {
		play: (resource: unknown) => {
			const previous = current;
			current = resource as Resource;
			if (previous && previous !== current) {
				previous.stream.destroy();
				previous.stream.read();
			}
		},
		stop: vi.fn(),
		on: vi.fn(),
	};
	const downlink = new OpusDownlink({
		player,
		createResource: (source) => ({ stream: source.stream }),
		now: () => Date.now(),
	});
	downlink.start();
	return {
		downlink,
		heard,
		/** One audio cycle of the player. */
		cycle: () => {
			const packet = current?.stream.read() as Buffer | null | undefined;
			heard.push(packet ? packet.readUInt16BE(1) : null);
		},
	};
}

function packet(id: number): Buffer {
	const buffer = Buffer.alloc(3);
	buffer[0] = 0xf8;
	buffer.writeUInt16BE(id, 1);
	return buffer;
}

async function harness(
	options: { soleRoomUser?: boolean; handoff?: boolean } = {},
) {
	vi.useFakeTimers();
	let callbacks!: Record<string, (...args: never[]) => void>;
	const room = roomPlayer();
	const appendAudio = vi.fn(() => "sent" as const);
	const appendSpeech = vi.fn(async () => undefined);
	let generation = 1;
	const conversation = {
		get generation() {
			return generation;
		},
		transport: {
			appendAudio,
			appendSpeech,
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
		},
		reconnect: vi.fn((reason: string) =>
			callbacks.onGenerationLost({ generation, reason } as never),
		),
		close: vi.fn(async () => undefined),
	};
	const evidence: Record<string, unknown>[] = [];
	const statuses: string[] = [];
	const persisted: Array<{ role: string; text: string }> = [];
	const handoffToLead = vi.fn(async () => ({
		handoffId: "handoff-a",
		state: "dispatched" as const,
		idempotencyKey: "codex-delegate:a",
		requestDigest: "d".repeat(64),
	}));
	const backend = new CodexVoiceBackend({
		sessionId: "session-webrtc",
		voice: "cove",
		container: {
			open: vi.fn(async (input: { realtime: typeof callbacks }) => {
				callbacks = input.realtime;
				return conversation;
			}),
		},
		loadContext: vi.fn(),
		downlink: () => room.downlink,
		monotonicNow: () => Date.now(),
		persistUtterance: async (utterance) => {
			persisted.push({ role: utterance.role, text: utterance.text });
		},
		...(options.soleRoomUser
			? { resolveSoleRoomUser: () => ({ userId: "founder", name: "Annie" }) }
			: {}),
		...(options.handoff ? { handoffToLead } : {}),
		onEvidence: (record) => evidence.push(record),
		postStatus: async (text) => {
			statuses.push(text);
		},
	});
	let nextPacket = 1;
	const events: string[] = [];
	const session = await backend.createConversation({ brain });
	for (const event of [
		"response-started",
		"response-done",
		"response-cancelled",
	] as const)
		session.on(event, () => events.push(event));
	const owned = session as ConversationSession & {
		sendOwnedAudio(
			frame: Buffer,
			owner: {
				utteranceId: string | null;
				ownerUserId: string | null;
				ownerName?: string | null;
			},
		): void;
	};
	/** Network and player advance together, 20 ms per character. */
	const step = async (pattern: string, deliver = true) => {
		const ids: number[] = [];
		for (const char of pattern) {
			if (deliver && char !== "-") {
				const id = nextPacket++;
				ids.push(id);
				callbacks.onDownlink({
					generation,
					payload: packet(id),
					voiced: char === "v",
					rms: char === "v" ? 2_000 : 0,
					sequence: id,
					receivedAtMs: Date.now(),
				} as never);
			}
			room.cycle();
			await vi.advanceTimersByTimeAsync(20);
		}
		return ids;
	};
	/** Packets that reach the queue without the player taking any. */
	const burst = (pattern: string) => {
		const ids: number[] = [];
		for (const char of pattern) {
			const id = nextPacket++;
			ids.push(id);
			callbacks.onDownlink({
				generation,
				payload: packet(id),
				voiced: char === "v",
				rms: 0,
				sequence: id,
				receivedAtMs: Date.now(),
			} as never);
		}
		return ids;
	};
	const turn = (
		type: "turn.created" | "turn.done",
		turnId: string,
		role: "user" | "assistant",
		transcript: string | null = null,
	) =>
		callbacks.onDataEvent({
			generation,
			event: { type, turnId, role, startMs: null, endMs: null, transcript },
		} as never);
	/** The app-server final that follows a turn.done (observed v3 order). */
	const final = (text: string) =>
		callbacks.onTranscript({
			generation,
			association: "unattributed",
			role: "assistant",
			text,
			final: true,
			raw: {},
		} as never);
	const founder = (speaking: boolean) =>
		owned.sendOwnedAudio(Buffer.alloc(960, speaking ? 1 : 0), {
			utteranceId: speaking ? "founder-utterance" : null,
			ownerUserId: speaking ? "founder" : null,
			ownerName: speaking ? "Annie" : null,
		});
	const heardIds = () => room.heard.filter((id): id is number => id !== null);
	return {
		session,
		room,
		events,
		evidence,
		statuses,
		persisted,
		appendAudio,
		appendSpeech,
		conversation,
		handoffToLead,
		step,
		burst,
		turn,
		final,
		founder,
		heardIds,
		get callbacks() {
			return callbacks;
		},
		finishReconnect: (next: number) => {
			generation = next;
			callbacks.onGenerationReady({ generation: next } as never);
		},
	};
}

describe("engine B room over WebRTC (FLY-2885 T4/T5)", () => {
	it("plays the first WebRTC packet on the very next player cycle, before any transcript", async () => {
		const h = await harness();
		const [first] = await h.step("v");
		expect(h.room.heard).toEqual([first]);
		expect(h.events).toEqual(["response-started"]);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({ kind: "codex_response_audible" }),
		);
	});

	it("keeps a burst of packets in order and never trims a normal backlog", async () => {
		const h = await harness();
		const ids = h.burst("vvvvvvvvvv");
		await h.step("----------", false);
		expect(h.heardIds()).toEqual(ids);
		expect(
			h.evidence.some((record) => record.kind === "downlink_queue_trim"),
		).toBe(false);
	});

	it("reports the response done once the player has gone quiet for 300 ms", async () => {
		const h = await harness();
		await h.step("vvv");
		await h.step("sssssssssssssssss");
		expect(h.events).toEqual(["response-started", "response-done"]);
	});

	it("sends founder audio up on the same generation and never re-sends it", async () => {
		const h = await harness();
		h.founder(true);
		h.founder(false);
		expect(h.appendAudio).toHaveBeenCalledTimes(2);
		expect(h.appendAudio).toHaveBeenNthCalledWith(1, expect.any(Buffer), 1, {
			utteranceId: "founder-utterance",
			ownerUserId: "founder",
			ownerName: "Annie",
		});
	});

	it("reads aloud into an idle room, binds the data-channel turn, and completes on consumed audio", async () => {
		const h = await harness();
		const receipt = h.session.speak!("你好。", "readback", {
			pendingKey: "hello",
			verification: "required",
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.appendSpeech).toHaveBeenCalledWith("你好。", 1);
		h.turn("turn.created", "readback", "assistant");
		await h.step("vvvvv");
		h.turn("turn.done", "readback", "assistant", "你好。");
		h.final("你好。");
		await expect(receipt).resolves.toMatchObject({
			outcome: "completed",
			transport: "submitted",
			contentProof: "transcript_equivalent",
		});
	});

	it("does not read aloud over an answer whose audio came before its turn.created (R3)", async () => {
		const h = await harness();
		h.founder(true);
		h.turn("turn.created", "u1", "user");
		h.founder(false);
		// The natural answer is audible first; turn.created lands 915 ms later.
		await h.step("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv");
		const receipt = h.session.speak!("我确认一下。", "cue", {
			pendingKey: "cue",
			verification: "required",
		});
		await h.step("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv");
		expect(h.appendSpeech).not.toHaveBeenCalled();
		h.turn("turn.created", "a1", "assistant");
		await h.step("vvvvvvvvvvssssssssssssssssssssssssss");
		expect(h.appendSpeech).not.toHaveBeenCalled();
		h.turn("turn.done", "a1", "assistant", "自然回答。");
		// Still 600 ms of quiet to wait after the last audible packet.
		await h.step("ssssssssssssssssssssssssssssssssssss");
		expect(h.appendSpeech).toHaveBeenCalledOnce();
		h.turn("turn.created", "a2", "assistant");
		await h.step("vvv");
		h.turn("turn.done", "a2", "assistant", "我确认一下。");
		h.final("我确认一下。");
		await expect(receipt).resolves.toMatchObject({ outcome: "completed" });
	});

	it("gives up after 10 s when the data channel never reports an answer to a user turn", async () => {
		const h = await harness();
		h.founder(true);
		h.callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "你好",
			final: false,
			raw: {},
		} as never);
		h.founder(false);
		const receipt = h.session.speak!("我确认一下。", "cue", {
			pendingKey: "stuck",
			verification: "required",
		});
		await vi.advanceTimersByTimeAsync(10_100);
		await expect(receipt).resolves.toMatchObject({
			outcome: "rejected",
			reason: "busy_conversation",
			transport: "none",
		});
		expect(h.appendSpeech).not.toHaveBeenCalled();
	});
});

describe("engine B barge-in through the room session (FLY-2885 T5)", () => {
	async function roomSession() {
		const h = await harness();
		let roomHandlers!: RoomHandlers;
		const frontend = new CodexRoomFrontend({
			backend: {
				id: "codex-realtime",
				capabilities: {} as never,
				createConversation: async () => h.session,
			},
			conversationOptions: { brain },
			onUnavailable: vi.fn(),
		});
		let ended: unknown;
		const session = new GenericVoiceSession({
			projection: {
				sessionId: "11111111-1111-4111-8111-111111111111",
				voiceBotUserId: "323456789012345678",
				mode: "meeting",
				projectName: "flywheel",
				leadId: "flywheel-eng-lead",
				displayName: "Tadashi",
				realtimeVoice: "verse",
				guildId: "guild",
				voiceChannelId: "voice",
				threadId: "thread",
				boundChannelIds: ["thread"],
				founderUserId: "founder",
				qaAllowUserIds: [],
			},
			delivery: { capture: vi.fn(async () => false) },
			createFrontend: (handlers) => {
				(frontend as unknown as { handlers: unknown }).handlers = handlers;
				return frontend;
			},
			createRoom: (handlers) => {
				roomHandlers = handlers;
				return {
					start: vi.fn(async () => ({ founderPresent: true })),
					playSpeech: vi.fn(async () => undefined),
					cancelAllSpeech: () => {
						h.room.downlink.cut();
					},
					status: vi.fn(async () => undefined),
					stop: vi.fn(async () => undefined),
				};
			},
			lifecycle: vi.fn(),
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		void session.waitForEnd().then((outcome) => {
			ended = outcome;
		});
		await session.start();
		await session.markLive();
		const founderSpeaks = () =>
			roomHandlers.onAudio(Buffer.alloc(960, 1), {
				utteranceId: "founder-barge-in",
				ownerUserId: "founder",
				ownerName: "Annie",
			});
		const founderSilent = () =>
			roomHandlers.onAudio(Buffer.alloc(960), {
				utteranceId: null,
				ownerUserId: null,
				ownerName: null,
			});
		return { ...h, session, founderSpeaks, founderSilent, ended: () => ended };
	}

	it("cuts everything the player still has queued the moment the founder speaks, and keeps the generation", async () => {
		const h = await roomSession();
		await h.step("vvvvv");
		const queued = h.burst("vvvvvvvvvvvvvvvvvvvv");
		h.founderSpeaks();
		await h.step("vvvvvvvvvv");
		expect(h.heardIds().filter((id) => queued.includes(id))).toEqual([]);
		expect(h.conversation.reconnect).not.toHaveBeenCalled();
		expect(h.appendAudio).toHaveBeenLastCalledWith(
			expect.any(Buffer),
			1,
			expect.objectContaining({ utteranceId: "founder-barge-in" }),
		);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({ kind: "codex_barge_in", local: true }),
		);
		expect(h.events).toContain("response-cancelled");
	});

	it("resumes with the new answer after the user turn and the boundary gap", async () => {
		const h = await roomSession();
		await h.step("vvvvv");
		h.founderSpeaks();
		await h.step("vvvvvvvvvv");
		h.founderSilent();
		h.turn("turn.created", "u1", "user");
		await h.step("ssssssssssssssss");
		const answer = await h.step("vvvvvvvvvv");
		expect(h.heardIds().slice(-9)).toEqual(answer.slice(0, 9));
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_barge_in_resumed",
				trigger: "user_turn",
			}),
		);
		expect(h.ended()).toBeUndefined();
	});

	it("still barges in while a replay backlog plays after the network has gone quiet", async () => {
		const h = await roomSession();
		await h.step("vvv");
		h.founderSpeaks();
		h.founderSilent();
		// New answer muted and buffered, the user evidence comes late.
		await h.step("vvvvvssssssssssssssss");
		const answer = await h.step("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv");
		h.turn("turn.created", "u1", "user");
		// Replay queued ~43 packets; the network itself is now silent.
		await h.step("ssssssssssssssssssssssssssssssssss");
		const backlogLeft = h.room.downlink.queued().voiced;
		expect(backlogLeft).toBeGreaterThan(0);
		h.founderSpeaks();
		const heardBefore = h.heardIds().length;
		await h.step("ssssssssss");
		expect(
			h
				.heardIds()
				.slice(heardBefore)
				.filter((id) => answer.includes(id)),
		).toEqual([]);
	});
});

describe("engine B read-aloud overrun in the room (FLY-2885 T5c)", () => {
	const line =
		"目前这件事已经进入评审，结果出来之后我会第一时间告诉你，你不用再单独跟进了。";

	it("mutes the overrun at once, mirrors only the line, and forces a new generation when the turn pauses without done", async () => {
		const h = await harness();
		const receipt = h.session.speak!(line, "readback", {
			pendingKey: "overrun",
			verification: "required",
		});
		await vi.advanceTimersByTimeAsync(0);
		h.turn("turn.created", "r1", "assistant");
		await h.step("vvvvvvvvvv");
		h.callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "assistant",
			text: `${line}另外今天还有两件事情已经顺利完成了呢。`,
			final: false,
			raw: {},
		} as never);
		await expect(receipt).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_overrun",
			transport: "submitted",
		});
		const invented = await h.step("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv");
		expect(h.heardIds().filter((id) => invented.includes(id))).toEqual([]);
		h.callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "assistant",
			text: `${line}另外今天还有两件事情已经顺利完成了呢。`,
			final: true,
			raw: {},
		} as never);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.persisted.at(-1)).toEqual({
			role: "assistant",
			text: `${prepareReplySpeech(line)[0]!.spokenText}${SPEECH_TRUNCATED_NOTE}`,
		});
		// The turn pauses >1.5 s and its done never comes: new generation.
		await h.step("s".repeat(76));
		expect(h.conversation.reconnect).toHaveBeenCalledOnce();
		// Founder audio during the generation change is dropped as a gap.
		h.founder(true);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_input_gap",
				reason: "generation_changed_uplink",
			}),
		);
		h.finishReconnect(2);
		await vi.advanceTimersByTimeAsync(0);
		const next = await h.step("vvv");
		expect(h.heardIds().slice(-3)).toEqual(next);
		expect(h.heardIds().filter((id) => invented.includes(id))).toEqual([]);
	});

	it("mutes a final-only overrun whose turn.done came first, then resumes after the quiet gap without a new generation", async () => {
		const h = await harness();
		const receipt = h.session.speak!(line, "readback", {
			pendingKey: "done-first",
			verification: "required",
		});
		await vi.advanceTimersByTimeAsync(0);
		h.turn("turn.created", "r1", "assistant");
		await h.step("vvvvvvvvvv");
		const invented = `${line}另外今天还有两件事情已经顺利完成了呢。`;
		// Observed v3 order: data-channel turn.done, then the app-server final.
		h.turn("turn.done", "r1", "assistant", invented);
		h.callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "assistant",
			text: invented,
			final: true,
			raw: {},
		} as never);
		await expect(receipt).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_overrun",
			transport: "submitted",
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.persisted.at(-1)).toEqual({
			role: "assistant",
			text: `${prepareReplySpeech(line)[0]!.spokenText}${SPEECH_TRUNCATED_NOTE}`,
		});
		// The invented tail's audio is still arriving: muted.
		const tail = await h.step("vvvvvvvvvv");
		expect(h.heardIds().filter((id) => tail.includes(id))).toEqual([]);
		// Its done already passed, so 240 ms of quiet ends the discard.
		await h.step("s".repeat(20));
		const next = await h.step("vvv");
		expect(h.heardIds().slice(-3)).toEqual(next);
		expect(h.conversation.reconnect).not.toHaveBeenCalled();
	});

	it("still truncates a final that lands after the 2 s wait, and leaves the next answer alone", async () => {
		const h = await harness();
		const receipt = h.session.speak!(line, "brief", {
			pendingKey: "late-final",
		});
		await vi.advanceTimersByTimeAsync(0);
		h.turn("turn.created", "r1", "assistant");
		await h.step("vvvvvvvvvv");
		h.turn("turn.done", "r1", "assistant", null);
		await h.step("s".repeat(110));
		await expect(receipt).resolves.toMatchObject({ outcome: "completed" });
		const invented = `${line}另外今天还有两件事情已经顺利完成了呢。`;
		h.final(invented);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.persisted.at(-1)).toEqual({
			role: "assistant",
			text: `${prepareReplySpeech(line)[0]!.spokenText}${SPEECH_TRUNCATED_NOTE}`,
		});
		// The founder's next question gets its own answer, untouched.
		h.turn("turn.created", "u1", "user");
		h.turn("turn.created", "a1", "assistant");
		const answer = "这是对新问题的完整回答，和刚才那句朗读无关。";
		h.final(answer);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.persisted.at(-1)).toEqual({ role: "assistant", text: answer });
		expect(h.conversation.reconnect).not.toHaveBeenCalled();
	});

	it("holds the next read-aloud until the overrun turn is done and quiet", async () => {
		const h = await harness();
		const first = h.session.speak!(line, "readback", {
			pendingKey: "first",
			verification: "required",
		});
		await vi.advanceTimersByTimeAsync(0);
		h.turn("turn.created", "r1", "assistant");
		h.callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "assistant",
			text: `${line}另外今天还有两件事情已经顺利完成了呢。`,
			final: false,
			raw: {},
		} as never);
		await first;
		const second = h.session.speak!("好的。", "readback", {
			pendingKey: "second",
			verification: "required",
		});
		await h.step("vvvvvvvvvv");
		expect(h.appendSpeech).toHaveBeenCalledTimes(1);
		h.turn("turn.done", "r1", "assistant", `${line}另外今天还有两件事。`);
		await h.step("s".repeat(50));
		expect(h.appendSpeech).toHaveBeenCalledTimes(2);
		h.turn("turn.created", "r2", "assistant");
		await h.step("vvv");
		h.turn("turn.done", "r2", "assistant", "好的。");
		h.final("好的。");
		await expect(second).resolves.toMatchObject({ outcome: "completed" });
	});
});

describe("engine B generation change in the session (FLY-2885 T7)", () => {
	it("settles the read-aloud, marks the gap, tells the thread, and resumes on the new generation", async () => {
		const h = await harness();
		const receipt = h.session.speak!("你好。", "readback", {
			pendingKey: "lost",
			verification: "required",
		});
		await vi.advanceTimersByTimeAsync(0);
		h.turn("turn.created", "r1", "assistant");
		const old = await h.step("vvvv");
		h.callbacks.onGenerationLost({
			generation: 1,
			reason: "webrtc_downlink_silent",
		} as never);
		await expect(receipt).resolves.toMatchObject({
			outcome: "failed",
			reason: "generation_changed",
			transport: "submitted",
		});
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_input_gap",
				reason: "generation_changed",
			}),
		);
		// Packets of the lost generation are ignored while it is replaced.
		const stale = h.burst("vvv");
		h.finishReconnect(2);
		const fresh = await h.step("vvv");
		expect(h.heardIds().filter((id) => stale.includes(id))).toEqual([]);
		expect(h.heardIds().slice(-3)).toEqual(fresh);
		expect(h.heardIds().slice(0, old.length)).toEqual(old);
		expect(h.statuses).toEqual(["📻 语音连接断了，正在重连", "📻 已重连"]);
	});
});
