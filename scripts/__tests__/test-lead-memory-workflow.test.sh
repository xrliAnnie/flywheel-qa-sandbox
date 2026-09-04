#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/scripts/lead-memory/repo-template/.github/workflows/guard.yml"

WORKFLOW="$WORKFLOW" python3 <<'PY'
import os
import re
from pathlib import Path

import yaml

path = Path(os.environ["WORKFLOW"])
source = path.read_text(encoding="utf-8")
workflow = yaml.safe_load(source)

assert workflow[True]["push"]["branches"] == ["main"], "workflow must run on pushes to main"
assert workflow["permissions"] == {"contents": "read"}, "workflow permissions must be contents: read only"
jobs = workflow["jobs"]
assert list(jobs) == ["guard"], "workflow must contain only the guard job"
steps = jobs["guard"]["steps"]
checkout = steps[0]
assert checkout["uses"] == "actions/checkout@v4"
assert checkout["with"]["fetch-depth"] == 0, "guard needs complete history"

install = next(step for step in steps if step.get("name") == "Install pinned gitleaks")
assert install["env"]["GITLEAKS_VERSION"] == "8.30.1"
assert install["env"]["GITLEAKS_LINUX_X64_SHA256"] == (
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
)
install_run = install["run"]
assert "sha256sum -c" in install_run
assert "gitleaks version" in install_run

guard = next(step for step in steps if step.get("name") == "Audit pushed commits and secrets")
guard_run = guard["run"]
assert "0000000000000000000000000000000000000000" in guard_run, "zero before must be explicit"
assert '.githooks/lib/guard.sh check-range "$range"' in guard_run, "CI must use the shipped guard"
assert "gitleaks git" in guard_run and '--log-opts="$range"' in guard_run
assert ".gitleaks.toml" in guard_run and ".gitleaksignore" in guard_run
assert "Memory-Owner: admin" in guard_run
assert "GITHUB_STEP_SUMMARY" in guard_run, "admin imports must be visible in the job summary"
assert "continue-on-error" not in source
assert not re.search(r"permissions:\s*write", source)
PY

printf 'ok - lead-memory guard workflow is pinned, read-only, and fail-closed\n'
