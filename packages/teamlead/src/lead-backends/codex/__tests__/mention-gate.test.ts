import { describe, expect, it } from "vitest";
import type { DiscordInboundMessage } from "../CodexDiscordGateway.js";
import { buildMentionGate, isMentioned } from "../mention-gate.js";

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
