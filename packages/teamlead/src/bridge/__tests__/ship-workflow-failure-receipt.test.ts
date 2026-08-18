import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	fileURLToPath(
		new URL(
			"../../../../../.github/workflows/ship-on-comment.yml",
			import.meta.url,
		),
	),
	"utf8",
);

describe("ship workflow failure receipt", () => {
	it("captures bounded merge API evidence before the action fails", () => {
		expect(workflow).toContain(
			"core.setOutput('merge_error', JSON.stringify({",
		);
		expect(workflow).toContain(
			"status: Number.isInteger(error?.status) ? error.status : null",
		);
		expect(workflow).toContain(
			"message: error instanceof Error ? error.message : String(error)",
		);
	});

	it("distinguishes pre-merge CI failure from merge-step failure in the durable receipt", () => {
		expect(workflow).toContain(
			"AWAIT_CI_RESULT: $" + "{{ steps.await-ci.outputs.outcome }}",
		);
		expect(workflow).toContain(
			"MERGE_ERROR: $" + "{{ steps.merge-pr.outputs.merge_error }}",
		);
		expect(workflow).toContain(
			"if (process.env.AWAIT_CI_OUTCOME === 'failure')",
		);
		expect(workflow).toContain(
			"} else if (process.env.MERGE_OUTCOME === 'failure') {",
		);
		expect(workflow).toContain("failedStep = 'merge_405_required_check'");
		expect(workflow).toContain("failedStep = 'merge_409_head'");
		expect(workflow).toContain("failedStep = 'merge_other'");
		expect(workflow).toContain("status=failure failed_step=$" + "{failedStep}");
	});
});
