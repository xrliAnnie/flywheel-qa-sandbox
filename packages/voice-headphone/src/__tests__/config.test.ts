import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHeadphoneConfig } from "../config.js";

function writeConfig(json: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "hp-config-"));
	const p = join(dir, "headphone.json");
	writeFileSync(p, JSON.stringify(json), "utf8");
	return p;
}

const VALID = {
	botTokenEnv: "HP_BOT_TOKEN",
	coreChannelId: "core-1",
	founderUserId: "annie-id",
	bridgeUrl: "http://localhost:9876",
	bridgeTokenEnv: "HP_BRIDGE_TOKEN",
};

const ENV = {
	HP_BOT_TOKEN: "bot-token-value",
	HP_BRIDGE_TOKEN: "bridge-token-value",
};

describe("loadHeadphoneConfig", () => {
	it("loads a full config, resolving tokens from env", () => {
		const cfg = loadHeadphoneConfig({
			configPath: writeConfig(VALID),
			env: { ...ENV },
		});
		expect(cfg.botToken).toBe("bot-token-value");
		expect(cfg.bridgeToken).toBe("bridge-token-value");
		expect(cfg.coreChannelId).toBe("core-1");
		expect(cfg.founderUserId).toBe("annie-id");
		expect(cfg.bridgeUrl).toBe("http://localhost:9876");
		// defaults
		expect(cfg.includeRoundtable).toBe(false);
		expect(cfg.stateFile.endsWith("headphone-state.json")).toBe(true);
	});

	it.each(["botTokenEnv", "coreChannelId", "founderUserId", "bridgeUrl"])(
		"fail-fast with guidance when required field %s is missing",
		(field) => {
			const bad: Record<string, unknown> = { ...VALID };
			delete bad[field];
			expect(() =>
				loadHeadphoneConfig({ configPath: writeConfig(bad), env: { ...ENV } }),
			).toThrow(new RegExp(field));
		},
	);

	it("fail-fast when the bot token env var is unset (daemon cannot run without its bot)", () => {
		const env = { ...ENV } as Record<string, string>;
		delete env.HP_BOT_TOKEN;
		expect(() =>
			loadHeadphoneConfig({ configPath: writeConfig(VALID), env }),
		).toThrow(/HP_BOT_TOKEN/);
	});

	it("voice approval requires bridgeTokenEnv", () => {
		const noBridgeToken: Record<string, unknown> = { ...VALID };
		delete noBridgeToken.bridgeTokenEnv;
		expect(() =>
			loadHeadphoneConfig({
				configPath: writeConfig(noBridgeToken),
				env: { ...ENV },
			}),
		).toThrow(/bridgeTokenEnv/);
	});

	it("ignores the retired voice-approval env and still requires bridgeTokenEnv", () => {
		const noBridgeToken: Record<string, unknown> = { ...VALID };
		delete noBridgeToken.bridgeTokenEnv;
		expect(() =>
			loadHeadphoneConfig({
				configPath: writeConfig(noBridgeToken),
				env: { ...ENV, FLYWHEEL_VOICE_APPROVAL: "0" },
			}),
		).toThrow(/bridgeTokenEnv/);
	});

	it("missing config file fail-fasts with setup guidance", () => {
		expect(() =>
			loadHeadphoneConfig({
				configPath: "/nonexistent/headphone.json",
				env: { ...ENV },
			}),
		).toThrow(/headphone\.json/);
	});

	it("accepts optional voices + phrases overrides and env overrides", () => {
		const cfg = loadHeadphoneConfig({
			configPath: writeConfig({
				...VALID,
				includeRoundtable: true,
				stateFile: "/tmp/custom-state.json",
				voices: { tadashi: { voiceId: "zh-CN-YunyangNeural" } },
				phrases: { skip: ["算了"] },
			}),
			env: { ...ENV, FLYWHEEL_HEADPHONE_INCLUDE_ROUNDTABLE: "0" },
		});
		expect(cfg.includeRoundtable).toBe(true);
		expect(cfg.stateFile).toBe("/tmp/custom-state.json");
		expect(cfg.voices?.tadashi?.voiceId).toBe("zh-CN-YunyangNeural");
		expect(cfg.phrases?.skip).toEqual(["算了"]);
	});

	it("malformed voices entry fail-fasts (same grammar as leads[].voice)", () => {
		expect(() =>
			loadHeadphoneConfig({
				configPath: writeConfig({
					...VALID,
					voices: { tadashi: { voiceId: "v", rate: "10%" } },
				}),
				env: { ...ENV },
			}),
		).toThrow(/rate/);
	});
});
