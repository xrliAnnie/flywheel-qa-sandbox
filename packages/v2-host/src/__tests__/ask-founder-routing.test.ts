import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../cli.js";
import { shouldRelayAskToFounder } from "../host.js";

const BASE_CONFIG = {
	v: 1,
	dispatch_interval_ms: 1000,
	lock_root: "/tmp/locks",
	launcher: {
		kind: "tmux",
		tmux_bin: "/usr/bin/tmux",
		claude_bin: "/usr/local/bin/claude",
		codex_bin: "/usr/local/bin/codex",
		client_cli: "/tmp/cli.js",
		release_root: "/tmp/release",
		state_root: "/tmp/state",
	},
	git_bin: "/usr/bin/git",
	gh_bin: "/usr/bin/gh",
};

// FLY-1547 (founder directive 2026-07-30): founder-facing push is default OFF;
// ask/blocked never leave the lead mailbox; only progress may relay, and only
// behind the explicit opt-in.
describe("shouldRelayAskToFounder", () => {
	it("relays nothing while the switch is off", () => {
		expect(shouldRelayAskToFounder("progress", false)).toBe(false);
		expect(shouldRelayAskToFounder("ask", false)).toBe(false);
		expect(shouldRelayAskToFounder("blocked", false)).toBe(false);
	});

	it("relays only progress when the switch is on", () => {
		expect(shouldRelayAskToFounder("progress", true)).toBe(true);
		expect(shouldRelayAskToFounder("ask", true)).toBe(false);
		expect(shouldRelayAskToFounder("blocked", true)).toBe(false);
	});
});

describe("runtime config founder_push", () => {
	it("defaults to off when the key is absent", () => {
		expect(parseRuntimeConfig(BASE_CONFIG).founderPush).toBe(false);
	});

	it("accepts an explicit boolean", () => {
		expect(
			parseRuntimeConfig({ ...BASE_CONFIG, founder_push: true }).founderPush,
		).toBe(true);
		expect(
			parseRuntimeConfig({ ...BASE_CONFIG, founder_push: false }).founderPush,
		).toBe(false);
	});

	it("refuses a non-boolean founder_push", () => {
		expect(() =>
			parseRuntimeConfig({ ...BASE_CONFIG, founder_push: "yes" }),
		).toThrow(/founder_push must be a boolean/);
	});

	it("accepts an optional launcher mailbox_mcp path (FLY-1547)", () => {
		const withMailbox = {
			...BASE_CONFIG,
			launcher: { ...BASE_CONFIG.launcher, mailbox_mcp: "/opt/mailbox.js" },
		};
		expect(parseRuntimeConfig(withMailbox).launcher).toMatchObject({
			mailboxMcpPath: "/opt/mailbox.js",
		});
		expect(parseRuntimeConfig(BASE_CONFIG).launcher).not.toHaveProperty(
			"mailboxMcpPath",
		);
		expect(() =>
			parseRuntimeConfig({
				...BASE_CONFIG,
				launcher: { ...BASE_CONFIG.launcher, mailbox_mcp: "relative.js" },
			}),
		).toThrow(/mailbox_mcp/);
	});

	it("still refuses unknown keys", () => {
		expect(() =>
			parseRuntimeConfig({ ...BASE_CONFIG, founder_pushh: true }),
		).toThrow(/invalid shape/);
	});
});
