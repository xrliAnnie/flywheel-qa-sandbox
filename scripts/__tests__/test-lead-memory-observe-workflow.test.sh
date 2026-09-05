#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/scripts/lead-memory/repo-template/.github/workflows/remote-observe.yml"

test -f "$WORKFLOW" || {
	printf 'not ok - remote observation workflow exists\n' >&2
	exit 1
}

WORKFLOW="$WORKFLOW" python3 <<'PY'
import os
import re
from pathlib import Path

import yaml

path = Path(os.environ["WORKFLOW"])
source = path.read_text(encoding="utf-8")
workflow = yaml.safe_load(source)
triggers = workflow[True]
assert triggers["schedule"] == [{"cron": "5 9 * * *"}], "natural observation must run at 09:05 UTC"
assert triggers["workflow_dispatch"] is not None, "manual dispatch must remain available for smoke testing"
assert workflow["permissions"] == {"contents": "read"}, "top-level permission must be contents: read only"
assert list(workflow["jobs"]) == ["observe"], "workflow must contain exactly one job"
job = workflow["jobs"]["observe"]
assert "permissions" not in job, "job-level permissions overrides are forbidden"
assert list(job) == ["runs-on", "steps"], "observer job must have no hidden behavior"
assert len(job["steps"]) == 1, "observer must contain exactly one step"
step = job["steps"][0]
assert set(step) == {"name", "run"}, "observer step may only have a name and shell body"
body = step["run"]
assert 'GITHUB_STEP_SUMMARY' in body
assert 'head_sha=$GITHUB_SHA' in body
assert 'run_id=$GITHUB_RUN_ID' in body
assert 'date -u' in body
assert "actions/checkout" not in source
assert "secrets." not in source and "github.token" not in source
assert "continue-on-error" not in source
assert not re.search(r"permissions:\s*write", source)
PY

printf 'ok - remote observation workflow is one-step, read-only, and server-evidenced\n'
