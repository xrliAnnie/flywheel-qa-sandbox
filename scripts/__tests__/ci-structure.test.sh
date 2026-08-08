#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
DISCORD_E2E="$REPO_ROOT/scripts/__tests__/fly1364-discord-e2e.test.sh"
REAL_TMUX_E2E="$REPO_ROOT/scripts/__tests__/tmux-server-rescue-real-tmux.test.sh"
CMUX_TEST="$REPO_ROOT/scripts/test-cmux-sync.sh"
HOOKS_E2E="$REPO_ROOT/scripts/test-cmux-sync-hooks-integration.sh"
LIVE_E2E="$REPO_ROOT/scripts/__tests__/fly1364-live-e2e.test.sh"

if grep -Fq -- ' -- --shard' "$WORKFLOW"; then
  echo "FAIL: ci.yml contains the swallowed pnpm shard form: -- --shard" >&2
  exit 1
fi

WORKFLOW="$WORKFLOW" DISCORD_E2E="$DISCORD_E2E" REAL_TMUX_E2E="$REAL_TMUX_E2E" CMUX_TEST="$CMUX_TEST" HOOKS_E2E="$HOOKS_E2E" LIVE_E2E="$LIVE_E2E" python3 <<'PY'
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

timeout_floors = {
    "unit-tests": (unit_tests, 15),
    # FLY-1482: the shell job's main-branch baseline reached 13m42s and a PR
    # replay was cancelled at the old 15-minute ceiling. Keep enough capacity
    # for the required real-watcher teardown coverage and ordinary CI variance.
    "script-tests": (script_tests, 20),
}
for job_id, (job, timeout_floor) in timeout_floors.items():
    timeout = job.get("timeout-minutes")
    require(
        isinstance(timeout, int) and timeout >= timeout_floor,
        f"{job_id}.timeout-minutes must be at least {timeout_floor}",
    )

script_steps = script_tests.get("steps")
require(isinstance(script_steps, list), "script-tests.steps must be a list")

# FLY-1364: the cmux authority/cleanup matrix and every shell-side delivery
# seam must be visible in the required PR gate. Keep this as one named step so
# a future workflow edit cannot silently strand one of the constituent suites.
fly1364_steps = [
    step
    for step in script_steps
    if isinstance(step, dict) and step.get("name") == "Test — FLY-1364 cmux sync repair"
]
require(len(fly1364_steps) == 1, "script-tests must contain exactly one FLY-1364 cmux sync repair step")
fly1364_step = fly1364_steps[0]
require("if" not in fly1364_step, "FLY-1364 shell suites must not be conditional")
require("continue-on-error" not in fly1364_step, "FLY-1364 shell suites must fail the PR gate")
fly1364_env = mapping(fly1364_step.get("env"), "FLY-1364 shell suite env")
require(
    str(fly1364_env.get("FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH")) == "1",
    "FLY-1364 CI must opt into the modern-Bash compatibility pass explicitly",
)
fly1364_commands = [
    line.strip()
    for line in str(fly1364_step.get("run", "")).splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]
expected_fly1364_commands = [
    "bash scripts/test-cmux-sync.sh",
    "bash scripts/__tests__/tmux-server-rescue.test.sh",
    "bash scripts/__tests__/tmux-server-rescue-lock.test.sh",
    "bash scripts/__tests__/tmux-server-rescue-instrumentation.test.sh",
    "bash scripts/__tests__/tmux-server-rescue-real-tmux.test.sh",
    "bash scripts/__tests__/flywheel-cmux-install-link-only.test.sh",
    "bash scripts/__tests__/test-cmux-autostart-flags.test.sh",
    "bash scripts/__tests__/test-teardown-cmux-ownership.test.sh",
    "bash scripts/__tests__/test-teardown-live-watcher-e2e.test.sh",
    "bash scripts/__tests__/test-teardown-lease-contract.test.sh",
    "bash scripts/__tests__/qa-teardown-finalize.test.sh",
    "bash scripts/__tests__/restart-cmux-watcher.test.sh",
]
require(
    fly1364_commands == expected_fly1364_commands,
    f"FLY-1364 CI command set/order drifted: {fly1364_commands}",
)

with open(os.environ["DISCORD_E2E"], encoding="utf-8") as handle:
    discord_e2e = handle.read()
require(
    re.search(r"^cmux_call_guarded\(\)", discord_e2e, re.MULTILINE) is not None,
    "FLY-1364 Discord E2E must intercept the guarded cmux mutation primitive",
)
require(
    re.search(r"^cmux\(\)", discord_e2e, re.MULTILINE) is not None,
    "FLY-1364 Discord E2E must fail closed on any direct cmux invocation",
)

with open(os.environ["REAL_TMUX_E2E"], encoding="utf-8") as handle:
    real_tmux_e2e = handle.read()
require(
    "mktemp -d /private/tmp/" not in real_tmux_e2e,
    "FLY-1364 real-tmux CI suite must use a portable temporary root",
)
require(
    re.search(r'\[ "\$\(uname -s\)" = "Darwin" \]', real_tmux_e2e) is not None,
    "FLY-1364 /tmp to /private/tmp normalization case must be Darwin-only",
)

with open(os.environ["CMUX_TEST"], encoding="utf-8") as handle:
    cmux_test = handle.read()
integration = cmux_test.split("# Integration: real tmux hook expansion", 1)[1].split(
    "# FLY-129: cmux IPC health check", 1
)[0]
require(
    'TMUX_INT_SOCKET="$TMPDIR_ROOT/tmux-hook-integration.sock"' in integration,
    "FLY-1364 embedded hook integration must allocate a private tmux socket",
)
require(
    re.search(r'command tmux(?! -S "\$TMUX_INT_SOCKET")', integration) is None,
    "FLY-1364 embedded hook integration must never address the default tmux server",
)
require(
    'command tmux -S "$TMUX_INT_SOCKET" kill-server' in integration,
    "FLY-1364 embedded hook integration must tear down its private tmux server",
)

with open(os.environ["HOOKS_E2E"], encoding="utf-8") as handle:
    hooks_e2e = handle.read()
require("tmux -L" not in hooks_e2e, "FLY-1364 hook suite must not use label-derived tmux sockets")
require(
    'TMUX_SOCKET="$TMPDIR_ROOT/tmux-hooks-integration.sock"' in hooks_e2e,
    "FLY-1364 hook suite must allocate an exact private tmux socket path",
)
require(
    'tmux() { command tmux -S "$TMUX_SOCKET" "$@"; }' in hooks_e2e,
    "FLY-1364 hook suite shim must route every sourced call to its private socket",
)

with open(os.environ["LIVE_E2E"], encoding="utf-8") as handle:
    live_e2e = handle.read()
require(" -L " not in live_e2e, "FLY-1364 live E2E must not use a label-derived tmux server")
require(
    'ISOLATED_TMUX_SOCKET="$TEST_ROOT/tmux-live.sock"' in live_e2e,
    "FLY-1364 live E2E must allocate an exact private tmux socket path",
)
require(
    "printf '#!/bin/sh\\nexec '\\''%s'\\'' -S '\\''%s'\\'' \"$@\"\\n'" in live_e2e,
    "FLY-1364 live E2E wrapper must pin tmux to its private socket",
)

apt_steps = [
    step
    for step in script_steps
    if isinstance(step, dict) and re.search(r"apt-get\s+update", str(step.get("run", "")))
]
require(len(apt_steps) == 1, f"script-tests must have exactly one apt-get update step, got {len(apt_steps)}")
apt_run = str(apt_steps[0].get("run", ""))
for package in ("tmux", "lsof", "sqlite3"):
    require(re.search(rf"\b{re.escape(package)}\b", apt_run) is not None, f"apt step must install {package}")

script_runs = [
    str(step.get("run", ""))
    for step in script_steps
    if isinstance(step, dict)
]
for required_command in (
    "bash scripts/__tests__/setup-quota-monitor.test.sh",
    "bash scripts/test-restart-services.sh",
    "bash scripts/__tests__/rollback-r4.test.sh",
    "bash scripts/__tests__/r4-window.test.sh",
    "bash scripts/__tests__/lead-body-hard-clear.test.sh",
    "bash scripts/__tests__/lead-restart-controlled-wave.test.sh",
    "bash packages/teamlead/scripts/__tests__/test-lead-identity-preflight.sh",
    "bash scripts/__tests__/supervisor-adoption.test.sh",
    "bash scripts/__tests__/supervisor-storm-regression.test.sh",
    "bash scripts/__tests__/restart-self-detach.test.sh",
):
    require(
        sum(required_command in run for run in script_runs) == 1,
        f"script-tests must run exactly once: {required_command}",
    )

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
