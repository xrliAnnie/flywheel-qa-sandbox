#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
CLASSIFIER="$REPO_ROOT/scripts/ci-classify.sh"
SUFFIX_LEDGER="$REPO_ROOT/engineering/doc/FLY-1987-actions-cost-audit/data/derive-lib.mjs"
REVIEW_GOVERNANCE_DOCS="$REPO_ROOT/packages/teamlead/src/bridge/__tests__/review-governance-docs.test.ts"
FLY1135_DOC_SENTINEL="$REPO_ROOT/packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts"
DISCORD_E2E="$REPO_ROOT/scripts/__tests__/fly1364-discord-e2e.test.sh"
REAL_TMUX_E2E="$REPO_ROOT/scripts/__tests__/tmux-server-rescue-real-tmux.test.sh"
CMUX_TEST="$REPO_ROOT/scripts/test-cmux-sync.sh"
HOOKS_E2E="$REPO_ROOT/scripts/test-cmux-sync-hooks-integration.sh"
LIVE_E2E="$REPO_ROOT/scripts/__tests__/fly1364-live-e2e.test.sh"

if grep -Fq -- ' -- --shard' "$WORKFLOW"; then
  echo "FAIL: ci.yml contains the swallowed pnpm shard form: -- --shard" >&2
  exit 1
fi

WORKFLOW="$WORKFLOW" CLASSIFIER="$CLASSIFIER" SUFFIX_LEDGER="$SUFFIX_LEDGER" REVIEW_GOVERNANCE_DOCS="$REVIEW_GOVERNANCE_DOCS" FLY1135_DOC_SENTINEL="$FLY1135_DOC_SENTINEL" DISCORD_E2E="$DISCORD_E2E" REAL_TMUX_E2E="$REAL_TMUX_E2E" CMUX_TEST="$CMUX_TEST" HOOKS_E2E="$HOOKS_E2E" LIVE_E2E="$LIVE_E2E" python3 <<'PY'
import ast
import os
import re
import shlex
import subprocess
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


def read_utf8(path: str, label: str) -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError as error:
        fail(f"could not read {label}: {error}")


def extract_classifier_python(shell_source: str) -> str:
    matches = re.findall(r"<<'PY'[^\n]*\n(.*?)\nPY\n", shell_source, re.DOTALL)
    if len(matches) != 1:
        fail(
            "could not extract classifier embedded Python: "
            f"expected one <<'PY' heredoc, found {len(matches)}"
        )
    return matches[0]


def extract_literal_tuple(python_source: str, name: str) -> tuple[bytes, ...]:
    try:
        tree = ast.parse(python_source)
    except SyntaxError as error:
        fail(f"could not extract {name}: classifier embedded Python does not parse: {error}")
    assignments = []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            assignments.append(node)
    if len(assignments) != 1:
        fail(f"could not extract {name}: expected one assignment, found {len(assignments)}")
    try:
        value = ast.literal_eval(assignments[0].value)
    except (ValueError, TypeError, SyntaxError) as error:
        fail(f"could not extract {name}: assignment is not a literal tuple: {error}")
    if not isinstance(value, tuple) or not all(isinstance(item, bytes) for item in value):
        fail(f"could not extract {name}: expected tuple[bytes, ...], got {value!r}")
    return value


def tuple_delta(
    actual: tuple[bytes, ...], expected: tuple[bytes, ...]
) -> tuple[list[bytes], list[bytes]]:
    return (
        [item for item in expected if item not in actual],
        [item for item in actual if item not in expected],
    )


def require_exact_tuple(
    actual: tuple[bytes, ...], expected: tuple[bytes, ...], label: str
) -> None:
    missing, unexpected = tuple_delta(actual, expected)
    require(
        actual == expected,
        f"{label} must match exactly: missing={missing!r}, "
        f"unexpected={unexpected!r}, actual={actual!r}",
    )


CONSUMER_SHAPE_REMEDIATION = (
    "consumer list shape changed — re-derive FLY-1278/FLY-1135 fence entries "
    "and update known_ci_consumed_doc_paths"
)


def extract_typescript_string_array(
    source: str,
    pattern: str,
    label: str,
    remediation: str = CONSUMER_SHAPE_REMEDIATION,
) -> tuple[str, ...]:
    matches = re.findall(pattern, source, re.DOTALL)
    if len(matches) != 1:
        fail(
            f"could not extract {label}: expected one static string array, "
            f"found {len(matches)}; {remediation}"
        )
    try:
        value = ast.literal_eval(matches[0])
    except (ValueError, TypeError, SyntaxError) as error:
        fail(f"could not extract {label}: {error}; {remediation}")
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail(
            f"could not extract {label}: expected list[str], got {value!r}; "
            f"{remediation}"
        )
    return tuple(value)


workflow_path = os.environ["WORKFLOW"]
repo_root = os.path.dirname(os.path.dirname(os.path.dirname(workflow_path)))
classifier_source = read_utf8(os.environ["CLASSIFIER"], "ci-classify.sh")
classifier_python = extract_classifier_python(classifier_source)

expected_allowed_prefixes = (
    b"doc/",
    b"product/doc/",
    b"engineering/doc/",
    b"content/doc/",
)
expected_allowed_suffixes = (
    b".md",
    b".markdown",
    b".mmd",
    b".html",
    b".htm",
    b".svg",
    b".png",
    b".jpg",
    b".jpeg",
    b".gif",
    b".webp",
    b".avif",
    b".pdf",
    b".txt",
    b".csv",
    b".log",
    b".out",
    b".jsonl",
    b".wav",
    b".mp3",
    b".m4a",
    b".ogg",
    b".mp4",
    b".webm",
    b".vtt",
    b".srt",
)
expected_known_ci_consumed_doc_paths = (
    b"doc/engineer/implementation/FLY-222-a0-a10-runbook.md",
    b"doc/qa/framework/529-room-playbook.md",
    b"engineering/doc/FLY-1775-529-generalized-dag-room/plan.md",
    b"engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md",
    b"engineering/doc/FLY-1648-hot-loop-closeout/runbook.md",
    b"doc/engineer/implementation/flag-authoring-runbook.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/exploration.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/research.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/plan.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/progress.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/fixtures/README.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round1.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round2.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round3.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/exploration.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/research.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/plan.md",
)

suffix_ledger_source = read_utf8(os.environ["SUFFIX_LEDGER"], "FLY-1987 suffix ledger")
ledger_new_suffixes = extract_typescript_string_array(
    suffix_ledger_source,
    r"export\s+const\s+SUFFIX_P0_ADDS\s*=\s*(\[.*?\])\s*;",
    "FLY-1987 SUFFIX_P0_ADDS",
    "the FLY-1987 ledger shape changed — re-derive the FLY-2001 suffix contract",
)
require_exact_tuple(
    tuple(suffix.encode("utf-8") for suffix in ledger_new_suffixes),
    expected_allowed_suffixes[13:],
    "FLY-1987 SUFFIX_P0_ADDS",
)

actual_allowed_prefixes = extract_literal_tuple(classifier_python, "allowed_prefixes")
actual_allowed_suffixes = extract_literal_tuple(classifier_python, "allowed_suffixes")
actual_known_paths = extract_literal_tuple(
    classifier_python, "known_ci_consumed_doc_paths"
)
require_exact_tuple(
    actual_allowed_prefixes, expected_allowed_prefixes, "classifier allowed_prefixes"
)
require_exact_tuple(
    actual_allowed_suffixes, expected_allowed_suffixes, "classifier allowed_suffixes"
)
require_exact_tuple(
    actual_known_paths,
    expected_known_ci_consumed_doc_paths,
    "classifier known_ci_consumed_doc_paths",
)

for path_bytes in expected_known_ci_consumed_doc_paths:
    path = path_bytes.decode("utf-8")
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", path],
        cwd=repo_root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    require(tracked.returncode == 0, f"known CI-consumed doc path must remain tracked: {path}")

review_governance_source = read_utf8(
    os.environ["REVIEW_GOVERNANCE_DOCS"], "review-governance-docs.test.ts"
)
fly1278_relative_paths = extract_typescript_string_array(
    review_governance_source,
    r"const\s+artifactPaths\s*=\s*(\[.*?\])\s*;",
    "FLY-1278 artifactPaths",
)
fly1278_prefix = "engineering/doc/FLY-1278-review-gate-convergence/"
fly1278_composed = tuple(
    f"{fly1278_prefix}{path}".encode("utf-8")
    for path in fly1278_relative_paths
    if path.endswith(tuple(item.decode("utf-8") for item in expected_allowed_suffixes))
)
expected_fly1278 = tuple(
    path for path in expected_known_ci_consumed_doc_paths if path.startswith(fly1278_prefix.encode())
)
require_exact_tuple(fly1278_composed, expected_fly1278, "FLY-1278 consumer/fence parity")

fly1135_source = read_utf8(
    os.environ["FLY1135_DOC_SENTINEL"], "fly1135-doc-sentinel.test.ts"
)
fly1135_relative_paths = extract_typescript_string_array(
    fly1135_source,
    r"for\s*\(\s*const\s+doc\s+of\s*(\[.*?\])\s*\)",
    "FLY-1135 inline for-of doc list",
)
fly1135_prefix = "engineering/doc/FLY-1135-layer1-dag-templates/"
fly1135_composed = tuple(
    f"{fly1135_prefix}{path}".encode("utf-8") for path in fly1135_relative_paths
)
expected_fly1135 = tuple(
    path for path in expected_known_ci_consumed_doc_paths if path.startswith(fly1135_prefix.encode())
)
require_exact_tuple(fly1135_composed, expected_fly1135, "FLY-1135 consumer/fence parity")

suffix_mutant = classifier_source.replace('    b".srt",\n', "", 1)
require(suffix_mutant != classifier_source, "positive control must remove classifier .srt")
mutant_suffixes = extract_literal_tuple(
    extract_classifier_python(suffix_mutant), "allowed_suffixes"
)
missing, unexpected = tuple_delta(mutant_suffixes, expected_allowed_suffixes)
require(
    missing == [b".srt"] and unexpected == [],
    f"positive control must report exact suffix delta, got missing={missing!r} unexpected={unexpected!r}",
)

fence_path = expected_known_ci_consumed_doc_paths[0].decode("utf-8")
fence_mutant_path = f"{fence_path}.mutated"
fence_mutant = classifier_source.replace(f'b"{fence_path}"', f'b"{fence_mutant_path}"', 1)
require(fence_mutant != classifier_source, "positive control must mutate one fence path")
mutant_paths = extract_literal_tuple(
    extract_classifier_python(fence_mutant), "known_ci_consumed_doc_paths"
)
missing, unexpected = tuple_delta(mutant_paths, expected_known_ci_consumed_doc_paths)
require(
    missing == [fence_path.encode("utf-8")]
    and unexpected == [fence_mutant_path.encode("utf-8")],
    f"positive control must report exact fence delta, got missing={missing!r} unexpected={unexpected!r}",
)

with open(workflow_path, encoding="utf-8") as handle:
    workflow = mapping(yaml.safe_load(handle), "workflow")

jobs = mapping(workflow.get("jobs"), "jobs")
expected_job_ids = {
    "classify",
    "quick-gate",
    "unit-tests",
    "script-tests",
    "script-tests-2",
    "payload-distribution",
    "ci-ok",
}
require(
    set(jobs) == expected_job_ids,
    f"job ids must be exactly {sorted(expected_job_ids)}, got {sorted(jobs)}",
)
require(
    list(jobs) == [
        "classify",
        "quick-gate",
        "unit-tests",
        "script-tests",
        "script-tests-2",
        "payload-distribution",
        "ci-ok",
    ],
    f"job order must preserve the unit-tests/script-tests boundary, got {list(jobs)}",
)

quick_gate = mapping(jobs["quick-gate"], "quick-gate")
classify = mapping(jobs["classify"], "classify")
unit_tests = mapping(jobs["unit-tests"], "unit-tests")
script_tests = mapping(jobs["script-tests"], "script-tests")
payload_distribution = mapping(jobs["payload-distribution"], "payload-distribution")
script_tests_2 = mapping(jobs["script-tests-2"], "script-tests-2")
ci_ok = mapping(jobs["ci-ok"], "ci-ok")

for job_id, job in (
    ("quick-gate", quick_gate),
    ("classify", classify),
):
    require("needs" not in job, f"{job_id} must start independently (no needs)")

for job_id, job in (
    ("unit-tests", unit_tests),
    ("script-tests", script_tests),
    ("script-tests-2", script_tests_2),
    ("payload-distribution", payload_distribution),
):
    require(job.get("needs") == ["classify"], f"{job_id} must depend only on classify")
    require(
        normalize_expression(job.get("if")) == "needs.classify.outputs.no_code!='true'",
        f"{job_id} must run unless classify proves no_code=true",
    )

permissions = mapping(classify.get("permissions"), "classify.permissions")
require(
    permissions == {"contents": "read", "actions": "read"},
    "classify must explicitly retain contents:read + actions:read under job-level permissions",
)
classify_steps = classify.get("steps")
require(isinstance(classify_steps, list), "classify.steps must be a list")
classify_checkout = [
    step for step in classify_steps
    if isinstance(step, dict) and step.get("uses") == "actions/checkout@v4"
]
require(len(classify_checkout) == 1, "classify must have one checkout")
require(
    mapping(classify_checkout[0].get("with"), "classify checkout.with").get("fetch-depth") == 0,
    "classify checkout must fetch full history",
)
classify_runs = [
    step for step in classify_steps
    if isinstance(step, dict) and str(step.get("run", "")).strip() == "bash scripts/ci-classify.sh"
]
require(len(classify_runs) == 1, "classify must run scripts/ci-classify.sh exactly once")
require(classify_runs[0].get("id") == "classify", "classifier step id must be classify")

concurrency = mapping(workflow.get("concurrency"), "concurrency")
require(
    normalize_expression(concurrency.get("group")) == "ci-${{github.ref}}",
    "CI concurrency must remain grouped by github.ref",
)
require(concurrency.get("cancel-in-progress") is True, "cancel-in-progress must remain true")

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
    "classify",
    "quick-gate",
    "unit-tests",
    "script-tests",
    "script-tests-2",
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
            normalize_expression(env.get("NO_CODE")) == "needs.classify.outputs.no_code",
            "ci-ok aggregate must receive classify no_code output",
        )
        normalized_run = re.sub(r"\s+", "", run)
        expected_run = re.sub(
            r"\s+",
            "",
            """printf '%s\\n' "$NEEDS_JSON" | jq -e --arg no_code "$NO_CODE" '
              . as $needs
              | ($needs["quick-gate"].result == "success")
                and ($needs.classify.result == "success")
                and (
                  ["unit-tests", "script-tests", "script-tests-2", "payload-distribution"]
                  | all(
                      . as $job
                      | ($needs[$job].result == "success")
                        or ($no_code == "true" and $needs[$job].result == "skipped")
                    )
                )
            '""",
        )
        require(
            normalized_run == expected_run,
            "ci-ok aggregate must accept heavy-job skips only when no_code=true",
        )
require(len(aggregate_steps) == 1, "ci-ok must contain exactly one NEEDS_JSON aggregate step")

timeout_floors = {
    "unit-tests": (unit_tests, 15),
    # FLY-1482: the shell job's main-branch baseline reached 13m42s and a PR
    # replay was cancelled at the old 15-minute ceiling. Keep enough capacity
    # for the required real-watcher teardown coverage and ordinary CI variance.
    "script-tests": (script_tests, 20),
    "script-tests-2": (script_tests_2, 20),
}
for job_id, (job, timeout_floor) in timeout_floors.items():
    timeout = job.get("timeout-minutes")
    require(
        isinstance(timeout, int) and timeout >= timeout_floor,
        f"{job_id}.timeout-minutes must be at least {timeout_floor}",
    )

script_steps = script_tests.get("steps")
require(isinstance(script_steps, list), "script-tests.steps must be a list")
quick_steps = quick_gate.get("steps")
require(isinstance(quick_steps, list), "quick-gate.steps must be a list")
ci_structure_in_quick = sum(
    "bash scripts/__tests__/ci-structure.test.sh" in str(step.get("run", ""))
    for step in quick_steps if isinstance(step, dict)
)
ci_structure_in_scripts = sum(
    "bash scripts/__tests__/ci-structure.test.sh" in str(step.get("run", ""))
    for step in script_steps if isinstance(step, dict)
)
ci_structure_in_scripts_2 = sum(
    "bash scripts/__tests__/ci-structure.test.sh" in str(step.get("run", ""))
    for step in (script_tests_2.get("steps") or []) if isinstance(step, dict)
)
require(
    ci_structure_in_quick == 1 and ci_structure_in_scripts == 0 and ci_structure_in_scripts_2 == 0,
    "ci-structure.test.sh must run exactly once in the always-on quick-gate",
)
retention_consumer_steps = [
    step for step in quick_steps
    if isinstance(step, dict)
    and step.get("name") == "Enforce FLY-2006 retention consumer gate"
]
require(
    len(retention_consumer_steps) == 1,
    "quick-gate must contain exactly one FLY-2006 retention consumer gate step",
)
require(
    str(retention_consumer_steps[0].get("run", "")).strip()
    == "node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs\nnode scripts/fly-2006-retention-consumer-gate.mjs",
    "FLY-2006 retention consumer gate commands drifted",
)
require(
    "continue-on-error" not in retention_consumer_steps[0],
    "FLY-2006 retention consumer gate must fail closed",
)
script_steps_2 = script_tests_2.get("steps")
require(isinstance(script_steps_2, list), "script-tests-2.steps must be a list")


def step_identity(step: object) -> str:
    require(isinstance(step, dict), "every script shard step must be a mapping")
    identity = step.get("name") or step.get("uses")
    require(bool(identity), f"script shard step lacks name/uses: {step}")
    return str(identity)


expected_setup = [
    "Record job start (FLY-1870 tripwire)",
    "actions/checkout@v4",
    "pnpm/action-setup@v4",
    "actions/setup-node@v4",
    "Configure git for tests",
    "Install dependencies",
    "Install better-sqlite3 prebuilt binary",
    "Build",
    "Ensure tmux/lsof/sqlite3/ripgrep (FLY-1905 hardened)",
]
expected_shard_tests = {
    "script-tests": [
        "Test — FLY-1707 incident replay",
        "Test — FLY-1393 flag truth CLI",
        "Test — FLY-1436 work-kind cutover CLI",
        "Test — FLY-1759 reap-first worktree teardown",
        "Test — FLY-1867 Playwright MCP lifecycle tools",
        "Test — FLY-1572 mailbox migration CLI",
        "Test — FLY-1764 legacy swap broadcast retirement",
        "Test — FLY-1327 cycle-time report",
        "Integration test — cmux-sync hooks",
        "Test — FLY-1364 cmux sync repair",
        "Test — FLY-1944 host terminal cutover brake",
        "Test — Discord adapter orphan reaper (FLY-183)",
        "Test — Lead rules single-bundle load chain (FLY-1402)",
        "Test — FLY-1496 model resolution + Lead derivation",
        "Test — FLY-1663 launchd-native Lead lifecycle",
        "Test — FLY-1830 non-Lead daemon convergence",
        "Test — FLY-1814 launchd fleet contracts",
        "Test — FLY-1929 voucher watch contracts",
        "Test — FLY-1678 statusline model-scoped bar + installer",
    ],
    "script-tests-2": [
        "Test — FLY-1905 CI apt-install helper",
        "Test — FLY-519 fleet provisioning + zero-secret gate",
        "Test — FLY-1356 skill-framework vendor + variant contracts",
        "Test — FLY-1609 four-arm analysis contract",
        "Test — FLY-648 one-command setup wizard",
        "Test — FLY-1023 Buddy onboarding (step CLI + provider contract)",
        "Test — FLY-1189 multi-Lead campaign harness",
        "Test — FLY-1775 generalized-DAG 529 room",
        "Test — FLY-1189 fault injector safety lock",
        "Test — FLY-1189 assert library + driver trap owner",
        "Test — FLY-1389 path-hygiene + 529-Room repair batch",
        "Test — NPM packaging pipeline + packaged-mode seams",
        "Test — FLY-1501 restart brake + heartbeat guard contracts",
        "Test — FLY-1634 restart net-deletion contracts",
        "Test — FLY-1959 updater sources + body provenance contracts",
        "Test — payload real-install smoke",
        "Test — onboard-shell public install chain",
        "Test — FLY-882 Discord bot token pool",
        "Test — FLY-513 global-codex repoint apply-path",
        "Test — FLY-1955 Codex daemon zombie recovery",
        "Test — FLY-697 codex-log-guard",
        "Test — FLY-1330 log janitor",
        "Test — FLY-1887 one-shot Codex hard timeout",
        "Test — FLY-1887 bounded Flywheel logs",
        "Test — FLY-1961 dual-vendor workspace trust",
        "Test — FLY-1018 gemini-agent guard",
        "Test — FLY-880 PM executor role contract",
        "Test — FLY-2015 diagram-design role routing",
        "Test — FLY-1787 CoS identity contract",
        "Test — FLY-1461 QA executor 529 N-to-N contract",
        "Test — FLY-1463 QA executor ship-report contract",
        "Test — FLY-1981 runtime role auto-QA retirement",
        "Test — FLY-913 restart-guard hook + install + strict-delivery",
        "Test — FLY-1434 unified restart + quota caller",
        "Test — FLY-1715 runner boundary shell contracts",
        "Test — FLY-1726 canonical Lead identity delivery",
        "Test — Lead in-flight mailbox adoption contracts",
        "Test — FLY-1649 r4 migration-window hardening",
        "Test — FLY-927 infra-alert shell path",
        "Test — FLY-957 record_deployed_range best-effort",
        "Test — FLY-1729/1743 restart update + consistency guards",
        "Test — FLY-1081 notify-path migration",
        "Test — FLY-1861 CI cancellation and classification contracts",
        "Test — FLY-1674 legacy-path residue guard",
        "Test — FLY-1338 matrix coverage parity (QA)",
        "Test — FLY-1855 executable Lead patrol snapshot",
        "Test — FLY-1986 load probe contract",
        "Test — FLY-1870 job elapsed tripwire contract",
    ],
}
script_shards = {
    "script-tests": (script_tests, script_steps),
    "script-tests-2": (script_tests_2, script_steps_2),
}

all_expected_tests = [
    name for names in expected_shard_tests.values() for name in names
]
require(
    len(all_expected_tests) == len(set(all_expected_tests)),
    "script shard test inventory must not contain duplicate step names",
)

for job_id, (job, steps) in script_shards.items():
    identities = [step_identity(step) for step in steps]
    require(
        identities[: len(expected_setup)] == expected_setup,
        f"{job_id} setup prefix drifted: {identities[:len(expected_setup)]}",
    )
    actual_tests = identities[len(expected_setup) : -1]
    require(
        actual_tests == expected_shard_tests[job_id],
        f"{job_id} test inventory/order drifted: {actual_tests}",
    )
    for step in steps[len(expected_setup) : -1]:
        require("if" not in step, f"{step_identity(step)} must not be conditional")
        require(
            "continue-on-error" not in step,
            f"{step_identity(step)} must fail the PR gate",
        )

    record = steps[0]
    require(
        str(record.get("run", "")).strip()
        == 'date +%s > "$RUNNER_TEMP/flywheel-job-start-epoch"',
        f"{job_id} must record its start epoch in the first step",
    )
    tripwire = steps[-1]
    require(
        step_identity(tripwire) == "Enforce FLY-1870 capacity tripwire",
        f"{job_id} must end with the FLY-1870 capacity tripwire",
    )
    require(
        normalize_expression(tripwire.get("if")) == "always()",
        f"{job_id} tripwire must run under always()",
    )
    require(
        "continue-on-error" not in tripwire,
        f"{job_id} tripwire must fail the PR gate",
    )
    tripwire_tokens = shlex.split(str(tripwire.get("run", "")))
    require(
        tripwire_tokens
        == [
            "bash",
            "scripts/ci-job-elapsed-tripwire.sh",
            "--cap-minutes",
            str(job.get("timeout-minutes")),
            "--threshold-pct",
            "85",
            "--start-file",
            "$RUNNER_TEMP/flywheel-job-start-epoch",
        ],
        f"{job_id} tripwire invocation drifted: {tripwire_tokens}",
    )
    require(
        "--now-epoch" not in tripwire_tokens,
        f"{job_id} production tripwire must use the real clock",
    )

repo_root = os.path.dirname(os.path.dirname(os.path.dirname(workflow_path)))
missing_bash_paths = []
for job_id, job in jobs.items():
    if not isinstance(job, dict):
        continue
    for step in job.get("steps", []):
        if not isinstance(step, dict):
            continue
        for line in str(step.get("run", "")).splitlines():
            if re.search(r"\bbash\s+", line) is None:
                continue
            try:
                tokens = shlex.split(line, comments=True)
            except ValueError as exc:
                fail(f"{job_id} has an unparsable run line {line!r}: {exc}")
            for index, token in enumerate(tokens[:-1]):
                candidate = tokens[index + 1]
                if token != "bash" or candidate.startswith("-"):
                    continue
                if "$" in candidate or candidate.startswith("/") or not candidate.endswith(".sh"):
                    continue
                if not os.path.isfile(os.path.join(repo_root, candidate)):
                    missing_bash_paths.append(f"{job_id}: {candidate}")
require(
    not missing_bash_paths,
    f"workflow bash paths must exist: {missing_bash_paths}",
)

# FLY-1715: the credential preflight and managed voice replacement are ship
# boundaries, so their hermetic harnesses must remain in the required PR gate.
# script-tests intentionally does not glob; pin the exact commands here.
fly1715_steps = [
    step
    for step in script_steps_2
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-1715 runner boundary shell contracts"
]
require(
    len(fly1715_steps) == 1,
    "script-tests-2 must contain exactly one FLY-1715 runner boundary shell contracts step",
)
fly1715_step = fly1715_steps[0]
require("if" not in fly1715_step, "FLY-1715 shell contracts must not be conditional")
require(
    "continue-on-error" not in fly1715_step,
    "FLY-1715 shell contracts must fail the PR gate",
)
fly1715_commands = [
    line.strip()
    for line in str(fly1715_step.get("run", "")).splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]
expected_fly1715_commands = [
    "bash scripts/__tests__/runner-tier-token-preflight.test.sh",
    "bash scripts/__tests__/restart-services-voice-bridge.test.sh",
]
require(
    fly1715_commands == expected_fly1715_commands,
    f"FLY-1715 CI command set/order drifted: {fly1715_commands}",
)

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
    "bash scripts/__tests__/fly1944-attach-protocol.test.sh",
    "bash scripts/__tests__/fly1944-birth-adoption.test.sh",
    "bash scripts/__tests__/fly1944-dead-view-rebuild.test.sh",
    "bash scripts/__tests__/fly1944-helper-reap.test.sh",
    "bash scripts/__tests__/fly1884-view-attach.test.sh",
    "bash scripts/__tests__/fly1884-attach-recovery.test.sh",
    "bash scripts/__tests__/fly1884-node-presence.test.sh",
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

# FLY-1830: the non-Lead daemon convergence is the only thing that puts a
# launchd label back after it leaves the domain. A suite that quietly falls out
# of the gate would restore exactly the silence this issue was filed about.
fly1830_steps = [
    step
    for step in script_steps
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-1830 non-Lead daemon convergence"
]
require(
    len(fly1830_steps) == 1,
    "script-tests must contain exactly one FLY-1830 non-Lead daemon convergence step",
)
fly1830_step = fly1830_steps[0]
require("if" not in fly1830_step, "FLY-1830 convergence suite must not be conditional")
require(
    "continue-on-error" not in fly1830_step,
    "FLY-1830 convergence suite must fail the PR gate",
)
fly1830_commands = [
    line.strip()
    for line in str(fly1830_step.get("run", "")).splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]
require(
    fly1830_commands == ["bash scripts/__tests__/converge-nonlead-daemons.test.sh"],
    f"FLY-1830 CI command set/order drifted: {fly1830_commands}",
)

# FLY-1814: the manifest, census, wiring, and explicit operator tools are one
# launchd-fleet contract. Keep this separate from FLY-1830 so its existing
# single-suite convergence guard cannot be weakened by future edits.
fly1814_steps = [
    step
    for step in script_steps
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-1814 launchd fleet contracts"
]
require(
    len(fly1814_steps) == 1,
    "script-tests must contain exactly one FLY-1814 launchd fleet contracts step",
)
fly1814_step = fly1814_steps[0]
require("if" not in fly1814_step, "FLY-1814 launchd suites must not be conditional")
require(
    "continue-on-error" not in fly1814_step,
    "FLY-1814 launchd suites must fail the PR gate",
)
fly1814_commands = [
    line.strip()
    for line in str(fly1814_step.get("run", "")).splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]
expected_fly1814_commands = [
    "bash scripts/__tests__/launchd-units-manifest.test.sh",
    "bash scripts/__tests__/launchd-units-manifest-fail-closed.test.sh",
    "bash scripts/__tests__/launchd-census.test.sh",
    "bash scripts/__tests__/launchd-census-wiring.test.sh",
    "bash scripts/__tests__/fly1814-operator-tools.test.sh",
]
require(
    fly1814_commands == expected_fly1814_commands,
    f"FLY-1814 CI command set/order drifted: {fly1814_commands}",
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

helper_steps = []
for job_id, (_, steps) in script_shards.items():
    job_helper_steps = [
        step
        for step in steps
        if isinstance(step, dict)
        and re.search(
            r"\bbash scripts/ci-apt-install\.sh(?:\s|$)",
            str(step.get("run", "")),
        )
    ]
    require(
        len(job_helper_steps) == 1,
        f"{job_id} must have exactly one ci-apt-install helper step, got {len(job_helper_steps)}",
    )
    helper_step = job_helper_steps[0]
    helper_run = str(helper_step.get("run", ""))
    for package in ("tmux", "lsof", "sqlite3", "ripgrep"):
        require(
            re.search(rf"\b{re.escape(package)}\b", helper_run) is not None,
            f"{job_id} helper step must ensure {package}",
        )
    helper_steps.append((job_id, helper_step))

unit_steps = unit_tests.get("steps")
require(isinstance(unit_steps, list), "unit-tests.steps must be a list")
unit_helper_steps = [
    step
    for step in unit_steps
    if isinstance(step, dict)
    and re.search(
        r"\bbash scripts/ci-apt-install\.sh(?:\s|$)",
        str(step.get("run", "")),
    )
]
require(
    len(unit_helper_steps) == 1,
    f"unit-tests must have exactly one ci-apt-install helper step, got {len(unit_helper_steps)}",
)
unit_helper_run = str(unit_helper_steps[0].get("run", ""))
for package in ("tmux", "lsof"):
    require(
        re.search(rf"\b{re.escape(package)}\b", unit_helper_run) is not None,
        f"unit-tests helper step must ensure {package}",
    )
helper_steps.append(("unit-tests", unit_helper_steps[0]))

for job_id, helper_step in helper_steps:
    helper_timeout = helper_step.get("timeout-minutes")
    require(
        isinstance(helper_timeout, int) and 0 < helper_timeout <= 8,
        f"{job_id} ci-apt-install helper step timeout-minutes must be in 1..8",
    )

all_run_text = [
    str(step.get("run", ""))
    for job in jobs.values()
    if isinstance(job, dict)
    for step in (job.get("steps") or [])
    if isinstance(step, dict)
]
require(
    all("apt-get" not in run for run in all_run_text),
    "ci.yml step run text must not contain bare apt-get; dependency setup must use ci-apt-install.sh",
)

script_runs = [
    str(step.get("run", ""))
    for step in script_steps + script_steps_2
    if isinstance(step, dict)
]
for required_command in (
    "bash scripts/__tests__/setup-quota-monitor.test.sh",
    "bash scripts/test-restart-services.sh",
    "bash scripts/__tests__/rollback-r4.test.sh",
    "bash scripts/__tests__/r4-window.test.sh",
    "bash scripts/__tests__/lead-body-hard-clear.test.sh",
    "bash scripts/__tests__/lead-restart-controlled-wave.test.sh",
    "bash scripts/__tests__/fly1680-v1-extinction.test.sh",
    "bash scripts/__tests__/flywheel-daemon-install-verify.test.sh",
    "bash scripts/__tests__/materialize-lead-manifests.test.sh",
    "bash scripts/__tests__/restart-self-detach.test.sh",
    "bash scripts/__tests__/restart-pull-preflight.test.sh",
    "bash scripts/__tests__/restart-deploy-consistency.test.sh",
    "bash scripts/__tests__/lead-body-evidence.test.sh",
    "bash scripts/__tests__/lead-body-provenance.test.sh",
    "bash scripts/__tests__/request-restart.test.sh",
    "bash scripts/__tests__/fly1726-default-lead-delivery.test.sh",
    "bash scripts/__tests__/fly1726-lead-identity-wrapper.test.sh",
    "bash scripts/__tests__/fly1697-v2-lease-body.test.sh",
    "bash packages/teamlead/scripts/__tests__/canonical-lead-identity.test.sh",
    "bash scripts/__tests__/ci-job-elapsed-tripwire.test.sh",
):
    require(
        sum(required_command in run for run in script_runs) == 1,
        f"script shards must run exactly once: {required_command}",
    )

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

stub_hygiene_steps = [
    step
    for step in unit_steps
    if isinstance(step, dict) and step.get("name") == "FLY-1883 stub-hygiene pairing"
]
require(
    len(stub_hygiene_steps) == 1,
    "unit-tests must contain exactly one FLY-1883 stub-hygiene pairing step",
)
stub_hygiene_step = stub_hygiene_steps[0]
require(
    str(stub_hygiene_step.get("if", "")).strip()
    == "matrix.name == 'teamlead 1 of 3'",
    "FLY-1883 stub-hygiene pairing must run only in teamlead shard 1",
)
require(
    str(stub_hygiene_step.get("run", "")).strip()
    == "pnpm --filter flywheel-teamlead test:stub-hygiene",
    "FLY-1883 stub-hygiene pairing command drifted",
)
require(
    "continue-on-error" not in stub_hygiene_step,
    "FLY-1883 stub-hygiene pairing must not swallow failures",
)

print("PASS: FLY-1338 CI structure contract")
PY
