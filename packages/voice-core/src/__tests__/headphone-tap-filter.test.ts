import { describe, expect, it } from "vitest";
import {
	shouldEnqueue,
	type TapConfig,
	type TapMessage,
} from "../headphone/tap-filter.js";

const cfg = (over: Partial<TapConfig> = {}): TapConfig => ({
	leadBotIds: new Set(["lead-1", "lead-2"]),
	systemBotIds: new Set(["bridge-fallback-bot"]),
	scopeChannelIds: new Set(["chat-1", "thread-1", "core-1"]),
	roundtableChannelIds: new Set(["roundtable-1"]),
	includeRoundtable: false,
	selfBotId: "headphone-bot",
	founderId: "annie-id",
	...over,
});

const msg = (over: Partial<TapMessage> = {}): TapMessage => ({
	authorId: "lead-1",
	authorIsBot: true,
	channelId: "chat-1",
	mentionsFounder: false,
	hasGateBinding: false,
	...over,
});

describe("shouldEnqueue truth table (plan B1-1.3 ①-⑦)", () => {
	it("① Lead bot in a scope channel → include", () => {
		expect(shouldEnqueue(msg(), cfg())).toBe(true);
	});

	it("② non-Lead/system authors → exclude (founder, bystander human, stranger bot)", () => {
		// founder's own message
		expect(
			shouldEnqueue(msg({ authorId: "annie-id", authorIsBot: false }), cfg()),
		).toBe(false);
		// bystander human
		expect(
			shouldEnqueue(
				msg({ authorId: "random-user", authorIsBot: false }),
				cfg(),
			),
		).toBe(false);
		// stranger bot with no gate binding
		expect(
			shouldEnqueue(
				msg({ authorId: "stranger-bot", authorIsBot: true }),
				cfg(),
			),
		).toBe(false);
	});

	it("③ roundtable excluded by default, included when includeRoundtable=true", () => {
		const inRoundtable = msg({ channelId: "roundtable-1" });
		expect(shouldEnqueue(inRoundtable, cfg())).toBe(false);
		expect(shouldEnqueue(inRoundtable, cfg({ includeRoundtable: true }))).toBe(
			true,
		);
	});

	it("③b roundtable inclusion still requires a recognized bot author", () => {
		expect(
			shouldEnqueue(
				msg({ channelId: "roundtable-1", authorId: "random-user" }),
				cfg({ includeRoundtable: true }),
			),
		).toBe(false);
	});

	it("④ Lead message @founder in an out-of-scope channel → include (fallback)", () => {
		expect(
			shouldEnqueue(
				msg({ channelId: "elsewhere", mentionsFounder: true }),
				cfg(),
			),
		).toBe(true);
		// without the mention it stays excluded
		expect(shouldEnqueue(msg({ channelId: "elsewhere" }), cfg())).toBe(false);
	});

	it("④b @founder wins even in an excluded roundtable (a direct @ is 'for her' by definition)", () => {
		expect(
			shouldEnqueue(
				msg({ channelId: "roundtable-1", mentionsFounder: true }),
				cfg(),
			),
		).toBe(true);
	});

	it("⑤ the headphone daemon's own bot is ALWAYS excluded (echo immunity, FLY-220)", () => {
		expect(
			shouldEnqueue(
				msg({ authorId: "headphone-bot", mentionsFounder: true }),
				cfg(),
			),
		).toBe(false);
		expect(
			shouldEnqueue(
				msg({ authorId: "headphone-bot", hasGateBinding: true }),
				cfg(),
			),
		).toBe(false);
	});

	it("⑥ system bots (gate-poller global fallback) in scope channels → include", () => {
		expect(shouldEnqueue(msg({ authorId: "bridge-fallback-bot" }), cfg())).toBe(
			true,
		);
	});

	it("⑦ unknown bot in a scope channel WITH a gate binding → include (classified by binding, not author guess)", () => {
		expect(
			shouldEnqueue(
				msg({ authorId: "stranger-bot", hasGateBinding: true }),
				cfg(),
			),
		).toBe(true);
		// a human with a gate binding flag is still excluded (binding rescues bots only)
		expect(
			shouldEnqueue(
				msg({
					authorId: "random-user",
					authorIsBot: false,
					hasGateBinding: true,
				}),
				cfg(),
			),
		).toBe(false);
	});
});
