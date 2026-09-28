/**
 * FLY-2896 — Bridge consent card: post once, decide fail-closed by the
 * founder's exact reactions, write the consent file (single writer), wake
 * the daemon, render outcomes once. All Discord I/O is a fake adapter.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CHANNEL_ID,
	EPISODE_KEY,
	FOUNDER_ID,
	GRANT_ID,
	MESSAGE_ID,
	OTHER_PROPOSAL_ID,
	PROPOSAL_ID,
	REQUEST_ID,
	sampleConsent,
	sampleProposal,
} from "../../__tests__/reset-card-test-fixtures.js";
import {
	type AuditTerminalRow,
	makeResetCardFiles,
	type ResetCardConsent,
	type ResetCardFiles,
	type ResetCardProposal,
} from "../../account-heal/reset-card-files.js";
import type { ReactionConfirmationCheck } from "../../lead-backends/codex/gateway/founder-confirmation.js";
import {
	APPROVE_EMOJI,
	createResetCardConsentTicker,
	escapeDiscordMarkdown,
	MAX_RESET_CARD_TEXT_LENGTH,
	REJECT_EMOJI,
	RESET_CARD_REACTION_GAP_MS,
	RESET_CARD_REACTION_MAX_ATTEMPTS,
	type ResetCardConsentDeps,
	type ResetCardDiscordOps,
	renderResetCardText,
	resetCardNonce,
	withResetCardTick,
} from "../reset-card-consent.js";

const NOW = Date.parse("2026-09-25T23:06:00.000Z");
const NOT_YET: ReactionConfirmationCheck = {
	confirmed: false,
	reason: "not_yet",
};
const CONFIRMED: ReactionConfirmationCheck = {
	confirmed: true,
	reason: "confirmed",
};
const OTHER_MESSAGE_ID = "444444444444444444";

let root: string;
let files: ResetCardFiles;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reset-card-consent-"));
	files = makeResetCardFiles(join(root, "claude-quota"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

interface Harness {
	deps: ResetCardConsentDeps;
	discord: {
		post: ReturnType<typeof vi.fn>;
		edit: ReturnType<typeof vi.fn>;
		react: ReturnType<typeof vi.fn>;
		checkReaction: ReturnType<typeof vi.fn>;
	};
	/** Per-emoji answer for the founder id the ticker asks about. */
	reactions: Record<string, ReactionConfirmationCheck>;
	wake: ReturnType<typeof vi.fn>;
	logs: string[];
	/** Every injected wait, in order (no real time passes in tests). */
	sleeps: number[];
	run(): Promise<void>;
	advance(ms: number): void;
	consent(): ResetCardConsent;
}

function harness(patch: Partial<ResetCardConsentDeps> = {}): Harness {
	let nowMs = NOW;
	const reactions: Record<string, ReactionConfirmationCheck> = {
		[APPROVE_EMOJI]: NOT_YET,
		[REJECT_EMOJI]: NOT_YET,
	};
	const discord = {
		post: vi.fn(async () => ({ ok: true as const, messageId: MESSAGE_ID })),
		edit: vi.fn(async () => ({ ok: true as const })),
		react: vi.fn(async () => ({ ok: true as const })),
		checkReaction: vi.fn(async (args: { emoji: string; founderId: string }) =>
			args.founderId === FOUNDER_ID ? reactions[args.emoji] : NOT_YET,
		),
	};
	const wake = vi.fn();
	const logs: string[] = [];
	const sleeps: number[] = [];
	const deps: ResetCardConsentDeps = {
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		files,
		now: () => nowMs,
		founderId: () => FOUNDER_ID,
		channelId: () => CHANNEL_ID,
		botToken: () => "bot-token",
		discord: discord as unknown as ResetCardDiscordOps,
		wake,
		timezone: () => "America/Los_Angeles",
		log: (message) => logs.push(message),
		...patch,
	};
	const ticker = createResetCardConsentTicker(deps);
	return {
		deps,
		discord,
		reactions,
		wake,
		logs,
		sleeps,
		run: async () => {
			ticker.tick();
			await ticker.settle();
		},
		advance: (ms) => {
			nowMs += ms;
		},
		consent: () => {
			const read = files.readConsent();
			if (read.status !== "ok") throw new Error(`consent ${read.status}`);
			return read.value;
		},
	};
}

function postedConsent(
	proposal: ResetCardProposal = sampleProposal(),
	patch: Partial<ResetCardConsent> = {},
): ResetCardConsent {
	return sampleConsent(proposal, {
		state: "posted",
		decidedAt: null,
		outcomeRenderedFor: null,
		...patch,
	});
}

function terminalRow(patch: Partial<AuditTerminalRow> = {}): AuditTerminalRow {
	return {
		at: "2026-09-26T00:00:00.000Z",
		kind: "terminal",
		proposalId: PROPOSAL_ID,
		episodeKey: EPISODE_KEY,
		outcome: "switched",
		reason: null,
		active: { name: "personal", fiveHPct: 90, sevenDPct: 42 },
		target: {
			name: "business",
			before: { fiveHPct: 12, sevenDPct: 100 },
			after: { fiveHPct: 3, sevenDPct: 0 },
		},
		grant: { id: GRANT_ID, resetsLeftBefore: 1, resetsLeftAfter: 0 },
		requestId: REQUEST_ID,
		redeemResult: "reset",
		redeemProven: true,
		consent: null,
		switch: { outcome: "switched", generation: 8 },
		...patch,
	};
}

const lastEditText = (h: Harness): string =>
	(h.discord.edit.mock.calls.at(-1)?.[0] as { text: string }).text;

describe("renderResetCardText", () => {
	it("pins founder message v4 with full names, remaining percentages and PT dates", () => {
		const proposal = sampleProposal({
			accountRows: [
				{
					name: "personal",
					fiveHPct: 88,
					sevenDPct: 41,
					recoveryAt: "2026-09-26T02:00:00.000Z",
					cards: [],
				},
				{
					name: "business",
					fiveHPct: 12,
					sevenDPct: 100,
					recoveryAt: "2026-10-01T02:00:00.000Z",
					cards: [{ count: 1, endsAt: "2026-10-22T16:00:00.000Z" }],
				},
				{
					name: "shopping",
					fiveHPct: 0,
					sevenDPct: 100,
					recoveryAt: "2026-09-30T02:00:00.000Z",
					cards: [{ count: 2, endsAt: "2026-10-20T16:00:00.000Z" }],
				},
				{
					name: "school",
					fiveHPct: 100,
					sevenDPct: 100,
					recoveryAt: "2026-09-29T02:00:00.000Z",
					cards: [],
				},
			],
		});
		const text = renderResetCardText(proposal, {
			founderId: FOUNDER_ID,
			timezone: "UTC",
		});
		expect(text).toBe(
			[
				"Claude 额度快用完了：在用的 personal 5 小时已用 88%，其他号都不能直接切。",
				`<@${FOUNDER_ID}>`,
				"```",
				"账号       5小时  周   自然恢复    重置卡",
				"personal*  12%    59%  9/25 19:00  无",
				"business   88%    0%   9/30 19:00  1张 10/22",
				"shopping   100%   0%   9/29 19:00  2张 10/20",
				"school     0%     0%   9/28 19:00  无",
				"```",
				"* = 在用；时间是 PT",
				"建议用 business 的重置卡：它最晚才自然恢复（9/30 19:00），卡 10/22 到期。用完切到 business。",
				"同意吗？在这条消息上点 ✅ 同意，点 ❌ 不用。",
			].join("\n"),
		);
		expect(text.length).toBeLessThanOrEqual(MAX_RESET_CARD_TEXT_LENGTH);
	});

	it("escapes markdown-ish account names and stays one chunk", () => {
		const proposal = sampleProposal();
		const text = renderResetCardText(
			sampleProposal({
				active: { ...proposal.active, name: "my_acct.v2" },
				target: { ...proposal.target, name: "biz~x" },
			}),
			{ founderId: FOUNDER_ID, timezone: "America/Los_Angeles" },
		);
		expect(text).toContain("在用的 my\\_acct.v2 5 小时");
		expect(text).toContain("建议用 biz\\~x 的重置卡");
		expect(text).toContain("my_acct.v2*");
		expect(text.length).toBeLessThanOrEqual(MAX_RESET_CARD_TEXT_LENGTH);
		expect(escapeDiscordMarkdown("a*b`c|d>e#f[g](h)<@i:j\\k\nl")).toBe(
			"a\\*b\\`c\\|d\\>e\\#f\\[g\\]\\(h\\)\\<\\@i\\:j\\\\k l",
		);
	});

	it("keeps legacy proposals readable and marks missing readings as unknown", () => {
		const proposal = sampleProposal();
		const text = renderResetCardText(
			sampleProposal({
				expiresAt: "2026-09-26T07:00:00.000Z",
				runway: { unknown: "too_early" },
				grant: { ...proposal.grant, endsAt: null, clears: ["seven_day"] },
				active: { ...proposal.active, fiveHResetAt: null },
			}),
			{ founderId: FOUNDER_ID, timezone: "America/Los_Angeles" },
		);
		expect(text).toContain("personal*  12%    59%  未知");
		expect(text).toContain("1张 未知");
		expect(text).toContain("卡到期时间未知");
		expect(text).toContain("同意吗？在这条消息上点 ✅ 同意，点 ❌ 不用。");
	});
});

describe("createResetCardConsentTicker — reaction seeding (QA rework)", () => {
	const RATE_LIMITED = {
		ok: false as const,
		status: 429,
		error: "discord_reaction_failed",
		retryAfterMs: 300,
	};

	it("seeds ✅ then ❌ with a gap between them", async () => {
		files.writeProposal(sampleProposal());
		const h = harness();
		await h.run();
		expect(
			h.discord.react.mock.calls.map((c) => (c[0] as { emoji: string }).emoji),
		).toEqual([APPROVE_EMOJI, REJECT_EMOJI]);
		expect(h.sleeps).toEqual([RESET_CARD_REACTION_GAP_MS]);
		expect(RESET_CARD_REACTION_GAP_MS).toBeGreaterThanOrEqual(250);
	});

	it("honours Discord's retry_after on a 429 and retries the same emoji", async () => {
		files.writeProposal(sampleProposal());
		const h = harness();
		h.discord.react
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce(RATE_LIMITED)
			.mockResolvedValueOnce({ ok: true });
		await h.run();
		expect(
			h.discord.react.mock.calls.map((c) => (c[0] as { emoji: string }).emoji),
		).toEqual([APPROVE_EMOJI, REJECT_EMOJI, REJECT_EMOJI]);
		expect(h.sleeps).toEqual([RESET_CARD_REACTION_GAP_MS, 300]);
	});

	it("bounds the retries, then re-seeds the missing reaction on a later tick — once", async () => {
		files.writeProposal(sampleProposal());
		const h = harness();
		h.discord.react.mockImplementation(async (args: { emoji: string }) =>
			args.emoji === REJECT_EMOJI ? RATE_LIMITED : { ok: true },
		);
		await h.run();
		const rejectAttempts = () =>
			h.discord.react.mock.calls.filter(
				(c) => (c[0] as { emoji: string }).emoji === REJECT_EMOJI,
			).length;
		expect(rejectAttempts()).toBe(RESET_CARD_REACTION_MAX_ATTEMPTS);
		expect(h.consent().state).toBe("posted");
		expect(h.logs.some((line) => line.includes("seed reaction ❌"))).toBe(true);

		// Discord recovers; the next reaction round puts ❌ back.
		h.discord.react.mockImplementation(async () => ({ ok: true }));
		h.discord.react.mockClear();
		h.advance(20_000);
		await h.run();
		expect(
			h.discord.react.mock.calls.map((c) => (c[0] as { emoji: string }).emoji),
		).toEqual([APPROVE_EMOJI, REJECT_EMOJI]);

		// Seeded now: later rounds never touch the reactions again.
		h.discord.react.mockClear();
		h.advance(20_000);
		await h.run();
		expect(h.discord.react).not.toHaveBeenCalled();
	});

	it("a restarted Bridge re-seeds a posted card once (idempotent PUTs)", async () => {
		const proposal = sampleProposal();
		files.writeProposal(proposal);
		files.writeConsent(postedConsent(proposal));
		const h = harness();
		await h.run();
		expect(
			h.discord.react.mock.calls.map((c) => (c[0] as { emoji: string }).emoji),
		).toEqual([APPROVE_EMOJI, REJECT_EMOJI]);
		expect(h.discord.post).not.toHaveBeenCalled();
		h.discord.react.mockClear();
		h.advance(20_000);
		await h.run();
		expect(h.discord.react).not.toHaveBeenCalled();
	});

	it("never seeds reactions once the founder has decided", async () => {
		const proposal = sampleProposal();
		files.writeProposal(proposal);
		files.writeConsent(sampleConsent(proposal));
		const h = harness();
		await h.run();
		expect(h.discord.react).not.toHaveBeenCalled();
	});
});

describe("createResetCardConsentTicker — posting", () => {
	it("posts exactly one card, persists the binding, then seeds ✅ and ❌", async () => {
		files.writeProposal(sampleProposal());
		const h = harness();
		const stateAtReact: string[] = [];
		h.discord.react.mockImplementation(async () => {
			stateAtReact.push(h.consent().state);
			return { ok: true };
		});

		await h.run();

		expect(h.discord.post).toHaveBeenCalledTimes(1);
		const args = h.discord.post.mock.calls[0]![0] as Record<string, unknown>;
		expect(args).toMatchObject({
			channelId: CHANNEL_ID,
			botToken: "bot-token",
			nonce: resetCardNonce(PROPOSAL_ID),
			allowedUserIds: [FOUNDER_ID],
		});
		expect((args.nonce as string).length).toBe(25);
		expect(args.text as string).toContain(`<@${FOUNDER_ID}>`);
		expect(h.consent()).toMatchObject({
			proposalId: PROPOSAL_ID,
			state: "posted",
			channelId: CHANNEL_ID,
			messageId: MESSAGE_ID,
			founderId: FOUNDER_ID,
			postedAt: new Date(NOW).toISOString(),
		});
		expect(
			h.discord.react.mock.calls.map((c) => (c[0] as { emoji: string }).emoji),
		).toEqual([APPROVE_EMOJI, REJECT_EMOJI]);
		expect(stateAtReact).toEqual(["posted", "posted"]);

		h.advance(5_000);
		await h.run();
		expect(h.discord.post).toHaveBeenCalledTimes(1);
	});

	it.each([
		["founder_id_missing", { founderId: () => null }],
		["channel_missing", { channelId: () => null }],
		["bot_token_missing", { botToken: () => null }],
		["founder_id_invalid", { founderId: () => "not-a-snowflake" }],
	] as const)(
		"writes post_failed:%s without posting",
		async (reason, patch) => {
			files.writeProposal(sampleProposal());
			const h = harness(patch);
			await h.run();
			expect(h.discord.post).not.toHaveBeenCalled();
			expect(h.consent()).toMatchObject({ state: "post_failed", reason });
		},
	);

	it("a failed POST is recorded as post_failed", async () => {
		files.writeProposal(sampleProposal());
		const h = harness();
		h.discord.post.mockResolvedValueOnce({ ok: false, error: "Discord 403" });
		await h.run();
		expect(h.consent()).toMatchObject({
			state: "post_failed",
			reason: "post_failed",
		});
		expect(h.discord.react).not.toHaveBeenCalled();
	});

	it("does not post for a proposal that is not awaiting consent", async () => {
		files.writeProposal(sampleProposal({ status: "expired" }));
		const h = harness();
		await h.run();
		expect(h.discord.post).not.toHaveBeenCalled();
		expect(files.readConsent().status).toBe("absent");
	});

	it("an invalid consent file blocks posting and writing", async () => {
		files.writeProposal(sampleProposal());
		writeFileSync(files.consentPath, '{"schemaVersion":1}\n');
		const h = harness();
		await h.run();
		expect(h.discord.post).not.toHaveBeenCalled();
		expect(readFileSync(files.consentPath, "utf8")).toBe(
			'{"schemaVersion":1}\n',
		);
		expect(h.logs.some((line) => line.includes("consent invalid"))).toBe(true);
	});

	it("reads files at most every 5 s", async () => {
		const readProposal = vi.fn(files.readProposal);
		const h = harness({ files: { ...files, readProposal } });
		await h.run();
		await h.run();
		expect(readProposal).toHaveBeenCalledTimes(1);
		h.advance(4_999);
		await h.run();
		expect(readProposal).toHaveBeenCalledTimes(1);
		h.advance(1);
		await h.run();
		expect(readProposal).toHaveBeenCalledTimes(2);
	});
});

describe("createResetCardConsentTicker — deciding", () => {
	it("✅ confirmed but ❌ read failed → not approved; ❌ not_yet later → approved + one wake", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const h = harness();
		h.reactions[APPROVE_EMOJI] = CONFIRMED;
		h.reactions[REJECT_EMOJI] = { confirmed: false, reason: "rate_limited" };

		await h.run();
		expect(h.consent().state).toBe("posted");
		expect(h.wake).not.toHaveBeenCalled();
		expect(
			h.discord.checkReaction.mock.calls.map(
				(c) => (c[0] as { emoji: string }).emoji,
			),
		).toEqual([APPROVE_EMOJI, REJECT_EMOJI]);

		h.reactions[REJECT_EMOJI] = NOT_YET;
		h.advance(20_000);
		await h.run();
		expect(h.consent()).toMatchObject({
			state: "approved",
			decidedAt: new Date(NOW + 20_000).toISOString(),
			founderId: FOUNDER_ID,
		});
		expect(h.wake).toHaveBeenCalledTimes(1);
		expect(h.discord.post).not.toHaveBeenCalled();
		expect(h.discord.edit).toHaveBeenCalledTimes(1);
		expect(lastEditText(h)).toContain(
			"✅ 你已同意：在用号 personal 用到 90% 时执行（只给 business 用这一张卡）",
		);
		expect(lastEditText(h)).not.toContain("前不回应");
		expect(h.consent().outcomeRenderedFor).toBe(
			`${PROPOSAL_ID}:approved_waiting`,
		);

		// The decision is final: a later ❌ neither reverts it nor is read again.
		h.reactions[REJECT_EMOJI] = CONFIRMED;
		h.advance(20_000);
		await h.run();
		expect(h.consent().state).toBe("approved");
		expect(h.discord.checkReaction).toHaveBeenCalledTimes(4);
	});

	it("❌ confirmed → rejected, with or without ✅", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const both = harness();
		both.reactions[APPROVE_EMOJI] = CONFIRMED;
		both.reactions[REJECT_EMOJI] = CONFIRMED;
		await both.run();
		expect(both.consent()).toMatchObject({
			state: "rejected",
			reason: "both_reactions",
		});
		expect(both.wake).not.toHaveBeenCalled();
		expect(lastEditText(both)).toContain("❌ 你已拒绝，未用卡");

		files.writeConsent(postedConsent());
		const only = harness();
		only.reactions[REJECT_EMOJI] = CONFIRMED;
		await only.run();
		expect(only.consent()).toMatchObject({ state: "rejected", reason: null });
		expect(only.wake).not.toHaveBeenCalled();
	});

	it("a non-founder ✅ never counts", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const h = harness();
		h.discord.checkReaction.mockImplementation(
			async (args: { founderId: string }) =>
				args.founderId === "999999999999999999" ? CONFIRMED : NOT_YET,
		);
		await h.run();
		expect(h.discord.checkReaction).toHaveBeenCalledTimes(2);
		for (const call of h.discord.checkReaction.mock.calls) {
			expect(call[0]).toMatchObject({
				founderId: FOUNDER_ID,
				channelId: CHANNEL_ID,
				messageId: MESSAGE_ID,
			});
		}
		expect(h.consent().state).toBe("posted");
		expect(h.wake).not.toHaveBeenCalled();
	});

	it("past expiresAt with no decision → expired and one edit", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const h = harness();
		h.advance(2 * 3_600_000);
		await h.run();
		expect(h.consent()).toMatchObject({ state: "expired", reason: null });
		expect(h.discord.edit).toHaveBeenCalledTimes(1);
		expect(lastEditText(h)).toContain("⌛ 已过期，未用卡");
		h.advance(20_000);
		await h.run();
		expect(h.discord.edit).toHaveBeenCalledTimes(1);
		expect(h.discord.checkReaction).toHaveBeenCalledTimes(2);
	});

	it("✅ seen only after expiresAt → expired, never approved", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const h = harness();
		h.reactions[APPROVE_EMOJI] = CONFIRMED;
		h.advance(2 * 3_600_000);
		await h.run();
		expect(h.consent()).toMatchObject({
			state: "expired",
			reason: "approve_after_expiry",
		});
		expect(h.wake).not.toHaveBeenCalled();
	});

	it("restart: a fresh ticker keeps polling the persisted message, no second post", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const h = harness();
		h.reactions[APPROVE_EMOJI] = CONFIRMED;
		await h.run();
		expect(h.discord.post).not.toHaveBeenCalled();
		// QA rework: a restarted Bridge re-puts its own ✅/❌ once (idempotent).
		expect(
			h.discord.react.mock.calls.map((c) => (c[0] as { emoji: string }).emoji),
		).toEqual([APPROVE_EMOJI, REJECT_EMOJI]);
		expect(h.discord.checkReaction.mock.calls[0]![0]).toMatchObject({
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
		});
		expect(h.consent().state).toBe("approved");
		expect(h.wake).toHaveBeenCalledTimes(1);
	});

	it("reads reactions at most every 20 s", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const h = harness();
		await h.run();
		expect(h.discord.checkReaction).toHaveBeenCalledTimes(2);
		h.advance(5_000);
		await h.run();
		expect(h.discord.checkReaction).toHaveBeenCalledTimes(2);
		h.advance(15_000);
		await h.run();
		expect(h.discord.checkReaction).toHaveBeenCalledTimes(4);
	});

	it("refuses to approve when the consent on disk moved underneath the decision", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(postedConsent());
		const h = harness();
		h.reactions[APPROVE_EMOJI] = CONFIRMED;
		h.discord.checkReaction.mockImplementation(
			async (args: { emoji: string }) => {
				if (args.emoji === REJECT_EMOJI) {
					files.writeConsent(
						postedConsent(sampleProposal(), { proposalId: OTHER_PROPOSAL_ID }),
					);
				}
				return h.reactions[args.emoji];
			},
		);
		await h.run();
		expect(h.wake).not.toHaveBeenCalled();
		expect(h.consent().proposalId).toBe(OTHER_PROPOSAL_ID);
		expect(h.consent().state).toBe("posted");
	});
});

describe("createResetCardConsentTicker — supersede and outcomes", () => {
	it("edits the old card as superseded before writing the new consent, then posts", async () => {
		files.writeProposal(sampleProposal({ proposalId: OTHER_PROPOSAL_ID }));
		files.writeConsent(postedConsent());
		const h = harness();
		const consentAtEdit: string[] = [];
		h.discord.edit.mockImplementation(async () => {
			consentAtEdit.push(h.consent().proposalId);
			return { ok: true };
		});
		h.discord.post.mockResolvedValueOnce({
			ok: true,
			messageId: OTHER_MESSAGE_ID,
		});

		await h.run();

		expect(h.discord.edit).toHaveBeenCalledTimes(1);
		expect(h.discord.edit.mock.calls[0]![0]).toMatchObject({
			messageId: MESSAGE_ID,
			text: "已被新情况取代，未用卡",
		});
		expect(consentAtEdit).toEqual([PROPOSAL_ID]);
		expect(h.discord.post).toHaveBeenCalledTimes(1);
		expect(h.consent()).toMatchObject({
			proposalId: OTHER_PROPOSAL_ID,
			state: "posted",
			messageId: OTHER_MESSAGE_ID,
		});
	});

	it("renders the old card's real outcome from the audit when superseding", async () => {
		files.appendAudit(
			terminalRow({
				outcome: "cancelled",
				reason: "direct_candidate_appeared",
			}),
		);
		files.writeProposal(sampleProposal({ proposalId: OTHER_PROPOSAL_ID }));
		files.writeConsent(sampleConsent(sampleProposal(), { state: "approved" }));
		const h = harness();
		await h.run();
		expect(h.discord.edit.mock.calls[0]![0]).toMatchObject({
			messageId: MESSAGE_ID,
			text: "已取消，未用卡：出现了能直接切的号",
		});
	});

	it("an approved old card without an audit row is superseded without '未用卡'", async () => {
		files.writeProposal(sampleProposal({ proposalId: OTHER_PROPOSAL_ID }));
		files.writeConsent(sampleConsent(sampleProposal(), { state: "approved" }));
		const h = harness();
		await h.run();
		expect(h.discord.edit.mock.calls[0]![0]).toMatchObject({
			text: "已被新情况取代",
		});
	});

	it("does not overwrite an old card that already shows a final outcome", async () => {
		files.writeProposal(sampleProposal({ proposalId: OTHER_PROPOSAL_ID }));
		files.writeConsent(
			sampleConsent(sampleProposal(), {
				state: "rejected",
				outcomeRenderedFor: `${PROPOSAL_ID}:rejected`,
			}),
		);
		const h = harness();
		await h.run();
		expect(h.discord.edit).not.toHaveBeenCalled();
		expect(h.discord.post).toHaveBeenCalledTimes(1);
	});

	it("edits the same display key only once, then again when the key changes", async () => {
		files.writeProposal(sampleProposal({ status: "executing" }));
		files.writeConsent(sampleConsent(sampleProposal(), { state: "approved" }));
		const h = harness();
		await h.run();
		expect(h.discord.edit).toHaveBeenCalledTimes(1);
		expect(lastEditText(h)).toContain("⏳ 正在用卡并切号…");

		files.writeProposal(sampleProposal({ status: "switching" }));
		h.advance(5_000);
		await h.run();
		expect(h.discord.edit).toHaveBeenCalledTimes(1);

		files.appendAudit(terminalRow());
		files.writeProposal(sampleProposal({ status: "switched" }));
		h.advance(5_000);
		await h.run();
		expect(h.discord.edit).toHaveBeenCalledTimes(2);
		expect(lastEditText(h)).toContain("✅ 已用卡并切到 business（5 小时 3%）");
		expect(h.consent().outcomeRenderedFor).toBe(`${PROPOSAL_ID}:switched`);
		expect(h.discord.checkReaction).not.toHaveBeenCalled();
	});

	it.each([
		["cancelled", "facts_changed:grant", "已取消，未用卡：情况变了"],
		["failed", "not_spent:cooldown", "⚠️ 用卡失败：卡在冷却期（这次没有花卡）"],
		["failed", "weird_code", "⚠️ 用卡失败：weird\\_code"],
		[
			"redeemed_switch_failed",
			"concurrent_switch",
			"⚠️ 已用卡但切号没成：有别的切号在进行；请核对额度页并手动切号",
		],
		[
			"redeem_ambiguous",
			null,
			"⚠️ 用卡后状态不确定，请人工核对（审计里有 request id）",
		],
		[
			"switched_unverified",
			null,
			"⚠️ 已用卡并切到 business，但切后读数未确认，请看额度页",
		],
	] as const)(
		"renders %s (%s) once",
		async (status, statusReason, expected) => {
			files.writeProposal(sampleProposal({ status, statusReason }));
			files.writeConsent(
				sampleConsent(sampleProposal(), { state: "approved" }),
			);
			const h = harness();
			await h.run();
			expect(h.discord.edit).toHaveBeenCalledTimes(1);
			expect(lastEditText(h)).toContain(expected);
			expect(h.consent().outcomeRenderedFor).toBe(`${PROPOSAL_ID}:${status}`);
		},
	);

	it("retries a failed outcome edit next round, but records a 404 as rendered", async () => {
		files.writeProposal(sampleProposal({ status: "rejected" }));
		files.writeConsent(sampleConsent(sampleProposal(), { state: "rejected" }));
		const h = harness();
		h.discord.edit.mockResolvedValueOnce({
			ok: false,
			status: 500,
			error: "Discord 500",
		});
		await h.run();
		expect(h.consent().outcomeRenderedFor).toBeNull();
		h.discord.edit.mockResolvedValueOnce({
			ok: false,
			status: 404,
			error: "Discord 404",
		});
		h.advance(5_000);
		await h.run();
		expect(h.discord.edit).toHaveBeenCalledTimes(2);
		expect(h.consent().outcomeRenderedFor).toBe(`${PROPOSAL_ID}:rejected`);
	});

	it("leaves a consent whose digest differs from the proposal untouched", async () => {
		files.writeProposal(sampleProposal());
		files.writeConsent(
			postedConsent(sampleProposal(), { digest: "f".repeat(64) }),
		);
		const h = harness();
		await h.run();
		expect(h.discord.checkReaction).not.toHaveBeenCalled();
		expect(h.consent().digest).toBe("f".repeat(64));
	});
});

describe("tick() discipline", () => {
	it("never throws when the round or the clock throws", async () => {
		const h = harness({
			files: {
				...files,
				readProposal: () => {
					throw new Error("disk");
				},
			},
		});
		expect(() => h.deps).not.toThrow();
		await expect(h.run()).resolves.toBeUndefined();
		expect(h.logs.some((line) => line.includes("round failed: Error"))).toBe(
			true,
		);

		const broken = createResetCardConsentTicker({
			...h.deps,
			now: () => {
				throw new Error("clock");
			},
		});
		expect(() => broken.tick()).not.toThrow();
		await expect(broken.settle()).resolves.toBeUndefined();
	});

	it("is single-flight: a tick during a round starts nothing", async () => {
		files.writeProposal(sampleProposal());
		const h = harness();
		let release: () => void = () => {};
		h.discord.post.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ ok: true, messageId: MESSAGE_ID });
				}),
		);
		const ticker = createResetCardConsentTicker(h.deps);
		ticker.tick();
		h.advance(10_000);
		ticker.tick();
		ticker.tick();
		release();
		await ticker.settle();
		expect(h.discord.post).toHaveBeenCalledTimes(1);
	});
});

describe("withResetCardTick", () => {
	it("runs the tick even when the chain rejects, and surfaces the rejection", async () => {
		const tick = vi.fn();
		const wrapped = withResetCardTick(
			tick,
			() => Promise.reject(new Error("land")),
			() => {},
		);
		await expect(wrapped()).rejects.toThrow("land");
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it("a throwing tick is logged and never blocks the chain", async () => {
		const next = vi.fn(async () => {});
		const logs: string[] = [];
		const wrapped = withResetCardTick(
			() => {
				throw new Error("tick");
			},
			next,
			(message) => logs.push(message),
		);
		await expect(wrapped()).resolves.toBeUndefined();
		expect(next).toHaveBeenCalledTimes(1);
		expect(logs).toEqual(["[reset-card-consent] tick threw: Error"]);
	});
});
