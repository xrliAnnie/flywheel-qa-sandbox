import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expandTilde, loadRoundtableConfig } from "../roundtable-config.js";

const REQUIRED = {
	FLYWHEEL_ROUNDTABLE_ENABLED: "1",
	FLYWHEEL_ROUNDTABLE_CHANNEL_ID: "chan-1",
	FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV: "CASS_BOT_TOKEN",
	CASS_BOT_TOKEN: "tok-abc",
	FLYWHEEL_ROUNDTABLE_BOT_USER_ID: "bot-9",
};

describe("expandTilde", () => {
	it("expands ~ and ~/...", () => {
		expect(expandTilde("~")).toBe(homedir());
		expect(expandTilde("~/.flywheel/x.json")).toBe(
			join(homedir(), ".flywheel/x.json"),
		);
		expect(expandTilde("/abs/path")).toBe("/abs/path");
		expect(expandTilde("rel/path")).toBe("rel/path");
	});
});

describe("loadRoundtableConfig", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("returns undefined when not enabled (byte-compat)", () => {
		expect(loadRoundtableConfig({})).toBeUndefined();
		expect(
			loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_ENABLED: "0" }),
		).toBeUndefined();
		expect(
			loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_ENABLED: "true" }),
		).toBeUndefined();
	});

	it("throws when enabled but channel id missing", () => {
		const env = { ...REQUIRED } as Record<string, string | undefined>;
		env.FLYWHEEL_ROUNDTABLE_CHANNEL_ID = "";
		expect(() => loadRoundtableConfig(env)).toThrow(
			/FLYWHEEL_ROUNDTABLE_CHANNEL_ID/,
		);
	});

	it("throws when bot token env name missing", () => {
		const env = { ...REQUIRED } as Record<string, string | undefined>;
		env.FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV = "";
		expect(() => loadRoundtableConfig(env)).toThrow(
			/FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV/,
		);
	});

	it("throws when bot token env name set but value empty", () => {
		const env = { ...REQUIRED } as Record<string, string | undefined>;
		env.CASS_BOT_TOKEN = "";
		expect(() => loadRoundtableConfig(env)).toThrow(/resolved token value/);
	});

	it("throws when bot user id missing", () => {
		const env = { ...REQUIRED } as Record<string, string | undefined>;
		env.FLYWHEEL_ROUNDTABLE_BOT_USER_ID = "";
		expect(() => loadRoundtableConfig(env)).toThrow(
			/FLYWHEEL_ROUNDTABLE_BOT_USER_ID/,
		);
	});

	it("resolves required + defaults", () => {
		const cfg = loadRoundtableConfig({ ...REQUIRED });
		expect(cfg).toBeDefined();
		expect(cfg?.channelId).toBe("chan-1");
		expect(cfg?.botToken).toBe("tok-abc");
		expect(cfg?.botUserId).toBe("bot-9");
		expect(cfg?.triggerMode).toBe("disabled");
		expect(cfg?.trigger.prefixes).toEqual(["📋", "TOPIC:"]);
		expect(cfg?.trigger.minMentions).toBe(2);
		expect(cfg?.memberUserIds).toEqual([]);
		expect(cfg?.threadOwnBotMessages).toBe(false);
		expect(cfg?.pollIntervalMs).toBe(3000);
		expect(cfg?.cursorPath).toBe(
			join(homedir(), ".flywheel/roundtable-inbound-cursor.json"),
		);
	});

	it("parses overrides + expands cursor path", () => {
		const cfg = loadRoundtableConfig({
			...REQUIRED,
			FLYWHEEL_ROUNDTABLE_TRIGGER_MODE: "broadcast",
			FLYWHEEL_ROUNDTABLE_TRIGGER_PREFIXES: "A:, B:",
			FLYWHEEL_ROUNDTABLE_MIN_MENTIONS: "3",
			FLYWHEEL_ROUNDTABLE_LEAD_USER_IDS: "l1, l2",
			FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS: "m1,m2 , m3",
			FLYWHEEL_ROUNDTABLE_POLL_INTERVAL_MS: "5000",
			FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH: "~/cursors/rt.json",
			FLYWHEEL_ROUNDTABLE_THREAD_OWN_BOT: "1",
		});
		expect(cfg?.triggerMode).toBe("broadcast");
		expect(cfg?.threadOwnBotMessages).toBe(true);
		expect(cfg?.trigger.prefixes).toEqual(["A:", "B:"]);
		expect(cfg?.trigger.minMentions).toBe(3);
		expect(cfg?.trigger.leadUserIds).toEqual(["l1", "l2"]);
		expect(cfg?.memberUserIds).toEqual(["m1", "m2", "m3"]);
		expect(cfg?.pollIntervalMs).toBe(5000);
		expect(cfg?.cursorPath).toBe(join(homedir(), "cursors/rt.json"));
	});

	it("degrades an unknown trigger mode to disabled (warns, no throw)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cfg = loadRoundtableConfig({
			...REQUIRED,
			FLYWHEEL_ROUNDTABLE_TRIGGER_MODE: "bogus",
		});
		expect(cfg?.triggerMode).toBe("disabled");
		expect(warn).toHaveBeenCalled();
	});
});
