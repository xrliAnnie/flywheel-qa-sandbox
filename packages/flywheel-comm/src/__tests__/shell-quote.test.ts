import { describe, expect, it } from "vitest";
import { shellQuote } from "../shell-quote.js";

describe("shellQuote", () => {
	it("preserves shell metacharacters as one POSIX argument", () => {
		expect(shellQuote(`a'b\n$(id) \`tick\` & #`)).toBe(
			`'a'"'"'b\n$(id) \`tick\` & #'`,
		);
	});
});
