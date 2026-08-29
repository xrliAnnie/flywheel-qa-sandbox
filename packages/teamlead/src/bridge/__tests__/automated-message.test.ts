import { describe, expect, it } from "vitest";
import {
	AUTOMATED_MESSAGE_PREFIX,
	markAutomatedDiscordText,
} from "../automated-message.js";

describe("automated Discord message provenance", () => {
	it("marks automation exactly once", () => {
		expect(markAutomatedDiscordText("hello")).toBe("🤖[自动] hello");
		expect(markAutomatedDiscordText("🤖[自动] hello")).toBe("🤖[自动] hello");
	});

	it("marks empty text so automation is never anonymous", () => {
		expect(markAutomatedDiscordText("")).toBe(AUTOMATED_MESSAGE_PREFIX);
	});

	it("keeps mentions and phase tags after the marker", () => {
		expect(markAutomatedDiscordText("<@123> 🧪QA running")).toBe(
			"🤖[自动] <@123> 🧪QA running",
		);
	});
});
