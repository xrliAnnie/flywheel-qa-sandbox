/**
 * FLY-967 round-2 QA kickback — Annie's real-machine 3-strike failure.
 *
 * Three bugs, all in the real-SDK glue that neither unit tests nor the
 * autostart staged run ever exercised. The fixes are extracted into
 * SDK-free exported helpers (the classifyVoiceDelta precedent) so the
 * regressions are pinned here:
 *
 *   ① slash "did not respond" (flaky): the first interaction ack happened
 *      AFTER createIssue (a Linear round-trip) — past Discord's 3-second
 *      token window. handleChatInteraction must defer FIRST, unconditionally,
 *      then editReply the placeholder (followUp for later replies).
 *   ② garbled assistant audio: createResource omitted inputType for the
 *      stream branch → StreamType.Arbitrary → ffmpeg probes headerless raw
 *      PCM and mis-decodes it. Streams are AssistantSpeaker's 48k s16le
 *      stereo and MUST be declared StreamType.Raw.
 *   ③ assistant deaf to the founder: isHuman consulted only members.cache
 *      (fail-closed). GUILD_CREATE voice_states carry no member objects, so
 *      anyone already in the VC before boot NEVER resolves and every speaking
 *      burst is dropped. makeIsHuman resolves cache misses via a background
 *      single-member REST fetch and prefetches current VC occupants at boot.
 */
import { describe, expect, it } from "vitest";
import { GeminiCommand } from "../assistant/GeminiCommand.js";
import {
	handleChatInteraction,
	makeCreateResource,
	makeIsHuman,
} from "../bots/discordWiring.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- ① interaction ack ----------

function fakeInteraction(overrides: Record<string, unknown> = {}) {
	const events: string[] = [];
	const payloads: { edit: unknown[]; followUp: unknown[] } = {
		edit: [],
		followUp: [],
	};
	const interaction = {
		deferReply: async () => {
			events.push("defer");
		},
		editReply: async (p: unknown) => {
			events.push("edit");
			payloads.edit.push(p);
		},
		followUp: async (p: unknown) => {
			events.push("followUp");
			payloads.followUp.push(p);
		},
		user: { id: "annie-1" },
		options: {
			getString: (name: string) => (name === "topic" ? "聊聊进展" : null),
		},
		...overrides,
	};
	return { interaction, events, payloads };
}

describe("FLY-967 ① handleChatInteraction — defer-first ack", () => {
	it("defers BEFORE the command handler runs (never after slow work)", async () => {
		const { interaction, events } = fakeInteraction();
		await handleChatInteraction(interaction, async () => {
			events.push("handler");
		});
		expect(events[0]).toBe("defer");
		expect(events.indexOf("handler")).toBeGreaterThan(events.indexOf("defer"));
	});

	it("first reply resolves the deferred placeholder via editReply; later replies followUp", async () => {
		const { interaction, events, payloads } = fakeInteraction();
		await handleChatInteraction(interaction, async (inv) => {
			await inv.reply("开场了", { joinUrl: "https://discord.gg/x" });
			await inv.reply("第二条");
		});
		expect(events).toEqual(["defer", "edit", "followUp"]);
		const first = payloads.edit[0] as {
			content: string;
			components?: unknown[];
		};
		expect(first.content).toBe("开场了");
		// Join button row survives the editReply path
		expect(JSON.stringify(first.components)).toContain("https://discord.gg/x");
		expect((payloads.followUp[0] as { content: string }).content).toBe(
			"第二条",
		);
	});

	it("passes topic and userId through to the handler", async () => {
		const { interaction } = fakeInteraction();
		let seen: { topic?: string; userId: string } | null = null;
		await handleChatInteraction(interaction, async (inv) => {
			seen = { topic: inv.topic, userId: inv.userId };
		});
		expect(seen).toEqual({ topic: "聊聊进展", userId: "annie-1" });
	});

	it("a failed defer never blocks the command; replies become no-ops instead of throwing", async () => {
		const { interaction, events } = fakeInteraction({
			deferReply: async () => {
				throw new Error("Unknown interaction");
			},
		});
		let ran = false;
		await handleChatInteraction(interaction, async (inv) => {
			ran = true;
			await inv.reply("should be swallowed"); // token is dead — nothing to edit
		});
		expect(ran).toBe(true);
		expect(events).toEqual([]); // no editReply/followUp attempted on a dead token
	});
});

// ---------- ② createResource stream declares Raw ----------

describe("FLY-967 ② makeCreateResource — raw PCM streams must not hit ffmpeg probe", () => {
	function stubVoice() {
		const calls: unknown[][] = [];
		return {
			calls,
			voice: {
				StreamType: { Raw: "raw-sentinel" },
				createAudioResource: (...args: unknown[]) => {
					calls.push(args);
					return { resource: true };
				},
			},
		};
	}

	it("stream sources are declared StreamType.Raw (48k s16le stereo from AssistantSpeaker)", () => {
		const { voice, calls } = stubVoice();
		const createResource = makeCreateResource(voice);
		const stream = { fake: "stream" };
		createResource({ kind: "stream", stream } as never);
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe(stream);
		expect(calls[0]![1]).toEqual({ inputType: "raw-sentinel" });
	});

	it("file sources keep the ffmpeg path (headers are probeable)", () => {
		const { voice, calls } = stubVoice();
		const createResource = makeCreateResource(voice);
		createResource({ kind: "file", path: "/tmp/x.wav" });
		expect(calls).toEqual([["/tmp/x.wav"]]);
	});
});

// ---------- ③ makeIsHuman — cache miss self-heals via REST fetch ----------

function fakeClient(opts: {
	cachedMembers?: Record<string, { bot: boolean }>;
	fetchable?: Record<string, { bot: boolean }>;
	voiceStateUserIds?: string[];
}) {
	const fetched: string[] = [];
	let rejectAll = false;
	const membersCache = new Map(
		Object.entries(opts.cachedMembers ?? {}).map(([id, m]) => [
			id,
			{ user: { bot: m.bot } },
		]),
	);
	const voiceStates = new Map(
		(opts.voiceStateUserIds ?? []).map((id) => [id, { channelId: "vc" }]),
	);
	const guild = {
		members: {
			cache: membersCache,
			fetch: async (userId: string) => {
				fetched.push(userId);
				if (rejectAll) throw new Error("rest down");
				const m = opts.fetchable?.[userId];
				if (!m) throw new Error("Unknown Member");
				return { user: { bot: m.bot } };
			},
		},
		voiceStates: { cache: voiceStates },
	};
	const client = {
		guilds: {
			cache: new Map([["g1", guild]]),
			fetch: async (guildId: string) => {
				if (guildId !== "g1") throw new Error("unknown guild");
				return guild;
			},
		},
	};
	return {
		client,
		fetched,
		setRejectAll: (v: boolean) => {
			rejectAll = v;
		},
	};
}

describe("FLY-967 ③ makeIsHuman — founder already in VC before boot must become audible", () => {
	it("cached members answer synchronously (human true, bot false)", () => {
		const { client } = fakeClient({
			cachedMembers: { human: { bot: false }, bot: { bot: true } },
		});
		const isHuman = makeIsHuman(client, "g1");
		expect(isHuman("human")).toBe(true);
		expect(isHuman("bot")).toBe(false);
	});

	it("cache miss fails closed for THIS burst but resolves via REST for the next one", async () => {
		const { client, fetched } = fakeClient({
			fetchable: { annie: { bot: false } },
		});
		const isHuman = makeIsHuman(client, "g1");
		expect(isHuman("annie")).toBe(false); // burst 1: unknown → dropped
		expect(fetched).toContain("annie"); // …but the resolve was kicked off
		await tick();
		await tick();
		expect(isHuman("annie")).toBe(true); // burst 2: admitted
	});

	it("resolved bots stay denied", async () => {
		const { client } = fakeClient({ fetchable: { sneaky: { bot: true } } });
		const isHuman = makeIsHuman(client, "g1");
		isHuman("sneaky");
		await tick();
		await tick();
		expect(isHuman("sneaky")).toBe(false);
	});

	it("a failed fetch is retried on a later burst (transient REST outage)", async () => {
		const { client, fetched, setRejectAll } = fakeClient({
			fetchable: { annie: { bot: false } },
		});
		setRejectAll(true);
		const isHuman = makeIsHuman(client, "g1");
		expect(isHuman("annie")).toBe(false);
		await tick();
		await tick();
		setRejectAll(false);
		expect(isHuman("annie")).toBe(false); // this burst re-kicks the fetch
		await tick();
		await tick();
		expect(isHuman("annie")).toBe(true);
		expect(fetched.filter((u) => u === "annie").length).toBeGreaterThanOrEqual(
			2,
		);
	});

	it("prefetches current VC occupants at construction (GUILD_CREATE voice_states carry no member)", async () => {
		const { client, fetched } = fakeClient({
			fetchable: { annie: { bot: false } },
			voiceStateUserIds: ["annie"],
		});
		const isHuman = makeIsHuman(client, "g1");
		expect(fetched).toContain("annie"); // resolved WITHOUT any isHuman call
		await tick();
		await tick();
		expect(isHuman("annie")).toBe(true); // her FIRST burst is already admitted
	});
});

// ---------- ④ kickoff title strips raw mention markup ----------

describe("FLY-967 ④ kickoff title — founder-facing, no raw mention markup", () => {
	it("strips <@id> tokens from the topic (FLY-993 regression)", async () => {
		let title = "";
		const slot = {
			acquire: () => ({ ok: true }) as const,
			release: () => {},
		};
		const cmd = new GeminiCommand({
			slot: slot as never,
			createIssue: async (t: string) => {
				title = t;
				return { identifier: "FLY-1", url: undefined };
			},
			pingFounder: async () => {},
			joinUrl: "https://discord.gg/x",
			startSession: async () => {},
			now: () => new Date("2026-07-07T23:00:00"),
		} as never);
		await cmd.handle({
			topic: "<@1516207680836866219> 随便聊聊",
			userId: "u1",
			reply: async () => {},
		});
		expect(title).not.toContain("<@");
		expect(title).toContain("随便聊聊");
	});
});
