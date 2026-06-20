import { describe, expect, it } from "vitest";
import {
	AliasResolutionError,
	type ChannelAliasConfig,
	parseExplicitAliases,
	resolveChannelAlias,
} from "../alias-allowlist.js";

const CHAT = "1500600400238084307";
const ROUNDTABLE = "1512578695468941333";
const OTHER = "1517226183341904032";

describe("resolveChannelAlias (FLY-350 fail-closed allowlist)", () => {
	const base: ChannelAliasConfig = {
		chatChannelId: CHAT,
		crossDeptChannelIds: [ROUNDTABLE],
	};

	it('resolves "chat" → chat channel id', () => {
		expect(resolveChannelAlias("chat", base)).toBe(CHAT);
	});

	it('resolves "roundtable" → the single cross-dept channel id', () => {
		expect(resolveChannelAlias("roundtable", base)).toBe(ROUNDTABLE);
	});

	it("trims surrounding whitespace on the alias", () => {
		expect(resolveChannelAlias("  roundtable  ", base)).toBe(ROUNDTABLE);
	});

	// R3#4: zero cross-dept channels → "roundtable" is unavailable, fail-closed.
	it('rejects "roundtable" when zero cross-dept channels are configured', () => {
		expect(() =>
			resolveChannelAlias("roundtable", {
				chatChannelId: CHAT,
				crossDeptChannelIds: [],
			}),
		).toThrow(AliasResolutionError);
	});

	// R3#4: multiple cross-dept channels → ambiguous, fail-closed.
	it('rejects "roundtable" when multiple cross-dept channels are configured (ambiguous)', () => {
		expect(() =>
			resolveChannelAlias("roundtable", {
				chatChannelId: CHAT,
				crossDeptChannelIds: [ROUNDTABLE, OTHER],
			}),
		).toThrow(/ambiguous/);
	});

	it("an explicit roundtable pin disambiguates a multi cross-dept list (pin ∈ list)", () => {
		expect(
			resolveChannelAlias("roundtable", {
				chatChannelId: CHAT,
				crossDeptChannelIds: [ROUNDTABLE, OTHER],
				explicitAliases: { roundtable: ROUNDTABLE },
			}),
		).toBe(ROUNDTABLE);
	});

	// R2 HIGH-1: an explicit pin can NEVER point outside the configured set.
	it("rejects a roundtable pin that is NOT one of the configured cross-dept channels", () => {
		expect(() =>
			resolveChannelAlias("roundtable", {
				chatChannelId: CHAT,
				crossDeptChannelIds: [ROUNDTABLE],
				explicitAliases: { roundtable: OTHER },
			}),
		).toThrow(/not one of the configured cross-department channels/);
	});

	it("rejects a chat pin that does not equal the configured chat channel", () => {
		expect(() =>
			resolveChannelAlias("chat", {
				...base,
				explicitAliases: { chat: OTHER },
			}),
		).toThrow(/cannot redirect "chat"/);
	});

	it("accepts a chat pin that equals the configured chat channel (no-op)", () => {
		expect(
			resolveChannelAlias("chat", { ...base, explicitAliases: { chat: CHAT } }),
		).toBe(CHAT);
	});

	// R2 HIGH-1: an explicit pin for an UNAPPROVED alias name must never widen the
	// surface — the approved-alias gate runs first.
	it("rejects an unapproved alias even if it has an explicit pin (dms:<id>)", () => {
		expect(() =>
			resolveChannelAlias("dms", {
				...base,
				explicitAliases: { dms: OTHER },
			}),
		).toThrow(/unknown target alias/);
	});

	it("rejects a raw channel id passed as the target (must be an alias)", () => {
		expect(() => resolveChannelAlias(ROUNDTABLE, base)).toThrow(
			/not a raw channel id/,
		);
	});

	it("rejects an unknown alias (fail-closed)", () => {
		expect(() => resolveChannelAlias("dms", base)).toThrow(/unknown target/);
	});

	it("rejects an empty alias", () => {
		expect(() => resolveChannelAlias("", base)).toThrow(/required/);
	});

	it("rejects an explicit roundtable pin that maps to an empty id (not in the configured set)", () => {
		expect(() =>
			resolveChannelAlias("roundtable", {
				...base,
				explicitAliases: { roundtable: "" },
			}),
		).toThrow(/not one of the configured cross-department channels/);
	});
});

describe("parseExplicitAliases", () => {
	it("parses a:1,b:2 into a map", () => {
		expect(parseExplicitAliases("roundtable:111,chat:222")).toEqual({
			roundtable: "111",
			chat: "222",
		});
	});

	it("returns empty map for undefined / empty", () => {
		expect(parseExplicitAliases(undefined)).toEqual({});
		expect(parseExplicitAliases("")).toEqual({});
	});

	it("skips malformed pairs without throwing", () => {
		expect(
			parseExplicitAliases("roundtable:111,garbage,:noname,nokey:"),
		).toEqual({ roundtable: "111" });
	});

	it("trims whitespace around names and ids", () => {
		expect(parseExplicitAliases("  roundtable : 111 ")).toEqual({
			roundtable: "111",
		});
	});
});
