/**
 * QA R4 (Annie's third real-machine run, qa-result FAIL f08ecc1d) — the
 * fake-resume root cause and its court:
 *  (a) the rotator's resume handle MUST reach createConversation — it was
 *      silently dropped, so "resumed=true" was a lie and every reconnect
 *      produced a blank-brained line (her 裸 LLM).
 *  (b) defensive journal replay on every connection-death recovery.
 *  (c) the stall warning fires ONCE per wait (she saw the same ⚠️ twice).
 *  (d) covered in voice-core (async transcript sink drain).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AudioFormat,
	BrainAdapter,
	ConversationEventMap,
	ConversationSession,
	ResumeHandle,
} from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TivPresenter } from "../discord/TivPresenter.js";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import { type HuddleLine, HuddleSession } from "../huddle/HuddleSession.js";
import { createHuddleTiv } from "../huddle/huddleTiv.js";
import { wireMeeting } from "../huddle/wireMeeting.js";

class FakeSession implements ConversationSession {
	readonly sessionId: string;
	injected: string[] = [];
	/** unified op order (R35 M3): context-vs-audio-vs-end sequencing. */
	ops: string[] = [];
	private handlers = new Map<string, ((...a: never[]) => void)[]>();
	constructor(
		id: string,
		readonly handle?: string,
	) {
		this.sessionId = id;
	}
	sendAudio(): void {
		this.ops.push("audio");
	}
	texts: string[] = [];
	sendText(t: string): void {
		this.texts.push(t);
		this.ops.push("text");
	}
	injectContext(t: string): void {
		this.injected.push(t);
		this.ops.push("context");
	}
	endUserTurn(): void {
		this.ops.push("end");
	}
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
			(h as (...x: unknown[]) => void)(...a);
	}
	async close(): Promise<ResumeHandle | undefined> {
		return this.handle
			? { backendId: "gemini-live", payload: this.handle }
			: undefined;
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
const transcriptDir = join(tmpdir(), `glaw-r4-${process.pid}`);
afterEach(() => {
	rmSync(transcriptDir, { recursive: true, force: true });
	vi.useRealTimers();
});

async function assemble(noHandleFor: number[] = []) {
	const sessions: FakeSession[] = [];
	const createOpts: Array<{ resumeHandle?: ResumeHandle }> = [];
	const stops: number[] = [];
	const warns: string[] = [];
	const meeting = await wireMeeting(
		invocation,
		[{ agentId: "eng", geminiVoice: "Kore" }, { agentId: "joy" }],
		{
			projectName: "flywheel",
			projectRoot: "/tmp/repo",
			transcriptDir,
			assembleTimeoutMs: 600_000,
		},
		{
			joinLeadVoice: async () => ({
				player: {
					play: () => {},
					stop: () => void stops.push(1),
					on: () => {},
				},
				createResource: (s) => s,
			}),
			createConversation: async (opts) => {
				createOpts.push({ resumeHandle: opts.resumeHandle });
				const s = new FakeSession(
					`s${sessions.length}`,
					noHandleFor.includes(sessions.length)
						? undefined
						: `resume-${sessions.length}`,
				);
				sessions.push(s);
				return s;
			},
			createBrain: () => ({}) as BrainAdapter,
			summarize: async () => "## 结论\n1. x",
			worktree: { create: async () => ({ path: "/tmp/wt" }) },
			linear: {
				comment: async () => {},
				setStatus: async () => {},
				lookupIssue: async () => ({ matchType: "identifier" as const }),
			} as never,
			tiv: (() => {
				const base = createHuddleTiv({
					presenter: new TivPresenter({
						deps: {
							send: async () => {},
							sendForId: async () => ({ messageId: "m1" }),
							edit: async () => {},
						},
					}),
					postCard: async () => {},
				});
				return {
					...base,
					warn: (t: string) => {
						warns.push(t);
						base.warn(t);
					},
				};
			})(),
			release: () => {},
		},
	);
	meeting.huddle.start();
	meeting.huddle.handleFounderVoiceState(true);
	return { meeting, sessions, createOpts, stops, warns };
}

describe("R4 (a) — resumed=true must mean ACTUALLY resumed", () => {
	it("connection death → the successor's createConversation receives the handle", async () => {
		const { sessions, createOpts } = await assemble();
		expect(createOpts[0]?.resumeHandle).toBeUndefined(); // first is fresh
		expect(createOpts[1]?.resumeHandle).toBeUndefined();
		sessions[0]?.emit("error", {
			name: "VoiceError",
			message: "ws closed",
			code: "connection-closed",
		} as never);
		await vi.waitFor(() => {
			if (sessions.length < 3) throw new Error("not rotated yet");
		});
		// THE lie, pinned red: the successor was created WITH the resume handle
		expect(createOpts[2]?.resumeHandle).toEqual({
			backendId: "gemini-live",
			payload: "resume-0",
		});
	});

	it("(b) the successor gets the journal replayed even though resume succeeded", async () => {
		const { sessions } = await assemble();
		// her words route via the ADDRESSED line (eng) and journal to joy
		sessions[0]?.emit("transcript", {
			role: "user",
			text: "发布定周五",
			final: true,
		});
		await vi.waitFor(() => {
			if (!sessions[1]?.injected.some((t) => t.includes("发布定周五")))
				throw new Error("journal not delivered to joy yet");
		});
		// JOY's connection dies → resumed successor must still get the journal
		sessions[1]?.emit("error", {
			name: "VoiceError",
			message: "ws closed",
			code: "connection-closed",
		} as never);
		await vi.waitFor(() => {
			if (sessions.length < 3) throw new Error("not rotated yet");
		});
		await vi.waitFor(() => {
			if (!sessions[2]?.injected.some((t) => t.includes("发布定周五")))
				throw new Error("journal not replayed yet");
		});
		// exactly once (no attach+reconnect double replay)
		expect(
			sessions[2]?.injected.filter((t) => t.includes("发布定周五")),
		).toHaveLength(1);
	});

	it("a stale attach-replay flag from a graceful rotation never eats a later reconnect replay (Codex R27)", async () => {
		// joy's FIRST session closes WITHOUT a handle → the graceful rotation
		// truly rebuilds context-less and attach replays (setting the flag).
		const { meeting, sessions } = await assemble([1]);
		sessions[0]?.emit("transcript", {
			role: "user",
			text: "发布定周五",
			final: true,
		});
		await vi.waitFor(() => {
			if (!sessions[1]?.injected.some((t) => t.includes("发布定周五")))
				throw new Error("journal not delivered yet");
		});
		// graceful goAway rotation on joy — close() returns NO handle
		sessions[1]?.emit("session-expiring", { inSec: 5 });
		await vi.waitFor(() => {
			if (sessions.length < 3) throw new Error("graceful not rotated yet");
		});
		// the no-handle rebuild replays on ATTACH (this is what sets the flag)
		await vi.waitFor(() => {
			if (!sessions[2]?.injected.some((t) => t.includes("发布定周五")))
				throw new Error("attach replay missing");
		});
		// now the SUCCESSOR dies (connection death) → defensive replay must
		// still run despite the earlier attach-side activity
		sessions[2]?.emit("error", {
			name: "VoiceError",
			message: "ws closed",
			code: "connection-closed",
		} as never);
		await vi.waitFor(() => {
			if (sessions.length < 4) throw new Error("reconnect not rotated yet");
		});
		await vi.waitFor(() => {
			if (!sessions[3]?.injected.some((t) => t.includes("发布定周五")))
				throw new Error("reconnect replay missing");
		});
		expect(
			sessions[3]?.injected.filter((t) => t.includes("发布定周五")),
		).toHaveLength(1);
		void meeting;
	});
});

describe("R4 (c) — one stall warning per wait", () => {
	function huddle() {
		const eng: HuddleLine = {
			leadId: "eng",
			displayName: "Tadashi",
			session: {
				sendAudio: () => {},
				sendText: () => {},
				injectContext: () => {},
				interrupt: () => {},
			},
			mouth: {
				beginTurn: () => {},
				feed: () => {},
				endTurn: () => {},
				flush: () => {},
				noteToolCall: () => {},
				noteToolResolved: () => {},
			},
		};
		const warns: string[] = [];
		const h = new HuddleSession({
			issue: invocation.issue,
			hostLeadId: "eng",
			lines: [eng],
			router: new AddressRouter([{ leadId: "eng", aliases: [] }], "eng"),
			feed: new FeedPipeline(),
			ladder: { notifyFounderUtterance: vi.fn() },
			tiv: {
				presence: () => {},
				caption: () => {},
				warn: (t) => void warns.push(t),
			},
			conclusion: {
				land: vi.fn(async () => "landed" as const),
				abortNoShow: vi.fn(async () => {}),
			},
			onTeardown: vi.fn(),
			assembleTimeoutMs: 600_000,
			thinkingWatchdogMs: 1_000,
		});
		h.start();
		h.handleFounderVoiceState(true);
		return { h, warns };
	}

	it("two stalls in the same wedged wait warn ONCE; after real progress a new stall warns again", async () => {
		vi.useFakeTimers();
		const { h, warns } = huddle();
		h.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(1_100);
		h.handleFounderSpeechStopped(); // she tries again, still wedged
		await vi.advanceTimersByTimeAsync(1_100);
		expect(warns.filter((w) => w.includes("等得比平时久"))).toHaveLength(1);
		// real progress clears the latch
		h.handleLineTranscript("eng", { role: "user", text: "问", final: true });
		h.handleLineResponseStarted("eng");
		// a NEW stall on the next wait warns again
		h.handleFounderSpeechStopped();
		await vi.advanceTimersByTimeAsync(1_100);
		expect(warns.filter((w) => w.includes("等得比平时久"))).toHaveLength(2);
	});
});

describe("R4 HIGH (Codex R27) — a lost transcript write can never publish as a complete record", () => {
	it("landing fails the transcript stage when the sink recorded a write failure for its file", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { JsonlTranscriptSink, clearTranscriptWriteFailure } = await import(
			"flywheel-voice-core"
		);
		const { AssistantLanding } = await import(
			"../assistant/AssistantLanding.js"
		);
		const dir = mkdtempSync(join(tmpdir(), "r4-sink-fail-"));
		try {
			// unwritable transcript path (parent is a FILE) → the sink fails
			const blocker = join(dir, "blocker");
			writeFileSync(blocker, "x");
			const transcriptPath = join(blocker, "session.jsonl");
			const sink = new JsonlTranscriptSink(transcriptPath, () => {});
			sink.append({
				ts: "2026-07-11T00:00:00.000Z",
				sessionId: "s",
				backendId: "gemini-live",
				face: "converse",
				role: "user",
				text: "丢失的行",
				final: true,
			});
			await sink.flush();
			const landing = new AssistantLanding({
				linear: {
					comment: vi.fn(async () => ({ url: "https://l/c1" })),
					closeIssue: vi.fn(async () => {}),
				},
				receiptPath: join(dir, "receipt.json"),
				transcriptPath,
			});
			const result = await landing.run({
				issueId: "FLY-1234",
				sessionId: "s",
				recapText: "纪要",
				quotes: [],
				confirmed: true,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.stage).toBe("transcript");
				expect(result.message).toContain("不完整");
			}
			clearTranscriptWriteFailure(transcriptPath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("R35 M3 — context replay lands BEFORE the recovered audio", () => {
	const FMT: AudioFormat = {
		encoding: "pcm16",
		sampleRateHz: 16_000,
		channels: 1,
	};
	it("on death-reconnect the successor gets journal context first, then the replayed founder frames, then the turn close", async () => {
		const { meeting, sessions } = await assemble();
		// journal content that the defensive replay will re-deliver to joy
		sessions[0]?.emit("transcript", {
			role: "user",
			text: "发布定周五",
			final: true,
		});
		await vi.waitFor(() => {
			if (!sessions[1]?.injected.some((t) => t.includes("发布定周五")))
				throw new Error("journal not delivered yet");
		});
		// route her speech to joy, then frames that will need replay
		sessions[0]?.emit("transcript", {
			role: "user",
			text: "Hiro 你来说说",
			final: true,
		});
		meeting.huddle.handleFounderFrame(Buffer.alloc(320, 7), FMT);
		meeting.huddle.handleFounderSpeechStopped();
		// joy's connection dies with her utterance unrecovered
		sessions[1]?.emit("error", {
			name: "VoiceError",
			message: "ws closed",
			code: "connection-closed",
		} as never);
		await vi.waitFor(() => {
			if (sessions.length < 3) throw new Error("not rotated yet");
		});
		const succ = sessions[2] as FakeSession;
		await vi.waitFor(() => {
			if (!succ.ops.includes("audio")) throw new Error("no replay yet");
		});
		// the recovered utterance must not be committed into a context-less
		// session: every context injection precedes the first replayed frame.
		const firstAudio = succ.ops.indexOf("audio");
		const lastContext = succ.ops.lastIndexOf("context");
		expect(lastContext).toBeGreaterThanOrEqual(0);
		expect(lastContext).toBeLessThan(firstAudio);
		// she had already finished speaking — the replay closes the turn
		expect(succ.ops.indexOf("end")).toBeGreaterThan(firstAudio);
	});
});

describe("R39 MEDIUM-2 — the wiring never says 请再说 after a delivered handoff", () => {
	it("a handoff queued during the rotation gap delivers on reconnect and the warn says so", async () => {
		const { meeting, sessions, warns } = await assemble();
		// joy's connection dies — onDown fires synchronously, opening the
		// down window; the routing utterance arrives in the SAME tick, before
		// the async rotation completes.
		sessions[1]?.emit("error", {
			name: "VoiceError",
			message: "ws closed",
			code: "connection-closed",
		} as never);
		sessions[0]?.emit("transcript", {
			role: "user",
			text: "Hiro 你来说说",
			final: true,
		});
		await vi.waitFor(() => {
			if (sessions.length < 3) throw new Error("not rotated yet");
		});
		const succ = sessions[2] as FakeSession;
		await vi.waitFor(() => {
			if (!succ.texts.some((t) => t.includes("[Annie 在点名你] Hiro 你来说说")))
				throw new Error("handoff not delivered yet");
		});
		const reconnectWarns = warns.filter((w) => w.includes("闪断"));
		expect(reconnectWarns.some((w) => w.includes("转给"))).toBe(true);
		expect(reconnectWarns.some((w) => w.includes("请再说"))).toBe(false);
		void meeting;
	});
});
