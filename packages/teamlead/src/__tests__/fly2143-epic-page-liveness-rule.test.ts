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

describe("FLY-2143 Epic page liveness patrol rule", () => {
	it("ships the freshness and visible-stuck contract in the department bundle only", () => {
		const department = assembledBundle("dept");
		const cos = assembledBundle("cos");

		for (const anchor of [
			"Epic 页面新鲜度与卡住行(FLY-2143)",
			"卡住说了一声的",
			"不是 Bridge 从沉默推断",
			"在等 founder",
			"epic-page status",
			"founder-html-delivery",
			"不重复发",
			"publish_failures_since_last_published",
			"不引用超过一个巡检周期",
		]) {
			expect(department).toContain(anchor);
		}
		for (const anchor of [
			"Epic 页面新鲜度与卡住行(FLY-2143)",
			"卡住说了一声的",
			"publish_failures_since_last_published",
		]) {
			expect(cos).not.toContain(anchor);
		}
	});

	it("summarizes the FLY-2143 addition in the base-rules README", () => {
		const readme = readFileSync(join(baseRulesDir, "README.md"), "utf8");
		expect(readme).toContain("FLY-2143 Epic 页面新鲜度与卡住行");
	});
});
