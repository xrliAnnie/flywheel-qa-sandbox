import { describe, expect, it } from "vitest";
import { label } from "../labels.js";

describe("epic-page labels", () => {
	it("is the single renderer vocabulary source and expands parameters", () => {
		expect(label("section.what")).toBe("要做的事");
		expect(label("page.decided_rule_note", { rule: "ready.v1" })).toBe(
			"已获 founder 裁定的规则 ready.v1",
		);
	});

	it("fails loudly for an unknown key or missing parameter", () => {
		expect(() => label("unknown" as never)).toThrow(/unknown/i);
		expect(() => label("page.default_rule_note")).toThrow(/parameter/i);
	});
});
