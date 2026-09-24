import { describe, expect, it, vi } from "vitest";
import { ChannelHeadcount } from "../room-headcount.js";

type Member = { user?: { bot?: boolean } } | null;

function guildClient(options?: { selfId?: string }) {
	const voiceStates = new Map<
		string,
		{ channelId: string | null; member: Member }
	>();
	const members = new Map<string, { user: { bot: boolean } }>();
	const client = {
		user: { id: options?.selfId ?? "voice-bot" },
		guilds: {
			cache: new Map([
				[
					"guild",
					{ voiceStates: { cache: voiceStates }, members: { cache: members } },
				],
			]),
		},
	};
	return {
		client,
		occupy(userId: string, channelId: string | null, member: Member) {
			voiceStates.set(userId, { channelId, member });
		},
		cacheMember(userId: string, bot: boolean) {
			members.set(userId, { user: { bot } });
		},
		leave(userId: string) {
			voiceStates.delete(userId);
		},
	};
}

function subscribed(client: unknown) {
	const unsubscribe = vi.fn();
	const deps = {
		onVoiceStateUpdate: vi.fn(() => unsubscribe),
		other: "kept",
	};
	const headcount = new ChannelHeadcount({
		guildId: "guild",
		voiceChannelId: "voice",
	});
	const wrapped = headcount.wrap(deps);
	const forwarded = vi.fn();
	const off = wrapped.onVoiceStateUpdate(client, forwarded);
	return { headcount, deps, wrapped, forwarded, off, unsubscribe };
}

const human: Member = { user: { bot: false } };
const bot: Member = { user: { bot: true } };

describe("ChannelHeadcount (FLY-2796 review R1/R2)", () => {
	it("is unknown before the room has subscribed with its client", () => {
		const headcount = new ChannelHeadcount({
			guildId: "guild",
			voiceChannelId: "voice",
		});
		expect(headcount.current()).toBeNull();
	});

	it("counts her alone as one, leaving out this bot and known bots", () => {
		const room = guildClient();
		room.occupy("founder", "voice", human);
		room.occupy("voice-bot", "voice", null);
		room.occupy("other-bot", "voice", bot);
		const test = subscribed(room.client);
		expect(test.headcount.current()).toBe(1);
	});

	it("sees a second human the moment the gateway cache has them — no event, no REST", () => {
		const room = guildClient();
		room.occupy("founder", "voice", human);
		const test = subscribed(room.client);
		expect(test.headcount.current()).toBe(1);
		room.occupy("guest", "voice", human);
		expect(test.headcount.current()).toBe(2);
		room.leave("guest");
		expect(test.headcount.current()).toBe(1);
	});

	it("counts an occupant it cannot classify yet as a possible human", () => {
		const room = guildClient();
		room.occupy("founder", "voice", human);
		room.occupy("unresolved", "voice", null);
		const test = subscribed(room.client);
		expect(test.headcount.current()).toBe(2);
		// Once the member cache says it is a bot, it stops counting.
		room.cacheMember("unresolved", true);
		expect(test.headcount.current()).toBe(1);
	});

	it("ignores people in other channels", () => {
		const room = guildClient();
		room.occupy("founder", "voice", human);
		room.occupy("guest", "another", human);
		room.occupy("idle", null, human);
		const test = subscribed(room.client);
		expect(test.headcount.current()).toBe(1);
	});

	it("is unknown when the guild's voice states cannot be read", () => {
		expect(subscribed({}).headcount.current()).toBeNull();
		expect(
			subscribed({ guilds: { cache: new Map() } }).headcount.current(),
		).toBeNull();
		const throwing = {
			guilds: {
				cache: {
					get() {
						throw new Error("cache gone");
					},
				},
			},
		};
		expect(subscribed(throwing).headcount.current()).toBeNull();
	});

	it("passes the room's subscription through untouched", () => {
		const room = guildClient();
		const test = subscribed(room.client);
		expect(test.deps.onVoiceStateUpdate).toHaveBeenCalledWith(
			room.client,
			test.forwarded,
		);
		expect(test.wrapped.other).toBe("kept");
		test.off();
		expect(test.unsubscribe).toHaveBeenCalledOnce();
	});
});
