import { describe, expect, it } from "vitest";
import { frozenSourceText } from "../source-text.js";

describe("frozen report source text", () => {
	it("extracts readable HTML and decodes entities without treating scripts, styles, or comments as evidence", () => {
		const source = frozenSourceText(
			"<h1>QA &amp; cases</h1><script>approve()</script><style>.x{}</style><!-- secret --><p>😀 case&nbsp;one</p><p>Result: &#80;ASS</p>",
			"html",
		);
		expect(source.text).toBe("QA & cases\n😀 case one\nResult: PASS");
		expect(source.originalDigest).not.toBe(source.textDigest);
		expect(source.text).not.toContain("approve");
	});
	it("preserves plain text and fails explicitly on input overflow", () => {
		expect(frozenSourceText("Requirement <T> & literal\n", "text").text).toBe(
			"Requirement <T> & literal\n",
		);
		expect(() => frozenSourceText("x".repeat(262145), "html")).toThrow(
			"source_budget_exceeded",
		);
	});
});
