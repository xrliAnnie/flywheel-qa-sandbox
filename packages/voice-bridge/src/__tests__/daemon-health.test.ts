/**
 * FLY-545 P6 — /health schema contract (Codex R1 HIGH).
 *
 * scripts/lib/bridge-port.sh classifies health JSON WITHOUT a `shuttingDown`
 * field as "legacy" and RECLAIMS (kills) the instance — so the voice-bridge
 * /health must carry `ok` + `shuttingDown` exactly like the Bridge's, or
 * every duplicate launchd start would kill a healthy daemon.
 */
import { describe, expect, it } from "vitest";
import type { DiscordDeps } from "../bots/discordWiring.js";
import { runVoiceBridge } from "../cli.js";
import type { HuddleBridgeConfig } from "../config.js";

function fakeDeps(): DiscordDeps {
	return {
		createClient: () => ({
			login: async () => "ok",
			isReady: () => true,
			once: () => {},
			destroy: () => {},
		}),
		joinVoice: async () => ({}),
		subscribeManual: () => () => {
			throw new Error("not used");
		},
		createDecoder: () => {
			throw new Error("not used");
		},
		createPlayer: () => {
			throw new Error("not used");
		},
		createResource: () => ({}),
		speakingEvents: () => ({ on: () => {} }),
		isHumanFactory: () => () => false,
	};
}

function config(port: number): HuddleBridgeConfig {
	return {
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		guildId: "g",
		voiceChannelId: "vc",
		commandName: "meet",
		moveMembers: true,
		orchestratorToken: "tok-orch",
		earsToken: "tok-ears",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				botTokenEnv: "X",
				botToken: "tok-lead",
			},
		],
		backchannelMs: 350,
		allowUserIds: [],
		healthPort: port,
		ffmpegBin: "ffmpeg",
	};
}

const okProbe = async () => ({ ok: true, detail: "fake ffmpeg" });

describe("voice-bridge daemon /health", () => {
	it("serves ok:true + shuttingDown:false (bridge-port.sh 'healthy' shape)", async () => {
		const port = 21000 + Math.floor(Math.random() * 20000);
		const runtime = await runVoiceBridge({
			config: config(port),
			deps: fakeDeps(),
			probe: okProbe,
			log: () => {},
		});
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.ok).toBe(true);
			expect(body.shuttingDown).toBe(false); // absent field = "legacy" = reclaimed
			expect(body.bots).toEqual([
				"orchestrator",
				"note-taker",
				"flywheel-eng-lead",
			]);
			expect(body.earsJoined).toBe(true);
			// FLY-1159 Codex R3: the advanced command name is part of the health
			// contract — mode off must serialize an explicit null, not omit it.
			expect(body.assistantAdvanced).toBeNull();
		} finally {
			await runtime.close();
		}
		await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
	});

	it("fails fast when the ffmpeg probe fails (before any VC join)", async () => {
		const port = 21000 + Math.floor(Math.random() * 20000);
		await expect(
			runVoiceBridge({
				config: config(port),
				deps: fakeDeps(),
				probe: async () => ({ ok: false, detail: "not found" }),
				log: () => {},
			}),
		).rejects.toThrow(/ffmpeg/);
	});
});
