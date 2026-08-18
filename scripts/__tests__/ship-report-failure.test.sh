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
steps = workflow["jobs"]["ship"]["steps"]
report = next((step for step in steps if step.get("name") == "❌ Report failure"), {})
merge = next((step for step in steps if step.get("id") == "merge-pr"), {})
checkout = next((step for step in steps if step.get("uses") == "actions/checkout@v4"), {})
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump({"report": report, "merge": merge, "checkout": checkout}, handle)
PY

node --input-type=module - "$TMP/contract.json" <<'JS'
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(process.argv[2], "utf8"));
const failures = [];
const report = contract.report ?? {};
const merge = contract.merge ?? {};
const checkout = contract.checkout ?? {};
const reportEnv = report.env ?? {};
const reportScript = report.with?.script ?? "";
const mergeScript = merge.with?.script ?? "";

const expectedEnv = {
  PR_INFO_OUTCOME: "${{ steps.pr-info.outcome }}",
  CHECKOUT_OUTCOME: "${{ steps.checkout.outcome }}",
  AWAIT_CI_OUTCOME: "${{ steps.await-ci.outcome }}",
  AWAIT_CI_RESULT: "${{ steps.await-ci.outputs.outcome }}",
  MERGE_OUTCOME: "${{ steps.merge-pr.outcome }}",
  MERGE_ERROR: "${{ steps.merge-pr.outputs.merge_error }}",
  HEAD_SHA: "${{ steps.pr-info.outputs.head_sha }}",
};

if (checkout.id !== "checkout") failures.push("checkout-missing-stable-id");
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
  { name: "pr-info", env: { PR_INFO_OUTCOME: "failure", CHECKOUT_OUTCOME: "skipped", AWAIT_CI_OUTCOME: "skipped", MERGE_OUTCOME: "skipped" }, expected: "preflight" },
  { name: "checkout", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "failure", AWAIT_CI_OUTCOME: "skipped", MERGE_OUTCOME: "skipped" }, expected: "preflight" },
  { name: "await-timeout", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "failure", AWAIT_CI_RESULT: "await_ci_timeout", MERGE_OUTCOME: "skipped" }, expected: "await_ci_timeout" },
  { name: "ci-failure", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "failure", AWAIT_CI_RESULT: "ci_failure", MERGE_OUTCOME: "skipped" }, expected: "ci_failure" },
  { name: "head-moved", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "failure", AWAIT_CI_RESULT: "head_moved", MERGE_OUTCOME: "skipped" }, expected: "head_moved" },
  { name: "required-check", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "success", MERGE_OUTCOME: "failure", MERGE_ERROR: JSON.stringify({ status: 405, message: 'Required status check "CI OK" is expected.' }) }, expected: "merge_405_required_check" },
  { name: "other-405", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "success", MERGE_OUTCOME: "failure", MERGE_ERROR: JSON.stringify({ status: 405, message: "Pull Request is not mergeable" }) }, expected: "merge_405_other" },
  { name: "head-409", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "success", MERGE_OUTCOME: "failure", MERGE_ERROR: JSON.stringify({ status: 409, message: "Head branch was modified" }) }, expected: "merge_409_head" },
  { name: "forbidden", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "success", MERGE_OUTCOME: "failure", MERGE_ERROR: JSON.stringify({ status: 403, message: "forbidden" }) }, expected: "merge_403" },
  { name: "unprocessable", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "success", MERGE_OUTCOME: "failure", MERGE_ERROR: JSON.stringify({ status: 422, message: "unprocessable" }) }, expected: "merge_422" },
  { name: "other", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "success", MERGE_OUTCOME: "failure", MERGE_ERROR: JSON.stringify({ status: null, message: "socket failed" }) }, expected: "merge_other" },
  { name: "injection", env: { PR_INFO_OUTCOME: "success", CHECKOUT_OUTCOME: "success", AWAIT_CI_OUTCOME: "success", MERGE_OUTCOME: "failure", MERGE_ERROR: JSON.stringify({ status: 405, message: "bad \"quote\" `tick`\nnewline" }) }, expected: "merge_405_other" },
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
      MERGE_OUTCOME: "skipped",
      MERGE_ERROR: "",
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
