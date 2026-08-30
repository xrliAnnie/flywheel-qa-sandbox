import { describe, expect, it } from "vitest";
import { runVoiceBridge } from "../cli.js";
import type { HuddleBridgeConfig } from "../config.js";

const CONFIG: HuddleBridgeConfig = {
	projectName: "flywheel",
	projectRoot: "/tmp/flywheel",
	guildId: "guild-1",
	voiceChannelId: "vc-1",
	commandName: "meet",
	moveMembers: true,
	orchestratorToken: "orch-token",
	earsToken: "ears-token",
	leads: [],
	backchannelMs: 350,
	bargeInMinRms: 0,
	bargeInHoldoffMs: 1000,
	allowUserIds: [],
	healthPort: 0,
	ffmpegBin: "ffmpeg",
	bridgeUrl: "http://127.0.0.1:1",
	apiToken: "bridge-token",
	founderUserId: "founder-1",
	geminiApiKey: "gemini-key",
	geminiModel: "gemini-live-test",
	claudeBin: "claude",
	brainTimeoutMs: 1000,
};

describe("retired assistant.advanced Bridge boundary", () => {
	it("rejects hand-constructed advanced mode before using injected dependencies", async () => {
		await expect(
			runVoiceBridge({
				config: CONFIG,
				assistant: {
					commandName: "gemini",
					assistantToken: null,
					briefing: {
						refreshSec: 600,
						maxAgeSec: 1800,
						charBudget: 8000,
						docs: [],
					},
					localBargeIn: false,
					advanced: { leadId: "qa-lead" },
				},
				deps: {} as never,
			}),
		).rejects.toThrow(/advanced.*retired.*remove/i);
	});
});
