import { describe, expect, it } from "vitest";
import { readV2DiscordIngressConfig } from "../../../v2-discord-ingress.js";

describe("v2-only Discord ingress config", () => {
	it("requires isolated runtime paths and never accepts a legacy queue path", () => {
		const config = readV2DiscordIngressConfig({
			FLYWHEEL_V2_CLI_BIN: "/opt/flywheel-v2",
			FLYWHEEL_V2_HOST_SOCKET: "/tmp/v2/host.sock",
			FLYWHEEL_V2_HOST_SECRET: "/tmp/v2/host.secret",
			FLYWHEEL_V2_LEAD_ID: "tadashi",
			FLYWHEEL_LEAD_BOT_TOKEN: "token",
			FLYWHEEL_LEAD_BOT_USER_ID: "bot",
			FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chat",
			FLYWHEEL_LEAD_CORE_CHANNEL_ID: "core",
			FLYWHEEL_V2_INBOUND_CURSOR: "/tmp/v2/discord-cursor.json",
			FLYWHEEL_V2_HOST_EPOCH: "epoch-test",
			FLYWHEEL_V2_SESSION_PROOF_ROOT: "/tmp/v2/session-proofs",
			FLYWHEEL_V2_OUTBOUND_STATE: "/tmp/v2/outbound-state.json",
			FLYWHEEL_COMM_DIR: "/tmp/legacy-comm",
		});

		expect(config).toMatchObject({
			socketPath: "/tmp/v2/host.sock",
			secretPath: "/tmp/v2/host.secret",
			channelIds: ["chat", "core"],
			cursorPath: "/tmp/v2/discord-cursor.json",
			hostEpoch: "epoch-test",
			sessionProofRoot: "/tmp/v2/session-proofs",
			outboundStatePath: "/tmp/v2/outbound-state.json",
		});
		expect(Object.keys(config)).not.toContain("commDbPath");
	});

	it("rejects relative authority-bearing paths", () => {
		expect(() =>
			readV2DiscordIngressConfig({
				FLYWHEEL_V2_HOST_SOCKET: "host.sock",
				FLYWHEEL_V2_HOST_SECRET: "/tmp/v2/host.secret",
				FLYWHEEL_V2_LEAD_ID: "tadashi",
				FLYWHEEL_LEAD_BOT_TOKEN: "token",
				FLYWHEEL_LEAD_BOT_USER_ID: "bot",
				FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chat",
				FLYWHEEL_V2_INBOUND_CURSOR: "/tmp/v2/cursor.json",
			}),
		).toThrow(/must be absolute/);
	});
});
