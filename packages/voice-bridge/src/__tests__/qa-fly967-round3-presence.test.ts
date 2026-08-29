/**
 * FLY-967 round-3 QA kickback — founder-present detection treated the
 * unresolved founder as a bot, so the session never entered live.
 *
 * Annie's third real-machine round: /gemini + Join both worked (round-2 fix
 * ① held), but the room stayed silent — venue log showed the session stuck
 * in `invoked`, founderPresent never true. Root cause is the SIBLING path of
 * round-2's bug ③: the ears path got the REST self-heal (makeIsHuman), but
 * the presence path kept two unresolved-member traps of its own:
 *
 *   - onVoiceStateUpdate emitted `isBot: newState.member?.user?.bot ?? true`
 *     — an unresolved member (no GuildMembers intent) defaults to BOT and
 *     wiring drops the join delta → humanCount never increments.
 *   - voiceChannelHumanCount counted only channel members with
 *     `member.user.bot === false` — an unresolved pre-sitting founder is
 *     invisible to the boot-time seed.
 *
 * Fix mirrors the round-2 self-heal: unresolved members are resolved via a
 * single-member REST fetch (VoiceState.guild carries the handle; no extra
 * intent needed) instead of being defaulted to bot. Resolution failure stays
 * fail-closed (drop / not-human).
 */
import { describe, expect, it } from "vitest";
import { classifyVoiceDelta } from "../assistant/wiring.js";
import {
	countHumansInVoiceChannel,
	makeVoiceStateForwarder,
} from "../bots/discordWiring.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

type Emitted = {
	userId: string;
	isBot: boolean;
	fromChannelId: string | null;
	toChannelId: string | null;
};

function fakeState(opts: {
	id: string;
	channelId: string | null;
	bot?: boolean; // member resolved with this bot flag
	fetchBot?: boolean; // REST resolution answer (member unresolved)
	fetchRejects?: boolean;
	fetched?: string[];
}) {
	return {
		id: opts.id,
		channelId: opts.channelId,
		member: opts.bot === undefined ? undefined : { user: { bot: opts.bot } },
		guild: {
			members: {
				fetch: async (userId: string) => {
					opts.fetched?.push(userId);
					if (opts.fetchRejects) throw new Error("rest down");
					return { user: { bot: opts.fetchBot ?? false } };
				},
			},
		},
	};
}

describe("FLY-967 round-3 ① makeVoiceStateForwarder — unresolved member must not default to bot", () => {
	it("resolved human emits without any REST fetch, isBot=false", async () => {
		const out: Emitted[] = [];
		const fetched: string[] = [];
		const forward = makeVoiceStateForwarder((u) => out.push(u));
		forward(
			fakeState({ id: "annie", channelId: null }),
			fakeState({ id: "annie", channelId: "vc", bot: false, fetched }),
		);
		await tick();
		expect(out).toEqual([
			{ userId: "annie", isBot: false, fromChannelId: null, toChannelId: "vc" },
		]);
		expect(fetched).toEqual([]);
	});

	it("resolved bot emits isBot=true", async () => {
		const out: Emitted[] = [];
		const forward = makeVoiceStateForwarder((u) => out.push(u));
		forward(
			fakeState({ id: "b1", channelId: null }),
			fakeState({ id: "b1", channelId: "vc", bot: true }),
		);
		await tick();
		expect(out[0]?.isBot).toBe(true);
	});

	it("UNRESOLVED real human joining the VC resolves via REST and emits isBot=false — founderPresent becomes true (Annie round-3 regression)", async () => {
		const out: Emitted[] = [];
		const fetched: string[] = [];
		const forward = makeVoiceStateForwarder((u) => out.push(u));
		forward(
			fakeState({ id: "annie", channelId: null }),
			fakeState({ id: "annie", channelId: "vc", fetchBot: false, fetched }),
		);
		expect(out).toEqual([]); // not yet — resolution in flight
		await tick();
		await tick();
		expect(fetched).toEqual(["annie"]);
		expect(out).toHaveLength(1);
		expect(out[0]?.isBot).toBe(false);
		// the wiring chain: this delta is a JOIN → humanCount++ → founderPresent
		expect(classifyVoiceDelta(out[0] as Emitted, "vc")).toBe("join");
	});

	it("UNRESOLVED bot resolves via REST and emits isBot=true (still filtered)", async () => {
		const out: Emitted[] = [];
		const forward = makeVoiceStateForwarder((u) => out.push(u));
		forward(
			fakeState({ id: "b2", channelId: null }),
			fakeState({ id: "b2", channelId: "vc", fetchBot: true }),
		);
		await tick();
		await tick();
		expect(out[0]?.isBot).toBe(true);
	});

	it("REST failure drops the delta fail-closed (no emit) and logs", async () => {
		const out: Emitted[] = [];
		const lines: string[] = [];
		const forward = makeVoiceStateForwarder(
			(u) => out.push(u),
			(l) => lines.push(l),
		);
		forward(
			fakeState({ id: "ghost", channelId: null }),
			fakeState({ id: "ghost", channelId: "vc", fetchRejects: true }),
		);
		await tick();
		await tick();
		expect(out).toEqual([]);
		expect(lines.join(" ")).toContain("ghost");
	});

	it("leave events fall back to the OLD state's member when the new one is bare", async () => {
		const out: Emitted[] = [];
		const forward = makeVoiceStateForwarder((u) => out.push(u));
		forward(
			fakeState({ id: "annie", channelId: "vc", bot: false }),
			fakeState({ id: "annie", channelId: null }),
		);
		await tick();
		expect(out).toEqual([
			{ userId: "annie", isBot: false, fromChannelId: "vc", toChannelId: null },
		]);
	});

	it("REST resolution must NOT reorder gateway order — unresolved join then leave stays join,leave even when the leave could resolve first (Codex R13)", async () => {
		const out: Emitted[] = [];
		const forward = makeVoiceStateForwarder((u) => out.push(u));
		// join: fetch resolves SLOWLY; leave: fetch would resolve instantly.
		let releaseJoin: (() => void) | undefined;
		const joinGate = new Promise<void>((r) => {
			releaseJoin = r;
		});
		const fetchLog: string[] = [];
		const slowGuild = {
			members: {
				fetch: async (userId: string) => {
					fetchLog.push(`join-fetch:${userId}`);
					await joinGate;
					return { user: { bot: false } };
				},
			},
		};
		const fastGuild = {
			members: {
				fetch: async (userId: string) => {
					fetchLog.push(`leave-fetch:${userId}`);
					return { user: { bot: false } };
				},
			},
		};
		forward(
			{ id: "annie", channelId: null, guild: slowGuild },
			{ id: "annie", channelId: "vc", guild: slowGuild },
		);
		forward(
			{ id: "annie", channelId: "vc", guild: fastGuild },
			{ id: "annie", channelId: null, guild: fastGuild },
		);
		await tick();
		await tick();
		expect(out).toEqual([]); // both queued behind the slow join resolution
		releaseJoin?.();
		await tick();
		await tick();
		await tick();
		expect(out.map((u) => `${u.fromChannelId}->${u.toChannelId}`)).toEqual([
			"null->vc",
			"vc->null",
		]);
	});
});

describe("FLY-967 round-3 ② countHumansInVoiceChannel — unresolved pre-sitting founder must count", () => {
	function fakeGuild(opts: {
		voiceStates: Record<string, string>; // userId -> channelId
		cachedMembers?: Record<string, { bot: boolean }>;
		fetchable?: Record<string, { bot: boolean }>;
		fetched?: string[];
	}) {
		return {
			voiceStates: {
				cache: new Map(
					Object.entries(opts.voiceStates).map(([id, ch]) => [
						id,
						{ channelId: ch },
					]),
				),
			},
			members: {
				cache: new Map(
					Object.entries(opts.cachedMembers ?? {}).map(([id, m]) => [
						id,
						{ user: { bot: m.bot } },
					]),
				),
				fetch: async (userId: string) => {
					opts.fetched?.push(userId);
					const m = opts.fetchable?.[userId];
					if (!m) throw new Error("Unknown Member");
					return { user: { bot: m.bot } };
				},
			},
		};
	}

	it("counts a cached human without fetching", async () => {
		const fetched: string[] = [];
		const guild = fakeGuild({
			voiceStates: { annie: "vc" },
			cachedMembers: { annie: { bot: false } },
			fetched,
		});
		expect(await countHumansInVoiceChannel(guild, "vc")).toBe(1);
		expect(fetched).toEqual([]);
	});

	it("counts an UNRESOLVED human by resolving via REST (GUILD_CREATE voice_states carry no member)", async () => {
		const fetched: string[] = [];
		const guild = fakeGuild({
			voiceStates: { annie: "vc" },
			fetchable: { annie: { bot: false } },
			fetched,
		});
		expect(await countHumansInVoiceChannel(guild, "vc")).toBe(1);
		expect(fetched).toEqual(["annie"]);
	});

	it("bots and other-channel occupants do not count", async () => {
		const guild = fakeGuild({
			voiceStates: { b1: "vc", annie: "other-vc" },
			cachedMembers: { b1: { bot: true } },
			fetchable: { annie: { bot: false } },
		});
		expect(await countHumansInVoiceChannel(guild, "vc")).toBe(0);
	});

	it("a member that cannot be resolved counts as not-human (fail-closed)", async () => {
		const guild = fakeGuild({ voiceStates: { ghost: "vc" } });
		expect(await countHumansInVoiceChannel(guild, "vc")).toBe(0);
	});
});
