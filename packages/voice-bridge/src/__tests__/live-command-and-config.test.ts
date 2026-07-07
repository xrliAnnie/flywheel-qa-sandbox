/**
 * FLY-967 P7 — LiveCommand (slot → issue → invite → session handoff, slot
 * never leaks on failure) + the optional huddle.assistant config sub-block
 * (absent = /live off, byte-compat; present = fail-fast validation).
 */
import { describe, expect, it, vi } from "vitest";
import { resolveAssistantConfig } from "../assistant/config.js";
import { LiveCommand } from "../assistant/LiveCommand.js";
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
	const cmd = new LiveCommand({
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

describe("LiveCommand (FLY-967 P7)", () => {
	it("defaults to /live, configurable name", () => {
		expect(makeCommand().cmd.name).toBe("live");
		expect(makeCommand({ commandName: "chat" }).cmd.name).toBe("chat");
	});

	it("happy path: issue title shape, invite with Join, ping, move, handoff", async () => {
		const h = makeCommand();
		await h.cmd.handle(h.inv);
		expect(h.createIssue).toHaveBeenCalledWith(
			"2026-07-07 15:00 · live(Annie) — 声线选型",
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
			commandName: "live",
			assistantToken: null,
			localBargeIn: false,
			briefing: {
				refreshSec: 600,
				maxAgeSec: 1800,
				charBudget: 8000,
				docs: [],
			},
		});
		expect(c?.voice).toBeUndefined();
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
