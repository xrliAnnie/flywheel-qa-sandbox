import { expect, it } from "vitest";
import {
	releaseCard,
	releaseMessageDigest,
} from "../customer-release/cards.js";
import { ReleaseDiscordClient } from "../customer-release/discord.js";

const now = Date.parse("2026-09-15T15:00:00Z");
const target = {
	epoch: 1,
	applicationId: "123456789012345678",
	botUserId: "223456789012345678",
	founderId: "323456789012345678",
	guildId: "423456789012345678",
	channelId: "523456789012345678",
};
const nonce = "a".repeat(32);
const card = releaseCard({
	kind: "veto",
	nonce,
	epoch: 1,
	timezone: "America/Los_Angeles",
	betaVersion: "1.2.3-beta.1",
	releaseVersion: "1.2.3",
	sourceCommit: "b".repeat(40),
	payloadSha256: "c".repeat(64),
	deadlineAt: now + 4 * 3600_000,
});
function fixture() {
	const calls: { path: string; method: string; body?: any }[] = [];
	const message: any = {
		...card,
		id: "623456789012345678",
		channel_id: target.channelId,
		author: { id: target.botUserId, bot: true },
		type: 0,
		timestamp: new Date(now).toISOString(),
		nonce: BigInt(`0x${nonce}`).toString(36),
	};
	const responses = new Map<string, unknown>([
		["/users/@me", { id: target.botUserId, bot: true }],
		[
			"/applications/@me",
			{ id: target.applicationId, interactions_endpoint_url: null },
		],
		[
			`/guilds/${target.guildId}`,
			{ id: target.guildId, owner_id: target.founderId },
		],
		[
			`/guilds/${target.guildId}/roles`,
			[
				{
					id: target.guildId,
					permissions: String((1 << 10) | (1 << 16) | (1 << 11)),
				},
			],
		],
		[
			`/guilds/${target.guildId}/members/${target.founderId}`,
			{ user: { id: target.founderId }, roles: [] },
		],
		[
			`/guilds/${target.guildId}/members/${target.botUserId}`,
			{ user: { id: target.botUserId, bot: true }, roles: [] },
		],
		[
			`/channels/${target.channelId}`,
			{
				id: target.channelId,
				guild_id: target.guildId,
				type: 0,
				permission_overwrites: [],
			},
		],
		[`/channels/${target.channelId}/messages/${message.id}`, message],
		[`/channels/${target.channelId}/messages?limit=100`, [message]],
	]);
	let healthy = true,
		postFailure = false;
	const client = new ReleaseDiscordClient({
		token: "fixture-token",
		target: () => target,
		healthy: () => healthy,
		now: () => now,
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			const u = new URL(String(url));
			expect(u.origin).toBe("https://discord.com");
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bot fixture-token",
			);
			const path = u.pathname.replace("/api/v10", "") + u.search;
			calls.push({
				path,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (init?.method === "POST") {
				if (postFailure) throw new Error("lost response");
				return Response.json(message);
			}
			const value = responses.get(path);
			if (value instanceof Response) return value;
			return value === undefined
				? new Response(null, { status: 404 })
				: Response.json(value);
		}) as typeof fetch,
	});
	return {
		client,
		calls,
		responses,
		message,
		unhealthy: () => {
			healthy = false;
		},
		losePost: () => {
			postFailure = true;
		},
	};
}
it("sends one nonce-enforced card, independently rereads message/access/app and returns proof", async () => {
	const f = fixture();
	const id = await f.client.send(card, nonce);
	const proof = await f.client.verifyMessage(id, releaseMessageDigest(card));
	expect(proof).toMatchObject({
		messageId: f.message.id,
		messageDigest: releaseMessageDigest(card),
		founderId: target.founderId,
		accessVerified: true,
		gatewayHealthy: true,
		verifiedAt: now,
	});
	const posts = f.calls.filter((c) => c.method === "POST");
	expect(posts).toHaveLength(1);
	expect(posts[0]!.body).toMatchObject({
		enforce_nonce: true,
		nonce: BigInt(`0x${nonce}`).toString(36),
		allowed_mentions: { parse: [] },
	});
	expect(posts[0]!.body.nonce.length).toBeLessThanOrEqual(25);
});
it.each([
	"owner_missing",
	"permission",
	"edited",
	"app_http",
	"wrong_author",
	"gateway",
	"poll",
])("probe fails closed on %s", async (kind) => {
	const f = fixture();
	if (kind === "owner_missing")
		f.responses.delete(`/guilds/${target.guildId}/members/${target.founderId}`);
	if (kind === "permission")
		f.responses.set(`/channels/${target.channelId}`, {
			id: target.channelId,
			guild_id: target.guildId,
			type: 12,
			permission_overwrites: [],
		});
	if (kind === "edited") f.message.content += " changed";
	if (kind === "app_http")
		f.responses.set("/applications/@me", {
			id: target.applicationId,
			interactions_endpoint_url: "https://elsewhere.example",
		});
	if (kind === "wrong_author") f.message.author.id = target.founderId;
	if (kind === "gateway") f.unhealthy();
	if (kind === "poll") f.message.poll = { question: { text: "spoof" } };
	await expect(
		f.client.verifyMessage(f.message.id, releaseMessageDigest(card)),
	).rejects.toThrow();
});
it("ambiguous POST never retries; scan recovers one exact persistent button marker", async () => {
	const f = fixture();
	f.losePost();
	await expect(f.client.send(card, nonce)).rejects.toThrow();
	delete f.message.nonce;
	expect(await f.client.findMessage(nonce, now)).toBe(f.message.id);
	expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
it("ambiguous recovery rejects duplicate markers and unavailable/truncated history", async () => {
	for (const fault of ["duplicate", "unavailable", "truncated"]) {
		const f = fixture();
		f.responses.set(
			`/channels/${target.channelId}/messages?limit=100`,
			fault === "unavailable"
				? new Response(null, { status: 503 })
				: fault === "duplicate"
					? [f.message, { ...f.message, id: "623456789012345677" }]
					: Array.from({ length: 100 }, (_, i) => ({
							...f.message,
							id: String(623456789012346000n - BigInt(i)),
							components: [],
						})),
		);
		await expect(f.client.findMessage(nonce, now)).rejects.toThrow();
	}
});
