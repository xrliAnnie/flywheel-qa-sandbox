import { describe, expect, it } from "vitest";
import {
	buildTopicTrigger,
	type RoundtableMessage,
	type RoundtableTriggerMode,
} from "../topic-trigger.js";

function msg(over: Partial<RoundtableMessage> = {}): RoundtableMessage {
	return {
		id: "100",
		channelId: "rt",
		authorId: "u1",
		authorBot: false,
		content: "hello",
		mentions: [],
		mentionEveryone: false,
		...over,
	};
}

describe("buildTopicTrigger", () => {
	it("disabled never triggers", () => {
		const t = buildTopicTrigger({ mode: "disabled" });
		expect(t(msg({ content: "TOPIC: x", mentionEveryone: true }))).toBe(false);
	});

	it("unknown mode degrades to never", () => {
		const t = buildTopicTrigger({ mode: "bogus" as RoundtableTriggerMode });
		expect(t(msg({ mentionEveryone: true }))).toBe(false);
	});

	it("explicit_prefix matches after leading whitespace, else not", () => {
		const t = buildTopicTrigger({
			mode: "explicit_prefix",
			prefixes: ["📋", "TOPIC:"],
		});
		expect(t(msg({ content: "TOPIC: restart" }))).toBe(true);
		expect(t(msg({ content: "   📋 broadcast" }))).toBe(true);
		expect(t(msg({ content: "just chatting TOPIC: no" }))).toBe(false);
		expect(t(msg({ content: "hello" }))).toBe(false);
	});

	it("explicit_prefix with no/empty prefixes never matches", () => {
		expect(buildTopicTrigger({ mode: "explicit_prefix" })(msg())).toBe(false);
		expect(
			buildTopicTrigger({ mode: "explicit_prefix", prefixes: [""] })(msg()),
		).toBe(false);
	});

	it("any_lead_mention triggers when a lead user id is @-mentioned", () => {
		const t = buildTopicTrigger({
			mode: "any_lead_mention",
			leadUserIds: ["lead-a", "lead-b"],
		});
		expect(t(msg({ mentions: ["lead-b"] }))).toBe(true);
		expect(t(msg({ mentions: ["someone-else"] }))).toBe(false);
		expect(t(msg({ mentions: [] }))).toBe(false);
	});

	it("any_lead_mention with no lead ids never triggers", () => {
		expect(
			buildTopicTrigger({ mode: "any_lead_mention" })(msg({ mentions: ["x"] })),
		).toBe(false);
	});

	it("broadcast triggers on mention_everyone OR >= minMentions", () => {
		const t = buildTopicTrigger({ mode: "broadcast", minMentions: 2 });
		expect(t(msg({ mentionEveryone: true }))).toBe(true);
		expect(t(msg({ mentions: ["a", "b"] }))).toBe(true);
		expect(t(msg({ mentions: ["a"] }))).toBe(false);
		// does NOT scan content for "@everyone" — relies on the structured boolean
		expect(t(msg({ content: "hey @everyone please", mentions: [] }))).toBe(
			false,
		);
	});

	it("broadcast default minMentions is 2", () => {
		const t = buildTopicTrigger({ mode: "broadcast" });
		expect(t(msg({ mentions: ["a"] }))).toBe(false);
		expect(t(msg({ mentions: ["a", "b"] }))).toBe(true);
	});

	it("any_top_level triggers on any message", () => {
		const t = buildTopicTrigger({ mode: "any_top_level" });
		expect(t(msg())).toBe(true);
		expect(t(msg({ content: "" }))).toBe(true);
	});
});
