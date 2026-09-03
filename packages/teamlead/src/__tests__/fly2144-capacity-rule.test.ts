import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptsDir = join(__dirname, "..", "..", "scripts");
const baseRulesDir = join(__dirname, "..", "..", "lead-rules-base");
const resolver = join(scriptsDir, "lead-rules-bundle.sh");

function assembledBundle(role: "dept" | "cos"): string {
	const paths = execFileSync(
		"bash",
		[
			"-c",
			`source "${resolver}"; compute_lead_rule_bundle "$1" "$2" mailbox 1`,
			"_",
			role,
			baseRulesDir,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				BASH_ENV: "",
				FLYWHEEL_LEAD_HAS_SUMMARY_DUTY: "0",
			},
		},
	)
		.split("\n")
		.filter(Boolean);
	return paths.map((path) => readFileSync(path, "utf8")).join("\n");
}

describe("FLY-2144 department Lead capacity input", () => {
	it("ships in the real department bundle without changing the CoS bundle", () => {
		const department = assembledBundle("dept");
		const cos = assembledBundle("cos");

		for (const anchor of [
			"Capacity input before dispatch (FLY-2144)",
			"/api/capacity",
			"不是闸门",
			"generatedAt",
			"巡检周期",
		]) {
			expect(department).toContain(anchor);
			expect(cos).not.toContain(anchor);
		}
		expect(department).toContain("`[patrol_tick]` 仍是**纯闹钟**");
		expect(department).toContain("名册为空");
	});
});
