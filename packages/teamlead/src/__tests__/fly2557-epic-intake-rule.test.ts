import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("materializes department intake rules with the production resolver while excluding CoS", () => {
	const directory = mkdtempSync(join(tmpdir(), "fly2557-rules-"));
	const packageRoot = join(__dirname, "../..");
	try {
		for (const role of ["dept", "cos"]) {
			const output = join(directory, `${role}.md`);
			execFileSync(
				"bash",
				[
					"-c",
					`set -euo pipefail
source "$1"
rules_bundle_reset
selected="$(compute_lead_rule_bundle "$3" "$2" mailbox 1)"
while IFS= read -r rule; do
  [ -z "$rule" ] || rules_bundle_add "$rule" base
done <<< "$selected"
rules_bundle_materialize "$4" "$3" test-lead test-project`,
					"_",
					join(packageRoot, "scripts/lead-rules-bundle.sh"),
					join(packageRoot, "lead-rules-base"),
					role,
					output,
				],
				{
					encoding: "utf8",
					env: { ...process.env, FLYWHEEL_LEAD_HAS_SUMMARY_DUTY: "0" },
				},
			);
			const bundle = readFileSync(output, "utf8");
			if (role === "cos") {
				expect(bundle).not.toContain("### 0.11 Epic");
				expect(bundle).not.toContain("runner-patrol-rules.md");
			} else {
				expect(bundle).toContain("### 0.11 Epic");
				for (const text of [
					"backfill=true",
					"dependency add",
					"dependency show",
					"epic-intake resolve",
					"messageId",
					"不重复",
					"最迟下一个巡检周期",
				])
					expect(bundle).toContain(text);
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
