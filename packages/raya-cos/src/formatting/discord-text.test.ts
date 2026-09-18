import { describe, expect, it } from "vitest";
import { chunkDiscordText, sanitizeDiscordText } from "./discord-text.js";

describe("Discord text safety", () => {
	it("scrubs credentials and neutralizes Discord mentions without truncating", () => {
		const secret = `sk-${"a".repeat(24)}`;
		const longText = `${secret} @everyone <@123456789012345678> ${"界".repeat(2_000)}`;
		const clean = sanitizeDiscordText(longText);

		expect(clean).not.toContain(secret);
		expect(clean).toContain("[redacted]");
		expect(clean).toContain("@\u200beveryone");
		expect(clean).toContain("<@\u200b123456789012345678>");
		expect(Array.from(clean).length).toBeGreaterThan(2_000);
	});

	it("chunks by Unicode code point and prefers a newline boundary", () => {
		const chunks = chunkDiscordText(
			`${"界".repeat(1_895)}\n${"🙂".repeat(20)}`,
		);

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBe("界".repeat(1_895));
		expect(chunks.join("")).toBe(`${"界".repeat(1_895)}${"🙂".repeat(20)}`);
		expect(chunks.every((chunk) => Array.from(chunk).length <= 1_900)).toBe(
			true,
		);
		expect(chunkDiscordText("界".repeat(1_900))).toEqual(["界".repeat(1_900)]);
	});
});
