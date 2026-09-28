import { expect, test } from "vitest";

test("literal-only contract", () => {
	expect("claude-opus-5").toBe("claude-opus-5");
});
