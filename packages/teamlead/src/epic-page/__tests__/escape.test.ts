import { describe, expect, it } from "vitest";
import { escapeMarkdownTableCell } from "../escape.js";

describe("escapeMarkdownTableCell", () => {
	it.each([
		["a|b", "a\\|b"],
		["a\nb\rc", "a b c"],
		[
			"[x](javascript:alert(1))",
			"&#91;x&#93;&#40;javascript:alert&#40;1&#41;&#41;",
		],
		["a\\b", "a\\\\b"],
	])("keeps %j inside one inert table cell", (input, expected) => {
		expect(escapeMarkdownTableCell(input)).toBe(expected);
	});
});
