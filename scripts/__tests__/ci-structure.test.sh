#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"

if grep -Fq -- ' -- --shard' "$WORKFLOW"; then
  echo "FAIL: ci.yml contains the swallowed pnpm shard form: -- --shard" >&2
  exit 1
fi

WORKFLOW="$WORKFLOW" python3 <<'PY'
import os
import re
import shlex
import sys

import yaml


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def mapping(value: object, label: str) -> dict:
    require(isinstance(value, dict), f"{label} must be a mapping")
    return value


def normalize_expression(value: object) -> str:
    text = str(value).strip()
    if text.startswith("${{") and text.endswith("}}"):
        text = text[3:-2]
    return re.sub(r"\s+", "", text)


workflow_path = os.environ["WORKFLOW"]
with open(workflow_path, encoding="utf-8") as handle:
    workflow = mapping(yaml.safe_load(handle), "workflow")

jobs = mapping(workflow.get("jobs"), "jobs")
expected_job_ids = {
    "quick-gate",
    "unit-tests",
    "script-tests",
    "payload-distribution",
    "ci-ok",
}
require(
    set(jobs) == expected_job_ids,
    f"job ids must be exactly {sorted(expected_job_ids)}, got {sorted(jobs)}",
)

quick_gate = mapping(jobs["quick-gate"], "quick-gate")
unit_tests = mapping(jobs["unit-tests"], "unit-tests")
script_tests = mapping(jobs["script-tests"], "script-tests")
ci_ok = mapping(jobs["ci-ok"], "ci-ok")

for job_id, job in (
    ("quick-gate", quick_gate),
    ("unit-tests", unit_tests),
    ("script-tests", script_tests),
):
    require("needs" not in job, f"{job_id} must start independently (no needs)")

strategy = mapping(unit_tests.get("strategy"), "unit-tests.strategy")
require(strategy.get("fail-fast") is False, "unit-tests strategy.fail-fast must be false")
matrix = mapping(strategy.get("matrix"), "unit-tests.strategy.matrix")
include = matrix.get("include")
require(isinstance(include, list), "unit-tests matrix.include must be a list")

expected_matrix = [
    {
        "name": "teamlead 1 of 3",
        "cmd": "pnpm --filter flywheel-teamlead test:run --shard=1/3",
    },
    {
        "name": "teamlead 2 of 3",
        "cmd": "pnpm --filter flywheel-teamlead test:run --shard=2/3",
    },
    {
        "name": "teamlead 3 of 3",
        "cmd": "pnpm --filter flywheel-teamlead test:run --shard=3/3",
    },
    {
        "name": "heavy",
        "cmd": "pnpm --filter flywheel-claude-runner --filter flywheel-comm --filter flywheel-edge-worker test:run",
    },
    {
        "name": "light",
        "cmd": "pnpm --filter './packages/*' --filter '!flywheel-teamlead' --filter '!flywheel-claude-runner' --filter '!flywheel-comm' --filter '!flywheel-edge-worker' test:run",
    },
]
actual_matrix = [
    {"name": entry.get("name"), "cmd": entry.get("cmd")}
    for entry in include
    if isinstance(entry, dict)
]

shards = []
for entry in actual_matrix:
    match = re.search(r"(?:^|\s)--shard=(\d+)/(\d+)(?:\s|$)", str(entry["cmd"]))
    if match:
        shards.append((int(match.group(1)), int(match.group(2))))
require(shards, "unit-tests matrix must contain teamlead shards")
denominators = {denominator for _, denominator in shards}
require(len(denominators) == 1, f"shard denominators differ: {sorted(denominators)}")
denominator = next(iter(denominators))
require(
    sorted(numerator for numerator, _ in shards) == list(range(1, denominator + 1)),
    f"shards must cover 1..{denominator} exactly once, got {shards}",
)


def filters(command: str) -> list[str]:
    tokens = shlex.split(command)
    values = []
    for index, token in enumerate(tokens[:-1]):
        if token == "--filter":
            values.append(tokens[index + 1])
    return values


light_entries = [entry for entry in actual_matrix if entry["name"] == "light"]
require(len(light_entries) == 1, "matrix must contain exactly one light entry")
light_entry = light_entries[0]
excluded = {
    value[1:]
    for value in filters(str(light_entry["cmd"]))
    if value.startswith("!")
}
positive_elsewhere = {
    value
    for entry in actual_matrix
    if entry is not light_entry
    for value in filters(str(entry["cmd"]))
    if not value.startswith("!")
}
require(excluded, "light entry must exclude packages owned by other matrix rows")
require(
    excluded <= positive_elsewhere,
    f"light exclusions lack positive coverage elsewhere: {sorted(excluded - positive_elsewhere)}",
)
require(actual_matrix == expected_matrix, "unit-tests matrix name/cmd contract changed")

ci_ok_needs = ci_ok.get("needs")
require(isinstance(ci_ok_needs, list), "ci-ok.needs must be a list")
expected_needs = {
    "quick-gate",
    "unit-tests",
    "script-tests",
    "payload-distribution",
}
require(
    len(ci_ok_needs) == len(expected_needs) and set(ci_ok_needs) == expected_needs,
    f"ci-ok.needs must be exactly {sorted(expected_needs)}, got {ci_ok_needs}",
)
require(
    normalize_expression(ci_ok.get("if")) == "always()&&!cancelled()",
    "ci-ok.if must be always() && !cancelled()",
)
ci_ok_steps = ci_ok.get("steps")
require(isinstance(ci_ok_steps, list), "ci-ok.steps must be a list")
aggregate_steps = []
for step in ci_ok_steps:
    if not isinstance(step, dict):
        continue
    env = step.get("env")
    run = str(step.get("run", ""))
    if isinstance(env, dict) and normalize_expression(env.get("NEEDS_JSON")) == "toJSON(needs)":
        aggregate_steps.append(step)
        require(
            re.search(r"jq\s+-e\s+['\"]all\(\.\[\];\s*\.result\s*==\s*['\"]success['\"]\)['\"]", run)
            is not None,
            "ci-ok NEEDS_JSON step must jq-check that every result is success",
        )
require(len(aggregate_steps) == 1, "ci-ok must contain exactly one NEEDS_JSON aggregate step")

for job_id, job in (("unit-tests", unit_tests), ("script-tests", script_tests)):
    timeout = job.get("timeout-minutes")
    require(
        isinstance(timeout, int) and timeout >= 15,
        f"{job_id}.timeout-minutes must be at least 15",
    )

script_steps = script_tests.get("steps")
require(isinstance(script_steps, list), "script-tests.steps must be a list")
apt_steps = [
    step
    for step in script_steps
    if isinstance(step, dict) and re.search(r"apt-get\s+update", str(step.get("run", "")))
]
require(len(apt_steps) == 1, f"script-tests must have exactly one apt-get update step, got {len(apt_steps)}")
apt_run = str(apt_steps[0].get("run", ""))
for package in ("tmux", "lsof", "sqlite3"):
    require(re.search(rf"\b{re.escape(package)}\b", apt_run) is not None, f"apt step must install {package}")

unit_steps = unit_tests.get("steps")
require(isinstance(unit_steps, list), "unit-tests.steps must be a list")
test_home_steps = [
    step
    for step in unit_steps
    if isinstance(step, dict)
    and re.search(
        r'mkdir\s+-p\s+["\']?\$HOME/\.flywheel["\']?',
        str(step.get("run", "")),
    )
]
require(
    not test_home_steps,
    "unit-tests must not mask fresh-host bugs by pre-creating $HOME/.flywheel",
)
matrix_execution_steps = [
    step
    for step in unit_steps
    if isinstance(step, dict) and normalize_expression(step.get("run")) == "matrix.cmd"
]
require(
    len(matrix_execution_steps) == 1,
    "unit-tests must contain exactly one run step executing matrix.cmd",
)
matrix_execution_step = matrix_execution_steps[0]
require("if" not in matrix_execution_step, "matrix.cmd execution step must not be conditional")
require(
    "continue-on-error" not in matrix_execution_step,
    "matrix.cmd execution step must not swallow failures",
)

print("PASS: FLY-1338 CI structure contract")
PY
