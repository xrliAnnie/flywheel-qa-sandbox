/**
 * FLY-967 P7 — GeminiCommand (slot → issue → invite → session handoff, slot
 * never leaks on failure) + the optional huddle.assistant config sub-block
 * (absent = /live off, byte-compat; present = fail-fast validation).
 */
import { describe, expect, it, vi } from "vitest";
import {
	ASSISTANT_SLOT_MODE,
	resolveAssistantConfig,
} from "../assistant/config.js";
import { GeminiCommand } from "../assistant/GeminiCommand.js";
import { SessionSlot } from "../SessionSlot.js";

function makeCommand(over: Record<string, unknown> = {}) {
	const slot = new SessionSlot();
	const createIssue = vi.fn(async () => ({
		identifier: "FLY-1300",
		url: "https://linear.app/i/FLY-1300",
	}));
	const pingFounder = vi.fn(async () => {});
	const moveFounderToVc = vi.fn(async () => true);
	const startSession = vi.fn(async () => {});
	const replies: { text: string; joinUrl?: string }[] = [];
	const inv = {
		topic: "声线选型",
		reply: vi.fn(async (text: string, opts?: { joinUrl?: string }) => {
			replies.push({ text, joinUrl: opts?.joinUrl });
		}),
	};
	const cmd = new GeminiCommand({
		slot,
		joinUrl: "https://discord.com/channels/g/vc",
		createIssue,
		pingFounder,
		moveFounderToVc,
		startSession,
		now: () => new Date("2026-07-07T15:00:00"),
		...over,
	});
	return {
		cmd,
		slot,
		createIssue,
		pingFounder,
		moveFounderToVc,
		startSession,
		inv,
		replies,
	};
}

describe("GeminiCommand (FLY-967 P7)", () => {
	it("defaults to /gemini, configurable name", () => {
		expect(makeCommand().cmd.name).toBe("gemini");
		expect(makeCommand({ commandName: "chat" }).cmd.name).toBe("chat");
	});

	it("happy path: issue title shape, invite with Join, ping, move, handoff", async () => {
		const h = makeCommand();
		await h.cmd.handle(h.inv);
		expect(h.createIssue).toHaveBeenCalledWith(
			"2026-07-07 15:00 · gemini(Annie) — 声线选型",
		);
		expect(h.replies[0].text).toContain("FLY-1300");
		expect(h.replies[0].joinUrl).toBe("https://discord.com/channels/g/vc");
		expect(h.pingFounder).toHaveBeenCalled();
		expect(h.moveFounderToVc).toHaveBeenCalled();
		expect(h.startSession).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: "FLY-1300", topic: "声线选型" }),
		);
		// session owns the slot now
		expect(h.slot.acquire("meet", "x").ok).toBe(false);
	});

	// FLY-1159 Codex R3 LOW-1: /gemini and /gemini-advanced share the slot mode,
	// so the slot's per-mode copy would misname whichever command is running as
	// /gemini. Same-mode busy must use neutral assistant-session wording; a
	// cross-mode holder (e.g. /eleven) keeps the slot's accurate message.
	it("same-mode busy (two assistant commands share the slot): neutral wording, no /gemini misnaming", async () => {
		const h = makeCommand({ commandName: "gemini-advanced" });
		h.slot.acquire(ASSISTANT_SLOT_MODE, "other-session");
		await h.cmd.handle(h.inv);
		expect(h.replies[0].text).toContain("助理语音会话");
		expect(h.replies[0].text).not.toContain("/gemini 正在进行");
		expect(h.createIssue).not.toHaveBeenCalled();
	});

	it("cross-mode busy keeps the slot's accurate per-mode message (/eleven named)", async () => {
		const h = makeCommand();
		h.slot.acquire("eleven", "eleven-session");
		await h.cmd.handle(h.inv);
		expect(h.replies[0].text).toContain("/eleven");
		expect(h.createIssue).not.toHaveBeenCalled();
	});

	it("busy room: founder-facing rejection, nothing created", async () => {
		const h = makeCommand();
		h.slot.acquire("meet", "FLY-999");
		await h.cmd.handle(h.inv);
		expect(h.replies[0].text).toContain("正在进行");
		expect(h.createIssue).not.toHaveBeenCalled();
		expect(h.startSession).not.toHaveBeenCalled();
	});

	it("issue-creation failure releases the slot and answers loudly", async () => {
		const h = makeCommand();
		h.createIssue.mockRejectedValue(new Error("bridge 502"));
		await h.cmd.handle(h.inv);
		expect(h.replies[0].text).toContain("失败");
		expect(h.slot.acquire("meet", "x").ok).toBe(true); // released
		expect(h.startSession).not.toHaveBeenCalled();
	});

	it("session-start failure releases the slot and keeps the issue open (retryable)", async () => {
		const h = makeCommand();
		h.startSession.mockRejectedValue(new Error("no gemini key"));
		await h.cmd.handle(h.inv);
		expect(h.replies.at(-1)?.text).toContain("FLY-1300 保持打开");
		expect(h.slot.acquire("meet", "x").ok).toBe(true);
	});

	it("a Discord invite/ping failure never strands the slot (Codex R1)", async () => {
		const log = vi.fn();
		const h = makeCommand({ log });
		h.inv.reply.mockRejectedValueOnce(new Error("discord 503"));
		await h.cmd.handle(h.inv);
		// meeting proceeds — the session takes slot ownership as usual
		expect(h.startSession).toHaveBeenCalled();
		expect(h.slot.acquire("meet", "x").ok).toBe(false); // held by the session
		expect(log).toHaveBeenCalledWith(expect.stringContaining("non-fatal"));
	});

	it("missing MOVE permission is never fatal", async () => {
		const log = vi.fn();
		const h = makeCommand({ moveFounderToVc: vi.fn(async () => false), log });
		await h.cmd.handle(h.inv);
		expect(h.startSession).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("MOVE_MEMBERS"));
	});
});

describe("resolveAssistantConfig (FLY-967 P7 config contract)", () => {
	const base = (assistant: unknown) => [
		{
			projectName: "flywheel",
			huddle: {
				guildId: "g",
				voiceChannelId: "vc",
				orchestratorBotTokenEnv: "ORCH",
				earsBotTokenEnv: "EARS",
				...(assistant === undefined ? {} : { assistant }),
			},
		},
	];

	it("absent assistant block → null (byte-compat, /live off)", () => {
		expect(resolveAssistantConfig(base(undefined), {})).toBeNull();
		expect(resolveAssistantConfig([], {})).toBeNull();
		expect(resolveAssistantConfig("junk", {})).toBeNull();
	});

	it("empty block gets full defaults", () => {
		const c = resolveAssistantConfig(base({}), {});
		expect(c).toMatchObject({
			commandName: "gemini",
			assistantToken: null,
			localBargeIn: false,
			bargeIn: true, // Annie's call: default ON (headphone users get real barge-in)
			briefing: {
				refreshSec: 600,
				maxAgeSec: 1800,
				charBudget: 8000,
				docs: [],
			},
		});
		expect(c?.voice).toBeUndefined();
	});

	it("bargeIn: false is honored (speaker users — assistant echo would cancel live responses)", () => {
		const c = resolveAssistantConfig(base({ bargeIn: false }), {});
		expect(c?.bargeIn).toBe(false);
	});

	it('a non-boolean bargeIn fails FAST — a string "false" silently meaning ON is the exact speaker-user trap (Codex R21)', () => {
		expect(() =>
			resolveAssistantConfig(base({ bargeIn: "false" }), {}),
		).toThrow(/bargeIn must be true or false/);
	});

	it("captions defaults ON; explicit false is honored (FLY-1065 escape hatch back to v1 log-only)", () => {
		expect(resolveAssistantConfig(base({}), {})?.captions).toBe(true);
		expect(
			resolveAssistantConfig(base({ captions: false }), {})?.captions,
		).toBe(false);
		expect(resolveAssistantConfig(base({ captions: true }), {})?.captions).toBe(
			true,
		);
	});

	it("a non-boolean captions fails FAST (same trap shape as bargeIn)", () => {
		expect(() =>
			resolveAssistantConfig(base({ captions: "false" }), {}),
		).toThrow(/captions must be true or false/);
	});

	it("explicit fields override defaults", () => {
		const c = resolveAssistantConfig(
			base({
				commandName: "chat",
				voice: "Kore",
				localBargeIn: true,
				briefing: { refreshSec: 300, docs: ["product/prd.md"] },
			}),
			{},
		);
		expect(c).toMatchObject({
			commandName: "chat",
			voice: "Kore",
			localBargeIn: true,
			briefing: { refreshSec: 300, docs: ["product/prd.md"], maxAgeSec: 1800 },
		});
	});

	it("assistantBotTokenEnv resolves from env, fails fast when missing", () => {
		const c = resolveAssistantConfig(
			base({ assistantBotTokenEnv: "ASSIST_TOKEN" }),
			{ ASSIST_TOKEN: "tok-123" },
		);
		expect(c?.assistantToken).toBe("tok-123");
		expect(() =>
			resolveAssistantConfig(
				base({ assistantBotTokenEnv: "ASSIST_TOKEN" }),
				{},
			),
		).toThrow(/ASSIST_TOKEN/);
	});

	it("bad types fail fast with guidance", () => {
		expect(() => resolveAssistantConfig(base({ commandName: 42 }), {})).toThrow(
			/commandName/,
		);
		expect(() =>
			resolveAssistantConfig(base({ briefing: { refreshSec: -1 } }), {}),
		).toThrow(/refreshSec/);
		expect(() =>
			resolveAssistantConfig(base({ briefing: { docs: [""] } }), {}),
		).toThrow(/docs/);
	});
});
