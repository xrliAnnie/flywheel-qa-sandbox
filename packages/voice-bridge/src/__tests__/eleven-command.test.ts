/**
 * FLY-1006 S7 — ElevenCommand contract tests: fail-loud preflight, shared
 * slot contention, session ownership handoff, /eleven stop.
 */
import { describe, expect, it } from "vitest";
import { ELEVEN_SLOT_MODE } from "../eleven/config.js";
import {
	ElevenCommand,
	type ElevenPreflightResult,
} from "../eleven/ElevenCommand.js";
import { SessionSlot } from "../SessionSlot.js";

function makeCommand(over: Record<string, unknown> = {}) {
	const slot = new SessionSlot();
	const calls = {
		started: [] as string[],
		startedIssues: [] as string[],
		issues: 0,
		stops: 0,
	};
	const replies: { text: string; joinUrl?: string }[] = [];
	const command = new ElevenCommand({
		slot,
		joinUrl: "https://discord.com/channels/g/vc",
		preflight: async (): Promise<ElevenPreflightResult> => ({ ok: true }),
		createIssue: async () => {
			calls.issues++;
			return { identifier: "FLY-2001", url: "https://linear.app/i/FLY-2001" };
		},
		startSession: async ({ sessionId, issueId }) => {
			calls.started.push(sessionId);
			calls.startedIssues.push(issueId);
		},
		stopSession: async () => false,
		now: () => new Date("2026-07-11T09:05:00"),
		log: () => {},
		...over,
	});
	const invoke = async (topic?: string) => {
		await command.handle({
			topic,
			reply: async (text, opts) => {
				replies.push({ text, joinUrl: opts?.joinUrl });
			},
		});
	};
	return { command, slot, calls, replies, invoke };
}

describe("ElevenCommand (FLY-1006 S7)", () => {
	it("preflight failure = fail-loud reply with the reason; slot untouched", async () => {
		const f = makeCommand({
			preflight: async () => ({
				ok: false,
				reason: "shim 不在线(http://127.0.0.1:8980/health)",
			}),
		});
		await f.invoke();
		expect(f.replies[0].text).toContain("shim 不在线");
		expect(f.calls.started).toHaveLength(0);
		expect(f.slot.current()).toBe(null);
	});

	it("busy room (e.g. /gemini live) → founder-facing rejection, no session", async () => {
		const f = makeCommand();
		f.slot.acquire("gemini", "meeting-1");
		await f.invoke();
		expect(f.replies[0].text).toContain("/gemini");
		expect(f.calls.started).toHaveLength(0);
	});

	it("happy path: acquire → kickoff issue → invite with Join → session started with issueId (owns the slot)", async () => {
		const f = makeCommand();
		await f.invoke("聊聊声线");
		expect(f.calls.issues).toBe(1);
		expect(f.replies[0].joinUrl).toContain("discord.com/channels");
		expect(f.replies[0].text).toContain("FLY-2001"); // kickoff issue named
		expect(f.calls.started).toHaveLength(1);
		expect(f.calls.startedIssues).toEqual(["FLY-2001"]); // issueId threaded
		expect(f.slot.current()?.mode).toBe(ELEVEN_SLOT_MODE);
	});

	it("FLY-1160: kickoff issue failure = no meeting — slot released, no session", async () => {
		const f = makeCommand({
			createIssue: async () => {
				throw new Error("linear down");
			},
		});
		await f.invoke("声线");
		expect(f.calls.started).toHaveLength(0);
		expect(f.slot.current()).toBe(null);
		expect(f.replies.at(-1)?.text).toContain("立项 issue 创建失败");
	});

	it("startSession failure releases the slot and tells the founder (issue stays open)", async () => {
		const f = makeCommand({
			startSession: async () => {
				throw new Error("agent unreachable");
			},
		});
		await f.invoke();
		expect(f.slot.current()).toBe(null);
		expect(f.replies.at(-1)?.text).toContain("启动失败");
		expect(f.replies.at(-1)?.text).toContain("FLY-2001 保持打开");
	});

	it("/eleven stop: live session torn down; nothing live = honest reply", async () => {
		let live = true;
		const f = makeCommand({
			stopSession: async () => {
				const was = live;
				live = false;
				return was;
			},
		});
		await f.invoke("stop");
		expect(f.replies[0].text).toContain("已结束");
		await f.invoke("stop");
		expect(f.replies[1].text).toContain("没有进行中");
	});
});
