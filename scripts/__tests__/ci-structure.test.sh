#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
REQUIRED_JOBS="$REPO_ROOT/.github/ci-required-jobs.json"
CLASSIFIER="$REPO_ROOT/scripts/ci-classify.sh"
SUFFIX_LEDGER="$REPO_ROOT/engineering/doc/FLY-1987-actions-cost-audit/data/derive-lib.mjs"
REVIEW_GOVERNANCE_DOCS="$REPO_ROOT/packages/teamlead/src/bridge/__tests__/review-governance-docs.test.ts"
FLY1135_DOC_SENTINEL="$REPO_ROOT/packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts"
DISCORD_E2E="$REPO_ROOT/scripts/__tests__/fly1364-discord-e2e.test.sh"
REAL_TMUX_E2E="$REPO_ROOT/scripts/__tests__/tmux-server-rescue-real-tmux.test.sh"
CMUX_TEST="$REPO_ROOT/scripts/test-cmux-sync.sh"
HOOKS_E2E="$REPO_ROOT/scripts/test-cmux-sync-hooks-integration.sh"
LIVE_E2E="$REPO_ROOT/scripts/__tests__/fly1364-live-e2e.test.sh"
FLY2331_GUARD_TEST="$REPO_ROOT/scripts/__tests__/fly2331-bridge-async-child.test.sh"

if grep -Fq -- ' -- --shard' "$WORKFLOW"; then
  echo "FAIL: ci.yml contains the swallowed pnpm shard form: -- --shard" >&2
  exit 1
fi

WORKFLOW="$WORKFLOW" REQUIRED_JOBS="$REQUIRED_JOBS" CLASSIFIER="$CLASSIFIER" SUFFIX_LEDGER="$SUFFIX_LEDGER" REVIEW_GOVERNANCE_DOCS="$REVIEW_GOVERNANCE_DOCS" FLY1135_DOC_SENTINEL="$FLY1135_DOC_SENTINEL" DISCORD_E2E="$DISCORD_E2E" REAL_TMUX_E2E="$REAL_TMUX_E2E" CMUX_TEST="$CMUX_TEST" HOOKS_E2E="$HOOKS_E2E" LIVE_E2E="$LIVE_E2E" FLY2331_GUARD_TEST="$FLY2331_GUARD_TEST" python3 <<'PY'
import ast
import copy
import json
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
fly2331_guard_source = read_utf8(
    os.environ["FLY2331_GUARD_TEST"], "FLY-2331 guard regression"
)
fly2331_claude_build = fly2331_guard_source.find(
    "pnpm --filter flywheel-claude-runner build"
)
fly2331_teamlead_build = fly2331_guard_source.find(
    "pnpm --filter flywheel-teamlead build"
)
fly2331_fake_path = fly2331_guard_source.find('export PATH="$FAKE_BIN:$PATH"')
require(
    0 <= fly2331_claude_build < fly2331_teamlead_build < fly2331_fake_path,
    "FLY-2331 fake git PATH must be installed only after both package builds",
)

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
    b"engineering/doc/FLY-2166-pre-cutover-audit-fix/g2-runbook.md",
    b"doc/engineer/implementation/flag-authoring-runbook.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/exploration.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/research.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/plan.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/progress.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/fixtures/README.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/fixtures/fly-1251-rounds-6-9.json",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round1.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round2.md",
    b"engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round3.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/exploration.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/research.md",
    b"engineering/doc/FLY-1135-layer1-dag-templates/plan.md",
    b"engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py",
    b"engineering/doc/FLY-2030-raya-brain-inquiry/summary-role-assignments.json",
    b"engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/capture.mjs",
    b"engineering/doc/FLY-1269-codex-phase-keepalive/qa/target7-pane-identity.mjs",
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

expected_run_name = "${{ (github.event.action == 'labeled' && github.event.label.name == 'ci:full') && format('CI full-request {0}', github.event.pull_request.head.sha) || '' }}"
require(workflow.get("run-name") == expected_run_name, "workflow run-name contract changed")
triggers = mapping(workflow.get("on", workflow.get(True)), "on")
require(
    mapping(triggers.get("push"), "on.push") == {"branches": ["main"]},
    "push trigger must remain main-only",
)
pull_request_trigger = mapping(triggers.get("pull_request"), "on.pull_request")
expected_pull_request_trigger = {
    "branches": ["main"],
    "types": ["opened", "synchronize", "reopened", "labeled"],
}
require(
    pull_request_trigger == expected_pull_request_trigger,
    "pull_request trigger must include exactly opened/synchronize/reopened/labeled",
)
trigger_mutant = copy.deepcopy(pull_request_trigger)
trigger_mutant["types"].remove("labeled")
require(
    trigger_mutant != expected_pull_request_trigger,
    "positive control must reject removal of the labeled trigger",
)

jobs = mapping(workflow.get("jobs"), "jobs")
expected_job_ids = {
    "classify",
    "quick-gate",
    "unit-tests",
    "script-tests",
    "script-tests-2",
    "script-tests-3",
    "script-tests-4",
    "script-tests-5",
    "script-tests-6",
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
        "script-tests-3",
        "script-tests-4",
        "script-tests-5",
        "script-tests-6",
        "payload-distribution",
        "ci-ok",
    ],
    f"job order must preserve the unit-tests/script-tests boundary, got {list(jobs)}",
)

quick_gate = mapping(jobs["quick-gate"], "quick-gate")
classify = mapping(jobs["classify"], "classify")
unit_tests = mapping(jobs["unit-tests"], "unit-tests")
script_tests = mapping(jobs["script-tests"], "script-tests")
script_tests_2 = mapping(jobs["script-tests-2"], "script-tests-2")
script_tests_3 = mapping(jobs["script-tests-3"], "script-tests-3")
script_tests_4 = mapping(jobs["script-tests-4"], "script-tests-4")
script_tests_5 = mapping(jobs["script-tests-5"], "script-tests-5")
script_tests_6 = mapping(jobs["script-tests-6"], "script-tests-6")
payload_distribution = mapping(jobs["payload-distribution"], "payload-distribution")
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
    ("script-tests-3", script_tests_3),
    ("script-tests-4", script_tests_4),
    ("script-tests-5", script_tests_5),
    ("script-tests-6", script_tests_6),
    ("payload-distribution", payload_distribution),
):
    require(job.get("needs") == ["classify"], f"{job_id} must depend only on classify")
    expected_heavy_if = "needs.classify.outputs.heavy!='skip'"
    require(
        normalize_expression(job.get("if")) == expected_heavy_if,
        f"{job_id} must run unless scope explicitly emits heavy=skip",
    )
require(
    normalize_expression("${{ needs.classify.outputs.heavy == 'run' }}")
    != expected_heavy_if,
    "positive control must reject fail-open heavy == run conditions",
)

permissions = mapping(classify.get("permissions"), "classify.permissions")
require(
    permissions == {"contents": "read", "actions": "read"},
    "classify must explicitly retain contents:read + actions:read under job-level permissions",
)
classify_steps = classify.get("steps")
require(isinstance(classify_steps, list), "classify.steps must be a list")
expected_classify_outputs = {
    "no_code": "${{ steps.classify.outputs.no_code }}",
    "heavy": "${{ steps.scope.outputs.heavy }}",
    "mode": "${{ steps.scope.outputs.mode }}",
    "tested_tree": "${{ steps.scope.outputs.tested_tree }}",
    "reuse_run": "${{ steps.scope.outputs.reuse_run }}",
}
require(
    classify.get("outputs") == expected_classify_outputs,
    "classify outputs must expose the exact five-value scope contract",
)
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
classify_step_contract = [
    (step.get("uses"), step.get("id"), str(step.get("run", "")).strip())
    for step in classify_steps
    if isinstance(step, dict)
]
require(
    classify_step_contract == [
        ("actions/checkout@v4", None, ""),
        (None, "classify", "bash scripts/ci-classify.sh"),
        (None, "reuse", "bash scripts/ci-full-reuse.sh"),
        (None, "scope", "bash scripts/ci-scope.sh"),
    ],
    f"classify step order/identity changed: {classify_step_contract}",
)
reuse_step = classify_steps[2]
require(
    normalize_expression(reuse_step.get("if")) == "github.event_name=='push'",
    "reuse probe must run only for push events",
)

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
        "name": "teamlead 1 of 4",
        "cmd": "node scripts/teamlead-ci-shard.mjs --shard=1/4",
    },
    {
        "name": "teamlead 2 of 4",
        "cmd": "node scripts/teamlead-ci-shard.mjs --shard=2/4",
    },
    {
        "name": "teamlead 3 of 4",
        "cmd": "node scripts/teamlead-ci-shard.mjs --shard=3/4",
    },
    {
        "name": "teamlead 4 of 4",
        "cmd": "node scripts/teamlead-ci-shard.mjs --shard=4/4",
    },
    {
        "name": "observation performance",
        "cmd": "pnpm --filter flywheel-teamlead exec vitest run src/ship-judgment/__tests__/observation-performance.test.ts",
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
    if tokens[:2] == ["node", "scripts/teamlead-ci-shard.mjs"]:
        with open(os.path.join(repo_root, tokens[1]), encoding="utf-8") as handle:
            helper = handle.read()
        require(re.search(r'"--filter",\s*"flywheel-teamlead",\s*"test:run"', helper), "teamlead helper must execute the original package test script")
        return ["flywheel-teamlead"]
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

with open(os.environ["REQUIRED_JOBS"], encoding="utf-8") as handle:
    required_jobs = mapping(json.load(handle), "ci-required-jobs.json")
unit_check_names = [f"Unit ({entry['name']})" for entry in actual_matrix]
script_check_names = [
    str(script_tests["name"]),
    str(script_tests_2["name"]),
    str(script_tests_3["name"]),
    str(script_tests_4["name"]),
    str(script_tests_5["name"]),
    str(script_tests_6["name"]),
]
expected_required_jobs = {
    "schema": 1,
    "aggregate": "CI OK",
    "aggregate_scoped": "CI Scope OK",
    "always": ["Classify CI scope", "Quick Gate (build + typecheck + lint)"],
    "heavy": unit_check_names
    + script_check_names
    + [str(payload_distribution["name"])],
}
require(
    required_jobs == expected_required_jobs,
    "required-job manifest must exactly expand the ci.yml check graph",
)
manifest_without_shard = copy.deepcopy(required_jobs)
manifest_without_shard["heavy"].remove(script_check_names[-1])
require(
    manifest_without_shard != expected_required_jobs,
    "positive control must reject a manifest missing one script shard",
)
renamed_matrix = copy.deepcopy(expected_required_jobs)
renamed_matrix["heavy"][0] += " renamed"
require(
    renamed_matrix != expected_required_jobs,
    "positive control must reject a renamed unit matrix check",
)

ci_ok_needs = ci_ok.get("needs")
require(isinstance(ci_ok_needs, list), "ci-ok.needs must be a list")
expected_needs = {
    "classify",
    "quick-gate",
    "unit-tests",
    "script-tests",
    "script-tests-2",
    "script-tests-3",
    "script-tests-4",
    "script-tests-5",
    "script-tests-6",
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
expected_aggregate_name = "contains(fromJSON('[\"full\",\"docs_only\",\"reuse\"]'),needs.classify.outputs.mode)&&'CIOK'||'CIScopeOK'"
require(
    normalize_expression(ci_ok.get("name")) == expected_aggregate_name,
    "aggregate name must whitelist full/docs_only/reuse as CI OK",
)
swapped_aggregate_name = expected_aggregate_name.replace(
    "&&'CIOK'||'CIScopeOK'", "&&'CIScopeOK'||'CIOK'"
)
require(
    swapped_aggregate_name != expected_aggregate_name,
    "positive control must reject swapped CI OK and CI Scope OK names",
)
ci_ok_steps = ci_ok.get("steps")
require(isinstance(ci_ok_steps, list), "ci-ok.steps must be a list")
aggregate_steps = []
aggregate_run = None
for step in ci_ok_steps:
    if not isinstance(step, dict):
        continue
    env = step.get("env")
    run = str(step.get("run", ""))
    if isinstance(env, dict) and normalize_expression(env.get("NEEDS_JSON")) == "toJSON(needs)":
        aggregate_steps.append(step)
        aggregate_run = run
        require(
            normalize_expression(env.get("NO_CODE")) == "needs.classify.outputs.no_code",
            "ci-ok aggregate must receive classify no_code output",
        )
        require(
            normalize_expression(env.get("HEAVY")) == "needs.classify.outputs.heavy",
            "ci-ok aggregate must receive classify heavy output",
        )
        require(
            normalize_expression(env.get("MODE")) == "needs.classify.outputs.mode",
            "ci-ok aggregate must receive classify mode output",
        )
        normalized_run = re.sub(r"\s+", "", run)
        expected_run = re.sub(
            r"\s+",
            "",
            """printf '%s\\n' "$NEEDS_JSON" | jq -e --arg no_code "$NO_CODE" --arg heavy "$HEAVY" --arg mode "$MODE" '
              . as $needs
              | ["unit-tests", "script-tests", "script-tests-2", "script-tests-3", "script-tests-4", "script-tests-5", "script-tests-6", "payload-distribution"] as $heavy_jobs
              | ($needs["quick-gate"].result == "success")
                and ($needs.classify.result == "success")
                and (
                  ( $mode == "full" and $heavy == "run" and $no_code != "true"
                    and ($needs["unit-tests"].result == "success")
                    and ($needs["script-tests"].result == "success")
                    and ($needs["script-tests-2"].result == "success")
                    and ($needs["script-tests-3"].result == "success")
                    and ($needs["script-tests-4"].result == "success")
                    and ($needs["script-tests-5"].result == "success")
                    and ($needs["script-tests-6"].result == "success")
                    and ($needs["payload-distribution"].result == "success") )
                  or
                  ( $heavy == "skip"
                    and ( ($mode == "docs_only" and $no_code == "true")
                          or (($mode == "scoped" or $mode == "reuse") and $no_code != "true") )
                    and ($heavy_jobs | all(. as $job | $needs[$job].result == "skipped")) )
                )
            '""",
        )
        require(
            normalized_run == expected_run,
            "ci-ok aggregate must enforce exact full and skip-mode result shapes",
        )
        jq_mutant = normalized_run.replace(
            'and($needs["script-tests-6"].result=="success")', "", 1
        )
        require(
            jq_mutant != expected_run,
            "positive control must reject removing one full-mode success assertion",
        )
require(len(aggregate_steps) == 1, "ci-ok must contain exactly one NEEDS_JSON aggregate step")
require(isinstance(aggregate_run, str), "ci-ok aggregate run command must be text")

heavy_job_ids = [
    "unit-tests",
    "script-tests",
    "script-tests-2",
    "script-tests-3",
    "script-tests-4",
    "script-tests-5",
    "script-tests-6",
    "payload-distribution",
]


def aggregate_status(
    no_code: str,
    heavy: str,
    mode: str,
    heavy_result: str = "success",
    overrides: dict[str, str] | None = None,
    command: str = aggregate_run,
) -> int:
    results = {job_id: heavy_result for job_id in heavy_job_ids}
    results.update(overrides or {})
    needs = {
        "classify": {"result": "success"},
        "quick-gate": {"result": "success"},
        **{job_id: {"result": result} for job_id, result in results.items()},
    }
    completed = subprocess.run(
        ["bash", "-c", command],
        env={
            **os.environ,
            "NEEDS_JSON": json.dumps(needs),
            "NO_CODE": no_code,
            "HEAVY": heavy,
            "MODE": mode,
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.returncode


require(aggregate_status("false", "run", "full") == 0, "full aggregate fixture must pass")
require(
    aggregate_status("true", "skip", "docs_only", "skipped") == 0,
    "docs-only aggregate fixture must pass",
)
for skip_mode in ("scoped", "reuse"):
    require(
        aggregate_status("false", "skip", skip_mode, "skipped") == 0,
        f"{skip_mode} aggregate fixture must pass",
    )
require(
    aggregate_status("false", "run", "full", overrides={"script-tests-6": "skipped"})
    != 0,
    "full mode must reject even one skipped required job",
)
require(
    aggregate_status("false", "skip", "scoped", "skipped", {"script-tests-6": "success"})
    != 0,
    "skip modes must reject partially executed heavy jobs",
)
require(
    aggregate_status("false", "run", "") != 0,
    "missing mode must fail closed",
)
require(
    aggregate_status("false", "skip", "docs_only", "skipped") != 0,
    "docs-only mode must require no_code=true",
)
aggregate_mutant = aggregate_run.replace(
    'and ($needs["script-tests-6"].result == "success")', "", 1
)
require(aggregate_mutant != aggregate_run, "positive control must remove one success assertion")
mutant_results = {"script-tests-6": "failure"}
require(
    aggregate_status("false", "run", "full", overrides=mutant_results) != 0,
    "real aggregate must reject a failed script shard",
)
require(
    aggregate_status(
        "false", "run", "full", overrides=mutant_results, command=aggregate_mutant
    )
    == 0,
    "positive control must prove removing one success assertion creates a false green",
)

summary_steps = [
    step
    for step in ci_ok_steps
    if isinstance(step, dict) and step.get("name") == "Summarize CI scope"
]
require(len(summary_steps) == 1, "ci-ok must contain exactly one scope summary step")
require(
    normalize_expression(summary_steps[0].get("if")) == "always()",
    "scope summary must run always",
)
upload_steps = [
    step
    for step in ci_ok_steps
    if isinstance(step, dict) and step.get("uses") == "actions/upload-artifact@v4"
]
require(len(upload_steps) == 1, "ci-ok must contain exactly one evidence upload")
upload_step = upload_steps[0]
require(
    normalize_expression(upload_step.get("if"))
    == "success()&&needs.classify.outputs.mode=='full'",
    "full evidence upload condition changed",
)
upload_with = mapping(upload_step.get("with"), "ci-ok evidence upload.with")
require(
    upload_with.get("name")
    == "ci-full-green-${{ needs.classify.outputs.tested_tree }}",
    "full evidence artifact name changed",
)
require(upload_with.get("retention-days") == 14, "full evidence retention must be 14 days")

timeout_floors = {
    "unit-tests": (unit_tests, 15),
    # FLY-1482: the shell job's main-branch baseline reached 13m42s and a PR
    # replay was cancelled at the old 15-minute ceiling. Keep enough capacity
    # for the required real-watcher teardown coverage and ordinary CI variance.
    "script-tests": (script_tests, 20),
    "script-tests-2": (script_tests_2, 20),
    "script-tests-3": (script_tests_3, 20),
    "script-tests-4": (script_tests_4, 20),
    "script-tests-5": (script_tests_5, 20),
    "script-tests-6": (script_tests_6, 20),
}
for job_id, (job, timeout_floor) in timeout_floors.items():
    timeout = job.get("timeout-minutes")
    require(
        isinstance(timeout, int) and timeout >= timeout_floor,
        f"{job_id}.timeout-minutes must be at least {timeout_floor}",
    )

script_steps = script_tests.get("steps")
require(isinstance(script_steps, list), "script-tests.steps must be a list")
script_steps_2 = script_tests_2.get("steps")
require(isinstance(script_steps_2, list), "script-tests-2.steps must be a list")
script_steps_3 = script_tests_3.get("steps")
require(isinstance(script_steps_3, list), "script-tests-3.steps must be a list")
script_steps_4 = script_tests_4.get("steps")
require(isinstance(script_steps_4, list), "script-tests-4.steps must be a list")
script_steps_5 = script_tests_5.get("steps")
require(isinstance(script_steps_5, list), "script-tests-5.steps must be a list")
script_steps_6 = script_tests_6.get("steps")
require(isinstance(script_steps_6, list), "script-tests-6.steps must be a list")
all_script_steps = (
    script_steps,
    script_steps_2,
    script_steps_3,
    script_steps_4,
    script_steps_5,
    script_steps_6,
)
quick_steps = quick_gate.get("steps")
require(isinstance(quick_steps, list), "quick-gate.steps must be a list")
fly2664_steps = [
    step
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-2664 merged worktree read-only audit"
]
require(
    len(fly2664_steps) == 1,
    "script shards must contain exactly one FLY-2664 merged worktree audit step",
)
require(
    str(fly2664_steps[0].get("run", "")).strip()
    == "node --test scripts/__tests__/audit-merged-worktrees.test.mjs",
    "FLY-2664 merged worktree audit command drifted",
)
require(
    "continue-on-error" not in fly2664_steps[0],
    "FLY-2664 merged worktree audit must fail closed",
)
ci_structure_in_quick = sum(
    "bash scripts/__tests__/ci-structure.test.sh" in str(step.get("run", ""))
    for step in quick_steps if isinstance(step, dict)
)
ci_structure_in_scripts = sum(
    "bash scripts/__tests__/ci-structure.test.sh" in str(step.get("run", ""))
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
)
require(
    ci_structure_in_quick == 1 and ci_structure_in_scripts == 0,
    "ci-structure.test.sh must run exactly once in the always-on quick-gate",
)
for new_suite in (
    "bash scripts/__tests__/ci-scope.test.sh",
    "bash scripts/__tests__/ci-full-reuse.test.sh",
):
    require(
        sum(
            new_suite in str(step.get("run", ""))
            for step in quick_steps
            if isinstance(step, dict)
        )
        == 1,
        f"{new_suite} must run exactly once in quick-gate",
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
package_gate_steps = [
    step for step in quick_steps
    if isinstance(step, dict)
    and step.get("name") == "Package gate receipt, retry, and host admission guards (FLY-2467/FLY-2702)"
]
require(
    len(package_gate_steps) == 1,
    "quick-gate must contain exactly one package gate receipt and host admission step",
)
require(
    str(package_gate_steps[0].get("run", "")).strip()
    == "node --test scripts/__tests__/package-gate.test.mjs\nnode --test scripts/__tests__/package-gate-host.test.mjs\nnode --test scripts/__tests__/qa-package-gate-host.test.mjs\nnode --test scripts/__tests__/teamlead-shards.test.mjs\nnode --test scripts/__tests__/vitest-worker-rpc.test.mjs",
    "package gate quick-gate inventory drifted",
)
require(
    "continue-on-error" not in package_gate_steps[0],
    "package gate quick-gate inventory must fail closed",
)

# FLY-2074: founder-facing acceptance must disclose all measured rounds and keep
# its machine-readable facts aligned with the rendered page. This is docs-only,
# so the guard must stay in the always-on lane and run without node_modules.
fly2074_steps = [
    step for step in quick_steps
    if isinstance(step, dict)
    and step.get("name") == "Enforce FLY-2074 founder disclosure contract"
]
require(
    len(fly2074_steps) == 1,
    "quick-gate must contain exactly one FLY-2074 founder disclosure step",
)
require(
    str(fly2074_steps[0].get("run", "")).strip()
    == "node scripts/fly2074-founder-disclosure-guard.mjs",
    "FLY-2074 founder disclosure command drifted",
)
require(
    "if" not in fly2074_steps[0],
    "FLY-2074 founder disclosure step must not be conditional",
)
require(
    "continue-on-error" not in fly2074_steps[0],
    "FLY-2074 founder disclosure step must fail closed",
)
fly2074_in_shards = sum(
    1
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
    and "fly2074-founder-disclosure-guard.mjs" in str(step.get("run", ""))
)
require(
    fly2074_in_shards == 0,
    "FLY-2074 founder disclosure must run only in the always-on quick gate",
)

# FLY-2045: the milestone-layout guard is the reason a milestone-only regression cannot
# reach main. Every such regression is a Markdown-only change, and Markdown under
# engineering/doc/ classifies inert, so the heavy jobs skip exactly those PRs -- the guard
# only works if it stays in the always-on lane, unconditional, and ahead of the install
# step (it is pure bash and must not depend on node_modules).
fly2045_steps = [
    step for step in quick_steps
    if isinstance(step, dict)
    and step.get("name") == "Enforce FLY-2045 milestone layout"
]
require(
    len(fly2045_steps) == 1,
    "quick-gate must contain exactly one FLY-2045 milestone layout step",
)
require(
    str(fly2045_steps[0].get("run", "")).strip()
    == "bash scripts/__tests__/fly2045-milestone-layout.test.sh",
    "FLY-2045 milestone layout command drifted",
)
require(
    "if" not in fly2045_steps[0],
    "FLY-2045 milestone layout step must not be conditional",
)
require(
    "continue-on-error" not in fly2045_steps[0],
    "FLY-2045 milestone layout step must fail closed",
)
fly2045_in_shards = sum(
    1
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
    and "fly2045-milestone-layout.test.sh" in str(step.get("run", ""))
)
require(
    fly2045_in_shards == 0,
    "FLY-2045 milestone layout must run only in the always-on quick gate, not in a shard",
)
quick_names = [
    str(step.get("name") or step.get("uses") or "")
    for step in quick_steps
    if isinstance(step, dict)
]
require(
    quick_names.index("Enforce FLY-2045 milestone layout")
    < quick_names.index("Install dependencies"),
    "FLY-2045 milestone layout must run before dependencies are installed",
)
require(
    quick_names.index("Enforce FLY-2074 founder disclosure contract")
    < quick_names.index("Install dependencies"),
    "FLY-2074 founder disclosure must run before dependencies are installed",
)


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
        "Test — FLY-1389 path-hygiene + 529-Room repair batch",
        "Test — FLY-2598 voice host configuration",
        "Test — FLY-1496 model resolution + Lead derivation",
        "Test — FLY-2007 phase-0 analyser contract",
        "Test — FLY-1887 one-shot Codex hard timeout",
        "Test — FLY-2237 slot Bridge cycle",
        "Test — onboard-shell public install chain",
        "Test — FLY-2145 Lead memory private repository",
        "Test — FLY-2144 retired dispatch residue guard",
        "Test — Lead in-flight mailbox adoption contracts",
        "Test — FLY-1189 multi-Lead campaign harness",
        "Test — FLY-1961 dual-vendor workspace trust",
        "Test — FLY-1959 updater sources + body provenance contracts",
        "Test — FLY-2102 startup flag freeze residue guard",
        "Test — FLY-2664 merged worktree read-only audit",
        "Test — FLY-2829 node soak smoke",
    ],
    "script-tests-2": [
        "Test — FLY-2331 Bridge async-child guard regression",
        "Test — FLY-2444 generalized Lead launcher",
        "Test — FLY-2598 voice client coexistence",
        "Test — FLY-1081 notify-path migration",
        "Test — FLY-913/2204 restart + calendar isolation guards",
        "Test — FLY-1955/2211 Codex daemon mutation safety",
        "Test — FLY-1330 log janitor",
        "Test — FLY-2465 isolated Codex quota contracts",
        "Test — FLY-2549 summary preflight with stale workspace dist",
        "Test — FLY-2139 database maintenance",
        "Test — FLY-2598 readonly voice preflight",
        "Test — FLY-2454 slot isolation contracts",
        "Test — FLY-1393 flag truth CLI",
        "Test — FLY-1338 matrix coverage parity (QA)",
        "Test — FLY-1759 reap-first worktree teardown",
        "Test — FLY-2829 node soak restart",
    ],
    "script-tests-3": [
        "Test — FLY-1434 unified restart + quota caller",
        "Test — payload real-install smoke",
        "Test — FLY-1501 restart brake + heartbeat guard contracts",
        "Test — FLY-1678 statusline model-scoped bar + installer",
        "Test — FLY-2456 hermetic restart drill evidence",
        "Test — FLY-1189 assert library + driver trap owner",
        "Test — FLY-648 one-command setup wizard",
        "Test — FLY-2134 artifact freshness monitor",
        "Test — Discord adapter orphan reaper (FLY-183)",
        "Test — resident Codex recovery contracts",
        "Test — FLY-1729/1743 restart update + consistency guards",
        "Test — FLY-1707 incident replay",
        "Test — FLY-1944 host terminal cutover brake",
        "Test — FLY-2446 two-Lead voice driver",
        "Test — FLY-1830 non-Lead daemon convergence",
        "Test — FLY-2829 prod watchdog",
    ],
    "script-tests-4": [
        "Test — FLY-1364 cmux sync repair",
        "Test — FLY-2404 shared Codex credential truth",
        "Test — FLY-1905 CI apt-install helper",
        "Test — Lead rules single-bundle load chain (FLY-1402)",
        "Test — FLY-2270 QA report host stub",
        "Test — FLY-1634 restart net-deletion contracts",
        "Test — FLY-2519 read-only Lead parity inventory",
        "Test — FLY-2403 Astra/Fable design outcome report",
        "Test — FLY-2383 voice concurrency measurement contract",
        "Test — FLY-1887 bounded Flywheel logs",
        "Test — FLY-957 record_deployed_range best-effort",
        "Test — FLY-2459 Codex department capability and migration",
        "Test — FLY-880 PM executor role contract",
        "Test — FLY-2015 diagram-design role routing",
        "Test — FLY-2022 diagram-design project install",
        "Test — FLY-1787 CoS identity contract",
        "Test — FLY-1461 QA executor 529 N-to-N contract",
        "Test — FLY-1463 QA executor ship-report contract",
        "Test — FLY-1981 runtime role auto-QA retirement",
        "Test — FLY-1715 runner boundary shell contracts",
        "Test — FLY-1945 trusted patrol helper closure",
        "Test — FLY-1870 job elapsed tripwire contract",
        "Test — FLY-2034 Belle staged credential gate",
        "Test — FLY-1356 skill-framework vendor + variant contracts",
        "Test — FLY-2270 slot Bridge launch boundary",
        "Test — FLY-513 global-codex repoint apply-path",
        "Test — FLY-697 codex-log-guard",
        "Test — FLY-1436 work-kind cutover CLI",
        "Test — FLY-1867/2026 Playwright lifecycle tools",
        "Test — FLY-2278 attempt-version rollback",
    ],
    "script-tests-5": [
        "Test — FLY-1855 executable Lead patrol snapshot",
        "Test — FLY-1929 voucher watch contracts",
        "Test — FLY-1986 load probe contract",
        "Test — FLY-2146 Lead memory remote sync",
        "Test — FLY-1023 Buddy onboarding (step CLI + provider contract)",
        "Test — NPM packaging pipeline + packaged-mode seams",
        "Test — FLY-1572 mailbox migration CLI",
        "Test — FLY-1861 CI cancellation and classification contracts",
        "Test — FLY-2533 packed phase protocols",
        "Test — FLY-519 fleet provisioning + zero-secret gate",
        "Test — FLY-1189 fault injector safety lock",
        "Test — FLY-2126 Raya voice scenario wrapper",
        "Test — FLY-1674 legacy-path residue guard",
        "Test — FLY-882 Discord bot token pool",
    ],
    "script-tests-6": [
        "Test — FLY-1663 launchd-native Lead lifecycle",
        "Test — FLY-1814 launchd fleet contracts",
        "Test — FLY-2693 voice health source",
        "Test — FLY-1726 canonical Lead identity delivery",
        "Test — FLY-2274 cutover window artifacts",
        "Test — FLY-2570 dynamic design ratio operator",
        "Test — FLY-1948 slot Discord channel evidence",
        "Test — FLY-1775 generalized-DAG 529 room",
        "Test — FLY-1649 r4 migration-window hardening",
        "Integration test — cmux-sync hooks",
        "Test — FLY-2033 meeting artifact closure",
        "Test — FLY-927 infra-alert shell path",
        "Test — FLY-2190 host tmux selection S0",
        "Test — FLY-1764 legacy swap broadcast retirement",
        "Test — FLY-1609 four-arm analysis contract",
        "Test — FLY-1327 cycle-time report",
        "Test — FLY-2655 isolated 529 voice room",
    ],
}
script_shards = {
    "script-tests": (script_tests, script_steps),
    "script-tests-2": (script_tests_2, script_steps_2),
    "script-tests-3": (script_tests_3, script_steps_3),
    "script-tests-4": (script_tests_4, script_steps_4),
    "script-tests-5": (script_tests_5, script_steps_5),
    "script-tests-6": (script_tests_6, script_steps_6),
}
expected_shard_names = {
    "script-tests": "Script Tests 1/6 — balanced shell suites A",
    "script-tests-2": "Script Tests 2/6 — balanced shell suites B",
    "script-tests-3": "Script Tests 3/6 — balanced shell suites C",
    "script-tests-4": "Script Tests 4/6 — balanced shell suites D",
    "script-tests-5": "Script Tests 5/6 — balanced shell suites E",
    "script-tests-6": "Script Tests 6/6 — balanced shell suites F",
}

all_expected_tests = [
    name for names in expected_shard_tests.values() for name in names
]
require(
    len(all_expected_tests) == len(set(all_expected_tests)),
    "script shard test inventory must not contain duplicate step names",
)

for job_id, (job, steps) in script_shards.items():
    require(
        job.get("name") == expected_shard_names[job_id],
        f"{job_id} display name drifted: {job.get('name')!r}",
    )
    identities = [step_identity(step) for step in steps]
    require(
        identities[: len(expected_setup)] == expected_setup,
        f"{job_id} setup prefix drifted: {identities[:len(expected_setup)]}",
    )
    checkout = mapping(steps[1], f"{job_id} checkout step")
    if job_id == "script-tests":
        require(
            mapping(checkout.get("with"), f"{job_id} checkout.with").get("fetch-depth") == 0,
            "script-tests must retain full history for FLY-2007",
        )
    else:
        require(
            checkout.get("with") is None,
            f"{job_id} must use the default shallow checkout",
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

fly2444_steps = [
    step for step in script_steps_2
    if isinstance(step, dict) and step.get("name") == "Test — FLY-2444 generalized Lead launcher"
]
require(len(fly2444_steps) == 1, "script-tests-2 must contain exactly one FLY-2444 step")
fly2444_commands = [
    line.strip()
    for line in str(fly2444_steps[0].get("run", "")).splitlines()
    if line.strip().startswith("bash ")
]
require(
    fly2444_commands
    == [
        "bash scripts/__tests__/flywheel-lead.test.sh",
        "bash scripts/__tests__/flywheel-lead-packaging.test.sh",
        "bash scripts/__tests__/host-tmux-selection-gate-probe.test.sh",
        "bash scripts/__tests__/lead-restart-lifecycle-generic-carrier.test.sh",
        "bash packages/teamlead/scripts/__tests__/codex-lead-args.test.sh",
        "bash packages/teamlead/scripts/__tests__/codex-lead-state-dir-parity.test.sh",
    ],
    f"FLY-2444 CI command inventory drifted: {fly2444_commands}",
)

fly2404_steps = [
    step
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict) and step.get("name") == "Test — FLY-2404 shared Codex credential truth"
]
require(len(fly2404_steps) == 1, "script shards must contain exactly one FLY-2404 step")
fly2404_commands = [
    line.strip()
    for line in str(fly2404_steps[0].get("run", "")).splitlines()
    if line.strip().startswith("bash ")
]
require(
    fly2404_commands
    == [
        "bash scripts/__tests__/codex-home-link-truth.test.sh",
        "bash scripts/__tests__/codex-home-reconcile.test.sh",
        "bash scripts/__tests__/codex-home-reconcile-cycle.test.sh",
        "bash scripts/__tests__/codex-home-launch-fence.test.sh",
        "bash scripts/__tests__/codex-home-reconcile-process.test.sh",
        "bash scripts/__tests__/codex-home-reconcile-cadence.test.sh",
        "bash scripts/__tests__/codex-home-migration-alert.test.sh",
        "bash scripts/__tests__/codex-home-migration-overdue-mutation.test.sh",
        "bash scripts/__tests__/codex-quota-readiness-check.test.sh",
        "bash scripts/__tests__/codex-lead-launchd-preflight.test.sh",
        "bash scripts/__tests__/codex-credential-cutover.test.sh",
        "bash scripts/__tests__/codex-home-credential-sweep.test.sh",
    ],
    f"FLY-2404 CI command inventory drifted: {fly2404_commands}",
)

fly2146_steps = [
    step for step in script_steps_5
    if isinstance(step, dict) and step.get("name") == "Test — FLY-2146 Lead memory remote sync"
]
require(len(fly2146_steps) == 1, "script-tests-5 must contain exactly one FLY-2146 step")
fly2146_step = fly2146_steps[0]
fly2146_commands = [
    line.strip()
    for line in str(fly2146_step.get("run", "")).splitlines()
    if re.match(r"^(?:FLY2145_REAL_GITLEAKS_BIN=.* )?bash scripts/__tests__/", line.strip())
]
expected_fly2146_commands = [
    'FLY2145_REAL_GITLEAKS_BIN="$install_dir/gitleaks" bash scripts/__tests__/test-lead-memory-sync.test.sh',
    "bash scripts/__tests__/test-lead-memory-arrival-check.test.sh",
    "bash scripts/__tests__/test-lead-memory-freshness-report.test.sh",
    "bash scripts/__tests__/test-lead-memory-observe-workflow.test.sh",
    "bash scripts/__tests__/test-lead-memory-retire.test.sh",
]
require(
    fly2146_commands == expected_fly2146_commands,
    f"FLY-2146 CI must run the five new suites exactly once and serially: {fly2146_commands}",
)
fly2146_env = mapping(fly2146_step.get("env"), "FLY-2146 shell suite env")
require(str(fly2146_env.get("GITLEAKS_VERSION")) == "8.30.1", "FLY-2146 must pin gitleaks 8.30.1")

fly2134_steps = [
    step
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict) and step.get("name") == "Test — FLY-2134 artifact freshness monitor"
]
require(len(fly2134_steps) == 1, "script shards must contain exactly one FLY-2134 step")
fly2134_step = fly2134_steps[0]
fly2134_commands = [
    line.strip()
    for line in str(fly2134_step.get("run", "")).splitlines()
    if line.strip().startswith("bash scripts/__tests__/")
]
expected_fly2134_commands = [
    "bash scripts/__tests__/artifact-freshness-manifest.test.sh",
    "bash scripts/__tests__/artifact-freshness-check.test.sh",
    "bash scripts/__tests__/bridge-liveness-probe-w4.test.sh",
]
require(
    fly2134_commands == expected_fly2134_commands,
    f"FLY-2134 CI must run the three new suites exactly once and serially: {fly2134_commands}",
)
require("if" not in fly2134_step, "FLY-2134 shell suites must not be conditional")
require(
    "continue-on-error" not in fly2134_step,
    "FLY-2134 shell suites must fail the PR gate",
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
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-1715 runner boundary shell contracts"
]
require(
    len(fly1715_steps) == 1,
    "script shards must contain exactly one FLY-1715 runner boundary shell contracts step",
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
    "bash scripts/__tests__/restart-services-no-voice-bridge.test.sh",
]
require(
    fly1715_commands == expected_fly1715_commands,
    f"FLY-1715 CI command set/order drifted: {fly1715_commands}",
)

# FLY-1364: the cmux authority/cleanup matrix and every shell-side delivery
# seam must be visible in the required PR gate. FLY-2829's three long-running
# soak/watchdog suites are pinned to lighter shards below; the node-registry
# suite stays with this named cmux step.
fly1364_steps = [
    step
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict) and step.get("name") == "Test — FLY-1364 cmux sync repair"
]
require(len(fly1364_steps) == 1, "script shards must contain exactly one FLY-1364 cmux sync repair step")
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
    "bash scripts/__tests__/cmux-cleanup-lifecycle.test.sh",
    "bash scripts/__tests__/cmux-view-rebind.test.sh",
    "bash scripts/__tests__/fly2048-cmux-convergence.test.sh",
    "bash scripts/__tests__/fly1884-view-attach.test.sh",
    "bash scripts/__tests__/fly1884-attach-recovery.test.sh",
    "bash scripts/__tests__/fly1884-node-presence.test.sh",
    "bash scripts/__tests__/fly2829-node-registry.test.sh",
    "bash scripts/__tests__/fly2829-workspace-convergence.test.sh",
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
    "bash scripts/__tests__/agent-visibility-rules.test.sh",
    "bash scripts/__tests__/agent-visibility.test.sh",
]
require(
    fly1364_commands == expected_fly1364_commands,
    f"FLY-1364 CI command set/order drifted: {fly1364_commands}",
)
require(
    fly1364_step in script_steps_4,
    "FLY-1364 cmux sync repair must remain in script-tests-4",
)

# FLY-2829 qa@2: these suites added 542s to shard D and crossed FLY-1870's
# 1020s tripwire. Move intact commands to the three lightest shards by measured
# duration; do not raise the cap or weaken mandatory/modern-Bash semantics.
fly2829_rebalanced = [
    (
        "script-tests",
        script_steps,
        "Test — FLY-2829 node soak smoke",
        "bash scripts/__tests__/fly2829-node-soak-smoke.test.sh",
    ),
    (
        "script-tests-2",
        script_steps_2,
        "Test — FLY-2829 node soak restart",
        "bash scripts/__tests__/fly2829-node-soak-restart.test.sh",
    ),
    (
        "script-tests-3",
        script_steps_3,
        "Test — FLY-2829 prod watchdog",
        "bash scripts/__tests__/fly2829-prod-watchdog.test.sh",
    ),
]
for job_id, expected_steps, step_name, command in fly2829_rebalanced:
    matches = [
        step
        for job_steps in all_script_steps
        for step in job_steps
        if isinstance(step, dict) and step.get("name") == step_name
    ]
    require(len(matches) == 1, f"{step_name} must run exactly once across script shards")
    step = matches[0]
    require(step in expected_steps, f"{step_name} must run in {job_id}")
    require(str(step.get("run", "")).strip() == command, f"{step_name} command drifted")
    require("if" not in step, f"{step_name} must not be conditional")
    require("continue-on-error" not in step, f"{step_name} must fail the PR gate")
    step_env = mapping(step.get("env"), f"{step_name} env")
    require(
        str(step_env.get("FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH")) == "1",
        f"{step_name} must opt into the modern-Bash compatibility pass",
    )

# FLY-1830: the non-Lead daemon convergence is the only thing that puts a
# launchd label back after it leaves the domain. A suite that quietly falls out
# of the gate would restore exactly the silence this issue was filed about.
fly1830_steps = [
    step
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-1830 non-Lead daemon convergence"
]
require(
    len(fly1830_steps) == 1,
    "script shards must contain exactly one FLY-1830 non-Lead daemon convergence step",
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
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-1814 launchd fleet contracts"
]
require(
    len(fly1814_steps) == 1,
    "script shards must contain exactly one FLY-1814 launchd fleet contracts step",
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
    "bash scripts/__tests__/flywheel-voice-wrapper.test.sh",
    "bash scripts/__tests__/restart-voice-on-demand.test.sh",
    "bash scripts/__tests__/install-voice-launchd.test.sh",
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

fly2693_steps = [
    step
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict)
    and step.get("name") == "Test — FLY-2693 voice health source"
]
require(
    len(fly2693_steps) == 1,
    "script-tests shards must contain exactly one FLY-2693 voice health source step",
)
require("if" not in fly2693_steps[0], "FLY-2693 health suite must not be conditional")
require(
    "continue-on-error" not in fly2693_steps[0],
    "FLY-2693 health suite must fail the PR gate",
)
require(
    str(fly2693_steps[0].get("run", "")).strip()
    == "python3 scripts/__tests__/voice-health.test.py\npython3 scripts/__tests__/voice-health-startup-spool.test.py\nbash scripts/__tests__/voice-health-alert-route.test.sh",
    "FLY-2693 health suite command drifted",
)


fly1948_steps = [
    step
    for job_steps in all_script_steps
    for step in job_steps
    if isinstance(step, dict) and step.get("name") == "Test — FLY-1948 slot Discord channel evidence"
]
require(len(fly1948_steps) == 1, "FLY-1948 channel evidence must run exactly once")
fly1948_commands = [line.strip() for line in str(fly1948_steps[0].get("run", "")).splitlines() if line.strip()]
require(fly1948_commands == [
    "pnpm --filter flywheel-comm build",
    "bash scripts/__tests__/qa-discord-liveness.test.sh",
    "bash scripts/__tests__/qa-529-discord-liveness.test.sh",
    "bash scripts/__tests__/qa-lead-coordinates.test.sh",
    "bash scripts/__tests__/qa-room-env.test.sh",
    "node --test scripts/__tests__/qa-529-discord-roundtrip.test.mjs",
], "FLY-1948 must build canonical envelopes before running every channel/roundtrip suite")

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
    for job_steps in all_script_steps
    for step in job_steps
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
    "bash scripts/__tests__/conditional-restart.test.sh",
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

matrix_names = {entry["name"] for entry in actual_matrix}
for step in unit_steps:
    condition = str(step.get("if", ""))
    for name in re.findall(r"matrix\.name\s*==\s*'([^']+)'", condition):
        require(name in matrix_names, f"conditional step targets absent matrix row: {name}")
require(
    not any(
        step.get("name") == "FLY-2453 whole-gate writer mutations"
        for step in unit_steps
        if isinstance(step, dict)
    ),
    "retired FLY-2453 pure-docs mutation gate must not return",
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
    == "matrix.name == 'teamlead 1 of 4'",
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

voice_driver_steps = [step for job_steps in all_script_steps for step in job_steps if isinstance(step, dict) and step.get("name") == "Test — FLY-2446 two-Lead voice driver"]
require(len(voice_driver_steps) == 1, "FLY-2446 driver must run exactly once across script shards")
voice_driver_step = voice_driver_steps[0]
require(voice_driver_step.get("run") == "node --test scripts/__tests__/fly2446-two-lead-run.test.mjs", "FLY-2446 driver command drifted")
require("if" not in voice_driver_step and "continue-on-error" not in voice_driver_step, "FLY-2446 driver must be a mandatory hermetic gate")
voice_preflight_steps = [step for job_steps in all_script_steps for step in job_steps if isinstance(step, dict) and step.get("name") == "Test — FLY-2598 readonly voice preflight"]
require(len(voice_preflight_steps) == 1, "FLY-2598 readonly preflight must run exactly once across script shards")
require(voice_preflight_steps[0].get("run") == "node --test scripts/__tests__/fly2598-voice-preflight.test.mjs", "FLY-2598 preflight command drifted")
require(not voice_preflight_steps[0].get("if") and not voice_preflight_steps[0].get("continue-on-error"), "FLY-2598 preflight must be mandatory")
voice_coexist_steps = [step for job_steps in all_script_steps for step in job_steps if isinstance(step, dict) and step.get("name") == "Test — FLY-2598 voice client coexistence"]
require(len(voice_coexist_steps) == 1, "FLY-2598 voice coexistence must run exactly once across script shards")
require(voice_coexist_steps[0].get("run") == "pnpm --filter flywheel-voice-codex... build\nnode --test scripts/__tests__/fly2598-voice-coexistence.test.mjs\n", "FLY-2598 coexistence command drifted")
require(not voice_coexist_steps[0].get("if") and not voice_coexist_steps[0].get("continue-on-error"), "FLY-2598 coexistence must be mandatory")
voice_config_steps = [step for job_steps in all_script_steps for step in job_steps if isinstance(step, dict) and step.get("name") == "Test — FLY-2598 voice host configuration"]
require(len(voice_config_steps) == 1, "FLY-2598 voice config test must run exactly once across script shards")
voice_config_step = voice_config_steps[0]
require(str(voice_config_step.get("run", "")).strip().splitlines() == ["pnpm --filter flywheel-teamlead... build", "pnpm --filter flywheel-comm... build", "node --test scripts/__tests__/voice-host-configure.test.mjs scripts/__tests__/install-voice-launchd.test.mjs"], "FLY-2598 voice config gate commands drifted")
require("if" not in voice_config_step and "continue-on-error" not in voice_config_step, "FLY-2598 voice config gate must be mandatory")
voice_2655_steps = [step for step in script_steps_6 if isinstance(step, dict) and step.get("name") == "Test — FLY-2655 isolated 529 voice room"]
require(len(voice_2655_steps) == 1, "FLY-2655 voice room test must run exactly once in script-tests-6")
require(voice_2655_steps[0].get("run") == "node --test scripts/__tests__/fly2655-voice-room.test.mjs", "FLY-2655 voice room command drifted")
require("if" not in voice_2655_steps[0] and "continue-on-error" not in voice_2655_steps[0], "FLY-2655 voice room gate must be mandatory")

print("PASS: FLY-1338 CI structure contract")
PY
