#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/ship-on-comment.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$WORKFLOW" "$TMP/contract.json" <<'PY'
import json
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as handle:
    workflow = yaml.safe_load(handle)
prepare_steps = workflow["jobs"]["prepare"]["steps"]
merge_steps = workflow["jobs"]["merge"]["steps"]
report_steps = workflow["jobs"]["report-failure"]["steps"]
report_if = workflow["jobs"]["report-failure"].get("if", "")
report = next((step for step in report_steps if step.get("uses") == "actions/github-script@v7"), {})
merge = next((step for step in merge_steps if step.get("id") == "merge-pr"), {})
checkout = next((step for step in prepare_steps if step.get("uses") == "actions/checkout@v4"), {})
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump({"report": report, "report_if": report_if, "merge": merge, "checkout": checkout}, handle)
PY

node --input-type=module - "$TMP/contract.json" <<'JS'
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(process.argv[2], "utf8"));
const failures = [];
const report = contract.report ?? {};
const reportIf = contract.report_if ?? "";
const merge = contract.merge ?? {};
const checkout = contract.checkout ?? {};
const reportEnv = report.env ?? {};
const reportScript = report.with?.script ?? "";
const mergeScript = merge.with?.script ?? "";

const expectedEnv = {
  PREPARE_RESULT: "${{ needs.prepare.result }}",
  PR_INFO_OUTCOME: "${{ needs.prepare.outputs.pr_info_outcome }}",
  CHECKOUT_OUTCOME: "${{ needs.prepare.outputs.checkout_outcome }}",
  AWAIT_CI_OUTCOME: "${{ needs.prepare.outputs.await_ci_outcome }}",
  AWAIT_CI_RESULT: "${{ needs.prepare.outputs.await_ci_result }}",
  MERGE_RESULT: "${{ needs.merge.result }}",
  MERGE_ERROR: "${{ needs.merge.outputs.merge_error }}",
  HEAD_SHA: "${{ needs.prepare.outputs.head_sha }}",
};

if (checkout.id !== "checkout") failures.push("checkout-missing-stable-id");
if (!reportIf.includes("needs.prepare.result == 'cancelled'") || !reportIf.includes("needs.merge.result == 'cancelled'")) {
  failures.push("report-if-does-not-cover-cancellation");
}
for (const [key, value] of Object.entries(expectedEnv)) {
  if (reportEnv[key] !== value) failures.push(`report-env-${key}`);
}
if (reportScript.includes("${{")) failures.push("report-script-inline-actions-expression");
if (!mergeScript.includes("core.setOutput('merge_error'") && !mergeScript.includes('core.setOutput("merge_error"')) {
  failures.push("merge-error-output-missing");
}

let execute;
try {
  execute = new Function(
    "github",
    "context",
    "core",
    `return (async () => {${reportScript}\n})()`,
  );
} catch (error) {
  failures.push(`report-script-parse:${error.message}`);
}

const cases = [
  { name: "pr-info", env: { PREPARE_RESULT: "failure", PR_INFO_OUTCOME: "failure", CHECKOUT_OUTCOME: "skipped", AWAIT_CI_OUTCOME: "skipped" }, expected: "preflight" },
  { name: "checkout", env: { PREPARE_RESULT: "failure", PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "failure", AWAIT_CI_OUTCOME: "skipped" }, expected: "preflight" },
  { name: "await-timeout", env: { PREPARE_RESULT: "failure", AWAIT_CI_OUTCOME: "failure", AWAIT_CI_RESULT: "await_ci_timeout" }, expected: "await_ci_timeout" },
  { name: "ci-failure", env: { PREPARE_RESULT: "failure", AWAIT_CI_OUTCOME: "failure", AWAIT_CI_RESULT: "ci_failure" }, expected: "ci_failure" },
  { name: "head-moved", env: { PREPARE_RESULT: "failure", AWAIT_CI_OUTCOME: "failure", AWAIT_CI_RESULT: "head_moved" }, expected: "head_moved" },
  { name: "prepare-cancelled", env: { PREPARE_RESULT: "cancelled", MERGE_RESULT: "skipped" }, expected: "prepare_cancelled" },
  { name: "merge-cancelled", env: { PREPARE_RESULT: "success", MERGE_RESULT: "cancelled" }, expected: "merge_cancelled" },
  { name: "required-check", env: { PREPARE_RESULT: "success", AWAIT_CI_OUTCOME: "success", MERGE_ERROR: JSON.stringify({ status: 405, message: 'Required status check "CI OK" is expected.' }) }, expected: "merge_405_required_check" },
  { name: "other-405", env: { PREPARE_RESULT: "success", AWAIT_CI_OUTCOME: "success", MERGE_ERROR: JSON.stringify({ status: 405, message: "Pull Request is not mergeable" }) }, expected: "merge_405_other" },
  { name: "head-409", env: { PREPARE_RESULT: "success", AWAIT_CI_OUTCOME: "success", MERGE_ERROR: JSON.stringify({ status: 409, message: "Head branch was modified" }) }, expected: "merge_409_head" },
  { name: "forbidden", env: { PREPARE_RESULT: "success", AWAIT_CI_OUTCOME: "success", MERGE_ERROR: JSON.stringify({ status: 403, message: "forbidden" }) }, expected: "merge_403" },
  { name: "unprocessable", env: { PREPARE_RESULT: "success", AWAIT_CI_OUTCOME: "success", MERGE_ERROR: JSON.stringify({ status: 422, message: "unprocessable" }) }, expected: "merge_422" },
  { name: "other", env: { PREPARE_RESULT: "success", AWAIT_CI_OUTCOME: "success", MERGE_ERROR: JSON.stringify({ status: null, message: "socket failed" }) }, expected: "merge_other" },
  { name: "injection", env: { PREPARE_RESULT: "success", AWAIT_CI_OUTCOME: "success", MERGE_ERROR: JSON.stringify({ status: 405, message: "bad \"quote\" `tick`\nnewline" }) }, expected: "merge_405_other" },
];

if (execute) {
  for (const test of cases) {
    const comments = [];
    const oldEnv = { ...process.env };
    Object.assign(process.env, {
      PR_INFO_OUTCOME: "skipped",
      CHECKOUT_OUTCOME: "skipped",
      AWAIT_CI_OUTCOME: "skipped",
      AWAIT_CI_RESULT: "",
      PREPARE_RESULT: "failure",
      MERGE_ERROR: "",
      MERGE_RESULT: "failure",
      HEAD_SHA: "a".repeat(40),
      ...test.env,
    });
    try {
      await execute(
        {
          rest: {
            issues: { createComment: async (input) => comments.push(input.body) },
            pulls: { get: async () => ({ data: { head: { sha: "b".repeat(40) } } }) },
          },
        },
        {
          repo: { owner: "owner", repo: "flywheel" },
          runId: 123,
          issue: { number: 871 },
          payload: { comment: { id: 999 } },
        },
        {},
      );
      const receipt = comments.join("\n");
      if (!receipt.includes(`status=failure failed_step=${test.expected}`)) {
        failures.push(`case-${test.name}:${receipt}`);
      }
    } catch (error) {
      failures.push(`case-${test.name}-threw:${error.message}`);
    } finally {
      process.env = oldEnv;
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[TEST] ✗ ${failure}`);
  process.exit(1);
}
console.log(`[TEST] ✓ failure receipt maps ${cases.length} preflight/await/merge outcomes and resists message injection`);
JS

printf '[PASS] ship failure receipt producer contract\n'
