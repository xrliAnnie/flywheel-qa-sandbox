import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { founderReviewCheckpointEnabled } from "../bridge/founder-review-authority.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function project(checkpoint: string): string {
	const root = mkdtempSync(join(tmpdir(), "fly2103-founder-review-"));
	roots.push(root);
	mkdirSync(join(root, ".flywheel"));
	writeFileSync(
		join(root, ".flywheel", "config.yaml"),
		`project: flywheel
linear:
  team_id: FLY
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: default
    orchestrators:
      - type: dag
        runner: claude
        budget_per_issue: 1
decision_layer:
  autonomy_level: advisor
  escalation_channel: discord
checkpoints:
${checkpoint}
`,
	);
	return root;
}

describe("founderReviewCheckpointEnabled", () => {
	it("treats a declared checkpoint as enabled without a legacy boolean", async () => {
		await expect(
			founderReviewCheckpointEnabled(
				project("  founder_review:\n    timeout_ms: 172800000"),
			),
		).resolves.toBe(true);
	});

	it("keeps an undeclared founder-review checkpoint disabled", async () => {
		await expect(
			founderReviewCheckpointEnabled(
				project("  question:\n    timeout_ms: 86400000"),
			),
		).resolves.toBe(false);
	});
});
