import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchCommitsDelta } from "../lib/qa-fly-2456-launch-delta.mjs";

function fixture(t, after = "old\nexec-B1\nexec-B2\nexec-B3\n") {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-launch-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const beforePath = join(dir, "before"),
		afterPath = join(dir, "after");
	writeFileSync(beforePath, "old\n");
	writeFileSync(afterPath, after);
	const manifest = {
		steps: Object.fromEntries(
			["B1", "B2", "B3"].map((label) => [
				`start-${label}`,
				{
					intent: { detail: { kind: "start", label } },
					receipt: {
						result: {
							success: true,
							generalized: true,
							executionId: `exec-${label}`,
							workflowRunId: `run-${label}`,
							workflowNodeId: "implement",
						},
					},
				},
			]),
		),
	};
	return { beforePath, afterPath, manifest };
}
test("declared starts bound launch receipt additions", (t) => {
	const r = launchCommitsDelta(fixture(t));
	assert.equal(r.status, "pass");
	assert.equal(r.added.length, 3);
});
test("manual replacement declarations do not authorize new launch receipts", (t) => {
	const f = fixture(t, "old\nforged\n");
	f.manifest.replacements = ["forged"];
	assert.equal(launchCommitsDelta(f).status, "fail");
	f.manifest.steps.fake = {
		intent: { detail: { kind: "observe" } },
		receipt: { result: { replacement: { executionId: "forged" } } },
	};
	assert.equal(launchCommitsDelta(f).status, "fail");
});
test("arbitrary start labels cannot whitelist unrelated executions", (t) => {
	const f = fixture(t, "old\nforged\n");
	f.manifest.steps.fake = {
		intent: { detail: { kind: "start", label: "unrelated" } },
		receipt: {
			result: {
				success: true,
				generalized: true,
				executionId: "forged",
				workflowRunId: "run-forged",
				workflowNodeId: "implement",
			},
		},
	};
	assert.equal(launchCommitsDelta(f).status, "fail");
});
test("missing receipt or unsuccessful start cannot declare an execution", (t) => {
	const f = fixture(t);
	delete f.manifest.steps["start-B1"].receipt;
	assert.equal(launchCommitsDelta(f).status, "fail");
});
test("malformed, duplicate and removed filenames fail closed", (t) => {
	for (const after of ["old\n../exec-B1\n", "old\nold\n", "exec-B1\n"])
		assert.equal(launchCommitsDelta(fixture(t, after)).status, "fail");
});
test("engine QA identity declares only the matching B1 run attempt1", (t) => {
	const f = fixture(t, "old\nqa-exec\n");
	f.manifest.config = { issues: { B1: "FLY-1" } };
	f.manifest.steps["start-B1"].intent.detail.issueId = "FLY-1";
	f.manifest.steps.qa = {
		intent: { detail: { kind: "qa-identity", label: "B1", issueId: "FLY-1" } },
		receipt: {
			result: {
				source: "workflow-engine",
				executionId: "qa-exec",
				workflowRunId: "run-B1",
				workflowNodeId: "qa",
				issueId: "FLY-1",
				attempt: 1,
				activationId: "activation:qa-exec:run-B1:qa:1",
			},
		},
	};
	assert.equal(launchCommitsDelta(f).status, "pass");
	f.manifest.steps.qa.receipt.result.workflowRunId = "other";
	assert.equal(launchCommitsDelta(f).status, "fail");
});
test("a fabricated QA start cannot substitute for engine adoption", (t) => {
	const f = fixture(t, "old\nforged-qa\n");
	f.manifest.steps.fake = {
		intent: { detail: { kind: "start", label: "QA" } },
		receipt: {
			result: {
				success: true,
				generalized: true,
				executionId: "forged-qa",
				workflowRunId: "run-B1",
				workflowNodeId: "qa",
			},
		},
	};
	assert.equal(launchCommitsDelta(f).status, "fail");
});
