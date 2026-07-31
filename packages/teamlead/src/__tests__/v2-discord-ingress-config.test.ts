import { describe, expect, it } from "vitest";
import { readV2DiscordIngressConfig } from "../v2-discord-ingress.js";

function baseEnv(
	over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	return {
		FLYWHEEL_V2_HOST_SOCKET: "/tmp/v2/host.sock",
		FLYWHEEL_V2_HOST_SECRET: "/tmp/v2/host.secret",
		FLYWHEEL_V2_LEAD_ID: "lead-1",
		FLYWHEEL_LEAD_BOT_TOKEN: "token",
		FLYWHEEL_LEAD_BOT_USER_ID: "bot-1",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chan-1",
		FLYWHEEL_V2_INBOUND_CURSOR: "/tmp/v2/cursor.json",
		FLYWHEEL_V2_HOST_EPOCH: "epoch-1",
		FLYWHEEL_V2_SESSION_PROOF_ROOT: "/tmp/v2/proofs",
		FLYWHEEL_V2_OUTBOUND_STATE: "/tmp/v2/outbound.json",
		...over,
	};
}

describe("FLY-1549 — v2 ingress display config validation", () => {
	it("defaults: display on, no db path, 180s sweep", () => {
		const config = readV2DiscordIngressConfig(baseEnv());
		expect(config.issueDisplayEnabled).toBe(true);
		expect(config.kernelDbPath).toBeUndefined();
		expect(config.displaySweepMs).toBe(180_000);
	});

	it("accepts an absolute kernel db path and canonical sweep values", () => {
		const config = readV2DiscordIngressConfig(
			baseEnv({
				FLYWHEEL_V2_DB_PATH: "/Users/x/.flywheel/flywheel-v2.db",
				FLYWHEEL_V2_DISPLAY_SWEEP_MS: "0",
			}),
		);
		expect(config.kernelDbPath).toBe("/Users/x/.flywheel/flywheel-v2.db");
		expect(config.displaySweepMs).toBe(0);
	});

	it("rejects a RELATIVE kernel db path — cwd-resolved authority paths can read a different valid db (Codex code R1 #3)", () => {
		expect(() =>
			readV2DiscordIngressConfig(
				baseEnv({ FLYWHEEL_V2_DB_PATH: "flywheel-v2.db" }),
			),
		).toThrow(/FLYWHEEL_V2_DB_PATH must be absolute/);
	});

	it("rejects non-canonical sweep cadence values (Codex code R1 #4)", () => {
		for (const bad of ["not-a-number", "1junk", "-5", "1.5"]) {
			expect(() =>
				readV2DiscordIngressConfig(
					baseEnv({ FLYWHEEL_V2_DISPLAY_SWEEP_MS: bad }),
				),
			).toThrow(/FLYWHEEL_V2_DISPLAY_SWEEP_MS/);
		}
	});

	it("FLYWHEEL_V2_ISSUE_DISPLAY=0 turns the display off", () => {
		const config = readV2DiscordIngressConfig(
			baseEnv({ FLYWHEEL_V2_ISSUE_DISPLAY: "0" }),
		);
		expect(config.issueDisplayEnabled).toBe(false);
	});
});
