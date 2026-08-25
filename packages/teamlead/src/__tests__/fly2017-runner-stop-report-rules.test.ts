import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASE = join(__dirname, "..", "..", "lead-rules-base");
const ruleFiles = [
	"department-lead-rules.md",
	"cos-lead-rules.md",
	"runner-messaging-rules.md",
	"runner-patrol-rules.md",
] as const;

describe("FLY-2017 runner-stop report Lead rules", () => {
	it.each(ruleFiles)("%s defines the trusted ACK-only exception", (file) => {
		const rule = readFileSync(join(BASE, file), "utf8");
		expect(rule).toContain("Trusted runner-stop exception (FLY-2017)");
		expect(rule).toContain("RUNNER-STOPPED kind=runner_stopped");
		expect(rule).toContain("rstop-<32 lowercase hex>");
		expect(rule).toContain("[REPORT]");
		expect(rule).toMatch(/never run `flywheel-comm respond`/i);
		expect(rule).toMatch(/ACK/i);
	});

	it.each(["department-lead-rules.md", "cos-lead-rules.md"])(
		"%s scopes the ordinary response contract to ASK events",
		(file) => {
			const rule = readFileSync(join(BASE, file), "utf8");
			expect(rule).toContain("`[ASK] runner_question`");
			expect(rule).toContain(
				"Only `gate_question` and `[ASK] runner_question` reply with `flywheel-comm respond`.",
			);
		},
	);
});
