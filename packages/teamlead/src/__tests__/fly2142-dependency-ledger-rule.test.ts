import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rules = readFileSync(
	join(__dirname, "..", "..", "lead-rules-base", "runner-patrol-rules.md"),
	"utf8",
);

describe("dependency ledger Lead rule (FLY-2142)", () => {
	it("keeps initial ordering and all three runtime update kinds actionable", () => {
		const section = rules.slice(rules.indexOf("## 7. 依赖账本 (FLY-2142)"));

		for (const anchor of [
			"dependency add",
			"dependency show",
			"漏掉的",
			"不需要做的",
			"新发现的",
			"dependency remove",
			"dependency discover",
			"依赖需要减法的地方",
			"ask --report",
		]) {
			expect(section).toContain(anchor);
		}
		expect(section).toMatch(/取消.*不等于.*依赖减法/);
		expect(section).toMatch(/Runner.*不得.*账本/);
	});
});
