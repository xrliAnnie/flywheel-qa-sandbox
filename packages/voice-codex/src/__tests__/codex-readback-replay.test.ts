import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import type { BrainAdapter } from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpusDownlink } from "../audio/OpusDownlink.js";
import { VoiceLease, type VoiceSessionProjection } from "../bridge-client.js";
import { CodexRoomFrontend } from "../codex/CodexRoomFrontend.js";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";
import { VoiceDaemon } from "../daemon.js";
import { GenericVoiceSession, type RoomHandlers } from "../session.js";

/**
 * FLY-2885 founder rework (2026-09-26): the founder's live session 1043b4a4
 * heard only the first sentence of a two-sentence Lead reply. These tests
 * replay that session through the production read-aloud path — daemon,
 * room session, Codex frontend, backend, speaker and the real Opus downlink —
 * with only the provider (data channel, transcripts, WebRTC packets) and the
 * room player simulated.
 */

interface Fixture {
	session: string;
	reply: { text: string };
	recorded: {
		overrun: {
			turnId: string;
			expectedChars: number;
			unalignedChars: number;
			detectedAtMs: number;
		};
		overrunResumed: { discardMs: number };
		admissionTimeouts: Array<{ busy: string }>;
		threadMirror: Array<{ role: string; text: string }>;
	};
	timeline: {
		overrunTurn: {
			createdAt: number;
			voicedFrom: number;
			voicedTo: number;
			deltas: Array<{ at: number; text: string }>;
			doneAt: number;
			finalText: string;
		};
		founderQuestion: {
			speakingFrom: number;
			speakingTo: number;
			userTurnAt: number;
			finalAt: number;
			text: string;
		};
		answerTurn: {
			createdAt: number;
			voicedFrom: number;
			voicedTo: number;
			doneAt: number;
			text: string;
		};
	};
}

const fixture = JSON.parse(
	readFileSync(
		new URL(
			"./fixtures/fly2885-founder-readback-1043b4a4.json",
			import.meta.url,
		),
		"utf8",
	),
) as Fixture;

const brain: BrainAdapter = {
	async *respond() {
		yield "unused";
	},
};

const FOUNDER = {
	utteranceId: "founder-utterance",
	ownerUserId: "founder",
	ownerName: "Annie",
};

const projection: VoiceSessionProjection = {
	sessionId: fixture.session,
	voiceBotUserId: "323456789012345678",
	mode: "rg",
	projectName: "flywheel",
	leadId: "flywheel-test-2",
	displayName: "Peter",
	realtimeVoice: "marin",
	guildId: "guild",
	voiceChannelId: "voice",
	threadId: "thread",
	boundChannelIds: ["thread"],
	founderUserId: "founder",
	qaAllowUserIds: [],
};

afterEach(() => {
	vi.useRealTimers();
});

/** A room player: one packet per 20 ms cycle, like @discordjs/voice. */
function roomPlayer() {
	type Resource = { stream: Readable };
	let current: Resource | undefined;
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
		cycle: () => {
			current?.stream.read();
		},
	};
}

function packet(id: number): Buffer {
	const buffer = Buffer.alloc(3);
	buffer[0] = 0xf8;
	buffer.writeUInt16BE(id & 0xffff, 1);
	return buffer;
}

type ReadbackScript = (
	room: ReplayRoom,
	sentAt: number,
	index: number,
	text: string,
) => void;

interface ReplayRoom {
	/** Schedule a provider event at an absolute (fake) time. */
	at(time: number, run: () => void): void;
	turn(
		type: "turn.created" | "turn.done",
		turnId: string,
		role: "user" | "assistant",
		transcript?: string | null,
	): void;
	assistantText(text: string, final: boolean): void;
	userFinal(text: string): void;
	/** The model's audio for [from, to). */
	voice(from: number, to: number): void;
	/** The founder's gated speech for [from, to). */
	speak(from: number, to: number): void;
}

/** The model reads what it was given, word for word (counterfactual). */
const faithful: ReadbackScript = (room, sentAt, index, text) => {
	const id = `readback-${index}`;
	const duration = Math.max(1_200, 150 * Array.from(text).length);
	room.at(sentAt + 600, () => room.turn("turn.created", id, "assistant"));
	room.voice(sentAt + 700, sentAt + 700 + duration);
	room.at(sentAt + 700 + duration, () =>
		room.turn("turn.done", id, "assistant", text),
	);
	room.at(sentAt + 712 + duration, () => room.assistantText(text, true));
};

async function replay(options: {
	reply: string;
	/** Scripts for the first read-aloud sends; later ones are faithful. */
	readbacks?: ReadbackScript[];
	/** Things that happen relative to the start of the replay. */
	setup?: (room: ReplayRoom, startAt: number) => void;
	/** The Lead reply shows up this long after the replay starts. */
	replyAfterMs?: number;
	/** How long after the reply is claimed the founder leaves the room. */
	leaveAfterMs: number;
}) {
	vi.useFakeTimers({ now: new Date("2026-09-26T15:56:20.000Z") });
	const startAt = Date.now();
	const player = roomPlayer();
	let callbacks: Record<string, (...args: never[]) => void> | undefined;
	let roomHandlers: RoomHandlers | undefined;
	const sent: Array<{ text: string; at: number }> = [];
	const evidence: Record<string, unknown>[] = [];
	const statuses: string[] = [];
	const mirror: Array<{ role: string; text: string }> = [];
	const receipts: string[] = [];
	const voiced: Array<{ from: number; to: number }> = [];
	const founderSpeech: Array<{ from: number; to: number }> = [];
	const room: ReplayRoom = {
		at: (time, run) => {
			setTimeout(run, Math.max(0, time - Date.now()));
		},
		turn: (type, turnId, role, transcript = null) =>
			callbacks?.onDataEvent({
				generation: 1,
				event: { type, turnId, role, startMs: null, endMs: null, transcript },
			} as never),
		assistantText: (text, final) =>
			callbacks?.onTranscript({
				generation: 1,
				association: "unattributed",
				role: "assistant",
				text,
				final,
				raw: {},
			} as never),
		userFinal: (text) =>
			callbacks?.onTranscript({
				generation: 1,
				itemId: "founder-question",
				association: "provider_item",
				role: "user",
				text,
				final: true,
				inputOwner: FOUNDER,
				raw: {},
			} as never),
		voice: (from, to) => voiced.push({ from, to }),
		speak: (from, to) => founderSpeech.push({ from, to }),
	};
	const conversation = {
		generation: 1,
		transport: {
			appendAudio: vi.fn(() => "sent" as const),
			appendSpeech: vi.fn(async (text: string) => {
				const now = Date.now();
				const index = sent.length;
				sent.push({ text, at: now });
				(options.readbacks?.[index] ?? faithful)(room, now, index, text);
			}),
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
		},
		close: vi.fn(async () => undefined),
	};
	const backend = new CodexVoiceBackend({
		sessionId: fixture.session,
		voice: "cove",
		container: {
			open: vi.fn(async (input: { realtime: Record<string, never> }) => {
				callbacks = input.realtime as never;
				return conversation;
			}),
		},
		loadContext: vi.fn(),
		downlink: () => player.downlink,
		monotonicNow: () => Date.now(),
		persistUtterance: async (utterance) => {
			mirror.push({ role: utterance.role, text: utterance.text });
		},
		onEvidence: (record) => evidence.push(record),
		postStatus: async (text) => {
			statuses.push(text);
		},
	});
	const session = new GenericVoiceSession({
		projection,
		delivery: { capture: async () => false },
		createFrontend: (handlers) =>
			new CodexRoomFrontend({
				backend,
				conversationOptions: { brain },
				handlers,
				onUnavailable: async () => undefined,
			}),
		createRoom: (handlers) => {
			roomHandlers = handlers;
			return {
				start: async () => ({ founderPresent: true }),
				playSpeech: async () => undefined,
				status: async (text) => {
					statuses.push(text);
				},
				stop: async () => undefined,
				cancelSpeech: vi.fn(),
				cancelAllSpeech: vi.fn(),
				setWaiting: vi.fn(),
				setBedEnabled: vi.fn(),
			};
		},
		lifecycle: () => undefined,
		evidence: (record) => evidence.push(record),
		confirmationMs: 0,
		postStatus: async (text) => {
			statuses.push(text);
		},
	});
	const lease = new VoiceLease(() => Date.now());
	lease.install(Date.now(), 15_000, 2_000);
	let claimedAt: number | undefined;
	const bridge = {
		desired: vi.fn(async () => ({ sessionId: fixture.session })),
		claim: vi.fn(async () => ({
			lease,
			leaseToken: "lease",
			leaseExpiresAt: "later",
			projection,
		})),
		renew: vi.fn(async () => {
			lease.install(Date.now(), 15_000, 2_000);
			return { state: "live", leaseExpiresAt: "later" };
		}),
		renewRecovered: vi.fn(),
		ready: vi.fn(async () => undefined),
		setState: vi.fn(async () => undefined),
		outbound: vi.fn(async () => {
			if (
				claimedAt !== undefined ||
				Date.now() < startAt + (options.replyAfterMs ?? 0)
			)
				return [];
			return [{ seq: 1, messageId: "m1", text: options.reply }];
		}),
		claimOutbound: vi.fn(async () => {
			claimedAt = Date.now();
			return "attempt";
		}),
		receipt: vi.fn(async (...args: unknown[]) => {
			receipts.push(args[5] as string);
		}),
	};
	const daemon = new VoiceDaemon({
		bridge,
		stateStore: {
			save: vi.fn(),
			list: vi.fn(() => []),
			remove: vi.fn(),
			quarantine: vi.fn(),
		},
		bootId: "boot",
		createSession: () => session,
		recoverSession: vi.fn(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		timing: {
			idlePollMs: 5_000,
			leaseRenewMs: 1_000,
			leaseMissMax: 2,
			presenceGraceMs: 120_000,
			speechChunkTokens: 80,
		},
	});

	options.setup?.(room, startAt);
	let finished = false;
	const running = daemon.runOnce().finally(() => {
		finished = true;
	});
	let sequence = 0;
	let founderWasSpeaking = false;
	let left = false;
	for (let ticks = 0; !finished && ticks < 20_000; ticks += 1) {
		const now = Date.now();
		if (callbacks) {
			const id = ++sequence;
			const isVoiced = voiced.some(
				(window) => window.from <= now && now < window.to,
			);
			callbacks.onDownlink({
				generation: 1,
				payload: packet(id),
				voiced: isVoiced,
				rms: isVoiced ? 2_000 : 0,
				sequence: id,
				receivedAtMs: now,
			} as never);
		}
		player.cycle();
		const speaking = founderSpeech.some(
			(window) => window.from <= now && now < window.to,
		);
		if (roomHandlers && (speaking || founderWasSpeaking))
			roomHandlers.onAudio(
				Buffer.alloc(960, speaking ? 1 : 0),
				speaking ? FOUNDER : { utteranceId: null, ownerUserId: null },
			);
		founderWasSpeaking = speaking;
		if (
			!left &&
			claimedAt !== undefined &&
			now >= claimedAt + options.leaveAfterMs
		) {
			left = true;
			roomHandlers?.onFounderPresence(false);
		}
		await vi.advanceTimersByTimeAsync(20);
	}
	expect(finished).toBe(true);
	await running;
	return {
		sent,
		evidence,
		statuses,
		mirror,
		receipts,
		startAt,
		claimedAt: claimedAt!,
	};
}

/** The recorded session: the model overruns chunk one, then she asks on. */
const recordedOverrun: ReadbackScript = (room, t1) => {
	const {
		overrunTurn: o,
		founderQuestion: q,
		answerTurn: a,
	} = fixture.timeline;
	const turnId = fixture.recorded.overrun.turnId;
	room.at(t1 + o.createdAt, () =>
		room.turn("turn.created", turnId, "assistant"),
	);
	room.voice(t1 + o.voicedFrom, t1 + o.voicedTo);
	for (const delta of o.deltas)
		room.at(t1 + delta.at, () => room.assistantText(delta.text, false));
	room.at(t1 + o.doneAt, () =>
		room.turn("turn.done", turnId, "assistant", o.finalText),
	);
	room.at(t1 + o.doneAt + 12, () => room.assistantText(o.finalText, true));
	// Her follow-up question and the model's 12 s answer to it.
	room.speak(t1 + q.speakingFrom, t1 + q.speakingTo);
	room.at(t1 + q.userTurnAt, () =>
		room.turn("turn.created", "founder-question", "user"),
	);
	room.at(t1 + q.finalAt, () => {
		room.turn("turn.done", "founder-question", "user");
		room.userFinal(q.text);
	});
	room.at(t1 + a.createdAt, () =>
		room.turn("turn.created", "answer", "assistant"),
	);
	room.voice(t1 + a.voicedFrom, t1 + a.voicedTo);
	room.at(t1 + a.doneAt, () =>
		room.turn("turn.done", "answer", "assistant", a.text),
	);
	room.at(t1 + a.doneAt + 12, () => room.assistantText(a.text, true));
};

/** The reply's two sentences as the speech projection reads them. */
const sentence1 = "我有 Peter 的角色背景,但没有读取他的完整 memory。";
const sentence2 =
	"知道他是产品负责人,主要负责产品需求、优先级和与 Annie 沟通;他最近具体在做什么,需要查记录,不能凭角色猜。";

describe("FLY-2885 founder readback replay (session 1043b4a4)", () => {
	it("reads both sentences of the Lead reply, not only the first", async () => {
		const result = await replay({
			reply: fixture.reply.text,
			readbacks: [recordedOverrun],
			// Her later turns reacted to hearing nothing; the replay stops at
			// the point the old path diverged, well after both sentences.
			leaveAfterMs: 45_000,
		});
		const t1 = result.sent[0]!.at;

		// Replay fidelity: the recorded overrun and discard are reproduced.
		expect(result.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_speech_overrun",
				turnId: fixture.recorded.overrun.turnId,
				expectedChars: fixture.recorded.overrun.expectedChars,
				unalignedChars: fixture.recorded.overrun.unalignedChars,
				detectedAtMs: fixture.recorded.overrun.detectedAtMs,
			}),
		);
		const resumed = result.evidence.find(
			(record) => record.kind === "codex_speech_overrun_resumed",
		);
		expect(
			Math.abs(
				(resumed?.discardMs as number) -
					fixture.recorded.overrunResumed.discardMs,
			),
		).toBeLessThanOrEqual(40);
		const [overrunLine] = fixture.recorded.threadMirror;
		expect(result.mirror).toContainEqual({
			role: overrunLine!.role,
			text: overrunLine!.text,
		});

		// Both sentences reach the model, the second after her exchange ends;
		// the handoff-id line the Lead quoted for correlation is not read.
		expect(result.sent.map((row) => row.text)).toEqual([sentence1, sentence2]);
		expect(result.sent[1]!.at).toBeGreaterThanOrEqual(
			t1 + fixture.timeline.answerTurn.doneAt,
		);
		expect(result.mirror).toContainEqual({
			role: "assistant",
			text: sentence2,
		});
		expect(
			result.evidence.filter(
				(record) => record.kind === "codex_speech_admission_timeout",
			),
		).toEqual([]);
		expect(result.statuses).not.toContain("📻 剩下的内容在频道里");
	});

	it("keeps the reply queued while she keeps talking and reads it once her turn is answered", async () => {
		const reply = "第一件事已经完成了。第二件事明天上午开始。";
		const result = await replay({
			reply,
			replyAfterMs: 2_000,
			setup: (room, start) => {
				// 32 s of continuous speech; the reply arrives 1.5 s into it.
				room.speak(start + 500, start + 32_500);
				room.at(start + 700, () =>
					room.turn("turn.created", "long-question", "user"),
				);
				room.at(start + 32_700, () => {
					room.turn("turn.done", "long-question", "user");
					room.userFinal("我先说一大段我自己的想法");
				});
				room.at(start + 33_300, () =>
					room.turn("turn.created", "long-answer", "assistant"),
				);
				room.voice(start + 33_500, start + 38_500);
				room.at(start + 38_550, () =>
					room.turn(
						"turn.done",
						"long-answer",
						"assistant",
						"好的，我听到了。",
					),
				);
				room.at(start + 38_562, () =>
					room.assistantText("好的，我听到了。", true),
				);
			},
			leaveAfterMs: 50_000,
		});
		// She was already talking when the reply was claimed.
		expect(result.claimedAt).toBeGreaterThan(result.startAt + 500);
		expect(result.sent.map((row) => row.text)).toEqual([reply]);
		expect(result.sent[0]!.at).toBeGreaterThanOrEqual(result.startAt + 38_550);
		expect(result.receipts).toEqual(["confirmed"]);
		expect(
			result.evidence.filter(
				(record) => record.kind === "codex_speech_admission_timeout",
			),
		).toEqual([]);
	});
});
