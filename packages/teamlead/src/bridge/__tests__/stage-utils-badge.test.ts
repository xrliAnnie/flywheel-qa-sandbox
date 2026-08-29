import { describe, expect, it } from "vitest";
import {
	splitStatusEmoji,
	stageBadge,
	stripStatusEmojiPrefix,
} from "../stage-utils.js";

/**
 * FLY-795 c6 (Annie badge correction, Lead-confirmed scope): pr_created becomes
 * 📬PR已开 (PR opened, awaiting review), split from `approve` which keeps ⏳待批
 * (awaiting founder ship approval). `test` STAYS 🧪QA (auto-QA stamps stage=test
 * for the real independent QA). Reverse-compat: old ⏳待批 titles still strip.
 */
describe("stage-utils badges (FLY-795 pr_created split)", () => {
	it("pr_created renders 📬PR已开; approve keeps ⏳待批", () => {
		expect(stageBadge("pr_created", true)).toBe("📬PR已开");
		expect(stageBadge("approve", true)).toBe("⏳待批");
	});

	it("test stays 🧪QA (real independent QA)", () => {
		expect(stageBadge("test", true)).toBe("🧪QA");
	});

	it("strips the NEW 📬PR已开 prefix off a thread title", () => {
		expect(stripStatusEmojiPrefix("📬PR已开 FLY-795 restart-resilient")).toBe(
			"FLY-795 restart-resilient",
		);
		const s = splitStatusEmoji("📬PR已开 FLY-795 x");
		expect(s.emoji).toBe("📬");
		expect(s.word).toBe("PR已开");
	});

	it("reverse-compat: the OLD ⏳待批 prefix (pre-change pr_created titles) still strips (via approve)", () => {
		expect(stripStatusEmojiPrefix("⏳待批 FLY-700 old title")).toBe(
			"FLY-700 old title",
		);
		expect(splitStatusEmoji("⏳待批 FLY-700 x").word).toBe("待批");
	});

	it("emoji-only prefixes (📬 / ⏳ / 🧪) still peel", () => {
		expect(stripStatusEmojiPrefix("📬 FLY-1 x")).toBe("FLY-1 x");
		expect(stripStatusEmojiPrefix("⏳ FLY-1 x")).toBe("FLY-1 x");
		expect(stripStatusEmojiPrefix("🧪 FLY-1 x")).toBe("FLY-1 x");
	});

	it("an unrelated leading emoji is not treated as a status prefix", () => {
		expect(stripStatusEmojiPrefix("🎉 party FLY-1")).toBe("🎉 party FLY-1");
	});
});
