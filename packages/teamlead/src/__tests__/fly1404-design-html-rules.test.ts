import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rules = readFileSync(
	join(process.cwd(), "lead-rules-base", "department-lead-rules.md"),
	"utf8",
);

describe("FLY-1404 Lead design-node visibility rule", () => {
	it("requires delivery, keeps implementation non-blocking, and routes late feedback through TURN", () => {
		expect(rules).toContain(
			"## Design-Node Visibility — Founder Design HTML (FLY-1404, strictly enforced)",
		);
		expect(rules).toContain("DESIGN-HTML ready:");
		expect(rules).toContain("founder-html-delivery");
		expect(rules).toMatch(/not.*wait for founder review/i);
		expect(rules).toMatch(/missing.*report.*return.*design/i);
		expect(rules).toContain("design-correction.md");
		expect(rules).toContain("current TURN holder");
		expect(rules).toContain("abolished concepts");
		expect(rules).toContain("retained organs");
		expect(rules).toContain("verbatim founder quote");
	});
});
