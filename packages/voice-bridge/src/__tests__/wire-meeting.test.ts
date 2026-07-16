/**
 * FLY-545 PR-2 — wireMeeting composition smoke: the assembly really wires
 * session events → HuddleSession handlers → mouths/feed/landing (the glue a
 * unit test of each part cannot see).
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AudioFormat,
	BrainAdapter,
	ConversationEventMap,
	ConversationSession,
} from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayerLike } from "../audio/LeadSpeaker.js";
import { TivPresenter } from "../discord/TivPresenter.js";
import { createHuddleTiv } from "../huddle/huddleTiv.js";
import { wireMeeting } from "../huddle/wireMeeting.js";

class FakeSession implements ConversationSession {
	readonly sessionId: string;
	texts: string[] = [];
	injected: string[] = [];
	audio: Buffer[] = [];
	private handlers = new Map<string, ((...a: never[]) => void)[]>();
	constructor(
		id: string,
		readonly voice: string | undefined,
		readonly preamble: string,
	) {
		this.sessionId = id;
	}
	sendAudio(frame: Buffer, _f: AudioFormat): void {
		this.audio.push(frame);
	}
	sendText(t: string): void {
		this.texts.push(t);
	}
	injectContext(t: string): void {
		this.injected.push(t);
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
			(h as (...args: ConversationEventMap[E]) => void)(...a);
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

function fakePlayer(): PlayerLike {
	return { play: () => {}, stop: () => {}, on: () => {} };
}

const transcriptDir = join(tmpdir(), `glaw-test-${process.pid}`);
afterEach(() => {
	rmSync(transcriptDir, { recursive: true, force: true });
});

async function assemble() {
	const sessions: FakeSession[] = [];
	const linearCalls: string[] = [];
	const posts: string[] = [];
	const released = vi.fn();
	const meeting = await wireMeeting(
		invocation,
		[
			{ agentId: "eng", geminiVoice: "Kore", aliases: ["阿正"] },
			{ agentId: "joy" }, // default voice rotation
		],
		{
			projectName: "flywheel",
			projectRoot: "/tmp/repo",
			transcriptDir,
			assembleTimeoutMs: 600_000,
		},
		{
			joinLeadVoice: async () => ({
				player: fakePlayer(),
				createResource: (s) => s,
			}),
			createConversation: async (opts) => {
				const s = new FakeSession(
					`s${sessions.length}`,
					opts.voice,
					opts.systemPreamble,
				);
				sessions.push(s);
				return s;
			},
			createBrain: () => ({}) as BrainAdapter,
			summarize: async () => "## 结论\n1. x(引用 [ts] Annie: x)",
			worktree: { create: async () => ({ path: "/tmp/wt" }) },
			linear: {
				comment: async (id: string) => {
					linearCalls.push(`comment:${id}`);
				},
				setStatus: async (id: string, s: string) => {
					linearCalls.push(`status:${id}:${s}`);
				},
				lookupIssue: async () => ({ matchType: "identifier" as const }),
			} as any,
			tiv: createHuddleTiv({
				presenter: new TivPresenter({
					deps: {
						send: async (c) => {
							posts.push(c);
						},
						sendForId: async (c) => {
							posts.push(c);
							return { messageId: `m${posts.length}` };
						},
						edit: async () => {},
					},
				}),
				postCard: async (c) => {
					posts.push(c);
				},
			}),
			release: released,
		},
	);
	return { meeting, sessions, linearCalls, posts, released };
}

describe("wireMeeting composition", () => {
	it("builds one session per Lead with voice + self-ID preamble, wires the event graph", async () => {
		const { meeting, sessions } = await assemble();
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.voice).toBe("Kore"); // configured
		expect(sessions[1]?.voice).toBe("Puck"); // default rotation index 1
		expect(sessions[0]?.preamble).toContain("你是 Tadashi");
		expect(sessions[0]?.preamble).toContain("自报身份");

		meeting.huddle.start();
		meeting.huddle.handleFounderVoiceState(true);
		// host greeting rode the wiring into the HOST session only
		expect(sessions[0]?.texts[0]).toContain("招呼");
		expect(sessions[1]?.texts).toHaveLength(0);

		// founder speaks (event from the addressed session) → journal fans out
		sessions[0]?.emit("transcript", {
			role: "user",
			text: "发布定周五",
			final: true,
		});
		expect(sessions[1]?.injected).toEqual(["[会议记录] Annie: 发布定周五"]);
		expect(sessions[0]?.injected).toHaveLength(0);

		await meeting.dispose();
	});

	it("conclude→confirm lands through linear and releases the meeting", async () => {
		const { meeting, sessions, linearCalls, released } = await assemble();
		meeting.huddle.start();
		meeting.huddle.handleFounderVoiceState(true);
		sessions[0]?.emit("transcript", {
			role: "user",
			text: "就这样",
			final: true,
		});
		expect(sessions[0]?.texts.at(-1)).toContain("recap");
		sessions[0]?.emit("transcript", { role: "user", text: "对", final: true });
		await vi.waitFor(() => {
			expect(released).toHaveBeenCalled();
		});
		expect(linearCalls).toEqual(["comment:FLY-1234", "status:FLY-1234:Done"]);
	});
});
