import { describe, expect, it } from "vitest";
import type { DiscordInboundMessage } from "../CodexDiscordGateway.js";
import { buildMentionGate } from "../mention-gate.js";
import { RoundtableThreadRegistry } from "../RoundtableThreadRegistry.js";
import { createThreadBudgetStore } from "../roundtable-thread-budget.js";

const BOT_A = "lead-a";
const THREAD = "topic-thread-1";

function msg(over: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
	return {
		id: "1",
		channelId: THREAD,
		authorId: "lead-b",
		authorBot: true,
		content: "",
		mentions: [],
		...over,
	};
}

describe("buildMentionGate — dynamic shared threads (FLY-314 Phase 2, FLY-220 safety)", () => {
	it("treats a registered topic thread as shared → bot must use exact @-id to trigger", () => {
		const registry = new RoundtableThreadRegistry();
		registry.add(THREAD);
		const gate = buildMentionGate({
			botUserId: BOT_A,
			sharedChannelIds: ["roundtable-parent"],
			mentionPatterns: ["\\bLeadA\\b"],
			dynamicSharedChannels: registry,
		});

		// another bot (Lead B) mentions Lead A by exact id in the thread → handled
		expect(
			gate(msg({ mentions: [BOT_A], content: `<@${BOT_A}> please look` })),
		).toBe(true);
		// Lead B says "LeadA" by NAME (regex) — but it's a BOT author → NOT handled (no loop)
		expect(
			gate(msg({ authorBot: true, content: "hey LeadA check this" })),
		).toBe(false);
		// no mention at all → not handled
		expect(gate(msg({ content: "just chatting" }))).toBe(false);
	});

	it("a thread NOT in the registry is not shared → bypasses gating (handled)", () => {
		const registry = new RoundtableThreadRegistry();
		const gate = buildMentionGate({
			botUserId: BOT_A,
			sharedChannelIds: ["roundtable-parent"],
			dynamicSharedChannels: registry,
		});
		// unregistered channel → treated as own chat/core → always handled
		expect(gate(msg({ channelId: "some-dm", content: "hi" }))).toBe(true);
	});

	it("non-bot author CAN trigger by name regex inside a thread", () => {
		const registry = new RoundtableThreadRegistry();
		registry.add(THREAD);
		const gate = buildMentionGate({
			botUserId: BOT_A,
			sharedChannelIds: [],
			mentionPatterns: ["\\bLeadA\\b"],
			dynamicSharedChannels: registry,
		});
		// a human (non-bot) saying the name → handled
		expect(
			gate(msg({ authorBot: false, authorId: "human", content: "LeadA?" })),
		).toBe(true);
	});

	it("byte-compat: no dynamicSharedChannels → only static shared gated", () => {
		const gate = buildMentionGate({
			botUserId: BOT_A,
			sharedChannelIds: ["roundtable-parent"],
		});
		// a thread id with no dynamic registry → not shared → handled (unchanged)
		expect(gate(msg({ channelId: THREAD, content: "x" }))).toBe(true);
	});
});

describe("buildMentionGate — FLY-576 non-bot (founder) relaxation in member threads, DEFAULT-ON", () => {
	function memberGate(extra: Record<string, unknown> = {}) {
		const registry = new RoundtableThreadRegistry();
		registry.add(THREAD); // registry membership == this Lead joined the thread
		return buildMentionGate({
			botUserId: BOT_A,
			sharedChannelIds: ["roundtable-parent"],
			mentionPatterns: ["\\bLeadA\\b"],
			dynamicSharedChannels: registry,
			// production shape: reply-in-thread on, autoContinue OFF (no budgetStore/autoContinue)
			...extra,
		});
	}

	it("THE FIX: non-bot human in a member thread, no @ / no name, autoContinue OFF → handled", () => {
		const gate = memberGate();
		expect(
			gate(
				msg({
					authorBot: false,
					authorId: "annie",
					content: "ok let us go with plan B",
				}),
			),
		).toBe(true);
	});

	it("bot path unchanged: bot in a member thread, no @, autoContinue OFF → dropped (no melee)", () => {
		const gate = memberGate();
		expect(gate(msg({ authorBot: true, content: "just chatting" }))).toBe(
			false,
		);
	});

	it("bot path unchanged: bot exact @-id in a member thread, autoContinue OFF → handled", () => {
		const gate = memberGate();
		expect(
			gate(
				msg({
					authorBot: true,
					mentions: [BOT_A],
					content: `<@${BOT_A}> ping`,
				}),
			),
		).toBe(true);
	});

	it("static shared PARENT channel (not a thread) stays mention-required for non-bot", () => {
		const gate = memberGate();
		// non-bot in the parent channel with no @ / no name → still gated (relaxation is thread-only)
		expect(
			gate(
				msg({
					channelId: "roundtable-parent",
					authorBot: false,
					content: "hello room",
				}),
			),
		).toBe(false);
	});

	it("non-bot human message seeds/refills the bot budget (reset event) when a budgetStore is present", () => {
		const store = createThreadBudgetStore();
		const gate = memberGate({ budgetStore: store, budgetN: 2 });
		gate(msg({ authorBot: false, authorId: "annie", content: "go" }));
		expect(store.budgets.get(THREAD)).toBe(2);
	});

	it("autoContinue ON: non-bot human still handled (unchanged)", () => {
		const store = createThreadBudgetStore();
		const gate = memberGate({
			autoContinue: true,
			budgetStore: store,
			budgetN: 2,
		});
		expect(
			gate(msg({ authorBot: false, authorId: "annie", content: "anything" })),
		).toBe(true);
	});
});
