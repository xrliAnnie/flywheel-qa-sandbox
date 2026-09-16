import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { DISCORD_PERMISSIONS as P } from "../channel-permissions.js";
import { preflightVoiceSession } from "../voice-session-preflight.js";
import type { VoiceStartPreflightInput } from "../voice-session-start.js";

const GUILD = "100000000000000001";
const ROOM = "100000000000000002";
const TEXT = "100000000000000004";
const BOT = "100000000000000005";
const ROLE = "100000000000000006";
const ALL = Object.values(P).reduce(
	(a, p) => (p === P.ADMINISTRATOR ? a : a | p),
	0n,
);
afterEach(() => vi.useRealTimers());
function input(bot = BOT, token = "lead-token"): VoiceStartPreflightInput {
	const project: ProjectEntry = {
		projectName: "flywheel",
		projectRoot: "/fixture",
		voiceRoom: { guildId: GUILD, voiceChannelId: ROOM },
		leads: [
			{
				agentId: "lead",
				summaryRole: "producer",
				botUserId: bot,
				botTokenEnv: "LEAD_TOKEN",
				botToken: "ignored-cached-token",
				chatChannel: TEXT,
				match: {},
			},
		],
	};
	return {
		mode: "meeting",
		project,
		lead: project.leads[0],
		voiceBotToken: token,
		voiceHost: {
			schemaVersion: 1,
			qaVoiceChannelIds: [],
			qaAllowUserIds: [],
			evidenceRoots: [],
		},
	};
}
const probe = vi.fn(async () => ({
	version: 1 as const,
	leadId: "lead",
	botUserId: BOT,
	runtimeId: "12345678-1234-4123-8123-123456789012",
	nonce: "0".repeat(64),
	auth: "1".repeat(64),
	ready: true,
	selfDropped: true,
	unknownDropped: true,
	otherPassed: true,
}));
function discord(
	over: {
		bot?: string;
		permission?: bigint;
		channel403?: string;
		remaining?: number;
		modify?: (path: string, body: unknown) => unknown;
	} = {},
) {
	return vi.fn<typeof fetch>(async (url, init) => {
		const path = new URL(String(url)).pathname.replace("/api/v10", "");
		expect(init?.method ?? "GET").toBe("GET");
		if (path === `/channels/${over.channel403}`)
			return new Response("private", { status: 403 });
		let body: unknown;
		if (path === "/users/@me") body = { id: over.bot ?? BOT };
		else if (path.includes("/members/")) body = { roles: [ROLE] };
		else if (path.endsWith("/roles"))
			body = [
				{ id: GUILD, permissions: "0" },
				{ id: ROLE, permissions: (over.permission ?? ALL).toString() },
			];
		else if (path.startsWith("/channels/"))
			body = { id: path.split("/").at(-1), permission_overwrites: [] };
		else if (path === "/gateway/bot")
			body = { session_start_limit: { remaining: over.remaining ?? 10 } };
		else throw new Error("unexpected fixture GET");
		return new Response(
			JSON.stringify(over.modify ? over.modify(path, body) : body),
		);
	});
}
describe("per-Lead voice preflight", () => {
	it.each([BOT, "100000000000000099"])(
		"uses only exact Lead %s token for one identity, both permission sets and gateway quota",
		async (bot) => {
			const fetchImpl = discord({ bot });
			const value = input(bot, `token-${bot}`);
			const probeSelfFilter = vi.fn(async () => ({
				...(await probe()),
				botUserId: bot,
			}));
			const receipt = await preflightVoiceSession(value, {
				fetchImpl,
				probeSelfFilter,
			});
			expect(receipt).toMatchObject({
				identityVerified: true,
				voicePermissions: true,
				textPermissions: true,
				gatewayRemaining: 10,
				selfFilter: { botUserId: bot },
			});
			expect(
				fetchImpl.mock.calls.filter(([url]) =>
					String(url).endsWith("/users/@me"),
				),
			).toHaveLength(1);
			expect(fetchImpl).toHaveBeenCalledTimes(6);
			for (const [, init] of fetchImpl.mock.calls)
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					`Bot token-${bot}`,
				);
			expect(probeSelfFilter).toHaveBeenCalledWith({
				projectName: "flywheel",
				lead: value.lead,
				token: `token-${bot}`,
			});
		},
	);
	it("rejects a different bot before any permission or socket work", async () => {
		const fetchImpl = discord({ bot: "100000000000000099" });
		const probeSelfFilter = vi.fn();
		await expect(
			preflightVoiceSession(input(), { fetchImpl, probeSelfFilter }),
		).rejects.toMatchObject({
			status: 503,
			reason: "lead_bot_identity_mismatch",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(probeSelfFilter).not.toHaveBeenCalled();
	});
	it.each([P.VIEW_CHANNEL, P.CONNECT, P.SPEAK])(
		"rejects missing voice permission %s",
		async (permission) => {
			await expect(
				preflightVoiceSession(input(), {
					fetchImpl: discord({ permission: ALL & ~permission }),
					probeSelfFilter: probe,
				}),
			).rejects.toMatchObject({ reason: "voice_permissions" });
		},
	);
	it.each([
		P.READ_MESSAGE_HISTORY,
		P.SEND_MESSAGES,
		P.CREATE_PUBLIC_THREADS,
		P.SEND_MESSAGES_IN_THREADS,
	])("rejects missing text permission %s", async (permission) => {
		await expect(
			preflightVoiceSession(input(), {
				fetchImpl: discord({ permission: ALL & ~permission }),
				probeSelfFilter: probe,
			}),
		).rejects.toMatchObject({ reason: "lead_text_permissions" });
	});
	it.each([
		[ROOM, "voice_permissions", "voice_channel"],
		[TEXT, "lead_text_permissions", "text_channel"],
	])(
		"preserves unknown permission and HTTP stage for channel %s 403",
		async (channel403, reason, stage) => {
			await expect(
				preflightVoiceSession(input(), {
					fetchImpl: discord({ channel403 }),
					probeSelfFilter: probe,
				}),
			).rejects.toMatchObject({
				reason,
				stage,
				httpStatus: 403,
				evidence: {
					[channel403 === ROOM ? "voicePermissions" : "textPermissions"]: null,
				},
			});
		},
	);
	it("applies member overwrites after role denial", async () => {
		const fetchImpl = discord({
			modify: (path, body: any) =>
				path === `/channels/${ROOM}`
					? {
							...body,
							permission_overwrites: [
								{ id: ROLE, type: 0, allow: "0", deny: P.SPEAK.toString() },
								{ id: BOT, type: 1, allow: P.SPEAK.toString(), deny: "0" },
							],
						}
					: body,
		});
		await expect(
			preflightVoiceSession(input(), { fetchImpl, probeSelfFilter: probe }),
		).resolves.toMatchObject({ voicePermissions: true });
	});
	it("fails closed on missing live self-filter and unavailable gateway budget", async () => {
		await expect(
			preflightVoiceSession(input(), {
				fetchImpl: discord(),
				probeSelfFilter: async () => {
					throw new Error("missing socket");
				},
			}),
		).rejects.toMatchObject({ reason: "self_filter_unverified" });
		await expect(
			preflightVoiceSession(input(), {
				fetchImpl: discord({ remaining: 0 }),
				probeSelfFilter: probe,
			}),
		).rejects.toMatchObject({ reason: "gateway_session_limit" });
	});
	it("rejects malformed Discord payloads and bounds stalled requests", async () => {
		await expect(
			preflightVoiceSession(input(), {
				fetchImpl: discord({ modify: () => ({}) }),
				probeSelfFilter: probe,
			}),
		).rejects.toMatchObject({ reason: "discord_payload_invalid" });
		vi.useFakeTimers();
		const pending = preflightVoiceSession(input(), {
			fetchImpl: vi.fn(() => new Promise(() => {})),
			probeSelfFilter: probe,
		});
		const assertion = expect(pending).rejects.toMatchObject({
			reason: "discord_timeout",
			stage: "identity",
		});
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
	});
});
