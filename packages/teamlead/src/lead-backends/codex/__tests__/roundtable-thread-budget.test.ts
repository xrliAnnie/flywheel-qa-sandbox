import { describe, expect, it } from "vitest";
import type { DiscordInboundMessage } from "../CodexDiscordGateway.js";
import { buildMentionGate } from "../mention-gate.js";
import { RoundtableThreadRegistry } from "../RoundtableThreadRegistry.js";
import {
	createThreadBudgetStore,
	DEFAULT_ROUNDTABLE_THREAD_BUDGET,
	decideTopicThreadContinuation,
	seedThreadBudget,
} from "../roundtable-thread-budget.js";

const THREAD = "topic-thread-1";

describe("DEFAULT_ROUNDTABLE_THREAD_BUDGET (FLY-676)", () => {
	it("is 12 (raised from 2 so natural multi-turn talk is not truncated)", () => {
		expect(DEFAULT_ROUNDTABLE_THREAD_BUDGET).toBe(12);
	});
});

describe("decideTopicThreadContinuation — bounded bot-only budget (FLY-314 R1#1 parity)", () => {
	it("UNSEEDED thread: a bot trigger drops (missing budget = exhausted, not a reset)", () => {
		const store = createThreadBudgetStore();
		expect(
			decideTopicThreadContinuation(
				{ threadId: THREAD, authorBot: true },
				store,
				{
					budgetN: 2,
				},
			),
		).toBe(false);
	});

	it("seeded thread: bot triggers consume budget and stop after N", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, THREAD, 2); // new top-level topic engage
		const bot = { threadId: THREAD, authorBot: true };
		expect(decideTopicThreadContinuation(bot, store, { budgetN: 2 })).toBe(
			true,
		);
		expect(decideTopicThreadContinuation(bot, store, { budgetN: 2 })).toBe(
			true,
		);
		expect(decideTopicThreadContinuation(bot, store, { budgetN: 2 })).toBe(
			false,
		);
	});

	it("a non-bot human resets the budget", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, THREAD, 2);
		const bot = { threadId: THREAD, authorBot: true };
		decideTopicThreadContinuation(bot, store, { budgetN: 2 });
		decideTopicThreadContinuation(bot, store, { budgetN: 2 });
		expect(decideTopicThreadContinuation(bot, store, { budgetN: 2 })).toBe(
			false,
		);
		// human (non-bot) → reset + handled (a real reset event, unlike a missing entry)
		expect(
			decideTopicThreadContinuation(
				{ threadId: THREAD, authorBot: false },
				store,
				{ budgetN: 2 },
			),
		).toBe(true);
		expect(decideTopicThreadContinuation(bot, store, { budgetN: 2 })).toBe(
			true,
		);
	});

	it("per-thread isolation", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, "T1", 1);
		seedThreadBudget(store, "T2", 1);
		const a = { threadId: "T1", authorBot: true };
		decideTopicThreadContinuation(a, store, { budgetN: 1 });
		expect(decideTopicThreadContinuation(a, store, { budgetN: 1 })).toBe(false);
		expect(
			decideTopicThreadContinuation(
				{ threadId: "T2", authorBot: true },
				store,
				{
					budgetN: 1,
				},
			),
		).toBe(true);
	});
});

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

describe("buildMentionGate — autoContinue topic threads (FLY-314 Part(b) parity)", () => {
	it("autoContinue OFF (default) → topic thread stays mention-required (byte-compat)", () => {
		const registry = new RoundtableThreadRegistry();
		registry.add(THREAD);
		const gate = buildMentionGate({
			botUserId: "lead-a",
			sharedChannelIds: ["roundtable-parent"],
			dynamicSharedChannels: registry,
		});
		// bot, no @ → drop (current FLY-220 behavior)
		expect(gate(msg({ mentions: [] }))).toBe(false);
		// bot with exact @ → handled
		expect(gate(msg({ mentions: ["lead-a"] }))).toBe(true);
	});

	it("autoContinue ON → member bot continues without @, bounded by budget; bot @ does NOT bypass", () => {
		const registry = new RoundtableThreadRegistry();
		registry.add(THREAD);
		const budgetStore = createThreadBudgetStore();
		seedThreadBudget(budgetStore, THREAD, 2); // simulate the top-level topic engage
		const gate = buildMentionGate({
			botUserId: "lead-a",
			sharedChannelIds: ["roundtable-parent"],
			dynamicSharedChannels: registry,
			autoContinue: true,
			budgetStore,
			budgetN: 2,
		});
		// no-@ bot messages continue, bounded
		expect(gate(msg({ mentions: [] }))).toBe(true);
		expect(gate(msg({ mentions: [] }))).toBe(true);
		expect(gate(msg({ mentions: [] }))).toBe(false); // budget exhausted
		// a bot @-mention does NOT revive the budget
		expect(gate(msg({ mentions: ["lead-a"] }))).toBe(false);
	});

	it("autoContinue ON → human resets budget; static shared PARENT still mention-required", () => {
		const registry = new RoundtableThreadRegistry();
		registry.add(THREAD);
		const budgetStore = createThreadBudgetStore();
		seedThreadBudget(budgetStore, THREAD, 1); // simulate the top-level topic engage
		const gate = buildMentionGate({
			botUserId: "lead-a",
			sharedChannelIds: ["roundtable-parent"],
			dynamicSharedChannels: registry,
			autoContinue: true,
			budgetStore,
			budgetN: 1,
		});
		gate(msg({ mentions: [] })); // 1→0
		expect(gate(msg({ mentions: [] }))).toBe(false);
		// human (non-bot) in the thread → reset
		expect(
			gate(msg({ authorBot: false, authorId: "human", mentions: [] })),
		).toBe(true);
		expect(gate(msg({ mentions: [] }))).toBe(true);
		// the PARENT channel is NOT a topic thread → still mention-required (no relax)
		expect(gate(msg({ channelId: "roundtable-parent", mentions: [] }))).toBe(
			false,
		);
		expect(
			gate(msg({ channelId: "roundtable-parent", mentions: ["lead-a"] })),
		).toBe(true);
	});
});
