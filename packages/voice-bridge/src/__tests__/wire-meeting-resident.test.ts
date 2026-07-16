/**
 * FLY-1160 §4.1 — wireMeeting in RESIDENT mode: the resident Claude brain
 * thinks + speaks (edge-tts text mouth), Gemini is STT ONLY (its response is
 * discarded), and non-addressed meeting facts ride the resident's
 * appendContext (not Gemini injectContext). The gemini-mode composition tests
 * (wire-meeting.test.ts) prove mode:"gemini" is byte-identical.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BrainAdapter,
	ConversationEventMap,
	ConversationSession,
} from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayerLike } from "../audio/LeadSpeaker.js";
import { TivPresenter } from "../discord/TivPresenter.js";
import { createHuddleTiv } from "../huddle/huddleTiv.js";
import type {
	ResidentBrainHandle,
	ResidentTurnBrain,
} from "../huddle/ResidentLineDriver.js";
import { wireMeeting } from "../huddle/wireMeeting.js";

class FakeSession implements ConversationSession {
	readonly sessionId: string;
	audio: Buffer[] = [];
	preamble: string;
	private handlers = new Map<string, ((...a: never[]) => void)[]>();
	constructor(id: string, preamble: string) {
		this.sessionId = id;
		this.preamble = preamble;
	}
	sendAudio(frame: Buffer): void {
		this.audio.push(frame);
	}
	sendText(): void {}
	injectContext(): void {}
	interrupt(): void {}
	injectToolResult(): void {}
	on<E extends keyof ConversationEventMap>(
		e: E,
		h: (...a: ConversationEventMap[E]) => void,
	): () => void {
		const list = this.handlers.get(e) ?? [];
		list.push(h as (...a: never[]) => void);
		this.handlers.set(e, list);
		return () => {};
	}
	emit<E extends keyof ConversationEventMap>(
		e: E,
		...a: ConversationEventMap[E]
	): void {
		for (const h of this.handlers.get(e) ?? [])
			(h as (...args: ConversationEventMap[E]) => void)(...a);
	}
	hasListener(e: keyof ConversationEventMap): boolean {
		return (this.handlers.get(e)?.length ?? 0) > 0;
	}
	async close(): Promise<undefined> {
		return undefined;
	}
}

const invocation = {
	issue: { id: "u1", identifier: "FLY-1234", url: "https://l/1234" },
	participants: [
		{ leadId: "eng", userId: "bot-1", displayName: "Tadashi" },
		{ leadId: "joy", userId: "bot-2", displayName: "Hiro" },
	],
	hostLeadId: "eng",
	initiatorChannelId: "chan-1",
};

/** a fake resident line: brain records prompts/contexts + yields a canned
 * reply; speaker records the sentences spoken. */
function fakeResident() {
	const prompts: string[] = [];
	const contexts: string[] = [];
	const spoken: string[] = [];
	const brain: ResidentBrainHandle = {
		async *respond(turn: Parameters<ResidentTurnBrain["respond"]>[0]) {
			prompts.push(turn.text);
			yield "好的。";
		},
		interrupt: async () => {},
		appendContext: (t: string) => {
			contexts.push(t);
			return { accepted: true, seq: contexts.length };
		},
	};
	const speaker = {
		speak: async (t: string) => {
			spoken.push(t);
			return { cancelled: false };
		},
		stop: () => {},
	};
	return { brain, speaker, prompts, contexts, spoken };
}

function fakePlayer(): PlayerLike {
	return { play: () => {}, stop: () => {}, on: () => {} };
}

const transcriptDir = join(tmpdir(), `glaw-resident-test-${process.pid}`);
afterEach(() => rmSync(transcriptDir, { recursive: true, force: true }));

const flush = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		for (let j = 0; j < 10; j++) await Promise.resolve();
	}
};

async function assembleResident() {
	const sessions: FakeSession[] = [];
	const residents = new Map<string, ReturnType<typeof fakeResident>>();
	const keys: string[] = [];
	const posts: string[] = [];
	const meeting = await wireMeeting(
		invocation,
		[{ agentId: "eng" }, { agentId: "joy" }],
		{
			projectName: "flywheel",
			projectRoot: "/tmp/repo",
			transcriptDir,
			assembleTimeoutMs: 600_000,
			mode: "resident",
		},
		{
			joinLeadVoice: async () => ({
				player: fakePlayer(),
				createResource: (s) => s,
			}),
			createConversation: async (opts) => {
				const s = new FakeSession(`s${sessions.length}`, opts.systemPreamble);
				sessions.push(s);
				return s;
			},
			createBrain: () => ({}) as BrainAdapter,
			createResidentLine: ({ key }) => {
				keys.push(key);
				const r = fakeResident();
				residents.set(key, r);
				return { brain: r.brain, speaker: r.speaker };
			},
			summarize: async () => "## 结论\n1. x",
			worktree: { create: async () => ({ path: "/tmp/wt" }) },
			linear: {
				comment: async () => {},
				setStatus: async () => {},
				lookupIssue: async () => ({ matchType: "identifier" as const }),
			} as any,
			tiv: createHuddleTiv({
				presenter: new TivPresenter({
					deps: {
						send: async (c) => void posts.push(c),
						sendForId: async (c) => {
							posts.push(c);
							return { messageId: `m${posts.length}` };
						},
						edit: async () => {},
					},
				}),
				postCard: async (c) => void posts.push(c),
			}),
			release: vi.fn(),
		},
	);
	return { meeting, sessions, residents, keys };
}

describe("wireMeeting resident mode (FLY-1160 §4.1)", () => {
	it("opens one resident brain per lead, keyed <issue>:<leadId>; Gemini is STT-only", async () => {
		const { meeting, sessions, keys } = await assembleResident();
		expect(keys).toEqual(["FLY-1234:eng", "FLY-1234:joy"]);
		// a Gemini session still exists per lead (for STT) with the squeezed
		// STT-only preamble (§4.1-2), NOT the thinking preamble.
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.preamble).toContain("只负责把用户说的话转成文字");
		// the discarded Gemini generation is NOT wired to any mouth.
		expect(sessions[0]?.hasListener("response-audio")).toBe(false);
		expect(sessions[0]?.hasListener("transcript")).toBe(true); // STT is wired
		await meeting.dispose();
	});

	it("host greeting + a founder turn drive the resident brain → the text speaker; the answer fans out via appendContext", async () => {
		const { meeting, residents } = await assembleResident();
		const eng = residents.get("FLY-1234:eng")!;
		const joy = residents.get("FLY-1234:joy")!;

		meeting.huddle.start();
		meeting.huddle.handleFounderVoiceState(true);
		await flush();
		expect(eng.prompts[0]).toContain("招呼"); // greeting drove the resident
		expect(eng.spoken).toEqual(["好的。"]); // spoken through the edge-tts mouth

		eng.prompts.length = 0;
		eng.spoken.length = 0;
		// founder speaks (Gemini STT emits a user transcript on the addressed line)
		meeting.huddle.handleLineTranscript("eng", {
			role: "user",
			text: "发布定周五",
			final: true,
		});
		await flush();
		// the resident (which never heard audio) was given the transcript
		expect(eng.prompts).toEqual(["发布定周五"]);
		// the OTHER line hears her words through the feed → appendContext (§4.1-4)
		expect(joy.contexts).toContain("[会议记录] Annie: 发布定周五");
		// and the answer fans out to the other line too (handleResidentAnswer)
		expect(joy.contexts).toContain("[会议记录] Tadashi: 好的。");
		await meeting.dispose();
	});

	it("assembly failure AFTER the first brain opened reaps every opened resident brain (Codex R1 HIGH-2)", async () => {
		const opened: string[] = [];
		const closed: string[] = [];
		let joins = 0;
		await expect(
			wireMeeting(
				invocation,
				[{ agentId: "eng" }, { agentId: "joy" }],
				{
					projectName: "flywheel",
					projectRoot: "/tmp/repo",
					transcriptDir,
					assembleTimeoutMs: 600_000,
					mode: "resident",
				},
				{
					joinLeadVoice: async () => {
						joins++;
						// the SECOND participant's join fails — the first brain is
						// already open by then.
						if (joins === 2) throw new Error("VC join failed for joy");
						return { player: fakePlayer(), createResource: (s) => s };
					},
					createConversation: async (opts) =>
						new FakeSession("s", opts.systemPreamble),
					createBrain: () => ({}) as BrainAdapter,
					createResidentLine: ({ key }) => {
						opened.push(key);
						const r = fakeResident();
						return { brain: r.brain, speaker: r.speaker };
					},
					closeResidentLine: (key) => {
						closed.push(key);
					},
					summarize: async () => "x",
					worktree: { create: async () => ({ path: "/tmp/wt" }) },
					linear: {
						comment: async () => {},
						setStatus: async () => {},
						lookupIssue: async () => ({ matchType: "identifier" as const }),
					} as any,
					tiv: createHuddleTiv({
						presenter: new TivPresenter({
							deps: {
								send: async () => {},
								sendForId: async () => ({ messageId: "m" }),
								edit: async () => {},
							},
						}),
						postCard: async () => {},
					}),
					release: vi.fn(),
				},
			),
		).rejects.toThrow(/VC join failed/);
		// the eng brain was opened; the failure path must have closed it.
		expect(opened).toEqual(["FLY-1234:eng"]);
		expect(closed).toEqual(["FLY-1234:eng"]);
	});

	it("FLY-1190: resident STT rotation EXHAUSTED (reconnect create fails) → onError marks the ears line failed, no wedge (Codex MEDIUM-1)", async () => {
		const sessions: FakeSession[] = [];
		const posts: string[] = [];
		let created = 0;
		const meeting = await wireMeeting(
			invocation,
			[{ agentId: "eng" }, { agentId: "joy" }],
			{
				projectName: "flywheel",
				projectRoot: "/tmp/repo",
				transcriptDir,
				assembleTimeoutMs: 600_000,
				mode: "resident",
			},
			{
				joinLeadVoice: async () => ({
					player: fakePlayer(),
					createResource: (s) => s,
				}),
				createConversation: async (opts) => {
					created++;
					// the two initial STT sessions assemble fine; the RECONNECT create
					// (3rd) throws → the rotator exhausts and MUST call onError. Without the
					// wiring the line wedges silently and this warn never surfaces.
					if (created > 2) throw new Error("STT reconnect create failed");
					const s = new FakeSession(`s${sessions.length}`, opts.systemPreamble);
					sessions.push(s);
					return s;
				},
				createBrain: () => ({}) as BrainAdapter,
				createResidentLine: () => {
					const r = fakeResident();
					return { brain: r.brain, speaker: r.speaker };
				},
				summarize: async () => "## 结论\n1. x",
				worktree: { create: async () => ({ path: "/tmp/wt" }) },
				linear: {
					comment: async () => {},
					setStatus: async () => {},
					lookupIssue: async () => ({ matchType: "identifier" as const }),
				} as any,
				tiv: createHuddleTiv({
					presenter: new TivPresenter({
						deps: {
							send: async (c) => void posts.push(c),
							sendForId: async (c) => {
								posts.push(c);
								return { messageId: `m${posts.length}` };
							},
							edit: async () => {},
						},
					}),
					postCard: async (c) => void posts.push(c),
				}),
				release: vi.fn(),
			},
		);
		meeting.huddle.start();
		meeting.huddle.handleFounderVoiceState(true);
		// eng's STT connection dies → rotator reconnect → create throws → onError →
		// handleLineFailed (the "本场会议不可用" warn is uniquely the wiring's onError).
		sessions[0]?.emit("error", {
			name: "VoiceError",
			message: "ws closed",
			code: "connection-closed",
		} as never);
		await vi.waitFor(
			() => {
				if (!posts.some((p) => p.includes("本场会议不可用")))
					throw new Error("onError → handleLineFailed warn never surfaced");
			},
			{ timeout: 5000, interval: 20 },
		);
		await meeting.dispose();
	});

	it("Gemini response-audio on the STT session never reaches the speaker", async () => {
		const { meeting, sessions, residents } = await assembleResident();
		const eng = residents.get("FLY-1234:eng")!;
		meeting.huddle.start();
		meeting.huddle.handleFounderVoiceState(true);
		await flush();
		eng.spoken.length = 0;
		// the discarded Gemini generation fires — it must produce NO speech.
		sessions[0]?.emit("response-audio", Buffer.from("pcm"));
		sessions[0]?.emit("response-done");
		await flush();
		expect(eng.spoken).toEqual([]);
		await meeting.dispose();
	});
});
