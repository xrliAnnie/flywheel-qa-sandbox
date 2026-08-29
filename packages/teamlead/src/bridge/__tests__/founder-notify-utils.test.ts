import { describe, expect, it } from "vitest";
import {
	isDiscordSnowflake,
	parseSqliteUtcMs,
	truncate,
} from "../founder-notify-utils.js";

describe("FLY-605 founder-notify-utils", () => {
	describe("parseSqliteUtcMs (Codex R1 #5)", () => {
		it("parses a SQLite UTC string (YYYY-MM-DD HH:MM:SS)", () => {
			expect(parseSqliteUtcMs("2026-06-26 19:00:00")).toBe(
				Date.parse("2026-06-26T19:00:00Z"),
			);
		});
		it("does NOT double-append Z to an ISO string already containing T/Z", () => {
			const iso = "2026-06-26T19:00:00Z";
			expect(parseSqliteUtcMs(iso)).toBe(Date.parse(iso));
		});
		it("returns null for empty / garbage / nullish", () => {
			expect(parseSqliteUtcMs("")).toBeNull();
			expect(parseSqliteUtcMs("not a date")).toBeNull();
			expect(parseSqliteUtcMs(null)).toBeNull();
			expect(parseSqliteUtcMs(undefined)).toBeNull();
		});
	});

	describe("isDiscordSnowflake (Codex R2 #4)", () => {
		it("accepts a 17-20 digit decimal id", () => {
			expect(isDiscordSnowflake("123456789012345678")).toBe(true);
			expect(isDiscordSnowflake("12345678901234567")).toBe(true); // 17
		});
		it("rejects malformed ids", () => {
			expect(isDiscordSnowflake("not-a-snowflake")).toBe(false);
			expect(isDiscordSnowflake("123")).toBe(false); // too short
			expect(isDiscordSnowflake("123456789012345678901")).toBe(false); // 21
			expect(isDiscordSnowflake("")).toBe(false);
			expect(isDiscordSnowflake(undefined)).toBe(false);
			expect(isDiscordSnowflake(null)).toBe(false);
		});
	});

	describe("truncate", () => {
		it("leaves short text intact", () => {
			expect(truncate("hello", 10)).toBe("hello");
		});
		it("cuts and appends an ellipsis when over the limit", () => {
			expect(truncate("hello world", 5)).toBe("hell…");
		});
	});
});
