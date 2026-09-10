import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { DISCORD_PERMISSIONS } from "../channel-permissions.js";
import { preflightVoiceSession } from "../voice-session-preflight.js";
import type { VoiceStartPreflightInput } from "../voice-session-start.js";

const GUILD = "100000000000000001";
const VOICE_CHANNEL = "100000000000000002";
const VOICE_BOT = "100000000000000003";
const CHAT_CHANNEL = "100000000000000004";
const LEAD_BOT = "100000000000000005";
const ROLE = "100000000000000006";
const cleanup: string[] = [];

afterEach(() => {
	for (const root of cleanup.splice(0)) rmSync(root, { recursive: true });
});

function bits(...values: bigint[]): string {
	return values.reduce((all, value) => all | value, 0n).toString();
}

function input(backend: "claude-code" | "codex-app-server" = "claude-code") {
	const stateDir = mkdtempSync(join(tmpdir(), "flywheel-voice-access-"));
	cleanup.push(stateDir);
	writeFileSync(
		join(stateDir, "access.json"),
		JSON.stringify({ allowBots: [] }),
	);
	const project: ProjectEntry = {
		projectName: "flywheel",
		projectRoot: "/repo/flywheel",
		huddle: {
			guildId: GUILD,
			voiceChannelId: VOICE_CHANNEL,
			orchestratorBotTokenEnv: "VOICE_TOKEN",
			orchestratorBotUserId: VOICE_BOT,
			earsBotTokenEnv: "EARS_TOKEN",
		},
		leads: [
			{
				agentId: "lead-a",
				summaryRole: "producer",
				chatChannel: CHAT_CHANNEL,
				botUserId: LEAD_BOT,
				botToken: "lead-token",
				discordStateDir: stateDir,
				backend,
				match: { labels: ["engineering"] },
			},
		],
	};
	return {
		stateDir,
		value: {
			mode: "meeting",
			project,
			lead: project.leads[0]!,
			voiceHost: {
				schemaVersion: 1,
				qaVoiceChannelIds: [],
				qaAllowUserIds: [],
				evidenceRoots: ["/repo"],
			},
			voiceBotToken: "voice-token",
			earsBotToken: "ears-token",
		} satisfies VoiceStartPreflightInput,
	};
}

function discordFetch(
	overrides: {
		voiceBotId?: string;
		leadBotId?: string;
		voiceBits?: string;
		textBits?: string;
	} = {},
) {
	const voiceBits =
		overrides.voiceBits ??
		bits(
			DISCORD_PERMISSIONS.VIEW_CHANNEL,
			DISCORD_PERMISSIONS.CONNECT,
			DISCORD_PERMISSIONS.SPEAK,
		);
	const textBits =
		overrides.textBits ??
		bits(
			DISCORD_PERMISSIONS.VIEW_CHANNEL,
			DISCORD_PERMISSIONS.READ_MESSAGE_HISTORY,
			DISCORD_PERMISSIONS.SEND_MESSAGES,
			DISCORD_PERMISSIONS.SEND_MESSAGES_IN_THREADS,
			DISCORD_PERMISSIONS.CREATE_PUBLIC_THREADS,
		);
	return vi.fn<typeof fetch>(async (request, init) => {
		const url = String(request);
		const auth = new Headers(init?.headers).get("Authorization");
		const botId =
			auth === "Bot voice-token"
				? (overrides.voiceBotId ?? VOICE_BOT)
				: (overrides.leadBotId ?? LEAD_BOT);
		let body: unknown;
		if (url.endsWith("/users/@me")) body = { id: botId };
		else if (url.includes(`/guilds/${GUILD}/members/`))
			body = { roles: [ROLE] };
		else if (url.endsWith(`/guilds/${GUILD}/roles`)) {
			body = [
				{ id: GUILD, permissions: "0" },
				{ id: ROLE, permissions: bits(BigInt(voiceBits), BigInt(textBits)) },
			];
		} else if (url.endsWith(`/channels/${VOICE_CHANNEL}`)) {
			body = { id: VOICE_CHANNEL, permission_overwrites: [] };
		} else if (url.endsWith(`/channels/${CHAT_CHANNEL}`)) {
			body = { id: CHAT_CHANNEL, permission_overwrites: [] };
		} else return new Response("not found", { status: 404 });
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
}

describe("voice session preflight", () => {
	it("proves both bot identities and the required voice/text permissions", async () => {
		const { value } = input();
		const fetchImpl = discordFetch();
		await expect(
			preflightVoiceSession(value, { fetchImpl }),
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(7);
	});

	it("fails on bot identity mismatch before provisioning", async () => {
		const { value } = input();
		await expect(
			preflightVoiceSession(value, {
				fetchImpl: discordFetch({ voiceBotId: "100000000000000099" }),
			}),
		).rejects.toMatchObject({
			status: 503,
			reason: "voice_bot_identity_mismatch",
		});
	});

	it("fails when the voice bot lacks SPEAK", async () => {
		const { value } = input();
		await expect(
			preflightVoiceSession(value, {
				fetchImpl: discordFetch({
					voiceBits: bits(
						DISCORD_PERMISSIONS.VIEW_CHANNEL,
						DISCORD_PERMISSIONS.CONNECT,
					),
				}),
			}),
		).rejects.toMatchObject({ status: 503, reason: "voice_permissions" });
	});

	it("rejects a Claude picker that would consume voice-bot mirrors", async () => {
		const { value, stateDir } = input();
		writeFileSync(
			join(stateDir, "access.json"),
			JSON.stringify({ allowBots: [VOICE_BOT] }),
		);
		await expect(
			preflightVoiceSession(value, { fetchImpl: discordFetch() }),
		).rejects.toMatchObject({ status: 503, reason: "native_pickup_mirror" });
	});

	it("rejects a Codex Lead whose live capabilities do not prove mirror exclusion", async () => {
		const { value, stateDir } = input("codex-app-server");
		writeFileSync(
			join(stateDir, "access.json"),
			JSON.stringify({ allowBots: [VOICE_BOT] }),
		);
		await expect(
			preflightVoiceSession(value, {
				fetchImpl: discordFetch(),
				probeCapabilities: async () => ({
					protocolVersions: [1, 2],
					features: ["discord_route_v2"],
					socketOwnerId: "old-process",
				}),
			}),
		).rejects.toMatchObject({ status: 503, reason: "native_pickup_mirror" });
	});

	it("accepts only the active authenticated Codex process's mirror exclusion", async () => {
		const { value } = input("codex-app-server");
		const probeCapabilities = vi.fn(async () => ({
			protocolVersions: [1, 2] as [1, 2],
			features: ["discord_route_v2"] as ["discord_route_v2"],
			socketOwnerId: "running-process",
			voiceMirrorIgnoredAuthorIds: [VOICE_BOT],
		}));
		await expect(
			preflightVoiceSession(value, {
				fetchImpl: discordFetch(),
				probeCapabilities,
			}),
		).resolves.toBeUndefined();
		expect(probeCapabilities).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "lead-a",
				authSecret: "lead-token",
				timeoutMs: 2_000,
			}),
		);
	});

	it("rejects an absent or unreachable Codex picker", async () => {
		const { value } = input("codex-app-server");
		await expect(
			preflightVoiceSession(value, {
				fetchImpl: discordFetch(),
				probeCapabilities: async () => {
					throw new Error("socket unavailable");
				},
			}),
		).rejects.toMatchObject({ status: 503, reason: "native_pickup_config" });
	});
});
