import { describe, expect, it } from "vitest";
import {
	deriveRoundtableThreadName,
	isTopicNoise,
	ROUNDTABLE_PLACEHOLDER_NAME,
	ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES,
} from "../roundtable-text.js";

describe("ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES (FLY-802)", () => {
	it("is 60 minutes — Discord's shortest auto_archive_duration", () => {
		// 1h so topic threads collapse out of the sidebar instead of piling up.
		expect(ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES).toBe(60);
	});
});

describe("deriveRoundtableThreadName (FLY-314 shared naming)", () => {
	it("uses the first line / topic text, stripping mention + emoji markup", () => {
		expect(
			deriveRoundtableThreadName("<@123> Flywheel restarted — check runners"),
		).toBe("Flywheel restarted — check runners");
	});

	it("strips custom emoji, role + channel mentions, collapses whitespace", () => {
		expect(
			deriveRoundtableThreadName(
				"<a:tada:1>  <@&99> ping   <#42>  deploy plan",
			),
		).toBe("ping deploy plan");
	});

	it("falls back to the placeholder ONLY when there is no usable text", () => {
		expect(deriveRoundtableThreadName("<@1> <#2>")).toBe(
			ROUNDTABLE_PLACEHOLDER_NAME,
		);
		expect(deriveRoundtableThreadName("   ")).toBe(ROUNDTABLE_PLACEHOLDER_NAME);
	});

	it("caps the name length", () => {
		const long = "x".repeat(200);
		expect(deriveRoundtableThreadName(long).length).toBeLessThanOrEqual(100);
	});

	it("keeps Chinese topic text", () => {
		expect(deriveRoundtableThreadName("<@1> 重启了，大家检查 runner")).toBe(
			"重启了，大家检查 runner",
		);
	});
});

describe("isTopicNoise (FLY-314 Unicode-aware noise gate, Codex R1 MEDIUM#4)", () => {
	it("treats a single Unicode emoji as noise", () => {
		expect(isTopicNoise("👍")).toBe(true);
	});

	it("treats MULTIPLE Unicode emoji as noise (the case a length rule misses)", () => {
		expect(isTopicNoise("👍👍")).toBe(true);
		expect(isTopicNoise("🎉🎉🎉")).toBe(true);
	});

	it("treats custom-emoji-only / mention-only / whitespace as noise", () => {
		expect(isTopicNoise("<:tada:12345>")).toBe(true);
		expect(isTopicNoise("<@123>")).toBe(true);
		expect(isTopicNoise("   ")).toBe(true);
		expect(isTopicNoise("")).toBe(true);
	});

	it("treats 1-2 char acknowledgements as noise", () => {
		expect(isTopicNoise("k")).toBe(true);
		expect(isTopicNoise("ok")).toBe(true);
	});

	it("does NOT treat a real English topic as noise", () => {
		expect(isTopicNoise("Flywheel restarted — check runners")).toBe(false);
	});

	it("does NOT treat a real Chinese topic as noise", () => {
		expect(isTopicNoise("重启了")).toBe(false);
	});

	it("does NOT treat a topic that also contains an emoji as noise", () => {
		expect(isTopicNoise("deploy plan 🚀")).toBe(false);
	});
});
