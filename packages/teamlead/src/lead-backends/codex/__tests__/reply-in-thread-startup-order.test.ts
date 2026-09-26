import { describe, expect, it, vi } from "vitest";
import {
	CodexDiscordGateway,
	type DiscordInboundMessage,
} from "../CodexDiscordGateway.js";
import { InMemoryInboundCursorStore } from "../InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "../RestPollDiscordInboundSource.js";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";

const RT = "roundtable";
const BOT = "bot-self";
const GUILD = "guild-1";
const THREAD = "t1";

/** Combined Discord mock: guild active-threads (discovery) + channel messages (RestPoll). */
function makeFetch() {
	return vi.fn(async (url: string) => {
		// discovery: GET /guilds/{g}/threads/active
		if (/\/guilds\/[^/]+\/threads\/active$/.test(url)) {
			return json({
				threads: [{ id: THREAD, parent_id: RT }],
				members: [{ id: THREAD, user_id: BOT }],
			});
		}
		// RestPoll: GET /channels/{id}/messages?after=...
		const m = url.match(/\/channels\/([^/]+)\/messages\?(.*)$/);
		if (m) {
			const channelId = m[1];
			const after = new URLSearchParams(m[2]).get("after");
			if (channelId === THREAD && after === "10") {
				// the downtime message that arrived in the thread while we were down
				return json([
					{
						id: "11",
						channel_id: THREAD,
						author: { id: "u1", bot: false },
						content: `<@${BOT}> any update?`,
						mentions: [{ id: BOT }],
					},
				]);
			}
			return json([]); // base channel + already-drained
		}
		throw new Error(`unexpected url ${url}`);
	}) as unknown as typeof fetch;
}
function json(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as unknown as Response;
}

describe("FLY-314 Phase 2 startup order (Codex code review #1)", () => {
	it("gateway-first: a resumed thread's downtime message reaches the router (not dropped)", async () => {
		const cursor = new InMemoryInboundCursorStore();
		cursor.save(THREAD, "10"); // we were last at id 10 in the thread before restart
		const fetchImpl = makeFetch();
		const source = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["base"],
			cursorStore: cursor,
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
		});
		const wiring = buildReplyInThreadWiring({
			cfg: { enabled: true, parentChannelId: RT, guildId: GUILD },
			botToken: "tok",
			botUserId: BOT,
			crossDeptChannelIds: [RT],
			source,
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
		});
		if (!wiring) throw new Error("wiring should be defined");
		const submits: string[] = [];
		const gateway = new CodexDiscordGateway({
			source,
			router: {
				submit: (i: { idempotencyKey: string }) => {
					submits.push(i.idempotencyKey);
					return { accepted: true, entryId: i.idempotencyKey };
				},
			} as unknown as Parameters<
				typeof CodexDiscordGateway.prototype.constructor
			>[0]["router"],
			botUserId: BOT,
			channelIds: ["base"],
			registry: wiring.registry,
			resolveReplyRoute: wiring.resolveReplyRoute,
			shouldHandle: (msg: DiscordInboundMessage) =>
				// mirror the runtime: thread is shared → require exact @-id
				wiring.registry.has(msg.channelId)
					? (msg.mentions ?? []).includes(BOT)
					: true,
			logger: { warn: () => {} },
		});

		// CORRECT ORDER (the fix): gateway installs the onMessage handler first, THEN
		// discovery drains the newly-subscribed thread.
		await gateway.start();
		await wiring.start();

		// the downtime message (id 11) was delivered to the router, not silently dropped
		expect(submits).toContain("11");
		await wiring.stop();
		await gateway.stop();
	});
});
