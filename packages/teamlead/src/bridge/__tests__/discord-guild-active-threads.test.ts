import { describe, expect, it, vi } from "vitest";
import {
	isDiscordSnowflake,
	lastActivityMs,
	listGuildActiveThreads,
	resolveInfraDiscordIdentity,
	snowflakeToMs,
} from "../discord-guild-active-threads.js";

const DISCORD_EPOCH_MS = 1_420_070_400_000;
const NOW = Date.UTC(2026, 8, 2, 20, 0, 0);

function snowflakeAt(ms: number): string {
	return (BigInt(ms - DISCORD_EPOCH_MS) << 22n).toString();
}

describe("resolveInfraDiscordIdentity", () => {
	it("requires the infra token and prefers DISCORD_GUILD_ID", () => {
		expect(resolveInfraDiscordIdentity({})).toBeNull();
		expect(
			resolveInfraDiscordIdentity({
				CLAUDE_INFRA_BOT_TOKEN: " token ",
				DISCORD_GUILD_ID: " primary ",
				FLYWHEEL_ROUNDTABLE_GUILD_ID: "fallback",
			}),
		).toEqual({ botToken: "token", guildId: "primary" });
	});

	it("falls back when DISCORD_GUILD_ID is empty", () => {
		expect(
			resolveInfraDiscordIdentity({
				CLAUDE_INFRA_BOT_TOKEN: "token",
				DISCORD_GUILD_ID: "  ",
				FLYWHEEL_ROUNDTABLE_GUILD_ID: " fallback ",
			}),
		).toEqual({ botToken: "token", guildId: "fallback" });
	});
});

describe("listGuildActiveThreads", () => {
	it("returns only structurally valid active threads", async () => {
		const valid = {
			id: snowflakeAt(NOW),
			parent_id: "parent",
			last_message_id: snowflakeAt(NOW - 60_000),
		};
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						threads: [valid, { ...valid, id: "not-a-snowflake" }, {}, null],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		) as typeof fetch;

		expect(
			await listGuildActiveThreads(
				{ botToken: "token", guildId: "guild" },
				{ fetchImpl },
			),
		).toEqual({ ok: true, threads: [valid] });
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://discord.com/api/v10/guilds/guild/threads/active",
			expect.objectContaining({
				headers: { Authorization: "Bot token" },
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("returns Discord retry timing for 429 responses", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ retry_after: 9 }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "1.5" },
				}),
		) as typeof fetch;
		expect(
			await listGuildActiveThreads(
				{ botToken: "token", guildId: "guild" },
				{ fetchImpl },
			),
		).toEqual({
			ok: false,
			status: 429,
			retryAfterMs: 1_500,
			error: "Discord 429",
		});
	});

	it("aborts a never-resolving request at the timeout", async () => {
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					});
				}),
		) as typeof fetch;
		expect(
			await listGuildActiveThreads(
				{ botToken: "token", guildId: "guild" },
				{ fetchImpl, timeoutMs: 5 },
			),
		).toEqual({ ok: false, error: "timeout" });
	});
});

describe("Discord activity clocks", () => {
	it("requires a real last-message snowflake and treats a later archive timestamp as activity", () => {
		const messageAt = NOW - 2 * 60 * 60_000;
		const unarchiveAt = NOW - 30 * 60_000;
		const messageId = snowflakeAt(messageAt);
		expect(isDiscordSnowflake(messageId)).toBe(true);
		expect(isDiscordSnowflake("42")).toBe(false);
		expect(snowflakeToMs(messageId)).toBe(messageAt);
		expect(
			lastActivityMs({
				id: snowflakeAt(NOW - 3 * 60 * 60_000),
				parent_id: "parent",
				last_message_id: messageId,
				thread_metadata: {
					archive_timestamp: new Date(unarchiveAt).toISOString(),
				},
			}),
		).toBe(unarchiveAt);
		expect(
			lastActivityMs({
				id: snowflakeAt(NOW - 3 * 60 * 60_000),
				parent_id: "parent",
				last_message_id: null,
			}),
		).toBeNull();
	});
});
