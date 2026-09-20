import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discordThreadLinkPair } from "../discord-link.js";

describe("canonical Discord thread links", () => {
	it("reuses the FLY-2639 app and web pair shape", () => {
		expect(discordThreadLinkPair("123", "456")).toEqual({
			app: "discord://-/channels/123/456",
			web: "https://discord.com/channels/123/456",
		});
	});

	it.each([
		["0", "456"],
		["123", "0"],
		["123/evil", "456"],
		["123", "456?evil"],
	])("rejects malformed guild/thread ids %s/%s", (guild, thread) => {
		expect(discordThreadLinkPair(guild, thread)).toBeNull();
	});

	it.each([
		"attention-sources.ts",
		"attention.ts",
		"attention-presentation.ts",
	])("routes %s through the shared canonical helper", (file) => {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		expect(source).toContain("discordThreadLinkPair(");
		expect(source).not.toMatch(/`https:\/\/discord\.com\/channels\/\$\{/);
	});
});
