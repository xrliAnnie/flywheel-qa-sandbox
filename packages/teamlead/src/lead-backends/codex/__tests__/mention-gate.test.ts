import { describe, expect, it } from "vitest";
import type { DiscordInboundMessage } from "../CodexDiscordGateway.js";
import {
	buildMentionGate,
	isIdMentioned,
	isMentioned,
} from "../mention-gate.js";

const BOT = "1499895683287748679"; // this Lead's bot user id

function m(over: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
	return {
		id: "1",
		channelId: "shared-1",
		authorId: "annie",
		authorBot: false,
		content: "hello",
		...over,
	};
}

describe("buildMentionGate (FLY-267 判)", () => {
	const gate = buildMentionGate({
		botUserId: BOT,
		sharedChannelIds: ["shared-1", "shared-2"],
		mentionPatterns: ["\\bMufasa\\b"],
	});

	it("non-shared channel: always handled (chat/core byte-compat)", () => {
		// no mention at all, but a non-shared channel is never gated
		expect(gate(m({ channelId: "chat-1", content: "anything" }))).toBe(true);
	});

	it("shared channel + explicit <@botId> mention → handled", () => {
		expect(gate(m({ content: `hey <@${BOT}> ping` }))).toBe(true);
	});

	it("shared channel + nickname <@!botId> mention → handled", () => {
		expect(gate(m({ content: `<@!${BOT}> yo` }))).toBe(true);
	});

	it("shared channel + Discord mentions array contains botId → handled", () => {
		expect(gate(m({ content: "no token here", mentions: [BOT] }))).toBe(true);
	});

	it("shared channel + name pattern (non-bot author) → handled", () => {
		expect(gate(m({ content: "Mufasa are you around?" }))).toBe(true);
	});

	it("shared channel + name pattern but BOT author → NOT handled (no bot loop)", () => {
		// a sibling Lead's prose merely containing the name must not trigger
		expect(
			gate(
				m({
					authorId: "siblingbot",
					authorBot: true,
					content: "asking Mufasa later",
				}),
			),
		).toBe(false);
	});

	it("shared channel + BOT author with EXACT mention → handled (sibling bot can @)", () => {
		expect(
			gate(
				m({
					authorId: "siblingbot",
					authorBot: true,
					content: `<@${BOT}> help`,
				}),
			),
		).toBe(true);
	});

	it("shared channel + no mention → NOT handled (silent, no spam)", () => {
		expect(gate(m({ content: "just chatting amongst ourselves" }))).toBe(false);
	});
});

describe("buildMentionGate — no name patterns (default Mufasa policy)", () => {
	const gate = buildMentionGate({
		botUserId: BOT,
		sharedChannelIds: ["shared-1"],
		// no mentionPatterns → exact mention id only
	});

	it("name in content does NOT trigger when no patterns configured", () => {
		expect(gate(m({ content: "talking about Mufasa to someone" }))).toBe(false);
	});

	it("exact mention still triggers", () => {
		expect(gate(m({ content: `<@${BOT}>` }))).toBe(true);
	});
});

describe("isMentioned — invalid regex is skipped, never throws", () => {
	it("a malformed pattern does not throw and does not match", () => {
		const gate = buildMentionGate({
			botUserId: BOT,
			sharedChannelIds: ["shared-1"],
			mentionPatterns: ["(unclosed", "\\bMufasa\\b"],
		});
		expect(() => gate(m({ content: "Mufasa" }))).not.toThrow();
		expect(gate(m({ content: "Mufasa" }))).toBe(true); // the valid one still matches
		expect(gate(m({ content: "nothing" }))).toBe(false);
	});

	it("isMentioned is directly callable with compiled-from-empty patterns", () => {
		expect(isMentioned(m({ content: `<@${BOT}>` }), BOT, [])).toBe(true);
		expect(isMentioned(m({ content: "plain" }), BOT, [])).toBe(false);
	});
});

// ─── FLY-898: core-strict (id-only) channels ────────────────────────────────
describe("buildMentionGate — coreStrictChannelIds (FLY-898 id-only core)", () => {
	const gate = buildMentionGate({
		botUserId: BOT,
		sharedChannelIds: ["shared-1"], // roundtable — name-aware
		coreStrictChannelIds: ["core-1"], // core — id-only
		mentionPatterns: ["\\bPeter\\b"],
	});

	it("core: real <@id> mention → handled", () => {
		expect(gate(m({ channelId: "core-1", content: `hi <@${BOT}>` }))).toBe(
			true,
		);
	});

	it("core: Discord mentions array contains bot → handled", () => {
		expect(
			gate(m({ channelId: "core-1", content: "no token", mentions: [BOT] })),
		).toBe(true);
	});

	it("core: BARE NAME in text (no @) → DROPPED (id-only, not name-matched)", () => {
		// The exact FLY-152 pile-on bug: "刚 Peter 帮我" must NOT trigger Peter.
		expect(
			gate(m({ channelId: "core-1", content: "刚 Peter 帮我搞了 X" })),
		).toBe(false);
		expect(gate(m({ channelId: "core-1", content: "Peter 看一下" }))).toBe(
			false,
		);
	});

	it("core: no-@ generic message → DROPPED (only CoS handles those)", () => {
		expect(gate(m({ channelId: "core-1", content: "status?" }))).toBe(false);
	});

	it("core: reply to THIS bot's own message → handled (reply-to-self)", () => {
		expect(
			gate(
				m({
					channelId: "core-1",
					content: "thanks",
					referencedAuthorId: BOT,
				}),
			),
		).toBe(true);
	});

	it("core: reply to SOMEONE ELSE's message → DROPPED", () => {
		expect(
			gate(
				m({
					channelId: "core-1",
					content: "thanks",
					referencedAuthorId: "someone-else",
				}),
			),
		).toBe(false); // reply to another author is not "addressing this bot"
	});

	it("roundtable (shared) still name-addressable → NOT regressed", () => {
		// Same gate: a bare name in the ROUNDTABLE still triggers (byte-compat).
		expect(gate(m({ channelId: "shared-1", content: "Peter around?" }))).toBe(
			true,
		);
	});

	it("chat/core-unrelated channel: always handled (byte-compat)", () => {
		expect(gate(m({ channelId: "chat-1", content: "anything" }))).toBe(true);
	});

	it("empty coreStrictChannelIds (default) → byte-compat: no core gating", () => {
		const g2 = buildMentionGate({
			botUserId: BOT,
			sharedChannelIds: ["shared-1"],
		});
		// a channel not in shared and not in coreStrict is always handled
		expect(g2(m({ channelId: "core-1", content: "status?" }))).toBe(true);
	});
});

describe("isIdMentioned (FLY-898) — @ + reply-to-self only, never name text", () => {
	it("exact <@id> → true", () => {
		expect(isIdMentioned(m({ content: `<@${BOT}>` }), BOT)).toBe(true);
	});
	it("mentions array → true", () => {
		expect(isIdMentioned(m({ content: "x", mentions: [BOT] }), BOT)).toBe(true);
	});
	it("reply-to-self (referencedAuthorId === bot) → true", () => {
		expect(isIdMentioned(m({ referencedAuthorId: BOT }), BOT)).toBe(true);
	});
	it("reply to another author → false", () => {
		expect(isIdMentioned(m({ referencedAuthorId: "other" }), BOT)).toBe(false);
	});
	it("bare name text (even non-bot author) → false", () => {
		expect(isIdMentioned(m({ content: "Peter hi" }), BOT)).toBe(false);
	});
	it("missing referencedAuthorId → reply-to-self does not trigger", () => {
		expect(isIdMentioned(m({ content: "plain" }), BOT)).toBe(false);
	});
});
