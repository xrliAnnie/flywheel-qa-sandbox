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
import { ElevenCommand } from "../eleven/ElevenCommand.js";
import type { ResidentVoiceLease } from "../resident-voice-session.js";
import { SessionSlot } from "../SessionSlot.js";

function residentLease(
	over: Partial<ResidentVoiceLease> = {},
): ResidentVoiceLease {
	const base = {
		mode: "meeting" as const,
		sessionId: "resident-session",
		sessionGeneration: 7,
		leaseToken: "resident-token",
		leaseTtlMs: 15_000,
		toSlotLease: (mode = "meeting") => ({
			mode,
			sessionId: "resident-session",
			sessionGeneration: 7,
			leaseToken: "resident-token",
		}),
		assertActive: () => {},
		renew: async () => {},
		setState: async () => {},
		startRenewing: () => () => {},
		close: vi.fn(async () => {}),
	};
	return { ...base, ...over };
}

function makeCommand(over: Record<string, unknown> = {}) {
	const slot = (over.slot as SessionSlot | undefined) ?? new SessionSlot();
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

	it("resident path reserves the local slot while claiming and hands the authoritative lease to the session", async () => {
		const lease = residentLease();
		const slot = new SessionSlot();
		let holderDuringClaim = slot.current();
		const claimSession = vi.fn(async () => {
			holderDuringClaim = slot.current();
			return lease;
		});
		const h = makeCommand({ slot, claimSession });
		await h.cmd.handle(h.inv);
		expect(claimSession).toHaveBeenCalledOnce();
		expect(holderDuringClaim).toMatchObject({ mode: ASSISTANT_SLOT_MODE });
		expect(h.slot.current()).toMatchObject({
			holder: "resident-session",
			sessionGeneration: 7,
		});
		expect(h.startSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "resident-session",
				lease,
			}),
		);
	});

	it("resident path closes the remote lease when kickoff issue creation fails", async () => {
		const lease = residentLease();
		const h = makeCommand({ claimSession: async () => lease });
		h.createIssue.mockRejectedValue(new Error("bridge 502"));
		await h.cmd.handle(h.inv);
		expect(lease.close).toHaveBeenCalledWith("failed", "issue_creation_failed");
		expect(h.slot.current()).toBe(null);
	});

	it("does not bypass a failed resident claim with a local-only session", async () => {
		const h = makeCommand({
			claimSession: async () => {
				throw new Error("bridge unavailable");
			},
		});
		await h.cmd.handle(h.inv);
		expect(h.replies.at(-1)?.text).toContain("语音不可用");
		expect(h.replies.at(-1)?.text).toContain("房间租约获取失败");
		expect(h.createIssue).not.toHaveBeenCalled();
		expect(h.slot.current()).toBe(null);
	});

	it("holds the shared slot while the resident claim is pending, rejects /eleven busy, and releases after failure", async () => {
		let rejectClaim!: (error: Error) => void;
		const h = makeCommand({
			claimSession: () =>
				new Promise<ResidentVoiceLease>((_resolve, reject) => {
					rejectClaim = reject;
				}),
		});
		const gemini = h.cmd.handle(h.inv);
		await vi.waitFor(() =>
			expect(h.slot.current()?.mode).toBe(ASSISTANT_SLOT_MODE),
		);

		const elevenReplies: string[] = [];
		const elevenClaim = vi.fn(async () => residentLease());
		const eleven = new ElevenCommand({
			slot: h.slot,
			joinUrl: "https://discord.com/channels/g/vc",
			preflight: async () => ({ ok: true }),
			createIssue: async () => ({ identifier: "FLY-2001" }),
			claimSession: elevenClaim,
			startSession: async () => {},
			stopSession: async () => false,
		});
		await eleven.handle({
			reply: async (text) => {
				elevenReplies.push(text);
			},
		});
		expect(elevenReplies.at(-1)).toContain("/gemini");
		expect(elevenClaim).not.toHaveBeenCalled();

		rejectClaim(new Error("resident_voice_claim_timeout:2000ms"));
		await gemini;
		expect(h.replies.at(-1)?.text).toContain("语音不可用");
		expect(h.replies.at(-1)?.text).toContain(
			"resident_voice_claim_timeout:2000ms",
		);
		expect(h.slot.current()).toBe(null);
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
			leads: [{ agentId: "eng-lead", botTokenEnv: "ENG_TOKEN" }],
			huddle: {
				guildId: "g",
				voiceChannelId: "vc",
				orchestratorBotTokenEnv: "ORCH",
				earsBotTokenEnv: "EARS",
				...(assistant === undefined ? {} : { assistant }),
			},
		},
	];
	const configured = (over: Record<string, unknown> = {}) => ({
		leadId: "eng-lead",
		...over,
	});

	it("absent assistant block → null (byte-compat, /live off)", () => {
		expect(resolveAssistantConfig(base(undefined), {})).toBeNull();
		expect(resolveAssistantConfig([], {})).toBeNull();
		expect(resolveAssistantConfig("junk", {})).toBeNull();
	});

	it("leadId is required and must name a declared project lead", () => {
		expect(() => resolveAssistantConfig(base({}), {})).toThrow(
			/huddle\.assistant\.leadId/,
		);
		expect(() => resolveAssistantConfig(base({ leadId: "ghost" }), {})).toThrow(
			/ghost.*leads/s,
		);
	});

	it("configured block gets full defaults", () => {
		const c = resolveAssistantConfig(base(configured()), {});
		expect(c).toMatchObject({
			commandName: "gemini",
			leadId: "eng-lead",
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
		const c = resolveAssistantConfig(base(configured({ bargeIn: false })), {});
		expect(c?.bargeIn).toBe(false);
	});

	it('a non-boolean bargeIn fails FAST — a string "false" silently meaning ON is the exact speaker-user trap (Codex R21)', () => {
		expect(() =>
			resolveAssistantConfig(base(configured({ bargeIn: "false" })), {}),
		).toThrow(/bargeIn must be true or false/);
	});

	it("captions defaults ON; explicit false is honored (FLY-1065 escape hatch back to v1 log-only)", () => {
		expect(resolveAssistantConfig(base(configured()), {})?.captions).toBe(true);
		expect(
			resolveAssistantConfig(base(configured({ captions: false })), {})
				?.captions,
		).toBe(false);
		expect(
			resolveAssistantConfig(base(configured({ captions: true })), {})
				?.captions,
		).toBe(true);
	});

	it("a non-boolean captions fails FAST (same trap shape as bargeIn)", () => {
		expect(() =>
			resolveAssistantConfig(base(configured({ captions: "false" })), {}),
		).toThrow(/captions must be true or false/);
	});

	it("explicit fields override defaults", () => {
		const c = resolveAssistantConfig(
			base(
				configured({
					commandName: "chat",
					voice: "Kore",
					localBargeIn: true,
					briefing: { refreshSec: 300, docs: ["product/prd.md"] },
				}),
			),
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
			base(configured({ assistantBotTokenEnv: "ASSIST_TOKEN" })),
			{ ASSIST_TOKEN: "tok-123" },
		);
		expect(c?.assistantToken).toBe("tok-123");
		expect(() =>
			resolveAssistantConfig(
				base(configured({ assistantBotTokenEnv: "ASSIST_TOKEN" })),
				{},
			),
		).toThrow(/ASSIST_TOKEN/);
	});

	it("bad types fail fast with guidance", () => {
		expect(() =>
			resolveAssistantConfig(base(configured({ commandName: 42 })), {}),
		).toThrow(/commandName/);
		expect(() =>
			resolveAssistantConfig(
				base(configured({ briefing: { refreshSec: -1 } })),
				{},
			),
		).toThrow(/refreshSec/);
		expect(() =>
			resolveAssistantConfig(
				base(configured({ briefing: { docs: [""] } })),
				{},
			),
		).toThrow(/docs/);
	});
});
